import * as vscode from 'vscode';
import { SessionRecovery, SessionInfo } from './sessionRecovery';

export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly recovery: SessionRecovery
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            null,
            this._disposables
        );
        this.update();
    }

    public static async createOrShow(recovery: SessionRecovery) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(column);
            await DashboardPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'copilotRecoveryDashboard',
            '📊 Copilot Recovery Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(panel, recovery);
    }

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'fixSession':
                const fixed = await this.recovery.fixSession(message.sessionId);
                if (fixed) {
                    vscode.window.showInformationMessage('Session fixed! Reload VS Code.');
                    this.update();
                }
                break;
            case 'fixAllStuck':
                const count = await this.recovery.fixAllStuck();
                vscode.window.showInformationMessage(`Fixed ${count} sessions. Reload VS Code.`);
                this.update();
                break;
            case 'exportSession':
                vscode.commands.executeCommand('copilot-recovery.exportSession', { session: { sessionId: message.sessionId } });
                break;
            case 'viewSession':
                vscode.commands.executeCommand('copilot-recovery.showSession', { session: { sessionId: message.sessionId } });
                break;
            case 'selectiveRecover':
                vscode.commands.executeCommand('copilot-recovery.selectiveRecover', { session: { sessionId: message.sessionId } });
                break;
            case 'deleteSession':
                const confirmed = await vscode.window.showWarningMessage(
                    `Delete session ${message.sessionId.slice(0, 8)}? This cannot be undone.`,
                    { modal: true },
                    'Delete'
                );
                if (confirmed === 'Delete') {
                    const deleted = await this.recovery.deleteSession(message.sessionId);
                    if (deleted) {
                        vscode.window.showInformationMessage('Session deleted');
                        this.update();
                    }
                }
                break;
            case 'refresh':
                this.update();
                break;
        }
    }

    private async update() {
        const stats = await this.recovery.analyzeStorage();
        const sessions = await this.recovery.listSessions();
        
        // Group sessions by workspace
        const byWorkspace = new Map<string, SessionInfo[]>();
        for (const session of sessions) {
            const ws = session._workspace || 'Unknown';
            if (!byWorkspace.has(ws)) {
                byWorkspace.set(ws, []);
            }
            byWorkspace.get(ws)!.push(session);
        }

        const stuckSessions = sessions.filter(s => s.lastResponseState === 3);
        const streamingSessions = sessions.filter(s => s.lastResponseState === 2);
        const withPendingEdits = sessions.filter(s => s.hasPendingEdits);

        this._panel.webview.html = this.getHtml(stats, sessions, byWorkspace, stuckSessions, streamingSessions, withPendingEdits);
    }

    private getHtml(
        stats: any,
        sessions: SessionInfo[],
        byWorkspace: Map<string, SessionInfo[]>,
        stuckSessions: SessionInfo[],
        streamingSessions: SessionInfo[],
        withPendingEdits: SessionInfo[]
    ): string {
        const totalSizeMB = (stats.totalSize / 1024 / 1024).toFixed(1);
        const usagePercent = Math.min(100, (stats.totalSize / (1024 * 1024 * 1024)) * 100);
        const usageColor = usagePercent > 80 ? '#e74c3c' : usagePercent > 50 ? '#f39c12' : '#27ae60';

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --border: var(--vscode-panel-border);
            --accent: var(--vscode-button-background);
            --error: #e74c3c;
            --warning: #f39c12;
            --success: #27ae60;
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--text-primary);
            background: var(--bg-primary);
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 { 
            font-size: 24px; 
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        h2 { 
            font-size: 18px; 
            margin: 24px 0 12px; 
            border-bottom: 1px solid var(--border);
            padding-bottom: 8px;
        }
        .header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .refresh-btn {
            background: var(--accent);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .refresh-btn:hover {
            opacity: 0.9;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: var(--bg-secondary);
            padding: 16px;
            border-radius: 8px;
            border: 1px solid var(--border);
        }
        .stat-card.error {
            border-color: var(--error);
            background: rgba(231, 76, 60, 0.1);
        }
        .stat-card.warning {
            border-color: var(--warning);
            background: rgba(243, 156, 18, 0.1);
        }
        .stat-value {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        .stat-label {
            color: var(--text-secondary);
            font-size: 13px;
        }
        .progress-bar {
            height: 8px;
            background: var(--border);
            border-radius: 4px;
            margin-top: 8px;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            border-radius: 4px;
            transition: width 0.3s;
        }
        .session-list {
            background: var(--bg-secondary);
            border-radius: 8px;
            border: 1px solid var(--border);
            overflow: hidden;
        }
        .session-item {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .session-item:last-child {
            border-bottom: none;
        }
        .session-item:hover {
            background: rgba(255,255,255,0.05);
        }
        .session-icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
        }
        .session-info {
            flex: 1;
            min-width: 0;
        }
        .session-title {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-meta {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        .session-actions {
            display: flex;
            gap: 8px;
        }
        .action-btn {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
        }
        .action-btn:hover {
            background: var(--accent);
            border-color: var(--accent);
        }
        .action-btn.primary {
            background: var(--accent);
            border-color: var(--accent);
        }
        .action-btn.danger {
            border-color: var(--error);
            color: var(--error);
        }
        .action-btn.danger:hover {
            background: var(--error);
            color: white;
        }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
        }
        .badge-error { background: var(--error); color: white; }
        .badge-warning { background: var(--warning); color: white; }
        .badge-success { background: var(--success); color: white; }
        .workspace-group {
            margin-bottom: 24px;
        }
        .workspace-header {
            font-size: 14px;
            font-weight: 600;
            padding: 8px 0;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--text-secondary);
        }
        .tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--border);
            padding-bottom: 8px;
        }
        .tab {
            padding: 8px 16px;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            border-radius: 4px 4px 0 0;
            font-size: 13px;
        }
        .tab.active {
            background: var(--accent);
            color: var(--vscode-button-foreground);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .size-badge {
            font-size: 11px;
            color: var(--text-secondary);
            background: var(--border);
            padding: 2px 6px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="header-row">
        <h1>📊 Copilot Recovery Dashboard</h1>
        <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
    </div>

    <div class="stats-grid">
        <div class="stat-card">
            <div class="stat-value">${sessions.length}</div>
            <div class="stat-label">Total Sessions</div>
        </div>
        <div class="stat-card ${stuckSessions.length > 0 ? 'error' : ''}">
            <div class="stat-value" style="color: ${stuckSessions.length > 0 ? 'var(--error)' : 'inherit'}">${stuckSessions.length}</div>
            <div class="stat-label">Stuck Sessions ⚠️</div>
            ${stuckSessions.length > 0 ? '<button class="action-btn primary" style="margin-top:8px" onclick="fixAllStuck()">Fix All</button>' : ''}
        </div>
        <div class="stat-card ${streamingSessions.length > 0 ? 'warning' : ''}">
            <div class="stat-value" style="color: ${streamingSessions.length > 0 ? 'var(--warning)' : 'inherit'}">${streamingSessions.length}</div>
            <div class="stat-label">Streaming (Frozen)</div>
        </div>
        <div class="stat-card ${withPendingEdits.length > 0 ? 'warning' : ''}">
            <div class="stat-value">${withPendingEdits.length}</div>
            <div class="stat-label">Pending Edits ✏️</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${totalSizeMB} MB</div>
            <div class="stat-label">Total Storage</div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${usagePercent}%; background: ${usageColor}"></div>
            </div>
            <div class="stat-label" style="margin-top:4px">${usagePercent.toFixed(1)}% of 1GB warning threshold</div>
        </div>
    </div>

    <div class="tabs">
        <button class="tab active" onclick="showTab('problems')">⚠️ Problems (${stuckSessions.length + streamingSessions.length})</button>
        <button class="tab" onclick="showTab('pending')">✏️ Pending Edits (${withPendingEdits.length})</button>
        <button class="tab" onclick="showTab('all')">📁 All Sessions</button>
        <button class="tab" onclick="showTab('largest')">💾 Largest</button>
    </div>

    <div id="problems" class="tab-content active">
        <h2>🚨 Sessions Needing Attention</h2>
        ${stuckSessions.length === 0 && streamingSessions.length === 0 ? 
            '<div class="empty-state">✅ No stuck or frozen sessions!</div>' :
            `<div class="session-list">
                ${stuckSessions.map(s => this.renderSessionItem(s, 'stuck')).join('')}
                ${streamingSessions.map(s => this.renderSessionItem(s, 'streaming')).join('')}
            </div>`
        }
    </div>

    <div id="pending" class="tab-content">
        <h2>✏️ Sessions with Pending Edits</h2>
        ${withPendingEdits.length === 0 ? 
            '<div class="empty-state">No pending edits</div>' :
            `<div class="session-list">
                ${withPendingEdits.map(s => this.renderSessionItem(s, 'pending')).join('')}
            </div>`
        }
    </div>

    <div id="all" class="tab-content">
        <h2>📁 All Sessions by Workspace</h2>
        ${Array.from(byWorkspace.entries()).map(([ws, sessions]) => `
            <div class="workspace-group">
                <div class="workspace-header">📂 ${ws} <span class="size-badge">${sessions.length} sessions</span></div>
                <div class="session-list">
                    ${sessions.slice(0, 20).map(s => this.renderSessionItem(s, 'normal')).join('')}
                    ${sessions.length > 20 ? `<div class="session-item"><em>... and ${sessions.length - 20} more</em></div>` : ''}
                </div>
            </div>
        `).join('')}
    </div>

    <div id="largest" class="tab-content">
        <h2>💾 Largest Sessions</h2>
        <div class="session-list">
            ${stats.largestSessions.slice(0, 15).map((s: any) => {
                const sizeMB = (s.size / 1024 / 1024).toFixed(1);
                const session = sessions.find(sess => sess.sessionId === s.sessionId);
                return `
                    <div class="session-item">
                        <span class="session-icon">💾</span>
                        <div class="session-info">
                            <div class="session-title">${s.title}</div>
                            <div class="session-meta">${sizeMB} MB • ${session?._workspace || 'Unknown'}</div>
                        </div>
                        <div class="session-actions">
                            <button class="action-btn" onclick="viewSession('${s.sessionId}')">View</button>
                            <button class="action-btn" onclick="exportSession('${s.sessionId}')">Export</button>
                            <button class="action-btn danger" onclick="deleteSession('${s.sessionId}')">Delete</button>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function showTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelector('#' + tabId).classList.add('active');
            event.target.classList.add('active');
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function fixSession(sessionId) {
            vscode.postMessage({ command: 'fixSession', sessionId });
        }
        
        function fixAllStuck() {
            vscode.postMessage({ command: 'fixAllStuck' });
        }
        
        function viewSession(sessionId) {
            vscode.postMessage({ command: 'viewSession', sessionId });
        }
        
        function exportSession(sessionId) {
            vscode.postMessage({ command: 'exportSession', sessionId });
        }
        
        function selectiveRecover(sessionId) {
            vscode.postMessage({ command: 'selectiveRecover', sessionId });
        }
        
        function deleteSession(sessionId) {
            vscode.postMessage({ command: 'deleteSession', sessionId });
        }
    </script>
</body>
</html>`;
    }

    private renderSessionItem(session: SessionInfo, type: string): string {
        const icon = type === 'stuck' ? '🔴' : type === 'streaming' ? '🟡' : type === 'pending' ? '📝' : '💬';
        const badge = type === 'stuck' ? '<span class="badge badge-error">STUCK</span>' : 
                      type === 'streaming' ? '<span class="badge badge-warning">FROZEN</span>' : 
                      session.hasPendingEdits ? '<span class="badge badge-warning">EDITS</span>' : '';
        
        return `
            <div class="session-item">
                <span class="session-icon">${icon}</span>
                <div class="session-info">
                    <div class="session-title">${session.title || 'Untitled'} ${badge}</div>
                    <div class="session-meta">${session.sessionId.slice(0, 8)} • ${session._workspace || 'Unknown'}</div>
                </div>
                <div class="session-actions">
                    ${type === 'stuck' ? `<button class="action-btn primary" onclick="fixSession('${session.sessionId}')">🔧 Fix</button>` : ''}
                    ${session.hasPendingEdits ? `<button class="action-btn" onclick="selectiveRecover('${session.sessionId}')">📋 Recover Files</button>` : ''}
                    <button class="action-btn" onclick="viewSession('${session.sessionId}')">View</button>
                    <button class="action-btn" onclick="exportSession('${session.sessionId}')">Export</button>
                </div>
            </div>
        `;
    }

    public dispose() {
        DashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
