#!/usr/bin/env python3
"""Shared Pi Flutter Bridge hook for Codex CLI and Claude Code.

Reads one hook-event JSON object from stdin. Codex and Claude Code use
different hook configuration files and tool names, but both send the same
core shape: {"hook_event_name": ..., "session_id": ..., "cwd": ...,
"tool_name": ..., "tool_input": {...}}.

PostToolUse records whether app-relevant files changed during the turn.
Stop performs at most one refresh through the shared sender
(~/.pi-flutter-bridge/bin/flutter_refresh.sh) and always exits 0 so the
agent turn is never accidentally continued (Stop exit 2 requests a
continuation in both agents).

State directory, sender, and this script default to ~/.pi-flutter-bridge and
can be relocated with PI_FLUTTER_BRIDGE_HOME.
"""

import json
import os
import re
import subprocess
import sys
import time

STATE_MAX_AGE_SECONDS = 24 * 60 * 60
SENDER_TIMEOUT_SECONDS = 20

GETTER_RE = re.compile(r"^(?:(?:static|late|final|const|covariant)\s+)*(?:[\w<>?, ]+\s+)?get\s+\w+\b", re.ASCII)
FIELD_RE = re.compile(r"^(?:(?:static|late|final|const|covariant)\s+)*(?:[\w<>?, ]+\s+)+\w+\s*(?:[;=])", re.ASCII)
THIS_RE = re.compile(r"\b(?:required\s+)?this\.\w+\b", re.ASCII)
CONTROL_RE = re.compile(r"^(?:return|throw|await|yield|break|continue|case)\b", re.ASCII)
LOCALE_RE = re.compile(r"(^|/)locale_(ru|en)\.dart$", re.IGNORECASE)
BOOTSTRAP_RE = re.compile(r"(^|/)(bootstrap|di|inject|injection|routes?|router|app_config|firebase_options)\b", re.IGNORECASE)
MODEL_DIR_RE = re.compile(r"(^|/)(models?/|[^/]*_model\.dart$)", re.IGNORECASE)
GEN_FILE_RE = re.compile(r"\.g\.dart$|\.freezed\.dart$")
GEN_BASH_RE = re.compile(r"flutter\s+pub\s+get|dart\s+run\s+build_runner|flutter\s+gen-l10n|fluttergen|build_runner")
BASH_PATH_RE = re.compile(r"\b(lib/[^\s'\"]+\.dart|pubspec\.yaml|assets/|config/)\b")
BASH_MODEL_RE = re.compile(r"\b(?:models?/[^\s'\"]+|[^\s'\"]+_model\.dart)\b", re.IGNORECASE)
PATCH_FILE_RE = re.compile(r"^\*\*\* (Update|Add|Delete) File: (.+)$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def bridge_home():
    return os.environ.get("PI_FLUTTER_BRIDGE_HOME") or os.path.join(os.path.expanduser("~"), ".pi-flutter-bridge")


def find_project_root(start):
    candidate = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.isfile(os.path.join(candidate, "pubspec.yaml")):
            return candidate
        parent = os.path.dirname(candidate)
        if parent == candidate:
            return None
        candidate = parent


def is_flutter_project(cwd):
    root = find_project_root(cwd)
    if root is None:
        return False
    if os.path.isfile(os.path.join(root, "lib", "main.dart")):
        return True
    try:
        with open(os.path.join(root, "pubspec.yaml"), encoding="utf-8") as handle:
            return re.search(r"^\s*flutter:\s*$", handle.read(), re.MULTILINE) is not None
    except OSError:
        return False


def state_directory():
    return os.path.join(bridge_home(), "state")


def sender_path():
    return os.path.join(bridge_home(), "bin", "flutter_refresh.sh")


def state_file(session_id):
    safe = session_id if REQUEST_ID_RE.match(session_id or "") else "default"
    return os.path.join(state_directory(), safe + ".json")


def project_path(cwd, project_root, raw_path):
    """Resolve a tool-reported path (relative to the agent cwd) to a path relative to the project root."""
    if not raw_path:
        return ""
    absolute = raw_path if os.path.isabs(raw_path) else os.path.normpath(os.path.join(cwd, raw_path))
    rel = os.path.relpath(absolute, project_root)
    if rel == os.curdir or rel.startswith("..") or os.path.isabs(rel):
        return absolute
    return rel.replace(os.sep, "/")


def is_app_relevant_path(project_path):
    if not project_path or project_path.startswith("../") or project_path.startswith("/"):
        return False
    if project_path.startswith("test/") or project_path.startswith("docs/"):
        return False
    if project_path in ("pubspec.yaml", "pubspec.lock"):
        return True
    if project_path.startswith("lib/") and project_path.endswith(".dart"):
        return True
    if project_path.startswith("assets/") or project_path.startswith("config/"):
        return True
    if project_path.startswith("lib/l10n/") and project_path.endswith(".arb"):
        return True
    if "/generated/" in project_path or ".g.dart" in project_path or ".freezed.dart" in project_path:
        return True
    return False


def is_restart_path(project_path):
    if project_path in ("pubspec.yaml", "pubspec.lock", "lib/main.dart"):
        return True
    if LOCALE_RE.search(project_path):
        return True
    if BOOTSTRAP_RE.search(project_path):
        return True
    if GEN_FILE_RE.search(project_path):
        return True
    return False


def is_model_path(project_path):
    return project_path.endswith(".dart") and bool(MODEL_DIR_RE.search(project_path))


def adds_class_member(old_text, new_text):
    previous = {line.strip() for line in str(old_text or "").splitlines()}
    for line in str(new_text or "").splitlines():
        added = line.strip()
        if not added or added in previous or CONTROL_RE.match(added):
            continue
        if GETTER_RE.match(added) or FIELD_RE.match(added) or THIS_RE.search(added):
            return True
    return False


def mark_path(result, project_path_value, kind, old_text="", new_text=""):
    if not is_app_relevant_path(project_path_value):
        return
    result["needsRefresh"] = True
    if is_restart_path(project_path_value) or is_model_path(project_path_value):
        result["needsRestart"] = True
        return
    if not project_path_value.endswith(".dart"):
        return
    if kind == "write":
        result["needsRestart"] = True
    elif kind == "edit" and adds_class_member(old_text, new_text):
        result["needsRestart"] = True


def mark_from_patch(result, cwd, project_root, patch_text):
    files = {}
    order = []
    current = None
    for line in str(patch_text or "").splitlines():
        match = PATCH_FILE_RE.match(line)
        if match:
            current = project_path(cwd, project_root, match.group(2))
            files.setdefault(current, {"kind": match.group(1).lower(), "prev": [], "added": []})
            if current not in order:
                order.append(current)
            continue
        if current is None or line.startswith("***") or line.startswith("@@"):
            continue
        if line.startswith("+"):
            files[current]["added"].append(line[1:])
        else:
            files[current]["prev"].append(line[1:] if line[:1] in "+-" else line)
    for name in order:
        entry = files[name]
        if entry["kind"] == "add":
            mark_path(result, name, "write")
        elif entry["kind"] == "delete":
            if is_app_relevant_path(name):
                result["needsRefresh"] = True
                result["needsRestart"] = True
        else:
            mark_path(result, name, "edit", "\n".join(entry["prev"]), "\n".join(entry["added"]))


def mark_from_bash_command(result, command):
    if not command:
        return
    lowered = str(command).lower()
    if GEN_BASH_RE.search(lowered):
        result["needsRefresh"] = True
        result["needsRestart"] = True
        return
    if BASH_PATH_RE.search(command):
        result["needsRefresh"] = True
        if BASH_MODEL_RE.search(command):
            result["needsRestart"] = True


def record_post_tool_use(event):
    cwd = event.get("cwd") or os.getcwd()
    project_root = find_project_root(cwd)
    if project_root is None or not is_flutter_project(cwd):
        return
    tool_name = str(event.get("tool_name") or "")
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}

    result = {"needsRefresh": False, "needsRestart": False}
    if tool_name == "apply_patch":
        mark_from_patch(result, cwd, project_root, tool_input.get("command"))
    elif tool_name in ("Edit", "Write"):
        kind = "write" if tool_name == "Write" else "edit"
        mark_path(
            result,
            project_path(cwd, project_root, tool_input.get("file_path") or tool_input.get("path") or ""),
            kind,
            tool_input.get("old_string") or tool_input.get("oldText") or "",
            tool_input.get("new_string") or tool_input.get("newText") or "",
        )
    elif tool_name == "Bash":
        command = str(tool_input.get("command") or "")
        # An explicit skill invocation already sent the request. Consume the
        # pending turn state so Stop cannot issue the same refresh again.
        if re.search(r"(?:^|[\s/])flutter_refresh\.sh(?:\s|$)", command):
            try:
                os.remove(state_file(event.get("session_id")))
            except OSError:
                pass
            return
        mark_from_bash_command(result, command)
    else:
        return

    if not result["needsRefresh"]:
        return
    merged = {"needsRefresh": False, "needsRestart": False, "updatedAt": int(time.time())}
    try:
        with open(state_file(event.get("session_id")), "r", encoding="utf-8") as handle:
            existing = json.load(handle)
        if isinstance(existing, dict):
            merged["needsRefresh"] = bool(existing.get("needsRefresh"))
            merged["needsRestart"] = bool(existing.get("needsRestart"))
    except (OSError, ValueError):
        pass
    merged["needsRefresh"] = merged["needsRefresh"] or result["needsRefresh"]
    merged["needsRestart"] = merged["needsRestart"] or result["needsRestart"]

    directory = state_directory()
    os.makedirs(directory, exist_ok=True)
    temporary = state_file(event.get("session_id")) + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(merged, handle)
    os.replace(temporary, state_file(event.get("session_id")))


