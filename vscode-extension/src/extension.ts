import * as vscode from 'vscode';
import { SessionTreeProvider, SessionItem } from './sessionProvider';
import { SessionRecovery } from './sessionRecovery';

// Constants for session merging
const MIN_SESSIONS_FOR_MERGE = 2;
const SIMILARITY_DISPLAY_THRESHOLD = 0.3;
const AUTO_PICK_THRESHOLD = 0.5;

export function activate(context: vscode.ExtensionContext) {
    console.log('Copilot Session Recovery is now active');

    const recovery = new SessionRecovery();
    const treeProvider = new SessionTreeProvider(recovery);

    // Register tree view
    const treeView = vscode.window.createTreeView('copilotRecovery.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

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

        vscode.commands.registerCommand('copilot-recovery.mergeSessions', async () => {
            const sessions = await recovery.listSessions();
            if (sessions.length < MIN_SESSIONS_FOR_MERGE) {
                vscode.window.showInformationMessage(`Need at least ${MIN_SESSIONS_FOR_MERGE} sessions to merge`);
                return;
            }

            // Step 1: Select target session
            const targetItems = sessions.map(s => ({
                label: s.title || 'Untitled',
                description: `${s.sessionId.slice(0, 8)} - ${s._workspace}`,
                detail: `State: ${getStateName(s.lastResponseState)}, Files: ${s.stats?.fileCount || 0}`,
                session: s
            }));

            const targetSelected = await vscode.window.showQuickPick(targetItems, {
                placeHolder: 'Select target session (sessions will be merged INTO this one)',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!targetSelected) return;

            // Step 2: Find similar sessions
            const similarities = await recovery.findSimilarSessions(targetSelected.session.sessionId);
            
            // Step 3: Show multi-select for source sessions
            const sourceItems = sessions
                .filter(s => s.sessionId !== targetSelected.session.sessionId)
                .map(s => {
                    const similarity = similarities.find(sim => sim.session.sessionId === s.sessionId);
                    const label = s.title || 'Untitled';
                    const description = `${s.sessionId.slice(0, 8)} - ${s._workspace}`;
                    
                    let detail = `State: ${getStateName(s.lastResponseState)}, Files: ${s.stats?.fileCount || 0}`;
                    if (similarity && similarity.score > SIMILARITY_DISPLAY_THRESHOLD) {
                        detail += ` | 🎯 Match: ${(similarity.score * 100).toFixed(0)}% (${similarity.reasons.join(', ')})`;
                    }
                    
                    return {
                        label,
                        description,
                        detail,
                        session: s,
                        picked: similarity && similarity.score > AUTO_PICK_THRESHOLD
                    };
                });

            const sourceSelected = await vscode.window.showQuickPick(sourceItems, {
                placeHolder: 'Select source sessions to merge (can select multiple)',
                canPickMany: true,
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!sourceSelected || sourceSelected.length === 0) return;

            // Step 4: Show preview for each merge
            let previewContent = `# Merge Preview\n\n`;
            previewContent += `**Target:** ${targetSelected.session.title || 'Untitled'} (${targetSelected.session.sessionId.slice(0, 8)})\n\n`;
            previewContent += `**Sources:** ${sourceSelected.length} session(s)\n\n---\n\n`;

            for (const source of sourceSelected) {
                const preview = await recovery.getMergePreview(source.session.sessionId, targetSelected.session.sessionId);
                if (preview) {
                    previewContent += `## Source: ${source.session.title || 'Untitled'}\n\n`;
                    previewContent += `**Chat Messages:**\n`;
                    previewContent += `- Source: ${preview.chatHistoryCount.source}\n`;
                    previewContent += `- Target: ${preview.chatHistoryCount.target}\n`;
                    previewContent += `- Merged Total: ${preview.chatHistoryCount.merged}\n\n`;
                    
                    previewContent += `**File Edits:**\n`;
                    previewContent += `- Source: ${preview.fileEditsCount.source}\n`;
                    previewContent += `- Target: ${preview.fileEditsCount.target}\n`;
                    previewContent += `- Merged Total: ${preview.fileEditsCount.merged}\n\n`;
                    
                    if (preview.conflicts.length > 0) {
                        previewContent += `**⚠️ Conflicts (${preview.conflicts.length}):**\n`;
                        preview.conflicts.forEach(c => {
                            previewContent += `- ${c}\n`;
                        });
                        previewContent += '\n';
                    }
                    
                    previewContent += '---\n\n';
                }
            }

            // Show preview
            const doc = await vscode.workspace.openTextDocument({
                content: previewContent,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: true });

            // Step 5: Confirm merge
            const confirm = await vscode.window.showWarningMessage(
                `Merge ${sourceSelected.length} session(s) into "${targetSelected.session.title || 'Untitled'}"?\n\nA backup will be created before merging.`,
                { modal: true },
                'Merge Sessions'
            );

            if (confirm !== 'Merge Sessions') return;

            // Step 6: Select backup location
            const backupUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select Backup Folder'
            });

            if (!backupUri || !backupUri[0]) return;

            // Step 7: Perform merge
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Merging sessions...',
                cancellable: false
            }, async (progress) => {
                let successCount = 0;
                const errors: string[] = [];

                for (let i = 0; i < sourceSelected.length; i++) {
                    const source = sourceSelected[i];
                    progress.report({ 
                        message: `Merging ${i + 1}/${sourceSelected.length}: ${source.session.title || 'Untitled'}`,
                        increment: (100 / sourceSelected.length)
                    });

                    const result = await recovery.mergeSessions(
                        source.session.sessionId,
                        targetSelected.session.sessionId,
                        backupUri[0].fsPath
                    );

                    if (result.success) {
                        successCount++;
                    } else {
                        errors.push(`${source.session.title || 'Untitled'}: ${result.error}`);
                    }
                }

                if (successCount > 0) {
                    const message = `Successfully merged ${successCount}/${sourceSelected.length} session(s)`;
                    if (errors.length > 0) {
                        vscode.window.showWarningMessage(
                            `${message}. ${errors.length} failed:\n${errors.join('\n')}`,
                            'Reload Window'
                        ).then(action => {
                            if (action === 'Reload Window') {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }
                        });
                    } else {
                        vscode.window.showInformationMessage(
                            `${message}. Reload VS Code to see the merged session.`,
                            'Reload Window'
                        ).then(action => {
                            if (action === 'Reload Window') {
                                vscode.commands.executeCommand('workbench.action.reloadWindow');
                            }
                        });
                    }
                    treeProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(`Failed to merge sessions:\n${errors.join('\n')}`);
                }
            });
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
