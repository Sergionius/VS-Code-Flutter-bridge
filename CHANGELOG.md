# Changelog

## 0.4.0

- Added **Flutter Agent Refresh: Set Up Agent**, a wizard that installs Flutter refresh for Pi, Codex, or Claude Code: a portable skill, opt-in automatic hooks (PostToolUse + Stop), and the shared sender.
- All agents now use one shared sender installed at `~/.pi-flutter-bridge/bin/flutter_refresh.sh`, kept up to date by the extension, so integrations survive extension updates.
- Added automatic hooks for Codex (`~/.codex/hooks.json`) and Claude Code (`~/.claude/settings.json`). Hooks are opt-in, merge-only, and never touch unrelated settings. Codex requires a one-time `/hooks` trust.
- Added **Flutter Agent Refresh: Remove Agent Integration** for clean uninstall per agent.
- **Diagnose** now reports sender availability, per-agent setup, and duplicate extension copies in a dedicated output channel.
- The sender walks up from the working directory to the Flutter project root, so agents started in a subdirectory work too.
- Prepared Marketplace packaging: real publisher id, `.vscodeignore`, VSIX excludes tests and Pi package files.

## 0.3.0

- Distributed the Flutter auto-refresh as an independently installable Pi package.

## 0.2.0

- Confirmed request/response protocol with unique request IDs and result statuses.

## 0.1.0

- Initial VS Code extension and signal-file based refresh bridge.
