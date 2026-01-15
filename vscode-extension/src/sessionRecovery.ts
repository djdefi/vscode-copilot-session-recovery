import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

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

interface SessionIndexEntry {
    title?: string;
    lastResponseState: number;
    hasPendingEdits?: boolean;
    stats?: SessionStats;
    lastMessageDate?: number;
}

interface SessionIndex {
    entries: Record<string, SessionIndexEntry>;
}

interface DatabaseRow {
    value: string;
}

interface WorkspaceData {
    folder?: string;
    workspace?: string;
}

interface StateEntry {
    resource?: string;
    state: number;
    originalHash?: string;
    currentHash?: string;
}

interface StateData {
    recentSnapshot?: {
        entries: StateEntry[];
    };
}

interface ChatRequestMessage {
    text?: string;
}

interface ChatRequest {
    message?: ChatRequestMessage;
    timestamp?: number;
    response?: ChatResponse;
}

interface ChatData {
    customTitle?: string;
    requests?: ChatRequest[];
}

interface ResponsePart {
    kind?: string;
    content?: {
        value?: string;
    };
    uri?: string;
    edits?: unknown[];
    toolId?: string;
}

interface ChatResponse {
    value?: ResponsePart[];
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

    private getSessionIndex(dbPath: string): SessionIndex | null {
        try {
            const db = new Database(dbPath, { readonly: true });
            const row = db.prepare(
                "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
            ).get() as DatabaseRow | undefined;
            db.close();
            
            if (row) {
                return JSON.parse(row.value) as SessionIndex;
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
                    const data = JSON.parse(fs.readFileSync(workspaceJson, 'utf8')) as WorkspaceData;
                    const folder = data.folder || data.workspace || 'Unknown';
                    workspaceName = folder.replace('file://', '').split('/').pop() || 'Unknown';
                } catch {}
            }

            // Get session index
            const index = this.getSessionIndex(dbPath);
            if (index?.entries) {
                for (const [sid, info] of Object.entries(index.entries)) {
                    const sessionInfo: SessionInfo = {
                        sessionId: sid,
                        title: info.title,
                        lastResponseState: info.lastResponseState,
                        hasPendingEdits: info.hasPendingEdits,
                        stats: info.stats,
                        lastMessageDate: info.lastMessageDate,
                        _workspace: workspaceName,
                        _ws_dir: wsDirPath
                    };
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
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StateData;
                const entries = state.recentSnapshot?.entries || [];
                details.pendingFiles = entries.map((entry: StateEntry) => ({
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
                const data = JSON.parse(fs.readFileSync(chatFile, 'utf8')) as ChatData;
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

    private formatResponseParts(response: ChatResponse): string {
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

            const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as StateData;
            const entries = state.recentSnapshot?.entries || [];
            let recovered = 0;

            for (const entry of entries) {
                if (entry.originalHash === entry.currentHash) continue;

                const uri = entry.resource || '';
                const filePath = decodeURIComponent(uri.replace('file://', ''));
                const contentFile = path.join(contentsDir, entry.currentHash || '');

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
        if (!this.storagePath) {
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
                
                if (info.lastResponseState !== 3) {
                    return false;
                }

                // Create backup
                const backup = dbPath + '.recovery_backup';
                if (!fs.existsSync(backup)) {
                    fs.copyFileSync(dbPath, backup);
                }

                // Fix the state
                info.lastResponseState = 1;

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
}
