import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SessionRecovery } from '../sessionRecovery';

// Define fixtures inline to avoid file reading issues with mocking
const sessionIndexFixture = {
  entries: {
    'test-session-123': {
      title: 'Test Chat Session',
      lastResponseState: 1,
      hasPendingEdits: false,
      stats: {
        fileCount: 3,
        requestCount: 5
      },
      lastMessageDate: 1704067200000
    },
    'stuck-session-456': {
      title: 'Stuck Session',
      lastResponseState: 3,
      hasPendingEdits: true,
      stats: {
        fileCount: 2,
        requestCount: 10
      },
      lastMessageDate: 1704153600000
    },
    'empty-session-789': {
      title: 'Empty Session',
      lastResponseState: 0,
      hasPendingEdits: false,
      stats: {
        fileCount: 0,
        requestCount: 1
      },
      lastMessageDate: 1704240000000
    }
  }
};

const chatHistoryFixture = JSON.stringify({
  customTitle: 'Test Chat with Various Response Types',
  requests: [
    {
      message: { text: 'How do I create a new file in TypeScript?' },
      timestamp: 1704067200000,
      response: {
        value: [
          {
            kind: 'markdownContent',
            content: {
              value: 'You can create a new file in TypeScript using the `fs` module.'
            }
          }
        ]
      }
    },
    {
      message: { text: 'Can you edit the file to add error handling?' },
      timestamp: 1704067260000,
      response: {
        value: [
          {
            kind: 'textEditGroup',
            uri: 'file:///home/user/project/src/example.ts',
            edits: [{ start: 0, end: 10, newText: 'updated content' }]
          },
          {
            kind: 'markdownContent',
            content: { value: 'I\'ve added error handling to the file.' }
          }
        ]
      }
    },
    {
      message: { text: 'What tool can help with this?' },
      timestamp: 1704067320000,
      response: {
        value: [
          { kind: 'toolInvocation', toolId: 'typescript-linter' },
          { kind: 'progressMessage', content: { value: 'Running TypeScript linter...' } }
        ]
      }
    },
    {
      message: { text: 'Show me the code block' },
      timestamp: 1704067380000,
      response: {
        value: [{ kind: 'codeblockUri', uri: 'file:///home/user/project/package.json' }]
      }
    }
  ]
});

const stateFixture = JSON.stringify({
  recentSnapshot: {
    entries: [
      {
        resource: 'file:///home/user/project/src/index.ts',
        state: 2,
        originalHash: 'abc123',
        currentHash: 'def456'
      },
      {
        resource: 'file:///home/user/project/src/utils.ts',
        state: 1,
        originalHash: 'xyz789',
        currentHash: 'xyz789'
      },
      {
        resource: 'file:///home/user/project/README.md',
        state: 2,
        originalHash: 'readme1',
        currentHash: 'readme2'
      }
    ]
  }
});

// Store database mock instance for per-test configuration
let mockDbInstance: any;

// Mock modules
vi.mock('fs');
vi.mock('os', () => ({
  homedir: vi.fn()
}));
vi.mock('better-sqlite3', () => {
  const mockDatabase = vi.fn(function(this: any) {
    mockDbInstance = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn(),
        run: vi.fn()
      }),
      close: vi.fn()
    };
    return mockDbInstance;
  });
  return {
    default: mockDatabase
  };
});

