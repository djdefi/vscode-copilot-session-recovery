import * as vscode from 'vscode';
import { SessionRecovery, PendingFile } from './sessionRecovery';

export interface PendingFileItem {
    filePath: string;
    fileName: string;
    sessionId: string;
    sessionTitle: string;
    currentHash: string;
    originalHash?: string;
    workspace?: string;
}

export class PendingFileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly file: PendingFileItem,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(file.fileName, collapsibleState);
        
        this.description = this.getShortPath();
        this.tooltip = this.buildTooltip();
        this.contextValue = 'pendingFile';
        this.iconPath = this.getIcon();
        
        this.command = {
            command: 'copilot-recovery.diffFile',
            title: 'View Diff',
            arguments: [{
                filePath: file.filePath,
                sessionId: file.sessionId,
                currentHash: file.currentHash,
                originalHash: file.originalHash
            }]
        };
    }

    private getShortPath(): string {
        const parts = this.file.filePath.split('/');
        if (parts.length > 3) {
            return `.../${parts.slice(-2).join('/')}`;
        }
        return this.file.filePath;
    }

    private buildTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${this.file.fileName}**\n\n`);
        md.appendMarkdown(`- Path: \`${this.file.filePath}\`\n`);
        md.appendMarkdown(`- Session: ${this.file.sessionTitle}\n`);
        md.appendMarkdown(`- Click to view diff\n`);
        return md;
    }

    private getIcon(): vscode.ThemeIcon {
        const ext = this.file.fileName.split('.').pop()?.toLowerCase() || '';
        const iconMap: { [key: string]: string } = {
            'ts': 'symbol-method',
            'tsx': 'symbol-method',
            'js': 'symbol-method',
            'jsx': 'symbol-method',
            'py': 'symbol-method',
            'rb': 'ruby',
            'go': 'symbol-method',
            'rs': 'symbol-method',
            'java': 'symbol-method',
            'md': 'markdown',
            'json': 'json',
            'yaml': 'symbol-namespace',
            'yml': 'symbol-namespace',
            'html': 'symbol-misc',
            'css': 'symbol-color',
            'sh': 'terminal',
            'bash': 'terminal'
        };
        return new vscode.ThemeIcon(iconMap[ext] || 'file', new vscode.ThemeColor('editorWarning.foreground'));
    }
}

export class SessionGroupItem extends vscode.TreeItem {
    constructor(
        public readonly sessionId: string,
        public readonly sessionTitle: string,
        public readonly files: PendingFileItem[],
        public readonly workspace: string
    ) {
        super(sessionTitle, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${files.length} pending`;
        this.tooltip = `${sessionTitle}\n${files.length} files with pending changes`;
        this.iconPath = new vscode.ThemeIcon('edit', new vscode.ThemeColor('editorWarning.foreground'));
        this.contextValue = 'sessionGroup';
    }
}

export class PendingFilesProvider implements vscode.TreeDataProvider<PendingFileTreeItem | SessionGroupItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PendingFileTreeItem | SessionGroupItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private files: PendingFileItem[] = [];

    constructor(private recovery: SessionRecovery) {
        this.loadFiles();
    }

    refresh(): void {
        this.loadFiles();
        this._onDidChangeTreeData.fire(undefined);
    }

    private async loadFiles(): Promise<void> {
        try {
            const allFiles = await this.recovery.getAllPendingFiles();
            this.files = allFiles.map(f => ({
                filePath: f.path,
                fileName: f.path.split('/').pop() || f.path,
                sessionId: f.sessionId,
                sessionTitle: f.sessionTitle,
                currentHash: f.currentHash || '',
                originalHash: f.originalHash
            }));
        } catch (error) {
            console.error('Failed to load pending files:', error);
            this.files = [];
        }
    }

    getTreeItem(element: PendingFileTreeItem | SessionGroupItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PendingFileTreeItem | SessionGroupItem): Promise<(PendingFileTreeItem | SessionGroupItem)[]> {
        if (!element) {
            // Root level - group by session
            await this.loadFiles();
            
            const bySession = new Map<string, PendingFileItem[]>();
            for (const file of this.files) {
                if (!bySession.has(file.sessionId)) {
                    bySession.set(file.sessionId, []);
                }
                bySession.get(file.sessionId)!.push(file);
            }
            
            return Array.from(bySession.entries()).map(
                ([sessionId, files]) => new SessionGroupItem(
                    sessionId,
                    files[0]?.sessionTitle || 'Untitled',
                    files,
                    files[0]?.workspace || ''
                )
            );
        }

        if (element instanceof SessionGroupItem) {
            return element.files.map(
                f => new PendingFileTreeItem(f, vscode.TreeItemCollapsibleState.None)
            );
        }

        return [];
    }

    getFileCount(): number {
        return this.files.length;
    }
}
