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
from collections import defaultdict
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


def format_size(bytes_size):
    """Format bytes as human-readable size."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if bytes_size < 1024:
            return f"{bytes_size:.1f}{unit}"
        bytes_size /= 1024
    return f"{bytes_size:.1f}TB"


def format_time_ago(timestamp_ms):
    """Format timestamp as relative time string."""
    if not timestamp_ms:
        return "unknown"
    try:
        dt = datetime.fromtimestamp(timestamp_ms / 1000)
        delta = datetime.now() - dt
        if delta.days > 30:
            return f"{delta.days // 30}mo ago"
        elif delta.days > 0:
            return f"{delta.days}d ago"
        elif delta.seconds > 3600:
            return f"{delta.seconds // 3600}h ago"
        elif delta.seconds > 60:
            return f"{delta.seconds // 60}m ago"
        else:
            return "just now"
    except:
        return "unknown"


def make_bar(value, max_value, width=30, filled='█', empty='░'):
    """Create a text progress bar."""
    if max_value == 0:
        return empty * width
    ratio = min(value / max_value, 1.0)
    filled_count = int(ratio * width)
    return filled * filled_count + empty * (width - filled_count)


def analyze_session_content(file_path):
    """Deep analysis of a session file's content."""
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
        
        requests = data.get('requests', [])
        title = data.get('customTitle', 'Untitled')[:60]
        
        # Handle different request formats
        parsed_requests = []
        for req in requests:
            if isinstance(req, dict):
                parsed_requests.append(req)
            elif isinstance(req, list) and len(req) > 0:
                # Sometimes requests are nested as [[request_data], ...]
                parsed_requests.append(req[0] if isinstance(req[0], dict) else {})
        
        # Timeline
        timestamps = []
        for req in parsed_requests:
            ts = req.get('timestamp')
            if ts:
                timestamps.append(ts)
        
        first_msg = min(timestamps) if timestamps else None
        last_msg = max(timestamps) if timestamps else None
        
        # Analyze content
        tool_usage = defaultdict(int)
        files_touched = set()
        total_user_chars = 0
        total_response_chars = 0
        errors = 0
        
        for req in parsed_requests:
            # User message - handle both dict and nested formats
            message = req.get('message', {})
            if isinstance(message, dict):
                user_text = message.get('text', '')
            elif isinstance(message, list) and message:
                user_text = message[0].get('text', '') if isinstance(message[0], dict) else str(message[0])
            else:
                user_text = str(message) if message else ''
            total_user_chars += len(user_text)
            
            # Response
            response = req.get('response', {})
            if isinstance(response, dict):
                value = response.get('value', [])
                if isinstance(value, list):
                    for part in value:
                        if not isinstance(part, dict):
                            continue
                        kind = part.get('kind', '')
                        
                        if kind == 'toolInvocation':
                            tool_id = part.get('toolId', 'unknown')
                            tool_usage[tool_id] += 1
                        
                        if kind == 'textEditGroup':
                            uri = part.get('uri', '')
                            if uri:
                                path = uri.replace('file://', '').split('/')[-1]
                                files_touched.add(path)
                        
                        if kind == 'markdownContent':
                            content = part.get('content', {})
                            if isinstance(content, dict):
                                val = content.get('value', '')
                                if isinstance(val, str):
                                    total_response_chars += len(val)
                        
                        if kind == 'error':
                            errors += 1
        
        # Duration
        duration_str = "N/A"
        if first_msg and last_msg:
            duration = (last_msg - first_msg) / 1000 / 3600  # hours
            if duration < 1:
                duration_str = f"{int(duration * 60)}min"
            elif duration < 24:
                duration_str = f"{duration:.1f}hrs"
            else:
                duration_str = f"{duration / 24:.1f}days"
        
        return {
            'title': title,
            'num_messages': len(parsed_requests),
            'first_msg': first_msg,
            'last_msg': last_msg,
            'duration': duration_str,
            'tool_usage': dict(tool_usage),
            'files_touched': list(files_touched)[:10],
            'user_chars': total_user_chars,
            'response_chars': total_response_chars,
            'errors': errors
        }
    except Exception as e:
        return {'error': str(e)}


