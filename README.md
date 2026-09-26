# Pi Flutter Refresh Bridge

Local VS Code extension for confirmed Flutter hot reload/restart requests from [pi-toolkit](https://github.com/Sergionius/pi-toolkit). It is installed locally, not published to the VS Code Marketplace.

## How it works

1. Pi atomically writes `.dart_tool/pi_flutter_refresh/request.json` with a unique request ID.
2. The extension validates the request and checks that the active debug session is a Dart session from the same workspace.
3. It invokes `dart.hotReload` or `flutter.hotRestart`.
4. It atomically writes `.dart_tool/pi_flutter_refresh/responses/<requestId>.json`.
5. Pi reports the confirmed result or times out instead of claiming success after only writing a file.

A successful response confirms that Dart-Code accepted the command. It does not guarantee that the next Flutter frame has already rendered.

Hot reload falls back to hot restart when `piFlutterRefreshBridge.reloadFallbackToRestart` is enabled and the reload command throws.

## Install and use

Requires VS Code 1.80+, the Dart/Flutter VS Code extension (Dart-Code), a Flutter project, and pi with [pi-toolkit](https://github.com/Sergionius/pi-toolkit) installed. This repository alone does not send refresh requests; pi-toolkit supplies the helper that writes them.

1. In pi, run `/pi-toolkit-sync-vscode` to copy the bridge bundled with pi-toolkit into VS Code's extensions directory. For updates to that bundled copy, update pi-toolkit first, then run `/reload` and `/pi-toolkit-sync-vscode` again. Changes in this standalone repository do not automatically update pi-toolkit's bundled copy.
2. In VS Code, run `Developer: Reload Window` after installation or update.
3. Open the Flutter project and start it using Run/Debug in that VS Code window.
4. Let pi edit Flutter app files; pi-toolkit requests refresh automatically. Use `Pi Flutter Bridge: Diagnose` in the VS Code Command Palette to inspect the workspace, signal path, and active debug session.

To try this repository's version directly, copy `package.json`, `extension.js`, `README.md`, and `LICENSE` into `~/.vscode/extensions/local.pi-flutter-refresh-bridge-0.2.1/` (or your VS Code extensions directory), then reload VS Code. The folder name must match the `publisher`, `name`, and `version` in `package.json`; pi-toolkit's sync command may overwrite it.

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

Run `npm run check` (Node.js 22 or newer) to syntax-check the extension and run the dependency-free tests. CI runs the same command on pushes and pull requests. The tests mock the VS Code API; they do not launch VS Code or a Flutter app.

## License

[MIT](LICENSE).
