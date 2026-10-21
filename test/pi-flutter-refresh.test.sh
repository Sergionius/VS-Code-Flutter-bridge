#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/pi/scripts/flutter_refresh.sh"
TEMP_DIRS=()

cleanup() {
  for directory in "${TEMP_DIRS[@]:-}"; do
    rm -rf "$directory"
  done
}
trap cleanup EXIT

NEW_PROJECT=""
new_project() {
  NEW_PROJECT="$(mktemp -d)"
  TEMP_DIRS+=("$NEW_PROJECT")
  mkdir -p "$NEW_PROJECT/lib"
  printf 'name: pi_flutter_bridge_test\nflutter:\n' > "$NEW_PROJECT/pubspec.yaml"
  touch "$NEW_PROJECT/lib/main.dart"
}

run_mock() {
  local status="$1"
  local expected_code="$2"
  local performed_mode="${3:-reload}"
  local project output code responder
  new_project
  project="$NEW_PROJECT"

  python3 - "$project" "$status" "$performed_mode" <<'PY' &
import json
import os
import sys
import time

root, status, performed = sys.argv[1:4]
request_path = os.path.join(root, ".dart_tool", "pi_flutter_refresh", "request.json")
for _ in range(200):
    try:
        with open(request_path, encoding="utf-8") as handle:
            request = json.load(handle)
        break
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.01)
else:
    raise SystemExit("request not found")

assert request["protocolVersion"] == 1
assert request["mode"] == "reload"
assert request["cwd"] == os.path.realpath(root)
response = {
    "protocolVersion": 1,
    "requestId": request["requestId"],
    "status": status,
    "requestedMode": request["mode"],
    "performedMode": performed if status == "ok" else None,
    "message": "mock response",
    "completedAt": int(time.time() * 1000),
}
response_dir = os.path.join(root, ".dart_tool", "pi_flutter_refresh", "responses")
os.makedirs(response_dir, exist_ok=True)
target = os.path.join(response_dir, request["requestId"] + ".json")
temporary = target + ".tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(response, handle)
os.replace(temporary, target)
PY
  responder=$!

  set +e
  output="$(cd "$project" && PI_FLUTTER_REFRESH_TIMEOUT_SECONDS=2 "$HELPER" reload 2>&1)"
  code=$?
  set -e
  wait "$responder"

  if [[ "$code" -ne "$expected_code" ]]; then
    printf 'Unexpected exit code %s, expected %s\n%s\n' "$code" "$expected_code" "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
}

bash -n "$HELPER"
run_mock ok 0 reload | grep -q "OK: Flutter hot reload accepted"
run_mock ok 0 restart | grep -q "OK: Flutter hot restart accepted.*requested reload"
run_mock no_debug_session 3 reload | grep -q "NO_DEBUG_SESSION"

new_project
project="$NEW_PROJECT"
set +e
output="$(cd "$project" && PI_FLUTTER_REFRESH_TIMEOUT_SECONDS=0.2 "$HELPER" reload 2>&1)"
code=$?
set -e
[[ "$code" -eq 8 ]]
grep -q "TIMEOUT" <<<"$output"

new_project
project="$NEW_PROJECT"
mkdir -p "$project/bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "$PI_TEST_CODE_ARGS"\n' > "$project/bin/code"
chmod +x "$project/bin/code"
(cd "$project" && PATH="$project/bin:$PATH" PI_TEST_CODE_ARGS="$project/code-args" PI_FLUTTER_REFRESH_VSCODE=1 "$HELPER" restart >/dev/null)
grep -q -- '--command flutter.hotRestart' "$project/code-args"

printf 'flutter refresh handshake tests: OK\n'
