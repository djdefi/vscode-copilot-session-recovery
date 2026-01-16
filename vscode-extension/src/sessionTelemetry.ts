import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TokenMetrics {
    totalTokens: number;
    estimatedContextUsed: number;
    contextLimit: number;
    contextUtilization: number; // 0-100%
    messageCount: number;
    avgTokensPerMessage: number;
    lastResponseTokens: number;
    sessionAge: number; // minutes
}

export interface RequestMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgResponseTime: number; // estimated from file timestamps
    requestsLastHour: number;
    lastRequestTime: Date | null;
}

export interface SessionHealthScore {
    score: number; // 0-100
    status: 'healthy' | 'warning' | 'critical';
    warnings: string[];
    recommendations: string[];
}

export interface LiveSessionMetrics {
    sessionId: string;
    title: string;
    workspace: string;
    tokens: TokenMetrics;
    requests: RequestMetrics;
    health: SessionHealthScore;
    pendingEditsCount: number;
    chatHistorySize: number;
    isActive: boolean;
}

// Approximate token counts (GPT-4 tokenizer approximation)
function estimateTokens(text: string): number {
    if (!text) return 0;
    // Rough estimate: ~4 chars per token for English text
    // Code tends to be ~3 chars per token due to shorter tokens
    const words = text.split(/\s+/).length;
    const chars = text.length;
    return Math.ceil(Math.max(words * 1.3, chars / 4));
}

export class SessionTelemetry {
    private storagePath: string | null;
    private contextLimits: { [model: string]: number } = {
        'gpt-4': 8192,
        'gpt-4-32k': 32768,
        'gpt-4-turbo': 128000,
        'gpt-4o': 128000,
        'claude-3': 200000,
        'claude-3.5-sonnet': 200000,
        'default': 128000 // Assume modern large context
    };

    constructor() {
        this.storagePath = this.getVSCodeStoragePath();
    }

    private getVSCodeStoragePath(): string | null {
        const home = os.homedir();
        const variants = [
            { folder: 'Code - Insiders', name: 'VS Code Insiders' },
            { folder: 'Code', name: 'VS Code' },
            { folder: 'VSCodium', name: 'VSCodium' }
        ];

        let base: string;
        if (process.platform === 'darwin') {
            base = path.join(home, 'Library', 'Application Support');
        } else if (process.platform === 'win32') {
            base = process.env.APPDATA || '';
        } else {
            base = path.join(home, '.config');
        }

        for (const { folder } of variants) {
            const storagePath = path.join(base, folder, 'User', 'workspaceStorage');
            if (fs.existsSync(storagePath)) {
                return storagePath;
            }
        }
        return null;
    }

