import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use sql.js (WASM-based SQLite, no native compilation needed)
let initSqlJs: any;
try {
    initSqlJs = require('sql.js');
} catch {
    initSqlJs = null;
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

export class SessionRecovery {
    private storagePath: string | null;
    private variant: string;
    private sqlPromise: Promise<any> | null = null;

    constructor() {
        const result = this.getVSCodeStoragePath();
        this.storagePath = result.path;
        this.variant = result.variant;
        
        // Initialize sql.js
        if (initSqlJs) {
            this.sqlPromise = initSqlJs();
        }
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

    private async getSessionIndex(dbPath: string): Promise<any | null> {
        if (!this.sqlPromise) {
            console.warn('sql.js not available');
            return null;
        }

        try {
            const SQL = await this.sqlPromise;
            const fileBuffer = fs.readFileSync(dbPath);
            const db = new SQL.Database(fileBuffer);
            
            const result = db.exec(
                "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'"
            );
            db.close();
            
            if (result.length > 0 && result[0].values.length > 0) {
                return JSON.parse(result[0].values[0][0] as string);
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
            const index = await this.getSessionIndex(dbPath);
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
        if (!this.storagePath || !this.sqlPromise) {
            return false;
        }

        const workspaceDirs = fs.readdirSync(this.storagePath);
        
        for (const wsDir of workspaceDirs) {
            const dbPath = path.join(this.storagePath, wsDir, 'state.vscdb');
            if (!fs.existsSync(dbPath)) continue;

            const index = await this.getSessionIndex(dbPath);
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
                    const SQL = await this.sqlPromise;
                    const fileBuffer = fs.readFileSync(dbPath);
                    const db = new SQL.Database(fileBuffer);
                    
                    db.run(
                        "UPDATE ItemTable SET value = ? WHERE key = 'chat.ChatSessionStore.index'",
                        [JSON.stringify(index)]
                    );
                    
                    // Write back to file
                    const data = db.export();
                    const buffer = Buffer.from(data);
                    fs.writeFileSync(dbPath, buffer);
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

    // Get pending file content by hash
    async getPendingFileContent(sessionId: string, fileHash: string): Promise<string | null> {
        if (!this.storagePath) return null;
        
        const workspaceDirs = fs.readdirSync(this.storagePath);
        for (const wsDir of workspaceDirs) {
            const contentPath = path.join(this.storagePath, wsDir, 'chatEditingSessions', sessionId, 'contents', fileHash);
            if (fs.existsSync(contentPath)) {
                return fs.readFileSync(contentPath, 'utf8');
            }
        }
        return null;
    }

    // Get all pending files across all sessions
    async getAllPendingFiles(): Promise<Array<PendingFile & { sessionId: string; sessionTitle: string }>> {
        const sessions = await this.listSessions();
        const allFiles: Array<PendingFile & { sessionId: string; sessionTitle: string }> = [];
        
        for (const session of sessions) {
            const details = await this.getSessionDetails(session.sessionId);
            if (details?.pendingFiles) {
                for (const file of details.pendingFiles) {
                    if (file.hasChanges) {
                        allFiles.push({
                            ...file,
                            sessionId: session.sessionId,
                            sessionTitle: session.title || 'Untitled'
                        });
                    }
                }
            }
        }
        return allFiles;
    }

    // Search across all chat histories
    async searchSessions(query: string): Promise<Array<{ sessionId: string; title: string; matches: string[] }>> {
        if (!this.storagePath) return [];
        
        const results: Array<{ sessionId: string; title: string; matches: string[] }> = [];
        const queryLower = query.toLowerCase();
        const workspaceDirs = fs.readdirSync(this.storagePath);
        
        for (const wsDir of workspaceDirs) {
            const chatDir = path.join(this.storagePath, wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) continue;
            
            const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(chatDir, file), 'utf8'));
                    const matches: string[] = [];
                    
                    for (const req of (data.requests || [])) {
                        const text = req.message?.text || '';
                        if (text.toLowerCase().includes(queryLower)) {
                            const snippet = text.slice(0, 100) + (text.length > 100 ? '...' : '');
                            matches.push(snippet);
                        }
                    }
                    
                    if (matches.length > 0) {
                        results.push({
                            sessionId: file.replace('.json', ''),
                            title: data.customTitle || 'Untitled',
                            matches
                        });
                    }
                } catch {}
            }
        }
        return results;
    }

    // Analyze storage usage
    async analyzeStorage(): Promise<{
        totalSize: number;
        sessionCount: number;
        stuckCount: number;
        pendingEditsCount: number;
        largestSessions: Array<{ sessionId: string; title: string; size: number }>;
    }> {
        let totalSize = 0;
        let sessionCount = 0;
        let stuckCount = 0;
        let pendingEditsCount = 0;
        const sessionSizes: Array<{ sessionId: string; title: string; size: number }> = [];
        
        const sessions = await this.listSessions();
        for (const session of sessions) {
            sessionCount++;
            if (session.lastResponseState === 3) stuckCount++;
            if (session.hasPendingEdits) pendingEditsCount++;
            
            // Calculate session size
            let sessionSize = 0;
            if (session._ws_dir) {
                const chatFile = path.join(session._ws_dir, 'chatSessions', `${session.sessionId}.json`);
                if (fs.existsSync(chatFile)) {
                    sessionSize += fs.statSync(chatFile).size;
                }
                const editDir = path.join(session._ws_dir, 'chatEditingSessions', session.sessionId);
                if (fs.existsSync(editDir)) {
                    sessionSize += this.getDirSize(editDir);
                }
            }
            totalSize += sessionSize;
            sessionSizes.push({ sessionId: session.sessionId, title: session.title || 'Untitled', size: sessionSize });
        }
        
        sessionSizes.sort((a, b) => b.size - a.size);
        
        return {
            totalSize,
            sessionCount,
            stuckCount,
            pendingEditsCount,
            largestSessions: sessionSizes.slice(0, 10)
        };
    }

    private getDirSize(dir: string): number {
        let size = 0;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    size += this.getDirSize(fullPath);
                } else {
                    size += fs.statSync(fullPath).size;
                }
            }
        } catch {}
        return size;
    }

    // Fix all stuck sessions
    async fixAllStuck(): Promise<number> {
        const sessions = await this.listSessions();
        let fixed = 0;
        
        for (const session of sessions) {
            if (session.lastResponseState === 3) {
                const success = await this.fixSession(session.sessionId);
                if (success) fixed++;
            }
        }
        return fixed;
    }

    // Apply a single pending file to its original location
    async applyPendingFile(sessionId: string, filePath: string, currentHash: string): Promise<boolean> {
        const content = await this.getPendingFileContent(sessionId, currentHash);
        if (!content) return false;
        
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
            return true;
        } catch (error) {
            console.error('Failed to apply file:', error);
            return false;
        }
    }
}