describe('SessionRecovery', () => {
  let recovery: SessionRecovery;
  const mockHomedir = '/mock/home';
  const mockStoragePath = '/mock/home/.config/Code/User/workspaceStorage';

  beforeEach(async () => {
    vi.resetAllMocks();
    mockDbInstance = null;
    
    // Mock os.homedir
    const os = await import('os');
    vi.mocked(os.homedir).mockReturnValue(mockHomedir);
    
    // Mock process.platform as linux by default
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getVSCodeStoragePath', () => {
    it('should return correct path for Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      
      recovery = new SessionRecovery();
      
      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockHomedir, '.config', 'Code - Insiders', 'User', 'workspaceStorage')
      );
    });

    it('should return correct path for macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      
      recovery = new SessionRecovery();
      
      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockHomedir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage')
      );
    });

    it('should return correct path for Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      
      recovery = new SessionRecovery();
      
      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join('C:\\Users\\Test\\AppData\\Roaming', 'Code - Insiders', 'User', 'workspaceStorage')
      );
    });

    it('should try fallback variants when primary not found', () => {
      vi.mocked(fs.existsSync)
        .mockReturnValueOnce(false) // Code - Insiders
        .mockReturnValueOnce(true);  // Code
      
      recovery = new SessionRecovery();
      
      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockHomedir, '.config', 'Code - Insiders', 'User', 'workspaceStorage')
      );
      expect(fs.existsSync).toHaveBeenCalledWith(
        path.join(mockHomedir, '.config', 'Code', 'User', 'workspaceStorage')
      );
    });

    it('should return null when no storage path found', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      recovery = new SessionRecovery();
      
      // Storage path should be null
      expect(vi.mocked(fs.existsSync).mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('listSessions', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should return empty array when no storage path', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      recovery = new SessionRecovery();
      
      const sessions = await recovery.listSessions();
      
      expect(sessions).toEqual([]);
    });

    it('should parse session index correctly', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('state.vscdb')) return true;
        if (typeof p === 'string' && p.includes('workspace.json')) return false;
        return true;
      });
      
      // Setup mock to return actual fixture data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({
              value: JSON.stringify(sessionIndexFixture)
            })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const sessions = await recovery.listSessions();
      
      expect(sessions.length).toBe(3);
      expect(sessions[0].sessionId).toBe('empty-session-789');
      expect(sessions[0].title).toBe('Empty Session');
      expect(sessions[1].sessionId).toBe('stuck-session-456');
      expect(sessions[2].sessionId).toBe('test-session-123');
    });

    it('should handle workspace.json correctly', async () => {
      const mockWorkspaceData = JSON.stringify({ folder: 'file:///home/user/my-project' });
      const sessionIndexData = {
        entries: {
          'session-1': {
            title: 'Test',
            lastResponseState: 1,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('workspace.json')) return mockWorkspaceData;
        return '';
      });
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const sessions = await recovery.listSessions();
      
      expect(sessions[0]._workspace).toBe('my-project');
    });
  });

  describe('exportSession', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should format markdown correctly', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test-session-123', true);
      
      expect(result).toContain('# Chat Session: Test Chat with Various Response Types');
      expect(result).toContain('**Session ID:** `test-session-123`');
      expect(result).toContain('**Messages:** 4');
      expect(result).toContain('**Export Type:** Full (with responses)');
      expect(result).toContain('### 👤 User');
      expect(result).toContain('### 🤖 Assistant');
    });

    it('should export prompts only when full=false', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Simple Chat',
        requests: [{
          message: { text: 'Hello' },
          timestamp: 1000,
          response: { value: [] }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test-session', false);
      
      expect(result).toContain('**Export Type:** Prompts only');
      expect(result).not.toContain('### 🤖 Assistant');
    });

    it('should throw error when session not found', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('chatSessions')) return false;
        return true;
      });
      
      await expect(recovery.exportSession('non-existent', false))
        .rejects.toThrow('Chat history for session non-existent not found');
    });
  });

  describe('formatResponseParts', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should handle markdownContent', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: {
            value: [{
              kind: 'markdownContent',
              content: { value: 'This is markdown content' }
            }]
          }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('This is markdown content');
    });

    it('should handle textEditGroup', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: {
            value: [{
              kind: 'textEditGroup',
              uri: 'file:///home/user/project/src/example.ts',
              edits: [1, 2, 3]
            }]
          }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('📝 **Edited:**');
      expect(result).toContain('(3 changes)');
    });

    it('should handle codeblockUri', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: {
            value: [{
              kind: 'codeblockUri',
              uri: 'file:///home/user/package.json'
            }]
          }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('📄 **File:**');
    });

    it('should handle toolInvocation', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: {
            value: [{
              kind: 'toolInvocation',
              toolId: 'my-tool'
            }]
          }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('🔧 **Tool:** `my-tool`');
    });

    it('should handle progressMessage', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: {
            value: [{
              kind: 'progressMessage',
              content: { value: 'Processing...' }
            }]
          }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('⏳ Processing...');
    });

    it('should handle empty response', async () => {
      const chatHistoryFixture = JSON.stringify({
        customTitle: 'Test',
        requests: [{
          message: { text: 'test' },
          timestamp: 1000,
          response: { value: [] }
        }]
      });
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(chatHistoryFixture);
      
      const result = await recovery.exportSession('test', true);
      
      expect(result).toContain('(No response content)');
    });
  });

  describe('getSessionDetails', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should return session details with chat history', async () => {
      const sessionIndexData = {
        entries: {
          'test-session-123': {
            title: 'Test Session',
            lastResponseState: 1,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.statSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('chatSessions')) {
          return { isDirectory: () => true, size: 5000 } as any;
        }
        return { isDirectory: () => true } as any;
      });
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const details = await recovery.getSessionDetails('test-session-123');
      
      expect(details).toBeDefined();
      expect(details?.sessionId).toBe('test-session-123');
      expect(details?.title).toBe('Test Session');
      expect(details?.chatHistorySize).toBe(5000);
    });

    it('should include pending files when available', async () => {
      const sessionIndexData = {
        entries: {
          'test-session-123': {
            title: 'Test Session',
            lastResponseState: 1,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('state.json')) return stateFixture;
        return '';
      });
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const details = await recovery.getSessionDetails('test-session-123');
      
      expect(details?.pendingFiles).toBeDefined();
      expect(details?.pendingFiles?.length).toBe(3);
      expect(details?.pendingFiles?.[0].path).toBe('/home/user/project/src/index.ts');
      expect(details?.pendingFiles?.[0].hasChanges).toBe(true);
      expect(details?.pendingFiles?.[1].hasChanges).toBe(false);
    });

    it('should return null when session not found', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      
      const details = await recovery.getSessionDetails('non-existent');
      
      expect(details).toBeNull();
    });
  });

  describe('recoverFiles', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should recover changed files', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(stateFixture);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      
      const count = await recovery.recoverFiles('test-session', '/output');
      
      expect(count).toBe(2); // Only files with changes
      expect(vi.mocked(fs.copyFileSync).mock.calls.length).toBe(2);
    });

    it('should throw error when session not found', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('state.json')) return false;
        return true;
      });
      
      await expect(recovery.recoverFiles('non-existent', '/output'))
        .rejects.toThrow('Editing session non-existent not found');
    });
  });

  describe('fixSession', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should fix stuck session', async () => {
      const sessionIndexData = {
        entries: {
          'stuck-session': {
            title: 'Stuck',
            lastResponseState: 3,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('.recovery_backup')) return false;
        return true;
      });
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      
      const mockRun = vi.fn();
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) }),
            run: mockRun
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const result = await recovery.fixSession('stuck-session');
      
      expect(result).toBe(true);
      expect(mockRun).toHaveBeenCalled();
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalled(); // Backup created
    });

    it('should return false for non-stuck session', async () => {
      const sessionIndexData = {
        entries: {
          'normal-session': {
            title: 'Normal',
            lastResponseState: 1,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockReturnValue(['workspace1'] as any);
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      const result = await recovery.fixSession('normal-session');
      
      expect(result).toBe(false);
    });
  });

  describe('backupSession', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      recovery = new SessionRecovery();
    });

    it('should create backup with all files', async () => {
      const sessionIndexData = {
        entries: {
          'test-session': {
            title: 'Test',
            lastResponseState: 1,
            lastMessageDate: 1000
          }
        }
      };
      
      vi.mocked(fs.readdirSync).mockImplementation((p: any, options?: any) => {
        // For workspace directories
        if (!options || !options.withFileTypes) {
          return ['workspace1'] as any;
        }
        // For copyDir with withFileTypes
        return [{
          name: 'test.txt',
          isDirectory: () => false
        }] as any;
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.copyFileSync).mockReturnValue(undefined);
      
      // Setup mock to return session data
      const Database = (await import('better-sqlite3')).default;
      vi.mocked(Database).mockImplementation(function(this: any) {
        mockDbInstance = {
          prepare: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({ value: JSON.stringify(sessionIndexData) })
          }),
          close: vi.fn()
        };
        return mockDbInstance;
      } as any);
      
      await recovery.backupSession('test-session', '/backup');
      
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled(); // session_meta.json
    });

    it('should throw error when session not found', async () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);
      
      await expect(recovery.backupSession('non-existent', '/backup'))
        .rejects.toThrow('Session non-existent not found');
    });
  });
});
