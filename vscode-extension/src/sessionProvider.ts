import * as vscode from 'vscode';
import { SessionRecovery, SessionInfo } from './sessionRecovery';

export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: SessionInfo,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(session.title || 'Untitled', collapsibleState);
        
        this.description = `${session.sessionId.slice(0, 8)}`;
        this.tooltip = this.buildTooltip();
        this.contextValue = this.getContextValue();
        this.iconPath = this.getIcon();
        
        this.command = {
            command: 'copilot-recovery.showSession',
            title: 'Show Details',
            arguments: [this]
        };
    }

    private buildTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${this.session.title || 'Untitled'}**\n\n`);
        md.appendMarkdown(`- ID: \`${this.session.sessionId}\`\n`);
        md.appendMarkdown(`- State: ${this.getStateName()}\n`);
        md.appendMarkdown(`- Pending Edits: ${this.session.hasPendingEdits ? 'Yes' : 'No'}\n`);
        if (this.session.stats) {
            md.appendMarkdown(`- Files: ${this.session.stats.fileCount || 0}\n`);
        }
        return md;
    }

    private getContextValue(): string {
        if (this.session.lastResponseState === 3) {
            return 'session-stuck';
        }
        if (this.session.hasPendingEdits) {
            return 'session-with-edits';
        }
        return 'session';
    }

    private getStateName(): string {
        const states: { [key: number]: string } = {
            0: 'pending',
            1: 'success',
            2: 'streaming',
            3: 'error/stuck'
        };
        return states[this.session.lastResponseState] || 'unknown';
    }

    private getIcon(): vscode.ThemeIcon {
        if (this.session.lastResponseState === 3) {
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        }
        if (this.session.hasPendingEdits) {
            return new vscode.ThemeIcon('edit', new vscode.ThemeColor('editorWarning.foreground'));
        }
        if (this.session.lastResponseState === 1) {
            return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        }
        return new vscode.ThemeIcon('comment-discussion');
    }
}

export class WorkspaceItem extends vscode.TreeItem {
    constructor(
        public readonly workspaceName: string,
        public readonly workspaceDir: string,
        public readonly sessions: SessionInfo[]
    ) {
        super(workspaceName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${sessions.length} sessions`;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'workspace';
    }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem | WorkspaceItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | WorkspaceItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sessions: SessionInfo[] = [];
    private groupByWorkspace = true;

    constructor(private recovery: SessionRecovery) {
        this.loadSessions();
    }

    refresh(): void {
        this.loadSessions();
        this._onDidChangeTreeData.fire(undefined);
    }

    private async loadSessions(): Promise<void> {
        try {
            this.sessions = await this.recovery.listSessions();
        } catch (error) {
            console.error('Failed to load sessions:', error);
            this.sessions = [];
        }
    }

    getTreeItem(element: SessionItem | WorkspaceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionItem | WorkspaceItem): Promise<(SessionItem | WorkspaceItem)[]> {
        if (!element) {
            // Root level
            await this.loadSessions();
            
            if (this.groupByWorkspace) {
                // Group by workspace
                const byWorkspace = new Map<string, SessionInfo[]>();
                for (const session of this.sessions) {
                    const ws = session._workspace || 'Unknown';
                    if (!byWorkspace.has(ws)) {
                        byWorkspace.set(ws, []);
                    }
                    byWorkspace.get(ws)!.push(session);
                }
                
                return Array.from(byWorkspace.entries()).map(
                    ([name, sessions]) => new WorkspaceItem(name, sessions[0]?._ws_dir || '', sessions)
                );
            } else {
                // Flat list
                return this.sessions.slice(0, 50).map(
                    s => new SessionItem(s, vscode.TreeItemCollapsibleState.None)
                );
            }
        }

        if (element instanceof WorkspaceItem) {
            return element.sessions.map(
                s => new SessionItem(s, vscode.TreeItemCollapsibleState.None)
            );
        }

        return [];
    }
}
