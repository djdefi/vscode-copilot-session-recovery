import * as vscode from 'vscode';
import { SessionTreeProvider, SessionItem } from './sessionProvider';
import { SessionRecovery } from './sessionRecovery';
import { PendingFilesProvider } from './pendingFilesProvider';
import { DashboardPanel } from './dashboardPanel';
import { TelemetryStatusBar } from './telemetryStatusBar';
import { TelemetryPanel } from './telemetryPanel';

let statusBarItem: vscode.StatusBarItem;
let telemetryStatusBar: TelemetryStatusBar;

export function activate(context: vscode.ExtensionContext) {
    console.log('Copilot Session Recovery is now active');

    const recovery = new SessionRecovery();
    const treeProvider = new SessionTreeProvider(recovery);
    const pendingFilesProvider = new PendingFilesProvider(recovery);

    // Create telemetry status bar (real-time token/context tracking)
    telemetryStatusBar = new TelemetryStatusBar(context);
    context.subscriptions.push(telemetryStatusBar);

    // Create legacy status bar item (for stuck/pending counts)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'copilot-recovery.showDashboard';
    context.subscriptions.push(statusBarItem);
    updateStatusBar(recovery);

    // Register tree views
    const treeView = vscode.window.createTreeView('copilotRecovery.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    const pendingFilesView = vscode.window.createTreeView('copilotRecovery.pendingFiles', {
        treeDataProvider: pendingFilesProvider,
        showCollapseAll: true
    });

    // Auto-refresh status bar periodically
    const refreshInterval = setInterval(() => updateStatusBar(recovery), 60000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

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
            pendingFilesProvider.refresh();
            updateStatusBar(recovery);
        }),

        // Show interactive dashboard
        vscode.commands.registerCommand('copilot-recovery.showDashboard', async () => {
            await DashboardPanel.createOrShow(recovery);
        }),

        // Show real-time telemetry panel
        vscode.commands.registerCommand('copilot-recovery.showTelemetryPanel', async () => {
            TelemetryPanel.createOrShow(context.extensionUri);
        }),

        // Refresh telemetry status bar
        vscode.commands.registerCommand('copilot-recovery.refreshTelemetry', async () => {
            telemetryStatusBar.forceRefresh();
            vscode.window.showInformationMessage('Telemetry refreshed');
        }),

        // Delete a session
        vscode.commands.registerCommand('copilot-recovery.deleteSession', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                const sessions = await recovery.listSessions();
                const items = sessions.map(s => ({
                    label: s.title || 'Untitled',
                    description: s.sessionId.slice(0, 8),
                    session: s
                }));
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select session to delete'
                });
                if (!selected) return;
                item = { session: selected.session };
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete session "${item.session.title || 'Untitled'}"? This will permanently remove chat history and pending edits.`,
                { modal: true },
                'Delete Session'
            );

            if (confirm === 'Delete Session') {
                const success = await recovery.deleteSession(item.session.sessionId);
                if (success) {
                    vscode.window.showInformationMessage('Session deleted');
                    treeProvider.refresh();
                    pendingFilesProvider.refresh();
                    updateStatusBar(recovery);
                } else {
                    vscode.window.showErrorMessage('Failed to delete session');
                }
            }
        }),

        // Diff a pending file - shows side-by-side comparison
        vscode.commands.registerCommand('copilot-recovery.diffFile', async (item: any) => {
            if (!item?.filePath || !item?.sessionId || !item?.currentHash) {
                // Prompt user to select from all pending files
                const allFiles = await recovery.getAllPendingFiles();
                if (allFiles.length === 0) {
                    vscode.window.showInformationMessage('No pending file edits found');
                    return;
                }

                const items = allFiles.map(f => ({
                    label: f.path.split('/').pop() || f.path,
                    description: f.sessionTitle,
                    detail: f.path,
                    file: f
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select a file to view diff'
                });
                if (!selected) return;
                item = {
                    filePath: selected.file.path,
                    sessionId: selected.file.sessionId,
                    currentHash: selected.file.currentHash,
                    originalHash: selected.file.originalHash
                };
            }

            const pendingContent = await recovery.getPendingFileContent(item.sessionId, item.currentHash);
            if (!pendingContent) {
                vscode.window.showErrorMessage('Could not retrieve pending file content');
                return;
            }

            // Create a temp file with pending content
            const pendingUri = vscode.Uri.parse(`untitled:Pending - ${item.filePath.split('/').pop()}`);
            const pendingDoc = await vscode.workspace.openTextDocument({
                content: pendingContent,
                language: getLanguageFromPath(item.filePath)
            });

            // Open diff with original file
            const originalUri = vscode.Uri.file(item.filePath);
            const originalExists = await vscode.workspace.fs.stat(originalUri).then(() => true, () => false);

            if (originalExists) {
                await vscode.commands.executeCommand('vscode.diff',
                    originalUri,
                    pendingDoc.uri,
                    `${item.filePath.split('/').pop()} ↔ Copilot Pending Changes`
                );
            } else {
                await vscode.window.showTextDocument(pendingDoc, { preview: true });
                vscode.window.showWarningMessage(`Original file not found: ${item.filePath}. Showing pending content only.`);
            }
        }),

        // Apply pending changes directly to the file
        vscode.commands.registerCommand('copilot-recovery.applyFile', async (item: any) => {
            if (!item?.filePath || !item?.sessionId || !item?.currentHash) {
                const allFiles = await recovery.getAllPendingFiles();
                if (allFiles.length === 0) {
                    vscode.window.showInformationMessage('No pending file edits found');
                    return;
                }

                const items = allFiles.map(f => ({
                    label: f.path.split('/').pop() || f.path,
                    description: f.sessionTitle,
                    detail: f.path,
                    file: f
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select a file to apply changes',
                    canPickMany: true
                });
                if (!selected || selected.length === 0) return;

                let applied = 0;
                for (const sel of selected) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Apply Copilot changes to ${sel.file.path}? This will overwrite the current file.`,
                        { modal: false },
                        'Apply', 'Skip'
                    );
                    if (confirm === 'Apply' && sel.file.currentHash) {
                        const success = await recovery.applyPendingFile(
                            sel.file.sessionId,
                            sel.file.path,
                            sel.file.currentHash
                        );
                        if (success) applied++;
                    }
                }
                vscode.window.showInformationMessage(`Applied changes to ${applied} file(s)`);
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Apply Copilot changes to ${item.filePath}? This will overwrite the current file.`,
                { modal: true },
                'Apply Changes'
            );

            if (confirm === 'Apply Changes') {
                const success = await recovery.applyPendingFile(item.sessionId, item.filePath, item.currentHash);
                if (success) {
                    vscode.window.showInformationMessage(`Applied changes to ${item.filePath}`);
                    // Open the file
                    const doc = await vscode.workspace.openTextDocument(item.filePath);
                    await vscode.window.showTextDocument(doc);
                } else {
                    vscode.window.showErrorMessage('Failed to apply changes');
                }
            }
        }),

        // Selective file recovery - pick specific files
        vscode.commands.registerCommand('copilot-recovery.selectiveRecover', async (item: SessionItem | any) => {
            const session = item?.session || item;
            if (!session?.sessionId) {
                vscode.window.showErrorMessage('No session selected');
                return;
            }

            const details = await recovery.getSessionDetails(session.sessionId);
            if (!details?.pendingFiles || details.pendingFiles.length === 0) {
                vscode.window.showInformationMessage('No pending files in this session');
                return;
            }

            const changedFiles = details.pendingFiles.filter(f => f.hasChanges);
            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage('No changed files in this session');
                return;
            }

            const items = changedFiles.map(f => ({
                label: f.path.split('/').pop() || f.path,
                description: f.path,
                picked: true,
                file: f
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select files to recover',
                canPickMany: true
            });

            if (!selected || selected.length === 0) return;

            const action = await vscode.window.showQuickPick([
                { label: 'View Diffs', action: 'diff' },
                { label: 'Apply to Original Locations', action: 'apply' },
                { label: 'Export to Folder', action: 'export' }
            ], { placeHolder: 'What would you like to do?' });

            if (!action) return;

            if (action.action === 'diff') {
                for (const sel of selected) {
                    await vscode.commands.executeCommand('copilot-recovery.diffFile', {
                        filePath: sel.file.path,
                        sessionId: session.sessionId,
                        currentHash: sel.file.currentHash
                    });
                }
            } else if (action.action === 'apply') {
                let applied = 0;
                for (const sel of selected) {
                    const success = await recovery.applyPendingFile(
                        session.sessionId,
                        sel.file.path,
                        sel.file.currentHash!
                    );
                    if (success) applied++;
                }
                vscode.window.showInformationMessage(`Applied ${applied}/${selected.length} files`);
            } else if (action.action === 'export') {
                const uri = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    openLabel: 'Select Export Folder'
                });
                if (uri && uri[0]) {
                    // Export only selected files
                    let exported = 0;
                    for (const sel of selected) {
                        const content = await recovery.getPendingFileContent(session.sessionId, sel.file.currentHash!);
                        if (content) {
                            const outPath = vscode.Uri.joinPath(uri[0], sel.file.path.replace(/^\//, ''));
                            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(outPath, '..'));
                            await vscode.workspace.fs.writeFile(outPath, Buffer.from(content, 'utf8'));
                            exported++;
                        }
                    }
                    vscode.window.showInformationMessage(`Exported ${exported} files to ${uri[0].fsPath}`);
                }
            }
        }),

        // Search across all sessions
        vscode.commands.registerCommand('copilot-recovery.searchSessions', async () => {
            const query = await vscode.window.showInputBox({
                placeHolder: 'Enter search term...',
                prompt: 'Search across all chat histories'
            });

            if (!query) return;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Searching sessions...'
            }, async () => {
                const results = await recovery.searchSessions(query);

                if (results.length === 0) {
                    vscode.window.showInformationMessage(`No results found for "${query}"`);
                    return;
                }

                const items = results.flatMap(r => r.matches.map(m => ({
                    label: r.title,
                    description: r.sessionId.slice(0, 8),
                    detail: m,
                    sessionId: r.sessionId
                })));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Found ${results.length} sessions with matches`,
                    matchOnDetail: true
                });

                if (selected) {
                    vscode.commands.executeCommand('copilot-recovery.exportSession', { session: { sessionId: selected.sessionId } });
                }
            });
        }),

        // Fix all stuck sessions
        vscode.commands.registerCommand('copilot-recovery.fixAllStuck', async () => {
            const sessions = await recovery.listSessions();
            const stuckCount = sessions.filter(s => s.lastResponseState === 3).length;

            if (stuckCount === 0) {
                vscode.window.showInformationMessage('No stuck sessions found');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Fix ${stuckCount} stuck session(s)? This will reset error states.`,
                { modal: true },
                'Fix All'
            );

            if (confirm === 'Fix All') {
                const fixed = await recovery.fixAllStuck();
                vscode.window.showInformationMessage(
                    `Fixed ${fixed} session(s). Reload VS Code to load them.`,
                    'Reload Window'
                ).then(action => {
                    if (action === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
                treeProvider.refresh();
                pendingFilesProvider.refresh();
                updateStatusBar(recovery);
            }
        }),

        // Analyze storage usage - opens dashboard
        vscode.commands.registerCommand('copilot-recovery.analyzeStorage', async () => {
            vscode.commands.executeCommand('copilot-recovery.showDashboard');
        }),

        treeView,
        pendingFilesView
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

function getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: { [key: string]: string } = {
        'ts': 'typescript',
        'tsx': 'typescriptreact',
        'js': 'javascript',
        'jsx': 'javascriptreact',
        'py': 'python',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'html': 'html',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'md': 'markdown',
        'sh': 'shellscript',
        'bash': 'shellscript',
        'sql': 'sql',
        'xml': 'xml',
        'vue': 'vue',
        'svelte': 'svelte'
    };
    return langMap[ext] || 'plaintext';
}

async function updateStatusBar(recovery: SessionRecovery) {
    try {
        const stats = await recovery.getQuickStats();
        
        if (stats.stuck > 0) {
            statusBarItem.text = `$(error) ${stats.stuck} stuck`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.tooltip = `${stats.stuck} stuck sessions, ${stats.pending} with pending edits. Click to open dashboard.`;
        } else if (stats.pending > 0) {
            statusBarItem.text = `$(edit) ${stats.pending} pending`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = `${stats.pending} sessions with pending edits. Click to open dashboard.`;
        } else {
            statusBarItem.text = `$(check) ${stats.total} sessions`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.tooltip = `${stats.total} Copilot sessions. Click to open dashboard.`;
        }
        
        statusBarItem.show();
    } catch (error) {
        statusBarItem.hide();
    }
}

export function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
