---
name: flutter-restart
description: Request a confirmed Flutter hot restart in the VS Code debug session without requiring Claude to run Bash. Invoke as a standalone /flutter-restart command after editing restart-worthy code.
disable-model-invocation: true
---

<!-- pi-flutter-bridge -->

# Request Flutter hot restart

Invoke `/flutter-restart` **alone in a new user turn**, after any code edits.
A Claude Code `UserPromptExpansion` hook sends the request through the shared
sender before this instruction reaches the model. It works even if Claude has
no Bash tool. Do not run the sender again or claim success without the hook's
`flutter-bridge: OK` confirmation. If the hook reports an error, report it.

Do not combine the slash command with an editing request: the hook fires on
submission, before Claude can edit. Use `/flutter-reload` instead for UI-only
changes.
