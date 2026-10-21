---
name: flutter-refresh
description: Request Flutter hot reload or hot restart in the VS Code debug session through Flutter Agent Refresh. Use after editing Flutter app files (lib/**.dart, pubspec.yaml, assets, generated code) or when the user asks to refresh, reload, or restart the running app.
---

<!-- pi-flutter-bridge -->

# Flutter refresh via Flutter Agent Refresh

When a Flutter app is running under VS Code's debugger, send confirmed
reload/restart requests through the bridge instead of unverified CLI calls.

## When to use

Only in Flutter projects: a `pubspec.yaml` with a `flutter:` section (or a
`lib/main.dart`) in the working directory or in a directory above it.

## Choose the mode

- `reload` — UI-only changes: widget layout, styling, texts, method bodies in
  `lib/**/*.dart`.
- `restart` — anything hot reload cannot apply reliably:
  - `lib/main.dart`, `pubspec.yaml`, `pubspec.lock`
  - model and data classes (`lib/models/**`, `*_model.dart`)
  - new fields, constructors, or getters added to existing classes
  - DI/bootstrap/routing/config files (`bootstrap`, `di`, `routes`, `router`,
    `app_config`, `firebase_options`)
  - generated code (`.g.dart`, `.freezed.dart`), l10n changes,
    `flutter pub get`, `build_runner` runs

When unsure, prefer `restart`: it always rebuilds a correct app state.

## Send the request

From the Flutter project root run:

```bash
bash ~/.pi-flutter-bridge/bin/flutter_refresh.sh <reload|restart>
```

The script walks up from the current directory to the project root, writes a
request that the VS Code extension confirms, and prints one summary line.
Report that line to the user and do not claim success before the bridge
confirms it.

In Claude Code, this manual step requires an agent-accessible Bash tool.
Loading `/flutter-refresh` does not grant one. If none is available, **do not
claim the skill sent a request**. After the editing turn is complete, ask the
user to enter `/flutter-reload` or `/flutter-restart` **alone in a new turn**.
Those commands use a Claude host hook and do not require Bash in the model.
If Automatic hooks are enabled, they refresh after edits without a manual
request. A user-run `! bash ...` tests the sender, not the agent's skill.

Exit codes: `0` confirmed (lines starting with `SKIPPED`/`WARN` are
non-fatal) · `2` usage error · `3` no debug session · `4` workspace mismatch
· `5` invalid request · `6` command failed · `8` timeout.

`PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` (default 10) caps how long the script
waits for the VS Code confirmation.

If the script is missing, ask the user to run **Flutter Agent Refresh: Set Up
Agent** in VS Code.
