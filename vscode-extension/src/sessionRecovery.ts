import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

// Use native Node.js SQLite via better-sqlite3
let Database: any;
try {
    Database = require('better-sqlite3');
} catch {
    // Will use fallback JSON parsing if better-sqlite3 not available
    Database = null;
}

export interface SessionStats {
    fileCount?: number;
    requestCount?: number;
}

export interface SessionInfo {
    sessionId: string;
    title?: string;
    lastResponseState: number;
    hasPendingEdits?: boolean;
    stats?: SessionStats;
    lastMessageDate?: number;
    _workspace?: string;
    _ws_dir?: string;
}

export interface PendingFile {
    path: string;
    state: number;
    hasChanges: boolean;
    originalHash?: string;
    currentHash?: string;
}

export interface SessionDetails extends SessionInfo {
    chatHistoryPath?: string;
    chatHistorySize?: number;
    pendingFiles?: PendingFile[];
}

export interface SessionSimilarity {
    session: SessionInfo;
    score: number;
    reasons: string[];
}

export interface MergePreview {
    source: SessionInfo;
    target: SessionInfo;
    chatHistoryCount: { source: number; target: number; merged: number };
    fileEditsCount: { source: number; target: number; merged: number };
    conflicts: string[];
}

export interface MergeResult {
    success: boolean;
    backupPath?: string;
    error?: string;
}

interface EditingSessionEntry {
    resource?: string;
    state: number;
    originalHash?: string;
    currentHash?: string;
}

export class SessionRecovery {
    private storagePath: string | null;
    private variant: string;

    constructor() {
        const result = this.getVSCodeStoragePath();
        this.storagePath = result.path;
        this.variant = result.variant;
    }

    private getVSCodeStoragePath(): { path: string | null; variant: string } {
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

        for (const { folder, name } of variants) {
            const storagePath = path.join(base, folder, 'User', 'workspaceStorage');
            if (fs.existsSync(storagePath)) {
                return { path: storagePath, variant: name };
            }
        }

        return { path: null, variant: 'Unknown' };
    }

