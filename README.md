# Flutter Agent Refresh

VS Code extension that lets coding agents refresh a running Flutter app with a confirmed hot reload or hot restart. One shared sender and one setup wizard serve three agents: [Pi](https://pi.dev), Codex CLI, and Claude Code. The extension is not published to the VS Code Marketplace yet; see [Install](#install).

## How it works

1. An agent (or the Pi package automatically) runs the shared sender `~/.pi-flutter-bridge/bin/flutter_refresh.sh <reload|restart>`.
2. The sender atomically writes `.dart_tool/pi_flutter_refresh/request.json` with a unique request ID and waits for the answer.
3. The extension validates the request and checks that the active debug session is a Dart session from the same workspace.
4. It invokes `dart.hotReload` or `flutter.hotRestart`.
5. It atomically writes `.dart_tool/pi_flutter_refresh/responses/<requestId>.json`.
6. The sender reports the confirmed result or times out instead of claiming success after only writing a file.

A successful response confirms that Dart-Code accepted the command. It does not guarantee that the next Flutter frame has already rendered. Hot reload falls back to hot restart when `piFlutterRefreshBridge.reloadFallbackToRestart` is enabled and the reload command throws.

Sender exit codes: `0` confirmed (`SKIPPED`/`WARN` lines are non-fatal) · `2` usage error · `3` no debug session · `4` workspace mismatch · `5` invalid request · `6` command failed · `8` timeout.

The bridge watches a workspace-local file under `.dart_tool`, so requests should come only from a trusted workspace.

## Install

**Marketplace (once published):** search for “Flutter Agent Refresh” in the Extensions view. Until then, install from source:

```bash
git clone https://github.com/Sergionius/flutter-agent-refresh.git
cd flutter-agent-refresh
npx @vscode/vsce package
code --install-extension flutter-agent-refresh-0.4.1.vsix
```

Requires VS Code 1.80+, the Dart/Flutter extension, Bash, Python 3, and Node.js 22.19+ for development. The Pi integration additionally requires the `pi` CLI.

On activation the extension installs the shared sender at `~/.pi-flutter-bridge/` and keeps it up to date, so agent integrations never reference the versioned Marketplace extension folder.

### Migrating from the pre-0.4 local copy

If you previously ran `/pi-flutter-bridge-sync`, remove the old `local.pi-flutter-refresh-bridge-*` folder from your VS Code extensions directory after installing this version, then reload the window. **Flutter Agent Refresh: Diagnose** warns when two copies of the extension are active.

## Set up an agent

Run **Flutter Agent Refresh: Set Up Agent** from the Command Palette, choose an agent, review what will be installed, and confirm. The wizard never overwrites settings it does not own, and re-running it is safe.

| Agent | Skill | Automatic refresh |
| --- | --- | --- |
| Pi | — (the Pi package *is* the integration) | Yes, out of the box: the package refreshes after each settled turn when app files changed. The wizard runs `pi install git:github.com/Sergionius/flutter-agent-refresh`. |
| Codex | `~/.codex/skills/flutter-refresh/` | Opt-in hooks in `~/.codex/hooks.json` (`PostToolUse` records changes, `Stop` refreshes). Open Codex and run `/hooks` once to review and trust them — untrusted hooks never run. |
| Claude Code | `~/.claude/skills/flutter-refresh/` | Opt-in hooks in `~/.claude/settings.json` (same events). Restart Claude Code sessions to load them. |

The skill teaches the agent when to request `reload` (UI-only changes) versus `restart` (models, constructors, `main.dart`, pubspec, generated code, bootstrap/DI/config) and how to call the shared sender. **Manual Claude Code skill execution requires an agent-accessible Bash tool.** In a Claude session without Bash, `/flutter-refresh` can load the skill but cannot send a request; a user-run `! bash ...` tests the sender, not the skill. For those sessions, enable the automatic hooks (tested separately) or use the VS Code Hot Reload / Hot Restart commands.

How automatic hooks choose the mode: `PostToolUse` records app-relevant changes (mirroring the Pi package heuristics), and the final `Stop` performs at most one refresh per turn — `restart` when restart-worthy files or new class members were touched, otherwise `reload`. Non-Flutter projects never trigger a request.

## Diagnose and remove

- **Flutter Agent Refresh: Diagnose** prints to the *Flutter Agent Refresh* output channel: the workspace, signal file, active debug session, sender availability, per-agent setup, and duplicate extension copies.
- **Flutter Agent Refresh: Remove Agent Integration** uninstalls one agent's skill and hook entries (only entries this bridge added), and offers to delete the shared sender when no other agent uses it.

Manual refresh commands **Flutter Agent Refresh: Hot Reload / Hot Restart** always work without any agent.

## Result statuses

- `ok`
- `no_debug_session`
- `workspace_mismatch`
- `invalid_request`
- `command_failed`

## Settings

- `piFlutterRefreshBridge.signalFile` — default `.dart_tool/pi_flutter_refresh/request.json`
- `piFlutterRefreshBridge.showNotifications` — default `true`; shows an auto-hiding status-bar message
- `piFlutterRefreshBridge.reloadFallbackToRestart` — default `true`
- `piFlutterRefreshBridge.messageTimeoutMs` — default `8000`

Environment variables for the sender and hooks: `PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` (default 10), `PI_FLUTTER_REFRESH_DISABLED=1` (disables the Pi package's automatic requests), `PI_FLUTTER_REFRESH_COMMAND` (custom refresh command override), `PI_FLUTTER_BRIDGE_HOME` (relocates `~/.pi-flutter-bridge` for the hook script).

## Limitations

- macOS and Linux only (Bash + Python 3); Windows is not supported.
- Hooks are installed at the user level; the sender skips non-Flutter projects, so they stay silent elsewhere.
- The reload/restart heuristics exist twice (TypeScript for Pi, Python for the hooks); both are covered by tests but can drift over time.
- Codex requires explicit `/hooks` trust after every change to the hook definition; this is Codex security policy, not a bug.
- A Claude Code skill cannot invoke the sender in sessions without an agent-accessible shell tool; automatic hooks run independently of the model's tool access.
- The Marketplace publisher id (`sergionius`) is registered. Publishing still requires publisher credentials and manual QA.

## Development

Run `npm run check` (Node.js 22.19+, Python 3, Bash) to syntax-check everything and run the test suites: protocol and bridge behavior, sender handshake with a mocked VS Code responder, installer idempotency and settings merging, hook heuristics, wizard smoke tests with a mocked VS Code API, and packaging checks. CI runs the same command on pushes and pull requests. Tests do not launch VS Code or a Flutter app.

Package locally with `npx @vscode/vsce package`; `.vscodeignore` keeps tests and the Pi package files out of the VSIX while the repository stays installable as a Pi package (`pi install git:github.com/Sergionius/flutter-agent-refresh`).

## License

[MIT](LICENSE).
