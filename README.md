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
- **Analyze storage** with visual gauges and breakdown by workspace
- **Timeline view** showing when sessions accumulated
- **Duplicate detection** finding sessions copied across workspaces
- **Deep analysis** of individual sessions (tool usage, tokens, files)
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

### Analyze storage (WinDirStat-style)

```bash
python recover_session.py analyze
```

Output:
```
====================================================================================================
  COPILOT SESSION ANALYSIS
====================================================================================================

  VS Code Variant: VS Code Insiders
  Total Session Storage: 1016.7MB
  Workspaces with Sessions: 25

  Storage Status: 🟡 WARNING
  █████████████████████████████████████████████████░ 1016.7MB / 1.0GB

====================================================================================================
  WORKSPACE BREAKDOWN
====================================================================================================

  djdefi-ops                █████████████████████████    232.9MB ( 22.9%)
    ⚠ 872d3cd2-dce5-40ed-9...    144.2MB [success] Refactoring Autonomous AI
    ⚠ f21bf0c3-1e16-4953-8...     28.7MB [success] Prioritizing Issues and P

  workspace.json            ████████████████████████░    231.7MB ( 22.8%)
    ⚠ bc1e28b1-2334-4ad7-b...    228.4MB [streaming] Improving ghe-console and
```

Shows visual gauges for storage consumption with problem indicators (⚠ for stuck/streaming/pending edits).

### Timeline view

```bash
python recover_session.py timeline
```

Shows when sessions were created and how storage accumulated over time:

```
  Today        ██████████████████████████████    257.1MB (21 sessions, 25.4%)
    [workspace] bc1e28b1 (228.4MB) Improving ghe-console...

  This week    ████████████████████████████░░    247.2MB (35 sessions, 24.4%)
    [enterprise2] bc1e28b1 (158.7MB) Improving ghe-console...

  Older        ███████████████████████████░░░    234.1MB (112 sessions, 23.1%)
```

### Find duplicates

```bash
python recover_session.py duplicates
```

Finds sessions duplicated across workspaces (common when switching workspace modes):

```
  Found 27 sessions duplicated across workspaces
  Total storage in duplicates: 512.4MB

  Session: bc1e28b1-2334-4ad7-b119-b6fa7c62c742
  Duplicated across 3 workspaces, total: 387.1MB
    - enterprise2          (0b18bf20)    158.7MB
    - workspace            (022f45c7)    228.4MB
```

### Deep session analysis

```bash
python recover_session.py deep bc1e28b1
```

Shows detailed breakdown of a single session:

```
  Title: Improving ghe-console and ghe-config-apply performance
  Messages: 336
  Duration: 5.8days
  Started: 8d ago
  Last message: 3d ago

  User input: 46.6KB
  AI response: 12.3MB
  Errors: 2

  Tool Usage:
    read_file                             ████████████████████   847
    run_in_terminal                       █████████░░░░░░░░░░░   423
    semantic_search                       ████░░░░░░░░░░░░░░░░   156

  Estimated Tokens: ~3,000,000 (12.3MB of text)
```

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

## Troubleshooting: gpt-4o-mini Context Summarization

If you notice Copilot making excessive calls to `gpt-4o-mini`, this is VS Code's built-in context summarization trying to compress large chat histories. Symptoms:

- Slow responses
- "Thinking..." appearing frequently
- High CPU usage from extension host

**Cause:** Large sessions (50MB+) force the context window to constantly summarize.

**Solution:** 
1. Run `python recover_session.py analyze` to find bloated sessions
2. Export important sessions: `python recover_session.py export <id>`
3. Start fresh: `Cmd+Shift+P` → "Clear Chat History" (per workspace)

**Prevention:**
- Start new sessions for new topics
- Avoid keeping 100+ message sessions active
- Close VS Code windows you're not using

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