    private getSessionIndex(dbPath: string): any | null {
        if (!Database) {
            // Fallback: try to read as JSON (won't work for SQLite, but provides graceful error)
            console.warn('better-sqlite3 not available, some features may be limited');
            return null;
        }

        try {
            const db = new Database(dbPath, { readonly: true });
            const row = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
            ).get() as { value: string } | undefined;
            db.close();
            
            if (row) {
                return JSON.parse(row.value);
            }
        } catch (error) {
            console.error(`Error reading database ${dbPath}:`, error);
        }
        return null;
    }

    async listSessions(): Promise<SessionInfo[]> {
        if (!this.storagePath) {
            return [];
        }

        const allSessions: SessionInfo[] = [];
        const workspaceDirs = fs.readdirSync(this.storagePath);

        for (const wsDir of workspaceDirs) {
            const wsDirPath = path.join(this.storagePath, wsDir);
            if (!fs.statSync(wsDirPath).isDirectory()) continue;

            const dbPath = path.join(wsDirPath, 'state.vscdb');
            if (!fs.existsSync(dbPath)) continue;

            // Get workspace name
            let workspaceName = 'Unknown';
            const workspaceJson = path.join(wsDirPath, 'workspace.json');
            if (fs.existsSync(workspaceJson)) {
                try {
                    const data = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
                    const folder = data.folder || data.workspace || 'Unknown';
                    workspaceName = folder.replace('file://', '').split('/').pop() || 'Unknown';
                } catch {}
            }

            // Get session index
            const index = this.getSessionIndex(dbPath);
            if (index?.entries) {
                for (const [sid, info] of Object.entries(index.entries)) {
                    const sessionInfo = info as any;
                    sessionInfo.sessionId = sid;
                    sessionInfo._workspace = workspaceName;
                    sessionInfo._ws_dir = wsDirPath;
                    allSessions.push(sessionInfo);
                }
            }
        }

        // Sort by last message date (newest first)
        allSessions.sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
        
        return allSessions;
    }

    async getSessionDetails(sessionId: string): Promise<SessionDetails | null> {
        const sessions = await this.listSessions();
        const session = sessions.find(s => s.sessionId.includes(sessionId));
        
        if (!session || !session._ws_dir) {
            return null;
        }

        const details: SessionDetails = { ...session };

        // Check chat history
        const chatFile = path.join(session._ws_dir, 'chatSessions', `${session.sessionId}.json`);
        if (fs.existsSync(chatFile)) {
            details.chatHistoryPath = chatFile;
            details.chatHistorySize = fs.statSync(chatFile).size;
        }

        // Check pending edits
        const editDir = path.join(session._ws_dir, 'chatEditingSessions', session.sessionId);
        const stateFile = path.join(editDir, 'state.json');
        
        if (fs.existsSync(stateFile)) {
            try {
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                const entries = state.recentSnapshot?.entries || [];
                details.pendingFiles = entries.map((entry: any) => ({
                    path: decodeURIComponent(entry.resource?.replace('file://', '') || ''),
                    state: entry.state,
                    hasChanges: entry.originalHash !== entry.currentHash,
                    originalHash: entry.originalHash,
                    currentHash: entry.currentHash
                }));
            } catch {}
        }

        return details;
    }

    async exportSession(sessionId: string, full: boolean = false): Promise<string> {
        if (!this.storagePath) {
            throw new Error('VS Code storage not found');
        }

        const workspaceDirs = fs.readdirSync(this.storagePath);
        
        for (const wsDir of workspaceDirs) {
            const chatFile = path.join(this.storagePath, wsDir, 'chatSessions', `${sessionId}.json`);
            if (fs.existsSync(chatFile)) {
                const data = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
                const requests = data.requests || [];
                
                let content = `# Chat Session: ${data.customTitle || 'Untitled'}\n\n`;
                content += `**Session ID:** \`${sessionId}\`\n`;
                content += `**Messages:** ${requests.length}\n`;
                content += `**Export Type:** ${full ? 'Full (with responses)' : 'Prompts only'}\n\n---\n\n`;
                
                for (let i = 0; i < requests.length; i++) {
                    const req = requests[i];
                    const text = req.message?.text || '';
                    const timestamp = req.timestamp;
                    const date = timestamp ? new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ') : 'N/A';
                    
                    content += `## [${i + 1}] ${date}\n\n`;
                    content += `### 👤 User\n\n${text}\n\n`;

                    if (full && req.response) {
                        const responseText = this.formatResponseParts(req.response);
                        content += `### 🤖 Assistant\n\n${responseText}\n\n`;
                    }

                    content += '---\n\n';
                }

                return content;
            }
        }

        throw new Error(`Chat history for session ${sessionId} not found`);
    }

    private formatResponseParts(response: any): string {
        if (!response?.value) return '(No response content)';

        const parts: string[] = [];
        
        for (const part of response.value) {
            const kind = part.kind || '';

            if (kind === 'markdownContent') {
                const text = part.content?.value || '';
                if (text) parts.push(text);
            } else if (kind === 'textEditGroup') {
                const uri = part.uri || '';
                const pathParts = decodeURIComponent(uri.replace('file://', '')).split('/').slice(-3);
                const edits = part.edits?.length || 0;
                parts.push(`\n📝 **Edited:** \`${pathParts.join('/')}\` (${edits} changes)\n`);
            } else if (kind === 'codeblockUri') {
                parts.push(`\n📄 **File:** \`${part.uri}\`\n`);
            } else if (kind === 'toolInvocation') {
                parts.push(`\n🔧 **Tool:** \`${part.toolId || 'unknown'}\`\n`);
            } else if (kind === 'progressMessage') {
                const text = part.content?.value || '';
                if (text) parts.push(`\n⏳ ${text}\n`);
            }
        }

        return parts.length > 0 ? parts.join('\n') : '(No response content)';
    }

    async recoverFiles(sessionId: string, outputDir: string): Promise<number> {
        if (!this.storagePath) {
            throw new Error('VS Code storage not found');
        }

        const workspaceDirs = fs.readdirSync(this.storagePath);
        
        for (const wsDir of workspaceDirs) {
            const editDir = path.join(this.storagePath, wsDir, 'chatEditingSessions', sessionId);
            const stateFile = path.join(editDir, 'state.json');
            const contentsDir = path.join(editDir, 'contents');

            if (!fs.existsSync(stateFile)) continue;

            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            const entries = state.recentSnapshot?.entries || [];
            let recovered = 0;

            for (const entry of entries) {
                if (entry.originalHash === entry.currentHash) continue;

                const uri = entry.resource || '';
                const filePath = decodeURIComponent(uri.replace('file://', ''));
                const contentFile = path.join(contentsDir, entry.currentHash);

                if (fs.existsSync(contentFile)) {
                    const relPath = filePath.replace(/^\//, '');
                    const outPath = path.join(outputDir, relPath);
                    
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    fs.copyFileSync(contentFile, outPath);
                    recovered++;
                }
            }

            return recovered;
        }

        throw new Error(`Editing session ${sessionId} not found`);
    }

    async fixSession(sessionId: string): Promise<boolean> {
        if (!this.storagePath || !Database) {
            return false;
        }

        const workspaceDirs = fs.readdirSync(this.storagePath);
        
        for (const wsDir of workspaceDirs) {
            const dbPath = path.join(this.storagePath, wsDir, 'state.vscdb');
            if (!fs.existsSync(dbPath)) continue;

            const index = this.getSessionIndex(dbPath);
            if (!index?.entries) continue;

            for (const [sid, info] of Object.entries(index.entries)) {
                if (!sid.includes(sessionId)) continue;
                
                const sessionInfo = info as any;
                if (sessionInfo.lastResponseState !== 3) {
                    return false;
                }

                // Create backup
                const backup = dbPath + '.recovery_backup';
                if (!fs.existsSync(backup)) {
                    fs.copyFileSync(dbPath, backup);
                }

                // Fix the state
                sessionInfo.lastResponseState = 1;

                try {
                    const db = new Database(dbPath);
                    db.prepare(
                        "UPDATE ItemTable SET value = ? WHERE key = 'chat.ChatSessionStore.index'"
                    ).run(JSON.stringify(index));
                    db.close();
                    return true;
                } catch (error) {
                    console.error('Failed to fix session:', error);
                    return false;
                }
            }
        }

        return false;
    }

    async backupSession(sessionId: string, outputDir: string): Promise<void> {
        if (!this.storagePath) {
            throw new Error('VS Code storage not found');
        }

        const sessions = await this.listSessions();
        const session = sessions.find(s => s.sessionId.includes(sessionId));
        
        if (!session || !session._ws_dir) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const backupDir = path.join(outputDir, session.sessionId.slice(0, 8));
        fs.mkdirSync(backupDir, { recursive: true });

        // Save metadata
        fs.writeFileSync(
            path.join(backupDir, 'session_meta.json'),
            JSON.stringify(session, null, 2)
        );

        // Copy chat history
        const chatFile = path.join(session._ws_dir, 'chatSessions', `${session.sessionId}.json`);
        if (fs.existsSync(chatFile)) {
            fs.copyFileSync(chatFile, path.join(backupDir, 'chat_history.json'));
        }

        // Copy editing session
        const editDir = path.join(session._ws_dir, 'chatEditingSessions', session.sessionId);
        if (fs.existsSync(editDir)) {
            this.copyDir(editDir, path.join(backupDir, 'editing_session'));
        }

        // Copy workspace.json
        const workspaceJson = path.join(session._ws_dir, 'workspace.json');
        if (fs.existsSync(workspaceJson)) {
            fs.copyFileSync(workspaceJson, path.join(backupDir, 'workspace.json'));
        }
    }

    private copyDir(src: string, dest: string): void {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                this.copyDir(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    /**
     * Convert a file:// URI to a file path (cross-platform compatible)
     */
    private uriToPath(uri: string): string {
        if (!uri) return '';
        
        try {
            // Use Node.js fileURLToPath for proper cross-platform conversion
            if (uri.startsWith('file://')) {
                return fileURLToPath(uri);
            }
            // Fallback for already-decoded paths
            return decodeURIComponent(uri.replace('file://', ''));
        } catch {
            // Fallback to simple decoding if fileURLToPath fails
            return decodeURIComponent(uri.replace('file://', '') || '');
        }
    }

    /**
     * Calculate similarity between two strings using a simple approach
     */
    private calculateStringSimilarity(str1: string, str2: string): number {
        if (!str1 || !str2) return 0;
        
        str1 = str1.toLowerCase();
        str2 = str2.toLowerCase();
        
        if (str1 === str2) return 1;
        
        // Calculate Jaccard similarity based on word tokens
        const words1 = new Set(str1.split(/\s+/));
        const words2 = new Set(str2.split(/\s+/));
        
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        
        // Guard against division by zero
        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    /**
     * Check if two date ranges overlap
     */
    private dateRangesOverlap(date1?: number, date2?: number, thresholdMs: number = 24 * 60 * 60 * 1000): boolean {
        if (!date1 || !date2) return false;
        return Math.abs(date1 - date2) < thresholdMs;
    }

    /**
     * Find sessions that are similar to the given session
     */
    async findSimilarSessions(sessionId: string): Promise<SessionSimilarity[]> {
        const allSessions = await this.listSessions();
        const targetSession = allSessions.find(s => s.sessionId === sessionId);
        
        if (!targetSession) {
            return [];
        }

        const similarities: SessionSimilarity[] = [];
        
        for (const session of allSessions) {
            if (session.sessionId === sessionId) continue;
            
            const reasons: string[] = [];
            let score = 0;
            
            // Title similarity (40% weight)
            if (targetSession.title && session.title) {
                const titleSim = this.calculateStringSimilarity(targetSession.title, session.title);
                if (titleSim > 0.3) {
                    score += titleSim * 0.4;
                    reasons.push(`Title similarity: ${(titleSim * 100).toFixed(0)}%`);
                }
            }
            
            // Date overlap (30% weight)
            if (this.dateRangesOverlap(targetSession.lastMessageDate, session.lastMessageDate)) {
                score += 0.3;
                reasons.push('Overlapping timeframe');
            }
            
            // Different workspace (30% weight) - sessions split across workspaces are candidates
            if (targetSession._workspace !== session._workspace && targetSession._workspace && session._workspace) {
                score += 0.3;
                reasons.push(`Different workspaces: ${targetSession._workspace} vs ${session._workspace}`);
            }
            
            if (score > 0.2) {
                similarities.push({ session, score, reasons });
            }
        }
        
        // Sort by score descending
        similarities.sort((a, b) => b.score - a.score);
        
        return similarities;
    }

    /**
     * Generate a preview of what would be merged
     */
    async getMergePreview(sourceSessionId: string, targetSessionId: string): Promise<MergePreview | null> {
        const allSessions = await this.listSessions();
        const source = allSessions.find(s => s.sessionId === sourceSessionId);
        const target = allSessions.find(s => s.sessionId === targetSessionId);
        
        if (!source || !target || !source._ws_dir || !target._ws_dir) {
            return null;
        }

        const conflicts: string[] = [];
        
        // Check chat history
        let sourceChatCount = 0;
        let targetChatCount = 0;
        
        const sourceChatFile = path.join(source._ws_dir, 'chatSessions', `${source.sessionId}.json`);
        const targetChatFile = path.join(target._ws_dir, 'chatSessions', `${target.sessionId}.json`);
        
        if (fs.existsSync(sourceChatFile)) {
            const data = JSON.parse(fs.readFileSync(sourceChatFile, 'utf8'));
            sourceChatCount = data.requests?.length || 0;
        }
        
        if (fs.existsSync(targetChatFile)) {
            const data = JSON.parse(fs.readFileSync(targetChatFile, 'utf8'));
            targetChatCount = data.requests?.length || 0;
        }
        
        // Check file edits
        let sourceFileCount = 0;
        let targetFileCount = 0;
        const sourceFiles = new Set<string>();
        const targetFiles = new Set<string>();
        
        const sourceEditDir = path.join(source._ws_dir, 'chatEditingSessions', source.sessionId);
        const targetEditDir = path.join(target._ws_dir, 'chatEditingSessions', target.sessionId);
        
        const sourceStateFile = path.join(sourceEditDir, 'state.json');
        const targetStateFile = path.join(targetEditDir, 'state.json');
        
        if (fs.existsSync(sourceStateFile)) {
            const state = JSON.parse(fs.readFileSync(sourceStateFile, 'utf8'));
            const entries: EditingSessionEntry[] = state.recentSnapshot?.entries || [];
            sourceFileCount = entries.length;
            entries.forEach((e) => {
                const filePath = this.uriToPath(e.resource || '');
                sourceFiles.add(filePath);
            });
        }
        
        if (fs.existsSync(targetStateFile)) {
            const state = JSON.parse(fs.readFileSync(targetStateFile, 'utf8'));
            const entries: EditingSessionEntry[] = state.recentSnapshot?.entries || [];
            targetFileCount = entries.length;
            entries.forEach((e) => {
                const filePath = this.uriToPath(e.resource || '');
                targetFiles.add(filePath);
                if (sourceFiles.has(filePath)) {
                    conflicts.push(`File exists in both sessions: ${filePath}`);
                }
            });
        }
        
        return {
            source,
            target,
            chatHistoryCount: {
                source: sourceChatCount,
                target: targetChatCount,
                merged: sourceChatCount + targetChatCount
            },
            fileEditsCount: {
                source: sourceFileCount,
                target: targetFileCount,
                merged: sourceFileCount + targetFileCount - conflicts.length
            },
            conflicts
        };
    }

    /**
     * Merge source session into target session
     */
    async mergeSessions(sourceSessionId: string, targetSessionId: string, backupDir: string): Promise<MergeResult> {
        if (!this.storagePath || !Database) {
            return { success: false, error: 'Database not available' };
        }

        const allSessions = await this.listSessions();
        const source = allSessions.find(s => s.sessionId === sourceSessionId);
        const target = allSessions.find(s => s.sessionId === targetSessionId);
        
        if (!source || !target || !source._ws_dir || !target._ws_dir) {
            return { success: false, error: 'Session not found' };
        }

        try {
            // Create backup
            const timestamp = Date.now();
            const backupPath = path.join(backupDir, `merge_backup_${timestamp}`);
            fs.mkdirSync(backupPath, { recursive: true });
            
            await this.backupSession(source.sessionId, backupPath);
            await this.backupSession(target.sessionId, backupPath);
            
            // Merge chat history
            const sourceChatFile = path.join(source._ws_dir, 'chatSessions', `${source.sessionId}.json`);
            const targetChatFile = path.join(target._ws_dir, 'chatSessions', `${target.sessionId}.json`);
            
            if (fs.existsSync(sourceChatFile) && fs.existsSync(targetChatFile)) {
                const sourceData = JSON.parse(fs.readFileSync(sourceChatFile, 'utf8'));
                const targetData = JSON.parse(fs.readFileSync(targetChatFile, 'utf8'));
                
                // Combine requests arrays and sort by timestamp
                const allRequests = [
                    ...(sourceData.requests || []),
                    ...(targetData.requests || [])
                ];
                
                // Deduplicate by request ID if present
                const seenIds = new Set<string>();
                const uniqueRequests = allRequests.filter(req => {
                    // Use request ID if available, otherwise create a composite key
                    // Include response state and agent info to reduce false duplicates
                    if (req.id) {
                        if (seenIds.has(req.id)) {
                            return false;
                        }
                        seenIds.add(req.id);
                        return true;
                    }
                    
                    // Fallback ID: timestamp + text hash + response type
                    const text = req.message?.text;
                    const textHash = typeof text === 'string' ? text.length + '_' + text.substring(0, 30) : 'empty';
                    const responseType = req.response?.value?.[0]?.kind || 'unknown';
                    const fallbackId = `${req.timestamp}_${textHash}_${responseType}`;
                    
                    if (seenIds.has(fallbackId)) {
                        return false;
                    }
                    seenIds.add(fallbackId);
                    return true;
                });
                
                // Sort by timestamp
                uniqueRequests.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                
                targetData.requests = uniqueRequests;
                
                // Update metadata
                if (sourceData.customTitle && !targetData.customTitle) {
                    targetData.customTitle = sourceData.customTitle;
                }
                
                fs.writeFileSync(targetChatFile, JSON.stringify(targetData, null, 2));
            }
            
            // Merge editing sessions
            const sourceEditDir = path.join(source._ws_dir, 'chatEditingSessions', source.sessionId);
            const targetEditDir = path.join(target._ws_dir, 'chatEditingSessions', target.sessionId);
            
            if (fs.existsSync(sourceEditDir) && fs.existsSync(targetEditDir)) {
                const sourceStateFile = path.join(sourceEditDir, 'state.json');
                const targetStateFile = path.join(targetEditDir, 'state.json');
                const sourceContentsDir = path.join(sourceEditDir, 'contents');
                const targetContentsDir = path.join(targetEditDir, 'contents');
                
                if (fs.existsSync(sourceStateFile) && fs.existsSync(targetStateFile)) {
                    const sourceState = JSON.parse(fs.readFileSync(sourceStateFile, 'utf8'));
                    const targetState = JSON.parse(fs.readFileSync(targetStateFile, 'utf8'));
                    
                    const sourceEntries: EditingSessionEntry[] = sourceState.recentSnapshot?.entries || [];
                    const targetEntries: EditingSessionEntry[] = targetState.recentSnapshot?.entries || [];
                    
                    // Merge entries, keeping newest currentHash for duplicates
                    const fileMap = new Map<string, EditingSessionEntry>();
                    
                    targetEntries.forEach((entry) => {
                        const filePath = this.uriToPath(entry.resource || '');
                        fileMap.set(filePath, entry);
                    });
                    
                    sourceEntries.forEach((entry) => {
                        const filePath = this.uriToPath(entry.resource || '');
                        const existing = fileMap.get(filePath);
                        
                        // Conflict resolution: prefer source entry when hashes differ
                        // This assumes user is merging older sessions into a newer target
                        // TODO: Could be enhanced with timestamp-based resolution
                        if (!existing || entry.currentHash !== existing.currentHash) {
                            fileMap.set(filePath, entry);
                            
                            // Copy content file
                            if (fs.existsSync(sourceContentsDir) && entry.currentHash) {
                                const sourceContentFile = path.join(sourceContentsDir, entry.currentHash);
                                const targetContentFile = path.join(targetContentsDir, entry.currentHash);
                                
                                if (fs.existsSync(sourceContentFile) && !fs.existsSync(targetContentFile)) {
                                    fs.mkdirSync(targetContentsDir, { recursive: true });
                                    fs.copyFileSync(sourceContentFile, targetContentFile);
                                }
                            }
                            
                            if (entry.originalHash && fs.existsSync(sourceContentsDir)) {
                                const sourceContentFile = path.join(sourceContentsDir, entry.originalHash);
                                const targetContentFile = path.join(targetContentsDir, entry.originalHash);
                                
                                if (fs.existsSync(sourceContentFile) && !fs.existsSync(targetContentFile)) {
                                    fs.mkdirSync(targetContentsDir, { recursive: true });
                                    fs.copyFileSync(sourceContentFile, targetContentFile);
                                }
                            }
                        }
                    });
                    
                    if (!targetState.recentSnapshot) {
                        targetState.recentSnapshot = {};
                    }
                    targetState.recentSnapshot.entries = Array.from(fileMap.values());
                    
                    fs.writeFileSync(targetStateFile, JSON.stringify(targetState, null, 2));
                }
            }
            
            // Update session index in target workspace
            const targetDbPath = path.join(target._ws_dir, 'state.vscdb');
            const targetIndex = this.getSessionIndex(targetDbPath);
            
            if (targetIndex?.entries && targetIndex.entries[target.sessionId]) {
                // Update file count and pending edits flag
                const targetSession = targetIndex.entries[target.sessionId];
                const targetStateFile = path.join(targetEditDir, 'state.json');
                
                if (fs.existsSync(targetStateFile)) {
                    const state = JSON.parse(fs.readFileSync(targetStateFile, 'utf8'));
                    const entries: EditingSessionEntry[] = state.recentSnapshot?.entries || [];
                    const hasChanges = entries.some((e) => e.originalHash !== e.currentHash);
                    
                    if (!targetSession.stats) {
                        targetSession.stats = {};
                    }
                    targetSession.stats.fileCount = entries.length;
                    targetSession.hasPendingEdits = hasChanges;
                }
                
                // Update request count
                const targetChatFile = path.join(target._ws_dir, 'chatSessions', `${target.sessionId}.json`);
                if (fs.existsSync(targetChatFile)) {
                    const data = JSON.parse(fs.readFileSync(targetChatFile, 'utf8'));
                    if (!targetSession.stats) {
                        targetSession.stats = {};
                    }
                    targetSession.stats.requestCount = data.requests?.length || 0;
                }
                
                // Write back to database
                const db = new Database(targetDbPath);
                db.prepare(
                    "UPDATE ItemTable SET value = ? WHERE key = 'chat.ChatSessionStore.index'"
                ).run(JSON.stringify(targetIndex));
                db.close();
            }
            
            return { success: true, backupPath };
            
        } catch (error) {
            console.error('Merge failed:', error);
            return { success: false, error: String(error) };
        }
    }
}