def analyze_sessions(args):
    """Analyze all sessions with size breakdown and visual gauges."""
    storage_path, variant = get_vscode_storage_path()
    if not storage_path:
        print("Error: VS Code storage not found")
        return 1
    
    state_names = {0: 'pending', 1: 'success', 2: 'streaming', 3: 'STUCK'}
    
    # Collect workspace data
    workspaces = []
    
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        # Get workspace info
        ws_name = "Unknown"
        ws_folder = ""
        ws_json = ws_dir / "workspace.json"
        if ws_json.exists():
            try:
                data = json.load(open(ws_json))
                ws_folder = data.get('folder', data.get('workspace', ''))
                ws_name = ws_folder.replace('file://', '').split('/')[-1] or "multi-root"
            except:
                pass
        
        # Get session index
        db_path = ws_dir / "state.vscdb"
        session_index = get_session_index(str(db_path)) if db_path.exists() else None
        
        sessions = []
        if session_index and session_index.get('entries'):
            for sid, info in session_index['entries'].items():
                chat_file = ws_dir / "chatSessions" / f"{sid}.json"
                file_size = chat_file.stat().st_size if chat_file.exists() else 0
                
                sessions.append({
                    'id': sid,
                    'title': info.get('title', 'Untitled')[:50] if info.get('title') else 'Untitled',
                    'state': info.get('lastResponseState', -1),
                    'has_pending': info.get('hasPendingEdits', False),
                    'last_msg_date': info.get('lastMessageDate'),
                    'file_size': file_size,
                    'file_path': str(chat_file) if chat_file.exists() else None
                })
        
        if sessions:
            total_size = sum(s['file_size'] for s in sessions)
            workspaces.append({
                'name': ws_name,
                'hash': ws_dir.name[:8],
                'folder': ws_folder,
                'path': str(ws_dir),
                'sessions': sessions,
                'total_size': total_size
            })
    
    # Sort by total size
    workspaces.sort(key=lambda x: x['total_size'], reverse=True)
    
    # Calculate totals for the gauge
    grand_total = sum(ws['total_size'] for ws in workspaces)
    max_ws_size = max((ws['total_size'] for ws in workspaces), default=0)
    
    # Print header
    print("=" * 100)
    print("  COPILOT SESSION ANALYSIS")
    print("=" * 100)
    print()
    print(f"  VS Code Variant: {variant}")
    print(f"  Total Session Storage: {format_size(grand_total)}")
    print(f"  Workspaces with Sessions: {len(workspaces)}")
    print()
    
    # Overall gauge
    warning_threshold = 500 * 1024 * 1024  # 500MB
    danger_threshold = 1024 * 1024 * 1024  # 1GB
    
    if grand_total > danger_threshold:
        status = "🔴 CRITICAL"
    elif grand_total > warning_threshold:
        status = "🟡 WARNING"
    else:
        status = "🟢 OK"
    
    print(f"  Storage Status: {status}")
    print(f"  {make_bar(grand_total, danger_threshold, 50)} {format_size(grand_total)} / {format_size(danger_threshold)}")
    print()
    
    # Workspace breakdown
    print("=" * 100)
    print("  WORKSPACE BREAKDOWN")
    print("=" * 100)
    print()
    
    for ws in workspaces[:15]:  # Top 15 workspaces
        if ws['total_size'] < 100 * 1024:  # Skip < 100KB
            continue
        
        pct = (ws['total_size'] / grand_total * 100) if grand_total > 0 else 0
        bar = make_bar(ws['total_size'], max_ws_size, 25)
        
        print(f"  {ws['name'][:25]:<25} {bar} {format_size(ws['total_size']):>10} ({pct:5.1f}%)")
        
        # Show top sessions in this workspace
        top_sessions = sorted(ws['sessions'], key=lambda x: x['file_size'], reverse=True)[:3]
        for s in top_sessions:
            if s['file_size'] < 1024 * 1024:  # Skip < 1MB
                continue
            state = state_names.get(s['state'], '?')
            flag = "⚠" if s['state'] == 3 or s['has_pending'] else " "
            print(f"    {flag} {s['id'][:20]}... {format_size(s['file_size']):>10} [{state}] {s['title'][:25]}")
        print()
    
    # Problem sessions
    print("=" * 100)
    print("  PROBLEM SESSIONS (stuck, streaming, or >50MB)")
    print("=" * 100)
    print()
    
    problem_sessions = []
    for ws in workspaces:
        for s in ws['sessions']:
            is_problem = (
                s['state'] in [2, 3] or  # streaming or stuck
                s['has_pending'] or
                s['file_size'] > 50 * 1024 * 1024  # > 50MB
            )
            if is_problem:
                problem_sessions.append({**s, 'workspace': ws['name']})
    
    problem_sessions.sort(key=lambda x: x['file_size'], reverse=True)
    
    if problem_sessions:
        print(f"  {'Session ID':<26} {'Workspace':<20} {'Size':>10} {'State':<10} Issue")
        print("  " + "-" * 90)
        
        for s in problem_sessions[:20]:
            state = state_names.get(s['state'], '?')
            issues = []
            if s['state'] == 3:
                issues.append("STUCK")
            if s['state'] == 2:
                issues.append("streaming")
            if s['has_pending']:
                issues.append("pending edits")
            if s['file_size'] > 50 * 1024 * 1024:
                issues.append("huge")
            
            print(f"  {s['id'][:24]}.. {s['workspace'][:18]:<20} {format_size(s['file_size']):>10} {state:<10} {', '.join(issues)}")
    else:
        print("  No problem sessions found!")
    
    print()
    return 0


