#!/usr/bin/env bash
set -u

mode="${1:-reload}"
case "$mode" in
  reload|restart) ;;
  *)
    echo "FAILED: unknown mode '$mode' (expected reload|restart)" >&2
    exit 2
    ;;
esac

if [[ ! -f "pubspec.yaml" ]]; then
  echo "SKIPPED: pubspec.yaml not found in $(pwd)"
  exit 0
fi

if ! grep -Eq '^[[:space:]]*flutter:[[:space:]]*$' pubspec.yaml && [[ ! -f "lib/main.dart" ]]; then
  echo "SKIPPED: this does not look like a Flutter app"
  exit 0
fi

LAST_CHANNEL=""

run_custom_command() {
  local requested_mode="$1"
  PI_FLUTTER_REFRESH_MODE="$requested_mode" bash -lc "$PI_FLUTTER_REFRESH_COMMAND"
}

run_project_bridge() {
  local requested_mode="$1"
  local bridge=""

  if [[ -x ".pi/flutter_refresh.sh" ]]; then
    bridge=".pi/flutter_refresh.sh"
  elif [[ -x "scripts/flutter_refresh.sh" ]]; then
    bridge="scripts/flutter_refresh.sh"
  else
    return 127
  fi

  PI_FLUTTER_REFRESH_MODE="$requested_mode" "$bridge" "$requested_mode"
}

run_vscode_command() {
  local requested_mode="$1"
  local command_id="dart.hotReload"
  [[ "$requested_mode" == "restart" ]] && command_id="flutter.hotRestart"

  if [[ "${PI_FLUTTER_REFRESH_VSCODE:-0}" != "1" ]]; then
    return 127
  fi
  if ! command -v code >/dev/null 2>&1; then
    echo "SKIPPED: PI_FLUTTER_REFRESH_VSCODE=1 but 'code' is not on PATH"
    return 127
  fi

  code --reuse-window --command "$command_id" >/dev/null
}

write_signal_file_and_wait() {
  local requested_mode="$1"
  local signal_file="${PI_FLUTTER_REFRESH_SIGNAL_FILE:-.dart_tool/pi_flutter_refresh/request.json}"
  local timeout_seconds="${PI_FLUTTER_REFRESH_TIMEOUT_SECONDS:-10}"

  python3 - "$signal_file" "$requested_mode" "$(pwd)" "$timeout_seconds" <<'PY'
import json
import os
import sys
import time
import uuid

signal_path, mode, cwd, timeout_raw = sys.argv[1:5]
try:
    timeout = max(0.1, float(timeout_raw))
except ValueError:
    print(f"INVALID_CONFIG: PI_FLUTTER_REFRESH_TIMEOUT_SECONDS must be numeric, got {timeout_raw!r}", file=sys.stderr)
    raise SystemExit(2)

request_id = str(uuid.uuid4())
request = {
    "protocolVersion": 1,
    "requestId": request_id,
    "mode": mode,
    "cwd": os.path.realpath(cwd),
    "createdAt": int(time.time() * 1000),
}

signal_path = os.path.abspath(signal_path)
signal_dir = os.path.dirname(signal_path)
response_path = os.path.join(signal_dir, "responses", f"{request_id}.json")
os.makedirs(signal_dir, exist_ok=True)
os.makedirs(os.path.dirname(response_path), exist_ok=True)

temporary_path = f"{signal_path}.{request_id}.tmp"
with open(temporary_path, "w", encoding="utf-8") as handle:
    json.dump(request, handle, ensure_ascii=False)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary_path, signal_path)
print(f"REQUESTED: Flutter hot {mode} ({request_id})", flush=True)

statuses = {
    "no_debug_session": (3, "NO_DEBUG_SESSION"),
    "workspace_mismatch": (4, "WORKSPACE_MISMATCH"),
    "invalid_request": (5, "INVALID_REQUEST"),
    "command_failed": (6, "COMMAND_FAILED"),
}
deadline = time.monotonic() + timeout
while time.monotonic() < deadline:
    try:
        with open(response_path, "r", encoding="utf-8") as handle:
            response = json.load(handle)
    except FileNotFoundError:
        time.sleep(0.1)
        continue
    except (json.JSONDecodeError, OSError):
        time.sleep(0.1)
        continue

    if response.get("requestId") != request_id:
        time.sleep(0.1)
        continue

    status = response.get("status")
    message = str(response.get("message") or "No details")
    if status == "ok":
        performed = response.get("performedMode") or mode
        suffix = f"; requested {mode}" if performed != mode else ""
        print(f"OK: Flutter hot {performed} accepted by Dart-Code{suffix}")
        raise SystemExit(0)

    exit_code, label = statuses.get(status, (7, "UNKNOWN_RESPONSE"))
    print(f"{label}: {message}", file=sys.stderr)
    raise SystemExit(exit_code)

print(f"TIMEOUT: no VS Code bridge response after {timeout:g}s ({request_id})", file=sys.stderr)
raise SystemExit(8)
PY
}

try_once() {
  local requested_mode="$1"
  local code

  if [[ -n "${PI_FLUTTER_REFRESH_COMMAND:-}" ]]; then
    LAST_CHANNEL="custom"
    run_custom_command "$requested_mode"
    return $?
  fi

  LAST_CHANNEL="project"
  run_project_bridge "$requested_mode"
  code=$?
  [[ $code -ne 127 ]] && return $code

  LAST_CHANNEL="vscode-cli"
  run_vscode_command "$requested_mode"
  code=$?
  [[ $code -ne 127 ]] && return $code

  LAST_CHANNEL="signal"
  write_signal_file_and_wait "$requested_mode"
}

if [[ "$mode" == "restart" ]]; then
  try_once restart
  code=$?
  if [[ $code -eq 0 ]]; then
    [[ "$LAST_CHANNEL" == "signal" ]] || echo "OK: Flutter hot restart command completed"
    exit 0
  fi
  [[ "$LAST_CHANNEL" == "signal" ]] || echo "FAILED: Flutter hot restart failed" >&2
  exit "$code"
fi

try_once reload
code=$?
if [[ $code -eq 0 ]]; then
  [[ "$LAST_CHANNEL" == "signal" ]] || echo "OK: Flutter hot reload command completed"
  exit 0
fi

# Protocol-aware VS Code bridge performs its own reload-to-restart fallback and
# uses reserved exit codes >=3 for confirmed failures. Do not issue duplicates.
if [[ "$LAST_CHANNEL" == "signal" || $code -ge 3 ]]; then
  exit "$code"
fi

echo "WARN: Flutter hot reload failed; trying hot restart" >&2
try_once restart
code=$?
if [[ $code -eq 0 ]]; then
  echo "OK: Flutter hot restart command completed after reload failure"
  exit 0
fi
echo "FAILED: Flutter hot reload and hot restart failed" >&2
exit "$code"