    async getActiveSessionMetrics(workspaceDir?: string): Promise<LiveSessionMetrics | null> {
        if (!this.storagePath) return null;

        // Find the most recently modified session in the current or specified workspace
        const workspaceDirs = fs.readdirSync(this.storagePath);
        let latestSession: any = null;
        let latestTime = 0;

        for (const wsDir of workspaceDirs) {
            const chatDir = path.join(this.storagePath, wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) continue;

            // Check workspace match if specified
            if (workspaceDir) {
                const workspaceJson = path.join(this.storagePath, wsDir, 'workspace.json');
                if (fs.existsSync(workspaceJson)) {
                    try {
                        const wsData = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
                        const folder = wsData.folder || wsData.workspace || '';
                        if (!folder.includes(workspaceDir)) continue;
                    } catch {}
                }
            }

            const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(chatDir, file);
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs > latestTime) {
                    latestTime = stat.mtimeMs;
                    try {
                        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        latestSession = {
                            ...data,
                            sessionId: file.replace('.json', ''),
                            wsDir,
                            filePath,
                            fileSize: stat.size,
                            lastModified: stat.mtime
                        };
                    } catch {}
                }
            }
        }

        if (!latestSession) return null;

        return this.analyzeSession(latestSession);
    }

    private analyzeSession(sessionData: any): LiveSessionMetrics {
        const requests = sessionData.requests || [];
        const now = Date.now();
        
        // Calculate token metrics
        let totalTokens = 0;
        let lastResponseTokens = 0;
        const timestamps: number[] = [];

        for (const req of requests) {
            const userText = req.message?.text || '';
            const userTokens = estimateTokens(userText);
            totalTokens += userTokens;

            // Estimate response tokens
            if (req.response?.value) {
                let responseText = '';
                for (const part of req.response.value) {
                    if (part.kind === 'markdownContent') {
                        responseText += part.content?.value || '';
                    }
                }
                const responseTokens = estimateTokens(responseText);
                totalTokens += responseTokens;
                lastResponseTokens = responseTokens;
            }

            if (req.timestamp) {
                timestamps.push(req.timestamp);
            }
        }

        // Add system prompt estimate (~1000 tokens for Copilot)
        const systemPromptTokens = 1000;
        totalTokens += systemPromptTokens;

        const contextLimit = this.contextLimits['default'];
        const contextUtilization = Math.round((totalTokens / contextLimit) * 100);

        // Calculate request metrics
        const successfulRequests = requests.filter((r: any) => r.response?.value?.length > 0).length;
        const failedRequests = requests.length - successfulRequests;
        
        // Requests in last hour
        const oneHourAgo = now - (60 * 60 * 1000);
        const requestsLastHour = timestamps.filter(t => t > oneHourAgo).length;

        // Calculate session age
        const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : now;
        const sessionAge = Math.round((now - firstTimestamp) / (60 * 1000)); // minutes

        // Estimate avg response time (rough estimate based on response size)
        const avgResponseTime = totalTokens > 0 ? Math.round(totalTokens / 50) / 10 : 0; // ~50 tokens/sec

        // Calculate health score
        const health = this.calculateHealthScore(contextUtilization, requests.length, failedRequests, sessionAge);

        // Get workspace name
        let workspace = 'Unknown';
        const workspaceJson = path.join(this.storagePath!, sessionData.wsDir, 'workspace.json');
        if (fs.existsSync(workspaceJson)) {
            try {
                const wsData = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
                const folder = wsData.folder || wsData.workspace || '';
                workspace = folder.replace('file://', '').split('/').pop() || 'Unknown';
            } catch {}
        }

        // Count pending edits
        let pendingEditsCount = 0;
        const editDir = path.join(this.storagePath!, sessionData.wsDir, 'chatEditingSessions', sessionData.sessionId);
        const stateFile = path.join(editDir, 'state.json');
        if (fs.existsSync(stateFile)) {
            try {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                const entries = state.recentSnapshot?.entries || [];
                pendingEditsCount = entries.filter((e: any) => e.originalHash !== e.currentHash).length;
            } catch {}
        }

        return {
            sessionId: sessionData.sessionId,
            title: sessionData.customTitle || 'Untitled',
            workspace,
            tokens: {
                totalTokens,
                estimatedContextUsed: totalTokens,
                contextLimit,
                contextUtilization,
                messageCount: requests.length,
                avgTokensPerMessage: requests.length > 0 ? Math.round(totalTokens / requests.length) : 0,
                lastResponseTokens,
                sessionAge
            },
            requests: {
                totalRequests: requests.length,
                successfulRequests,
                failedRequests,
                avgResponseTime,
                requestsLastHour,
                lastRequestTime: timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null
            },
            health,
            pendingEditsCount,
            chatHistorySize: sessionData.fileSize || 0,
            isActive: (now - (sessionData.lastModified?.getTime() || 0)) < 5 * 60 * 1000 // Active if modified in last 5 min
        };
    }

    private calculateHealthScore(
        contextUtilization: number,
        messageCount: number,
        failedRequests: number,
        sessionAge: number
    ): SessionHealthScore {
        let score = 100;
        const warnings: string[] = [];
        const recommendations: string[] = [];

        // Context utilization penalties
        if (contextUtilization > 90) {
            score -= 40;
            warnings.push('🚨 Context nearly full! Responses may be truncated.');
            recommendations.push('Start a new session to avoid context overflow.');
        } else if (contextUtilization > 75) {
            score -= 25;
            warnings.push('⚠️ Context window 75%+ utilized.');
            recommendations.push('Consider starting a fresh session soon.');
        } else if (contextUtilization > 50) {
            score -= 10;
        }

        // Message count penalties (very long sessions lose coherence)
        if (messageCount > 50) {
            score -= 20;
            warnings.push('📝 Very long session (50+ messages).');
            recommendations.push('Long sessions can lose context coherence.');
        } else if (messageCount > 30) {
            score -= 10;
        }

        // Failed request penalties
        if (failedRequests > 3) {
            score -= 15;
            warnings.push(`❌ ${failedRequests} failed requests in this session.`);
        } else if (failedRequests > 0) {
            score -= 5;
        }

        // Session age (very old sessions may have stale context)
        if (sessionAge > 24 * 60) { // > 24 hours
            score -= 10;
            warnings.push('🕐 Session is over 24 hours old.');
            recommendations.push('Context may be stale. Consider refreshing.');
        }

        // Ensure score is in valid range
        score = Math.max(0, Math.min(100, score));

        let status: 'healthy' | 'warning' | 'critical';
        if (score >= 70) {
            status = 'healthy';
        } else if (score >= 40) {
            status = 'warning';
        } else {
            status = 'critical';
        }

        return { score, status, warnings, recommendations };
    }

    // Get aggregated metrics across all sessions
    async getGlobalMetrics(): Promise<{
        totalSessions: number;
        activeSessions: number;
        totalStorageUsed: number;
        stuckSessions: number;
        totalPendingFiles: number;
        avgContextUtilization: number;
        topWorkspaces: Array<{ name: string; sessions: number; size: number }>;
    }> {
        if (!this.storagePath) {
            return {
                totalSessions: 0,
                activeSessions: 0,
                totalStorageUsed: 0,
                stuckSessions: 0,
                totalPendingFiles: 0,
                avgContextUtilization: 0,
                topWorkspaces: []
            };
        }

        const workspaceDirs = fs.readdirSync(this.storagePath);
        const workspaceStats = new Map<string, { sessions: number; size: number }>();
        
        let totalSessions = 0;
        let activeSessions = 0;
        let totalStorageUsed = 0;
        let stuckSessions = 0;
        let totalPendingFiles = 0;
        let contextSum = 0;

        const now = Date.now();
        const fiveMinAgo = now - (5 * 60 * 1000);

        for (const wsDir of workspaceDirs) {
            const wsDirPath = path.join(this.storagePath, wsDir);
            if (!fs.statSync(wsDirPath).isDirectory()) continue;

            // Get workspace name
            let workspaceName = 'Unknown';
            const workspaceJson = path.join(wsDirPath, 'workspace.json');
            if (fs.existsSync(workspaceJson)) {
                try {
                    const data = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
                    const folder = data.folder || data.workspace || '';
                    workspaceName = folder.replace('file://', '').split('/').pop() || 'Unknown';
                } catch {}
            }

            const chatDir = path.join(wsDirPath, 'chatSessions');
            if (!fs.existsSync(chatDir)) continue;

            const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.json'));
            let wsSessionCount = 0;
            let wsSize = 0;

            for (const file of files) {
                totalSessions++;
                wsSessionCount++;
                
                const filePath = path.join(chatDir, file);
                const stat = fs.statSync(filePath);
                totalStorageUsed += stat.size;
                wsSize += stat.size;

                if (stat.mtimeMs > fiveMinAgo) {
                    activeSessions++;
                }

                // Quick check for stuck state (would need index for accurate count)
                // Estimate context utilization
                if (stat.size > 100000) { // 100KB+ suggests high context usage
                    contextSum += 70; // Estimate 70% for large sessions
                } else if (stat.size > 50000) {
                    contextSum += 40;
                } else {
                    contextSum += 15;
                }
            }

            if (wsSessionCount > 0) {
                const existing = workspaceStats.get(workspaceName) || { sessions: 0, size: 0 };
                workspaceStats.set(workspaceName, {
                    sessions: existing.sessions + wsSessionCount,
                    size: existing.size + wsSize
                });
            }

            // Count pending files
            const editDir = path.join(wsDirPath, 'chatEditingSessions');
            if (fs.existsSync(editDir)) {
                for (const sessionDir of fs.readdirSync(editDir)) {
                    const stateFile = path.join(editDir, sessionDir, 'state.json');
                    if (fs.existsSync(stateFile)) {
                        try {
                            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                            const entries = state.recentSnapshot?.entries || [];
                            totalPendingFiles += entries.filter((e: any) => e.originalHash !== e.currentHash).length;
                        } catch {}
                    }
                }
            }
        }

        // Sort workspaces by size
        const topWorkspaces = Array.from(workspaceStats.entries())
            .map(([name, stats]) => ({ name, ...stats }))
            .sort((a, b) => b.size - a.size)
            .slice(0, 10);

        return {
            totalSessions,
            activeSessions,
            totalStorageUsed,
            stuckSessions,
            totalPendingFiles,
            avgContextUtilization: totalSessions > 0 ? Math.round(contextSum / totalSessions) : 0,
            topWorkspaces
        };
    }

    // Format metrics for status bar display
    formatStatusBar(metrics: LiveSessionMetrics): string {
        const contextIcon = metrics.tokens.contextUtilization > 75 ? '🔴' : 
                           metrics.tokens.contextUtilization > 50 ? '🟡' : '🟢';
        const contextK = Math.round(metrics.tokens.totalTokens / 1000);
        const limitK = Math.round(metrics.tokens.contextLimit / 1000);
        
        let status = `${contextIcon} ${contextK}K/${limitK}K`;
        
        if (metrics.pendingEditsCount > 0) {
            status += ` | 📝${metrics.pendingEditsCount}`;
        }
        
        if (metrics.requests.totalRequests > 0) {
            status += ` | 💬${metrics.requests.totalRequests}`;
        }

        return status;
    }

    // Format detailed tooltip
    formatTooltip(metrics: LiveSessionMetrics): string {
        const lines = [
            `**${metrics.title}** (${metrics.workspace})`,
            '',
            `📊 **Context Usage**`,
            `   ${metrics.tokens.totalTokens.toLocaleString()} / ${metrics.tokens.contextLimit.toLocaleString()} tokens`,
            `   ${this.renderProgressBar(metrics.tokens.contextUtilization)} ${metrics.tokens.contextUtilization}%`,
            '',
            `💬 **Messages**: ${metrics.requests.totalRequests} (${metrics.requests.successfulRequests} ✓, ${metrics.requests.failedRequests} ✗)`,
            `📝 **Pending Edits**: ${metrics.pendingEditsCount} files`,
            `⏱️ **Session Age**: ${this.formatDuration(metrics.tokens.sessionAge)}`,
            `💾 **History Size**: ${(metrics.chatHistorySize / 1024).toFixed(1)} KB`,
            '',
            `🏥 **Health Score**: ${metrics.health.score}/100 (${metrics.health.status})`
        ];

        if (metrics.health.warnings.length > 0) {
            lines.push('', '⚠️ **Warnings**:');
            metrics.health.warnings.forEach(w => lines.push(`   ${w}`));
        }

        if (metrics.health.recommendations.length > 0) {
            lines.push('', '💡 **Recommendations**:');
            metrics.health.recommendations.forEach(r => lines.push(`   ${r}`));
        }

        return lines.join('\n');
    }

    private renderProgressBar(percent: number): string {
        const filled = Math.round(percent / 10);
        const empty = 10 - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    private formatDuration(minutes: number): string {
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours < 24) return `${hours}h ${mins}m`;
        const days = Math.floor(hours / 24);
        return `${days}d ${hours % 24}h`;
    }
}
