# Pi Flutter Refresh Bridge

VS Code extension and independently installable [Pi](https://pi.dev) package for automatic Flutter hot reload/restart. The VS Code extension is installed locally, not published to the VS Code Marketplace.

## How it works

1. Pi atomically writes `.dart_tool/pi_flutter_refresh/request.json` with a unique request ID.
2. The extension validates the request and checks that the active debug session is a Dart session from the same workspace.
3. It invokes `dart.hotReload` or `flutter.hotRestart`.
4. It atomically writes `.dart_tool/pi_flutter_refresh/responses/<requestId>.json`.
5. Pi reports the confirmed result or times out instead of claiming success after only writing a file.

A successful response confirms that Dart-Code accepted the command. It does not guarantee that the next Flutter frame has already rendered.

Hot reload falls back to hot restart when `piFlutterRefreshBridge.reloadFallbackToRestart` is enabled and the reload command throws.

## Install and use

Requires Pi, Node.js 22.19+, Python 3, Bash, VS Code 1.80+, Dart-Code, and a Flutter project. Install independently of pi-toolkit:

```bash
pi install git:github.com/Sergionius/VS-Code-Flutter-bridge
```

1. Run `/reload` in Pi, then `/pi-flutter-bridge-sync` to copy this repository's VS Code extension into VS Code's extensions directory. Run `/pi-flutter-bridge-doctor` to check the helper and installation.
2. In VS Code, run `Developer: Reload Window` after installation or update.
3. Open the Flutter project and start it using Run/Debug in that VS Code window.
4. Let Pi edit Flutter app files; the Pi extension requests refresh automatically. Use `Pi Flutter Bridge: Diagnose` from the VS Code Command Palette to inspect the workspace, signal path, and active debug session.

After `pi update git:github.com/Sergionius/VS-Code-Flutter-bridge`, run `/reload`, `/pi-flutter-bridge-sync`, and `Developer: Reload Window` again. `PI_FLUTTER_REFRESH_DISABLED=1` disables automatic requests, `PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` sets the response timeout (10 seconds by default), and `PI_FLUTTER_BRIDGE_EXTENSIONS_DIR` overrides the VS Code extensions directory.

**Migrating from pi-toolkit:** Update pi-toolkit to the release without bundled Flutter support first and run `/reload`, then install this package and run `/reload` again. Check `~/.pi/agent/settings.json` and project settings for old direct `extensions/flutter-refresh.ts` paths, and remove them to prevent two listeners from issuing duplicate refresh requests. The old `/pi-toolkit-sync-vscode` and `/pi-toolkit-doctor` commands are replaced by the commands above. Keep other pi-toolkit resources installed. Roll back by removing this package and installing a previous pi-toolkit revision; do not load both Flutter extensions at once.

To use only the VS Code extension without Pi, copy `package.json`, `extension.js`, `README.md`, and `LICENSE` into `~/.vscode/extensions/local.pi-flutter-refresh-bridge-0.3.0/` (or your VS Code extensions directory), then reload VS Code. The folder name must match the `publisher`, `name`, and `version` in `package.json`; the Pi sync command may overwrite it. Without the Pi package, you must send refresh requests yourself.

The bridge watches a workspace-local file under `.dart_tool`, so requests should come only from a trusted workspace. It checks the request's workspace and the active Dart debug session before running a refresh.

## Result statuses

- `ok`
- `no_debug_session`
- `workspace_mismatch`
- `invalid_request`
- `command_failed`

Requests without a protocol version/request ID remain supported as legacy fire-and-forget requests during migration.

## Settings

- `piFlutterRefreshBridge.signalFile` — default `.dart_tool/pi_flutter_refresh/request.json`
- `piFlutterRefreshBridge.showNotifications` — default `true`; shows an auto-hiding status-bar message
- `piFlutterRefreshBridge.reloadFallbackToRestart` — default `true`
- `piFlutterRefreshBridge.messageTimeoutMs` — default `8000`

## Development

Run `npm run check` (Node.js 22.19 or newer, Python 3 and Bash) to syntax-check the extension and test the Pi extension, handshake, installer, and mocked VS Code API. CI runs the same command on pushes and pull requests. Tests do not launch VS Code or a Flutter app.

## License

[MIT](LICENSE).
