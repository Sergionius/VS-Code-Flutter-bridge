# Pi Flutter Refresh Bridge

Local VS Code bridge for confirmed Flutter hot reload/restart requests from pi.

## How it works

1. Pi atomically writes `.dart_tool/pi_flutter_refresh/request.json` with a unique request ID.
2. The extension validates the request and checks that the active debug session is a Dart session from the same workspace.
3. It invokes `dart.hotReload` or `flutter.hotRestart`.
4. It atomically writes `.dart_tool/pi_flutter_refresh/responses/<requestId>.json`.
5. Pi reports the confirmed result or times out instead of claiming success after only writing a file.

A successful response confirms that Dart-Code accepted the command. It does not guarantee that the next Flutter frame has already rendered.

Hot reload falls back to hot restart when `piFlutterRefreshBridge.reloadFallbackToRestart` is enabled and the reload command throws.

## Usage

1. Open the Flutter project in VS Code.
2. Start the app with Run/Debug in that VS Code window.
3. Reload VS Code after installing or updating this extension.
4. Let Pi edit Flutter app files. The `pi-toolkit` package invokes its bundled helper automatically.

Use `/pi-toolkit-sync-vscode` in Pi to install updates to this bridge. Use `Pi Flutter Bridge: Diagnose` from the VS Code Command Palette to inspect the active workspace, signal path, and debug session.

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
