# VS Code Copilot Chat Session Recovery Tool

A command-line tool to recover stuck or broken Copilot Chat sessions from VS Code's internal storage.

## The Problem

VS Code Copilot Chat sessions can get stuck in an error state (`lastResponseState: 3`) where:
- The session appears in the sidebar but won't load
- Pending file edits are trapped and inaccessible  
- Chat history with hundreds of messages becomes unreachable
- No built-in recovery mechanism exists

This commonly happens when:
- Switching between single-folder and multi-folder workspaces
- VS Code crashes during a long agent session
- Network interruptions during streaming responses

## Features

- **List all sessions** across all workspaces with status indicators
- **Show session details** including pending files and chat history size
- **Export chat history** to readable markdown
- **Recover pending files** that were never saved
- **Fix stuck sessions** by resetting the error state

## Installation

```bash
# No dependencies required - uses Python 3 standard library only
curl -O https://raw.githubusercontent.com/djdefi/vscode-copilot-session-recovery/main/recover_session.py
chmod +x recover_session.py
```

## Usage

### List all sessions

```bash
python recover_session.py list
```

Output:
```
VS Code variant: VS Code Insiders
Storage path: /Users/you/Library/Application Support/Code - Insiders/User/workspaceStorage

Found 15 sessions:

ID                                       State        Files  Title
----------------------------------------------------------------------------------------------------
*bc1e28b1-2334-4ad7-b119-b6fa7c62c742    error/stuck  34     Improving ghe-console and...
 ca63f280-9f8c-41d4-af47-1554f841c3be    success      0      Managing stale pull requests...

* = has pending edits
```

### Show session details

```bash
python recover_session.py show bc1e28b1
```

Shows:
- Session metadata
- Chat history file location and size
- All pending file edits with modification status

### Export chat history

```bash
python recover_session.py export bc1e28b1-2334-4ad7-b119-b6fa7c62c742 -o ./exported
```

Creates a markdown file with all messages from the session.

### Recover pending files

```bash
python recover_session.py recover bc1e28b1-2334-4ad7-b119-b6fa7c62c742 -o ./recovered
```

Extracts all files with uncommitted changes to the specified directory, preserving the original path structure.

### Fix stuck session

```bash
python recover_session.py fix bc1e28b1-2334-4ad7-b119-b6fa7c62c742
```

Resets `lastResponseState` from 3 (error) to 1 (success), allowing the session to load.

Then reload VS Code: `Cmd+Shift+P` → "Developer: Reload Window"

## How It Works

VS Code stores chat data in:
```
~/Library/Application Support/Code - Insiders/User/workspaceStorage/<hash>/
├── state.vscdb                    # SQLite DB with session index
├── chatSessions/
│   └── <session-id>.json          # Full conversation history (can be 100MB+)
└── chatEditingSessions/
    └── <session-id>/
        ├── state.json             # Edit state and file mappings
        └── contents/              # Actual modified file contents
            ├── abc123...          # Content stored by hash
            └── def456...
```

The tool:
1. Reads `state.vscdb` to find the session index
2. Parses `chatSessions/*.json` for conversation history
3. Extracts pending edits from `chatEditingSessions/*/state.json`
4. Recovers actual file content from the `contents/` folder
5. Can patch `lastResponseState` from 3 (error) to 1 (success)

## Storage Locations by OS

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Code/User/workspaceStorage/` |
| macOS (Insiders) | `~/Library/Application Support/Code - Insiders/User/workspaceStorage/` |
| Windows | `%APPDATA%/Code/User/workspaceStorage/` |
| Linux | `~/.config/Code/User/workspaceStorage/` |

## Session States

| State | Meaning |
|-------|--------|
| 0 | Pending |
| 1 | Success |
| 2 | Streaming |
| 3 | Error/Stuck |

## Known Limitations

- Sessions may be split across workspaces when switching between single-folder and multi-folder modes
- The tool can recover data but VS Code may still not display fixed sessions until restart
- Very large sessions (100MB+) may take time to parse
- File content without changes (state=2, accepted) is already saved to disk

## Related VS Code Issues

- [#262313](https://github.com/microsoft/vscode/issues/262313) - Copilot Chat checkpoint restore intermittently fails - data loss risk
- [#282104](https://github.com/microsoft/vscode/issues/282104) - Feature Request: Support local context import/export functionality for Copilot Chat
- [#282782](https://github.com/microsoft/vscode/issues/282782) - Canceling Background Agent worktree dialog clears active chat session

## Contributing

PRs welcome! Ideas for improvement:
- Export full responses (not just user prompts)
- GUI version as VS Code extension
- Automatic backup scheduling
- Session merging between workspaces

## License

MIT
