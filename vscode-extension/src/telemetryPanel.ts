import * as vscode from 'vscode';
import { SessionTelemetry, LiveSessionMetrics } from './sessionTelemetry';

export class TelemetryPanel {
    public static currentPanel: TelemetryPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly telemetry: SessionTelemetry;
    private disposables: vscode.Disposable[] = [];
    private refreshInterval: NodeJS.Timeout | null = null;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.telemetry = new SessionTelemetry();

        // Set initial HTML
        this.updatePanel();

        // Auto-refresh every 5 seconds
        this.refreshInterval = setInterval(() => {
            this.updatePanel();
        }, 5000);

        // Handle disposal
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'refresh':
                        this.updatePanel();
                        break;
                    case 'newSession':
                        vscode.commands.executeCommand('workbench.action.chat.newChat');
                        break;
                    case 'showDashboard':
                        vscode.commands.executeCommand('copilot-recovery.showDashboard');
                        break;
                    case 'fixStuck':
                        vscode.commands.executeCommand('copilot-recovery.fixAllStuck');
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.ViewColumn.Beside;

        if (TelemetryPanel.currentPanel) {
            TelemetryPanel.currentPanel.panel.reveal(column);
            TelemetryPanel.currentPanel.updatePanel();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'copilotTelemetry',
            'Copilot Session Telemetry',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        TelemetryPanel.currentPanel = new TelemetryPanel(panel, extensionUri);
    }

    private async updatePanel() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.name;
        const activeMetrics = await this.telemetry.getActiveSessionMetrics(workspaceFolder);
        const globalMetrics = await this.telemetry.getGlobalMetrics();