def timeline_sessions(args):
    """Show session timeline - when did storage build up."""
    storage_path, _ = get_vscode_storage_path()
    if not storage_path:
        print("Error: VS Code storage not found")
        return 1
    
    now = datetime.now().timestamp() * 1000
    
    age_buckets = {
        'Today': {'max_days': 1, 'sessions': [], 'size': 0},
        'Yesterday': {'max_days': 2, 'sessions': [], 'size': 0},
        'This week': {'max_days': 7, 'sessions': [], 'size': 0},
        'This month': {'max_days': 30, 'sessions': [], 'size': 0},
        'Older': {'max_days': float('inf'), 'sessions': [], 'size': 0}
    }
    
    # Collect all sessions
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        ws_json = ws_dir / "workspace.json"
        ws_name = "Unknown"
        if ws_json.exists():
            try:
                data = json.load(open(ws_json))
                ws_name = data.get('folder', '').replace('file://', '').split('/')[-1] or "workspace"
            except:
                pass
        
        db_path = ws_dir / "state.vscdb"
        session_index = get_session_index(str(db_path)) if db_path.exists() else None
        
        if not session_index or 'entries' not in session_index:
            continue
        
        for sid, info in session_index['entries'].items():
            chat_file = ws_dir / "chatSessions" / f"{sid}.json"
            file_size = chat_file.stat().st_size if chat_file.exists() else 0
            last_date = info.get('lastMessageDate')
            
            if not last_date:
                continue
            
            age_days = (now - last_date) / 1000 / 86400
            
            entry = {
                'workspace': ws_name[:15],
                'id': sid[:8],
                'size': file_size,
                'title': (info.get('title') or 'Untitled')[:30]
            }
            
            for period, bucket in age_buckets.items():
                prev_max = 0
                for p, b in age_buckets.items():
                    if p == period:
                        break
                    prev_max = b['max_days']
                
                if prev_max <= age_days < bucket['max_days']:
                    bucket['sessions'].append(entry)
                    bucket['size'] += file_size
                    break
    
    # Print timeline
    print("=" * 100)
    print("  SESSION TIMELINE")
    print("=" * 100)
    print()
    
    total_all = sum(b['size'] for b in age_buckets.values())
    max_size = max((b['size'] for b in age_buckets.values()), default=0)
    
    for period, bucket in age_buckets.items():
        if not bucket['sessions']:
            continue
        
        bar = make_bar(bucket['size'], max_size, 30)
        pct = (bucket['size'] / total_all * 100) if total_all > 0 else 0
        
        print(f"  {period:<12} {bar} {format_size(bucket['size']):>10} ({len(bucket['sessions'])} sessions, {pct:.1f}%)")
        
        # Top 3 by size
        top = sorted(bucket['sessions'], key=lambda x: -x['size'])[:3]
        for s in top:
            print(f"    [{s['workspace']:<15}] {s['id']} ({format_size(s['size']):>8}) {s['title']}")
        print()
    
    return 0