def cleanup_stale_state():
    try:
        entries = os.listdir(state_directory())
    except OSError:
        return
    now = time.time()
    for name in entries:
        path = os.path.join(state_directory(), name)
        try:
            if now - os.path.getmtime(path) > STATE_MAX_AGE_SECONDS:
                os.remove(path)
        except OSError:
            pass


def last_line(text):
    for line in reversed(str(text or "").splitlines()):
        if line.strip():
            return line.strip()
    return ""


def run_refresh(event):
    state_path = state_file(event.get("session_id"))
    try:
        with open(state_path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return {}
    try:
        os.remove(state_path)
    except OSError:
        pass
    cleanup_stale_state()

    if not state.get("needsRefresh"):
        return {}

    if not is_flutter_project(event.get("cwd") or os.getcwd()):
        return {}

    mode = "restart" if state.get("needsRestart") else "reload"
    sender = sender_path()
    if not os.path.isfile(sender):
        return {"systemMessage": "flutter-bridge: sender not installed at %s; run Pi Flutter Bridge: Set Up Agent in VS Code" % sender}

    environment = dict(os.environ)
    environment.setdefault("PI_FLUTTER_REFRESH_TIMEOUT_SECONDS", "10")
    try:
        completed = subprocess.run(
            [sender, mode],
            cwd=event.get("cwd") or os.getcwd(),
            env=environment,
            capture_output=True,
            text=True,
            timeout=SENDER_TIMEOUT_SECONDS,
        )
        # The sender prints REQUESTED on stdout before waiting, but failures
        # such as NO_DEBUG_SESSION and TIMEOUT go to stderr. Never report the
        # request line as if it were a completed refresh.
        summary = (last_line(completed.stderr) if completed.returncode else last_line(completed.stdout))
        summary = summary or last_line(completed.stdout) or "exit code %d" % completed.returncode
        return {"systemMessage": "flutter-bridge: " + summary}
    except subprocess.TimeoutExpired:
        return {"systemMessage": "flutter-bridge: refresh timed out after %ds" % SENDER_TIMEOUT_SECONDS}
    except OSError as error:
        return {"systemMessage": "flutter-bridge: could not run sender: %s" % error}


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(event, dict):
        return 0

    name = event.get("hook_event_name")
    if name == "PostToolUse":
        try:
            record_post_tool_use(event)
        except OSError:
            pass
        return 0
    if name == "Stop":
        output = {}
        try:
            output = run_refresh(event)
        except Exception as error:  # Never fail the turn: exit 2 would continue it.
            output = {"systemMessage": "flutter-bridge hook error: %s" % error}
        print(json.dumps(output))
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