        this.panel.webview.html = this.getHtmlContent(activeMetrics, globalMetrics);
    }

    private getHtmlContent(
        activeMetrics: LiveSessionMetrics | null,
        globalMetrics: {
            totalSessions: number;
            activeSessions: number;
            totalStorageUsed: number;
            stuckSessions: number;
            totalPendingFiles: number;
            avgContextUtilization: number;
            topWorkspaces: Array<{ name: string; sessions: number; size: number }>;
        }
    ): string {
        const activeSession = activeMetrics ? this.renderActiveSession(activeMetrics) : `
            <div class="card empty">
                <h3>No Active Session</h3>
                <p>Start a Copilot chat to see real-time telemetry</p>
                <button onclick="vscode.postMessage({command: 'newSession'})">
                    Start New Chat
                </button>
            </div>
        `;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Copilot Session Telemetry</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --fg-color: var(--vscode-editor-foreground);
            --card-bg: var(--vscode-editorWidget-background);
            --border-color: var(--vscode-editorWidget-border);
            --accent: var(--vscode-button-background);
            --success: #4caf50;
            --warning: #ff9800;
            --danger: #f44336;
        }

        body {
            font-family: var(--vscode-font-family);
            background: var(--bg-color);
            color: var(--fg-color);
            padding: 20px;
            margin: 0;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        .header h1 {
            margin: 0;
            font-size: 1.5em;
        }

        .refresh-btn {
            background: var(--accent);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
        }

        .refresh-btn:hover {
            opacity: 0.9;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
        }

        .card.empty {
            text-align: center;
            padding: 40px;
        }

        .card h3 {
            margin: 0 0 16px 0;
            font-size: 1.1em;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
        }

        .metric {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }

        .metric-value {
            font-weight: bold;
            font-family: var(--vscode-editor-font-family);
        }

        .progress-container {
            margin: 16px 0;
        }

        .progress-bar {
            height: 20px;
            background: var(--vscode-input-background);
            border-radius: 10px;
            overflow: hidden;
            position: relative;
        }

        .progress-fill {
            height: 100%;
            border-radius: 10px;
            transition: width 0.3s ease;
        }

        .progress-fill.healthy { background: var(--success); }
        .progress-fill.warning { background: var(--warning); }
        .progress-fill.critical { background: var(--danger); }

        .progress-label {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 0.9em;
            font-weight: bold;
        }

        .health-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: bold;
        }

        .health-badge.healthy { background: var(--success); color: white; }
        .health-badge.warning { background: var(--warning); color: black; }
        .health-badge.critical { background: var(--danger); color: white; }

        .warnings-list {
            margin: 12px 0;
            padding: 0;
            list-style: none;
        }

        .warnings-list li {
            padding: 8px 12px;
            margin: 4px 0;
            background: rgba(255, 152, 0, 0.2);
            border-left: 3px solid var(--warning);
            border-radius: 4px;
        }

        .recommendations-list {
            margin: 12px 0;
            padding: 0;
            list-style: none;
        }

        .recommendations-list li {
            padding: 8px 12px;
            margin: 4px 0;
            background: rgba(76, 175, 80, 0.2);
            border-left: 3px solid var(--success);
            border-radius: 4px;
        }

        .stat-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-top: 16px;
        }

        .stat-box {
            text-align: center;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 8px;
        }

        .stat-value {
            font-size: 1.8em;
            font-weight: bold;
            color: var(--accent);
        }

        .stat-label {
            font-size: 0.8em;
            opacity: 0.8;
            margin-top: 4px;
        }

        .workspace-list {
            max-height: 200px;
            overflow-y: auto;
        }

        .workspace-item {
            display: flex;
            justify-content: space-between;
            padding: 8px;
            border-bottom: 1px solid var(--border-color);
        }

        .workspace-item:last-child {
            border-bottom: none;
        }

        .action-buttons {
            display: flex;
            gap: 8px;
            margin-top: 16px;
        }

        button {
            background: var(--accent);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }

        button:hover {
            opacity: 0.9;
        }

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .live-indicator {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            color: var(--success);
        }

        .live-dot {
            width: 8px;
            height: 8px;
            background: var(--success);
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .timestamp {
            font-size: 0.8em;
            opacity: 0.7;
            text-align: right;
            margin-top: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Copilot Session Telemetry</h1>
        <div style="display: flex; gap: 10px; align-items: center;">
            <span class="live-indicator"><span class="live-dot"></span> Live</span>
            <button class="refresh-btn" onclick="vscode.postMessage({command: 'refresh'})">
                ↻ Refresh
            </button>
        </div>
    </div>

    <div class="grid">
        ${activeSession}

        <div class="card">
            <h3>🌐 Global Overview</h3>
            <div class="stat-grid">
                <div class="stat-box">
                    <div class="stat-value">${globalMetrics.totalSessions}</div>
                    <div class="stat-label">Total Sessions</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${globalMetrics.activeSessions}</div>
                    <div class="stat-label">Active (5m)</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${(globalMetrics.totalStorageUsed / (1024 * 1024)).toFixed(1)}M</div>
                    <div class="stat-label">Storage</div>
                </div>
            </div>
            <div class="stat-grid" style="margin-top: 12px;">
                <div class="stat-box">
                    <div class="stat-value" style="color: ${globalMetrics.stuckSessions > 0 ? 'var(--danger)' : 'var(--success)'}">${globalMetrics.stuckSessions}</div>
                    <div class="stat-label">Stuck</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${globalMetrics.totalPendingFiles}</div>
                    <div class="stat-label">Pending Files</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${globalMetrics.avgContextUtilization}%</div>
                    <div class="stat-label">Avg Context</div>
                </div>
            </div>
            
            ${globalMetrics.stuckSessions > 0 ? `
                <div class="action-buttons">
                    <button onclick="vscode.postMessage({command: 'fixStuck'})">
                        🔧 Fix ${globalMetrics.stuckSessions} Stuck Sessions
                    </button>
                </div>
            ` : ''}
        </div>
    </div>

    <div class="card">
        <h3>📁 Top Workspaces by Usage</h3>
        <div class="workspace-list">
            ${globalMetrics.topWorkspaces.map(ws => `
                <div class="workspace-item">
                    <span>${ws.name}</span>
                    <span>
                        <strong>${ws.sessions}</strong> sessions · 
                        ${(ws.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                </div>
            `).join('')}
        </div>
    </div>

    <div class="action-buttons" style="margin-top: 20px;">
        <button onclick="vscode.postMessage({command: 'showDashboard'})">
            📊 Open Full Dashboard
        </button>
        <button class="secondary" onclick="vscode.postMessage({command: 'newSession'})">
            ➕ New Chat Session
        </button>
    </div>

    <div class="timestamp">
        Last updated: ${new Date().toLocaleTimeString()}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
    </script>
</body>
</html>`;
    }

    private renderActiveSession(metrics: LiveSessionMetrics): string {
        const ctx = metrics.tokens;
        const health = metrics.health;
        
        const progressClass = ctx.contextUtilization > 80 ? 'critical' : 
                             ctx.contextUtilization > 60 ? 'warning' : 'healthy';

        return `
        <div class="card">
            <h3>🎯 Active Session: ${metrics.title}</h3>
            <p style="opacity: 0.8; margin-bottom: 16px;">${metrics.workspace}</p>
            
            <div class="progress-container">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span>Context Window</span>
                    <span><strong>${ctx.totalTokens.toLocaleString()}</strong> / ${ctx.contextLimit.toLocaleString()} tokens</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill ${progressClass}" style="width: ${ctx.contextUtilization}%"></div>
                    <span class="progress-label">${ctx.contextUtilization}%</span>
                </div>
            </div>

            <div class="metric">
                <span>Messages</span>
                <span class="metric-value">${metrics.requests.totalRequests}</span>
            </div>
            <div class="metric">
                <span>Successful / Failed</span>
                <span class="metric-value">${metrics.requests.successfulRequests} / ${metrics.requests.failedRequests}</span>
            </div>
            <div class="metric">
                <span>Pending Edits</span>
                <span class="metric-value">${metrics.pendingEditsCount} files</span>
            </div>
            <div class="metric">
                <span>Session Age</span>
                <span class="metric-value">${this.formatDuration(ctx.sessionAge)}</span>
            </div>
            <div class="metric">
                <span>History Size</span>
                <span class="metric-value">${(metrics.chatHistorySize / 1024).toFixed(1)} KB</span>
            </div>

            <div style="margin-top: 16px;">
                <span>Health Score: </span>
                <span class="health-badge ${health.status}">${health.score}/100</span>
            </div>

            ${health.warnings.length > 0 ? `
                <ul class="warnings-list">
                    ${health.warnings.map(w => `<li>${w}</li>`).join('')}
                </ul>
            ` : ''}

            ${health.recommendations.length > 0 ? `
                <ul class="recommendations-list">
                    ${health.recommendations.map(r => `<li>💡 ${r}</li>`).join('')}
                </ul>
            ` : ''}

            ${ctx.contextUtilization > 70 ? `
                <div class="action-buttons">
                    <button onclick="vscode.postMessage({command: 'newSession'})">
                        🆕 Start Fresh Session
                    </button>
                </div>
            ` : ''}
        </div>
        `;
    }

    private formatDuration(minutes: number): string {
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        if (hours < 24) return `${hours}h ${mins}m`;
        const days = Math.floor(hours / 24);
        return `${days}d ${hours % 24}h`;
    }

    public dispose() {
        TelemetryPanel.currentPanel = undefined;
        
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }

        this.panel.dispose();

        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }
}
