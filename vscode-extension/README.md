# Copilot Session Recovery - VS Code Extension

A VS Code extension to recover stuck or broken Copilot Chat sessions directly from the editor.

## Features

### Session Browser
Browse all Copilot Chat sessions across workspaces in a dedicated tree view:

- 🔴 **Error icons** for stuck sessions (state 3)
- ✏️ **Edit icons** for sessions with pending changes
- ✅ **Pass icons** for healthy sessions

### Command Palette

All commands available via `Cmd+Shift+P` → "Copilot Recovery":

| Command | Description |
|---------|-------------|
| **List Sessions** | Quick pick to browse all sessions |
| **Show Details** | View session metadata, pending files |
| **Export Chat** | Export history to markdown (prompts or full) |
| **Recover Files** | Extract pending file edits to disk |
| **Fix Session** | Reset stuck state from 3 to 1 |
| **Backup Session** | Full backup of session + chat + files |

### Context Menu

Right-click any session in the tree view for quick actions.

## Installation

### From Source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` to launch the Extension Development Host.

### From VSIX

```bash
npm run package
code --install-extension copilot-session-recovery-0.1.0.vsix
```

## Architecture

```
src/
├── extension.ts        # Entry point, command registration
├── sessionProvider.ts  # Tree data provider for session list
└── sessionRecovery.ts  # Core recovery logic (TypeScript port of CLI)
```

The extension uses `better-sqlite3` to read VS Code's internal SQLite databases.

## Requirements

- VS Code 1.85.0+
- Node.js 18+ (for `better-sqlite3` compilation)

## Known Issues

- Tree view requires manual refresh after fixing a session
- Large sessions (100MB+) may take a moment to parse
- `better-sqlite3` requires native compilation

## Contributing

See the main [README](../README.md) for contribution guidelines.

## License

MIT