def duplicates_sessions(args):
    """Find duplicate sessions across workspaces."""
    storage_path, _ = get_vscode_storage_path()
    if not storage_path:
        print("Error: VS Code storage not found")
        return 1
    
    session_locations = defaultdict(list)
    
    # Collect all session locations
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        ws_json = ws_dir / "workspace.json"
        ws_name = "Unknown"
        if ws_json.exists():
            try:
                data = json.load(open(ws_json))
                ws_name = data.get('folder', '').replace('file://', '').split('/')[-1] or "workspace"
            except:
                pass
        
        db_path = ws_dir / "state.vscdb"
        session_index = get_session_index(str(db_path)) if db_path.exists() else None
        
        if not session_index or 'entries' not in session_index:
            continue
        
        for sid, info in session_index['entries'].items():
            chat_file = ws_dir / "chatSessions" / f"{sid}.json"
            file_size = chat_file.stat().st_size if chat_file.exists() else 0
            
            session_locations[sid].append({
                'workspace': ws_name,
                'hash': ws_dir.name[:8],
                'size': file_size,
                'path': str(chat_file)
            })
    
    # Find duplicates
    duplicates = {sid: locs for sid, locs in session_locations.items() if len(locs) > 1}
    
    print("=" * 100)
    print("  DUPLICATE SESSIONS")
    print("=" * 100)
    print()
    
    if not duplicates:
        print("  No duplicate sessions found!")
        return 0
    
    # Sort by total wasted space
    sorted_dups = sorted(
        duplicates.items(),
        key=lambda x: sum(l['size'] for l in x[1]),
        reverse=True
    )
    
    total_wasted = sum(sum(l['size'] for l in locs) for _, locs in sorted_dups)
    print(f"  Found {len(duplicates)} sessions duplicated across workspaces")
    print(f"  Total storage in duplicates: {format_size(total_wasted)}")
    print()
    
    for sid, locs in sorted_dups[:15]:
        total = sum(l['size'] for l in locs)
        print(f"  Session: {sid[:36]}")
        print(f"  Duplicated across {len(locs)} workspaces, total: {format_size(total)}")
        for loc in locs:
            print(f"    - {loc['workspace'][:20]:<20} ({loc['hash']}) {format_size(loc['size']):>10}")
        print()
    
    return 0


def deep_session(args):
    """Deep analysis of a specific session's content."""
    storage_path, _ = get_vscode_storage_path()
    session_id = args.session_id
    
    # Find session file
    for ws_dir in storage_path.iterdir():
        if not ws_dir.is_dir():
            continue
        
        # Check if this session exists here
        db_path = ws_dir / "state.vscdb"
        if not db_path.exists():
            continue
        
        index = get_session_index(str(db_path))
        if not index:
            continue
        
        for sid, info in index.get('entries', {}).items():
            if session_id in sid:
                chat_file = ws_dir / "chatSessions" / f"{sid}.json"
                
                if not chat_file.exists():
                    print(f"Session index found but no chat file at: {chat_file}")
                    continue
                
                file_size = chat_file.stat().st_size
                
                print("=" * 100)
                print(f"  DEEP ANALYSIS: {sid[:36]}")
                print("=" * 100)
                print()
                print(f"  File: {chat_file}")
                print(f"  Size: {format_size(file_size)}")
                print()
                
                analysis = analyze_session_content(str(chat_file))
                
                if 'error' in analysis:
                    print(f"  Error analyzing: {analysis['error']}")
                    return 1
                
                print(f"  Title: {analysis['title']}")
                print(f"  Messages: {analysis['num_messages']}")
                print(f"  Duration: {analysis['duration']}")
                print(f"  Started: {format_time_ago(analysis['first_msg'])}")
                print(f"  Last message: {format_time_ago(analysis['last_msg'])}")
                print()
                print(f"  User input: {format_size(analysis['user_chars'])}")
                print(f"  AI response: {format_size(analysis['response_chars'])}")
                print(f"  Errors: {analysis['errors']}")
                print()
                
                if analysis['tool_usage']:
                    print("  Tool Usage:")
                    for tool, count in sorted(analysis['tool_usage'].items(), key=lambda x: -x[1])[:15]:
                        bar = make_bar(count, max(analysis['tool_usage'].values()), 20)
                        print(f"    {tool[:35]:<35} {bar} {count:>5}")
                    print()
                
                if analysis['files_touched']:
                    print("  Files Touched:")
                    for f in analysis['files_touched']:
                        print(f"    - {f}")
                
                print()
                
                # Estimate token usage (rough: 4 chars per token)
                total_chars = analysis['user_chars'] + analysis['response_chars']
                est_tokens = total_chars // 4
                print(f"  Estimated Tokens: ~{est_tokens:,} ({format_size(total_chars)} of text)")
                
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
    
    # analyze - new visual analysis
    analyze_parser = subparsers.add_parser("analyze", help="Analyze all sessions with size gauges")
    analyze_parser.set_defaults(func=analyze_sessions)
    
    # timeline - when did sessions build up
    timeline_parser = subparsers.add_parser("timeline", help="Show session timeline")
    timeline_parser.set_defaults(func=timeline_sessions)
    
    # duplicates - find duplicate sessions
    dups_parser = subparsers.add_parser("duplicates", help="Find duplicate sessions across workspaces")
    dups_parser.set_defaults(func=duplicates_sessions)
    
    # deep - deep dive into a specific session
    deep_parser = subparsers.add_parser("deep", help="Deep analysis of a specific session")
    deep_parser.add_argument("session_id", help="Session ID (partial match OK)")
    deep_parser.set_defaults(func=deep_session)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return 1
    
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
