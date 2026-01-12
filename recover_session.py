#!/usr/bin/env python3
"""
VS Code Copilot Chat Session Recovery Tool
==========================================

Recovers stuck or broken Copilot Chat sessions from VS Code's internal storage.

Supports:
- Listing all chat sessions
- Extracting pending file edits
- Exporting chat history to markdown
- Fixing stuck session states (lastResponseState)
- Copying missing session files between workspaces

Usage:
    python recover_session.py list                    # List all sessions
    python recover_session.py show <session_id>      # Show session details
    python recover_session.py export <session_id>    # Export chat history
    python recover_session.py recover <session_id>   # Recover pending files
    python recover_session.py fix <session_id>       # Fix stuck session state

Author: Created during a recovery session, January 2026
License: MIT
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote


def get_vscode_storage_path():
    """Get the VS Code storage path based on OS and variant."""
    home = Path.home()
    
    # Check for different VS Code variants
    variants = [
        ("Code - Insiders", "VS Code Insiders"),
        ("Code", "VS Code"),
        ("VSCodium", "VSCodium"),
    ]
    
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", ""))
    else:  # Linux
        base = home / ".config"
    
    for folder, name in variants:
        path = base / folder / "User" / "workspaceStorage"
        if path.exists():
            return path, name
    
    return None, None


def find_workspace_by_path(storage_path, folder_path):
    """Find workspace storage by folder path."""
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        workspace_json = ws_dir / "workspace.json"
        if workspace_json.exists():
            try:
                with open(workspace_json) as f:
                    data = json.load(f)
                folder = data.get("folder", "")
                workspace = data.get("workspace", "")
                if folder_path in folder or folder_path in workspace:
                    return ws_dir
            except:
                pass
    return None


def get_session_index(db_path):
    """Read the chat session index from the SQLite database."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'")
    result = cursor.fetchone()
    conn.close()
    
    if result:
        return json.loads(result[0])
    return None


def list_sessions(args):
    """List all chat sessions in all workspaces."""
    storage_path, variant = get_vscode_storage_path()
    if not storage_path:
        print("Error: VS Code storage not found")
        return 1
    
    print(f"VS Code variant: {variant}")
    print(f"Storage path: {storage_path}\n")
    
    all_sessions = []
    
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        db_path = ws_dir / "state.vscdb"
        if not db_path.exists():
            continue
        
        # Get workspace info
        workspace_json = ws_dir / "workspace.json"
        workspace_name = "Unknown"
        if workspace_json.exists():
            try:
                with open(workspace_json) as f:
                    data = json.load(f)
                workspace_name = data.get("folder", data.get("workspace", "Unknown"))
                workspace_name = workspace_name.replace("file://", "").split("/")[-1]
            except:
                pass
        
        # Get session index
        try:
            index = get_session_index(db_path)
            if index and "entries" in index:
                for sid, info in index["entries"].items():
                    info["_workspace"] = workspace_name
                    info["_ws_dir"] = str(ws_dir)
                    all_sessions.append(info)
        except:
            pass
    
    # Sort by last message date
    all_sessions.sort(key=lambda x: x.get("lastMessageDate", 0), reverse=True)
    
    # State names
    state_names = {0: "pending", 1: "success", 2: "streaming", 3: "error/stuck"}
    
    print(f"Found {len(all_sessions)} sessions:\n")
    print(f"{'ID':<40} {'State':<12} {'Files':<6} {'Title':<40}")
    print("-" * 100)
    
    for s in all_sessions[:50]:  # Show top 50
        sid = s.get("sessionId", "?")[:36]
        state = state_names.get(s.get("lastResponseState", -1), "unknown")
        stats = s.get("stats", {})
        files = stats.get("fileCount", 0) if stats else 0
        title = s.get("title", "Untitled")[:38]
        pending = "*" if s.get("hasPendingEdits") else " "
        
        print(f"{pending}{sid:<39} {state:<12} {files:<6} {title}")
    
    print("\n* = has pending edits")
    return 0


def show_session(args):
    """Show details of a specific session."""
    storage_path, _ = get_vscode_storage_path()
    if not storage_path:
        print("Error: VS Code storage not found")
        return 1
    
    session_id = args.session_id
    
    # Find the session
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        db_path = ws_dir / "state.vscdb"
        if not db_path.exists():
            continue
        
        index = get_session_index(db_path)
        if not index:
            continue
        
        for sid, info in index.get("entries", {}).items():
            if session_id in sid:
                print(f"Session: {sid}")
                print(f"Title: {info.get('title')}")
                print(f"Last Response State: {info.get('lastResponseState')} (3=stuck)")
                print(f"Has Pending Edits: {info.get('hasPendingEdits')}")
                print(f"Stats: {info.get('stats')}")
                
                # Check for chat history
                chat_file = ws_dir / "chatSessions" / f"{sid}.json"
                if chat_file.exists():
                    size = chat_file.stat().st_size
                    print(f"\nChat history: {chat_file}")
                    print(f"Size: {size / 1024 / 1024:.2f} MB")
                
                # Check for editing session
                edit_dir = ws_dir / "chatEditingSessions" / sid
                if edit_dir.exists():
                    state_file = edit_dir / "state.json"
                    if state_file.exists():
                        with open(state_file) as f:
                            state = json.load(f)
                        snapshot = state.get("recentSnapshot", {})
                        entries = snapshot.get("entries", [])
                        print(f"\nPending file edits: {len(entries)}")
                        for entry in entries:
                            if isinstance(entry, dict):
                                uri = entry.get("resource", "")
                                s = entry.get("state", -1)
                                orig = entry.get("originalHash", "")
                                curr = entry.get("currentHash", "")
                                changed = "*" if orig != curr else " "
                                path = unquote(uri.replace("file://", ""))
                                print(f"  {changed}[{s}] {path}")
                
                return 0
    
    print(f"Session {session_id} not found")
    return 1


