import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem } from './sessionProvider';
import { SessionRecovery } from './sessionRecovery';

export function activate(context: vscode.ExtensionContext) {
    console.log('Copilot Session Recovery is now active');

    const recovery = new SessionRecovery();
    const treeProvider = new SessionTreeProvider(recovery);

    // Register tree view
    const treeView = vscode.window.createTreeView('copilotRecovery.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Status bar item for backup status
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'copilot-recovery.showBackupStatus';
    context.subscriptions.push(statusBarItem);

    // Auto-backup timer state
    let autoBackupTimer: NodeJS.Timeout | undefined;

    // Function to update status bar
    function updateStatusBar() {
        const lastBackup = context.globalState.get<number>('lastBackupTimestamp');
        if (lastBackup) {
            const date = new Date(lastBackup);
            const timeStr = date.toLocaleTimeString();
            statusBarItem.text = `$(archive) Last backup: ${timeStr}`;
            statusBarItem.tooltip = `Last automatic backup: ${date.toLocaleString()}`;
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    // Function to perform auto-backup
    async function performAutoBackup() {
        const config = vscode.workspace.getConfiguration('copilot-recovery.autoBackup');
        const enabled = config.get<boolean>('enabled', false);
        
        if (!enabled) {
            return;
        }

        let backupLocation = config.get<string>('location', '');
        
        // Use default location if not specified
        if (!backupLocation) {
            const homeDir = os.homedir();
            backupLocation = path.join(homeDir, '.copilot-session-backups');
        }

        try {
            const maxBackups = config.get<number>('maxBackups', 10);
            const count = await recovery.backupAllSessions(backupLocation, maxBackups);
            
            const timestamp = Date.now();
            await context.globalState.update('lastBackupTimestamp', timestamp);
            updateStatusBar();
            
            console.log(`Auto-backup completed: ${count} sessions backed up to ${backupLocation}`);
        } catch (error) {
            console.error('Auto-backup failed:', error);
            vscode.window.showErrorMessage(`Auto-backup failed: ${error}`);
        }
    }

    // Function to start/restart auto-backup timer
    function setupAutoBackupTimer() {
        // Clear existing timer
        if (autoBackupTimer) {
            clearInterval(autoBackupTimer);
            autoBackupTimer = undefined;
        }

        const config = vscode.workspace.getConfiguration('copilot-recovery.autoBackup');
        const enabled = config.get<boolean>('enabled', false);
        
        if (!enabled) {
            statusBarItem.hide();
            return;
        }

        const intervalMinutes = config.get<number>('intervalMinutes', 60);
        const intervalMs = intervalMinutes * 60 * 1000;

        // Update status bar
        updateStatusBar();

        // Start timer
        autoBackupTimer = setInterval(() => {
            performAutoBackup();
        }, intervalMs);

        // Perform initial backup after a short delay
        setTimeout(() => {
            performAutoBackup();
        }, 5000);
    }

    // Setup timer on activation
    setupAutoBackupTimer();

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copilot-recovery.autoBackup')) {
                setupAutoBackupTimer();
            }
        })
    );

    // Command to show backup status
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-recovery.showBackupStatus', async () => {
            const lastBackup = context.globalState.get<number>('lastBackupTimestamp');
            const config = vscode.workspace.getConfiguration('copilot-recovery.autoBackup');
            const enabled = config.get<boolean>('enabled', false);
            const intervalMinutes = config.get<number>('intervalMinutes', 60);
            const location = config.get<string>('location', '') || path.join(os.homedir(), '.copilot-session-backups');

            let message = `**Auto-backup Status**\n\n`;
            message += `- Enabled: ${enabled ? 'Yes' : 'No'}\n`;
            message += `- Interval: ${intervalMinutes} minutes\n`;
            message += `- Location: ${location}\n`;
            
            if (lastBackup) {
                const date = new Date(lastBackup);
                message += `- Last backup: ${date.toLocaleString()}\n`;
            } else {
                message += `- Last backup: Never\n`;
            }

            const doc = await vscode.workspace.openTextDocument({
                content: message,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        })
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-recovery.listSessions', async () => {
            const sessions = await recovery.listSessions();
            const items = sessions.map(s => ({
                label: s.title || 'Untitled',
                description: `${s.sessionId.slice(0, 8)} - ${getStateName(s.lastResponseState)}`,
                detail: `Files: ${s.stats?.fileCount || 0}, Pending: ${s.hasPendingEdits ? 'Yes' : 'No'}`,
                session: s
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a session to view details',
                matchOnDescription: true
            });

            if (selected) {
                vscode.commands.executeCommand('copilot-recovery.showSession', selected.session);
            }
        }),

        vscode.commands.registerCommand('copilot-recovery.showSession', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                vscode.window.showErrorMessage('No session selected');
                return;
            }

            const details = await recovery.getSessionDetails(session.sessionId);
            if (!details) {
                vscode.window.showErrorMessage(`Session ${session.sessionId} not found`);
                return;
            }

            const doc = await vscode.workspace.openTextDocument({
                content: formatSessionDetails(details),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),

        vscode.commands.registerCommand('copilot-recovery.exportSession', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                const sessions = await recovery.listSessions();
                const items = sessions.map(s => ({
                    label: s.title || 'Untitled',
                    description: s.sessionId.slice(0, 8),
                    session: s
                }));
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select session to export'
                });
                if (!selected) return;
                item = { session: selected.session };
            }

            const fullExport = await vscode.window.showQuickPick(
                [
                    { label: 'Prompts Only', full: false },
                    { label: 'Full Export (with responses)', full: true }
                ],
                { placeHolder: 'Export type' }
            );
            if (!fullExport) return;

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`chat_history_${item.session.sessionId.slice(0, 8)}.md`),
                filters: { 'Markdown': ['md'] }
            });

            if (uri) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Exporting chat history...'
                }, async () => {
                    const content = await recovery.exportSession(item.session.sessionId, fullExport.full);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                });
                vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
            }
        }),

        vscode.commands.registerCommand('copilot-recovery.recoverFiles', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                vscode.window.showErrorMessage('No session selected');
                return;
            }

            const uri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select Output Folder'
            });

            if (uri && uri[0]) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Recovering files...'
                }, async () => {
                    const count = await recovery.recoverFiles(session.sessionId, uri[0].fsPath);
                    vscode.window.showInformationMessage(`Recovered ${count} files to ${uri[0].fsPath}`);
                });
                treeProvider.refresh();
            }
        }),

        vscode.commands.registerCommand('copilot-recovery.fixSession', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                vscode.window.showErrorMessage('No session selected');
                return;
            }

            if (session.lastResponseState !== 3) {
                vscode.window.showInformationMessage('Session is not in stuck state');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Fix stuck session "${session.title}"? This will reset the error state.`,
                { modal: true },
                'Fix Session'
            );

            if (confirm === 'Fix Session') {
                const success = await recovery.fixSession(session.sessionId);
                if (success) {
                    vscode.window.showInformationMessage(
                        'Session fixed! Reload VS Code to load the session.',
                        'Reload Window'
                    ).then(action => {
                        if (action === 'Reload Window') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                    treeProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('Failed to fix session');
                }
            }
        }),

        vscode.commands.registerCommand('copilot-recovery.backupSession', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                vscode.window.showErrorMessage('No session selected');
                return;
            }

            const uri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select Backup Folder'
            });

            if (uri && uri[0]) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Creating backup...'
                }, async () => {
                    await recovery.backupSession(session.sessionId, uri[0].fsPath);
                });
                vscode.window.showInformationMessage(`Backup saved to ${uri[0].fsPath}`);
            }
        }),

        vscode.commands.registerCommand('copilot-recovery.refresh', () => {
            treeProvider.refresh();
        }),

        treeView
    );
}

function getStateName(state: number): string {
    const states: { [key: number]: string } = {
        0: 'pending',
        1: 'success',
        2: 'streaming',
        3: 'error/stuck'
    };
    return states[state] || 'unknown';
}

function formatSessionDetails(details: any): string {
    let md = `# Session: ${details.title || 'Untitled'}\n\n`;
    md += `**Session ID:** \`${details.sessionId}\`\n`;
    md += `**State:** ${getStateName(details.lastResponseState)}`;
    if (details.lastResponseState === 3) md += ' ⚠️';
    md += '\n';
    md += `**Has Pending Edits:** ${details.hasPendingEdits ? 'Yes ✏️' : 'No'}\n`;
    
    if (details.stats) {
        md += `**Stats:** Files: ${details.stats.fileCount || 0}, `;
        md += `Requests: ${details.stats.requestCount || 0}\n`;
    }
    
    if (details.chatHistorySize) {
        md += `**Chat History Size:** ${(details.chatHistorySize / 1024 / 1024).toFixed(2)} MB\n`;
    }
    
    if (details.pendingFiles && details.pendingFiles.length > 0) {
        md += '\n## Pending File Edits\n\n';
        for (const file of details.pendingFiles) {
            const icon = file.hasChanges ? '📝' : '📄';
            md += `- ${icon} \`${file.path}\` (state: ${file.state})\n`;
        }
    }
    
    return md;
}

export function deactivate() {}