def export_session(args):
    """Export chat history to markdown."""
    storage_path, _ = get_vscode_storage_path()
    session_id = args.session_id
    output_dir = Path(args.output) if args.output else Path.cwd()
    
    # Find chat history file
    for ws_dir in storage_path.iterdir():
        chat_file = ws_dir / "chatSessions" / f"{session_id}.json"
        if chat_file.exists():
            print(f"Found: {chat_file}")
            
            with open(chat_file) as f:
                data = json.load(f)
            
            requests = data.get("requests", [])
            output_file = output_dir / f"chat_history_{session_id[:8]}.md"
            
            with open(output_file, "w") as out:
                out.write(f"# Chat Session: {data.get('customTitle', 'Untitled')}\n\n")
                out.write(f"**Session ID:** `{session_id}`\n")
                out.write(f"**Messages:** {len(requests)}\n\n---\n\n")
                
                for i, req in enumerate(requests):
                    msg = req.get("message", {})
                    text = msg.get("text", "")
                    ts = req.get("timestamp", 0)
                    dt = datetime.fromtimestamp(ts/1000) if ts else None
                    
                    out.write(f"## [{i+1}] {dt.strftime('%Y-%m-%d %H:%M') if dt else 'N/A'}\n\n")
                    out.write(f"**User:** {text}\n\n")
                    out.write("---\n\n")
            
            print(f"Exported {len(requests)} messages to {output_file}")
            return 0
    
    print(f"Chat history for {session_id} not found")
    return 1


def recover_files(args):
    """Recover pending file edits from a session."""
    storage_path, _ = get_vscode_storage_path()
    session_id = args.session_id
    output_dir = Path(args.output) if args.output else Path.cwd() / "recovered_files"
    
    for ws_dir in storage_path.iterdir():
        edit_dir = ws_dir / "chatEditingSessions" / session_id
        if edit_dir.exists():
            state_file = edit_dir / "state.json"
            contents_dir = edit_dir / "contents"
            
            if not state_file.exists():
                continue
            
            with open(state_file) as f:
                state = json.load(f)
            
            snapshot = state.get("recentSnapshot", {})
            entries = snapshot.get("entries", [])
            
            recovered = 0
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                
                orig = entry.get("originalHash", "")
                curr = entry.get("currentHash", "")
                
                if orig != curr:  # Has changes
                    uri = entry.get("resource", "")
                    path = unquote(uri.replace("file://", ""))
                    content_file = contents_dir / curr
                    
                    if content_file.exists():
                        # Determine output path
                        rel_path = path.lstrip("/")
                        out_path = output_dir / rel_path
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy(content_file, out_path)
                        print(f"Recovered: {rel_path}")
                        recovered += 1
            
            print(f"\nRecovered {recovered} files to {output_dir}")
            return 0
    
    print(f"Editing session {session_id} not found")
    return 1


def fix_session(args):
    """Fix a stuck session by resetting lastResponseState."""
    storage_path, _ = get_vscode_storage_path()
    session_id = args.session_id
    
    for ws_dir in storage_path.iterdir():
        db_path = ws_dir / "state.vscdb"
        if not db_path.exists():
            continue
        
        index = get_session_index(db_path)
        if not index:
            continue
        
        for sid, info in index.get("entries", {}).items():
            if session_id in sid:
                old_state = info.get("lastResponseState")
                if old_state != 3:
                    print(f"Session state is {old_state}, not stuck (3)")
                    return 0
                
                # Create backup
                backup = db_path.with_suffix(".vscdb.recovery_backup")
                if not backup.exists():
                    shutil.copy(db_path, backup)
                    print(f"Created backup: {backup}")
                
                # Fix the state
                info["lastResponseState"] = 1
                
                conn = sqlite3.connect(db_path, isolation_level=None)
                cursor = conn.cursor()
                cursor.execute("BEGIN EXCLUSIVE")
                cursor.execute(
                    "UPDATE ItemTable SET value = ? WHERE key = 'chat.ChatSessionStore.index'",
                    (json.dumps(index),)
                )
                cursor.execute("COMMIT")
                conn.close()
                
                print(f"Fixed session {sid}")
                print(f"lastResponseState: {old_state} -> 1")
                print("\nReload VS Code (Cmd+Shift+P -> Developer: Reload Window)")
                return 0
    
    print(f"Session {session_id} not found")
    return 1


def main():
    parser = argparse.ArgumentParser(
        description="VS Code Copilot Chat Session Recovery Tool"
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # list
    list_parser = subparsers.add_parser("list", help="List all sessions")
    list_parser.set_defaults(func=list_sessions)
    
    # show
    show_parser = subparsers.add_parser("show", help="Show session details")
    show_parser.add_argument("session_id", help="Session ID (partial match OK)")
    show_parser.set_defaults(func=show_session)
    
    # export
    export_parser = subparsers.add_parser("export", help="Export chat history")
    export_parser.add_argument("session_id", help="Session ID")
    export_parser.add_argument("-o", "--output", help="Output directory")
    export_parser.set_defaults(func=export_session)
    
    # recover
    recover_parser = subparsers.add_parser("recover", help="Recover pending files")
    recover_parser.add_argument("session_id", help="Session ID")
    recover_parser.add_argument("-o", "--output", help="Output directory")
    recover_parser.set_defaults(func=recover_files)
    
    # fix
    fix_parser = subparsers.add_parser("fix", help="Fix stuck session state")
    fix_parser.add_argument("session_id", help="Session ID")
    fix_parser.set_defaults(func=fix_session)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
