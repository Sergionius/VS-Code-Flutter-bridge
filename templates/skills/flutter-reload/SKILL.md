---
name: flutter-reload
description: Request a confirmed Flutter hot reload in the VS Code debug session without requiring Claude to run Bash. Invoke as a standalone /flutter-reload command after editing UI code.
disable-model-invocation: true
---

<!-- pi-flutter-bridge -->

# Request Flutter hot reload

Invoke `/flutter-reload` **alone in a new user turn**, after any code edits.
A Claude Code `UserPromptExpansion` hook sends the request through the shared
sender before this instruction reaches the model. It works even if Claude has
no Bash tool. Do not run the sender again or claim success without the hook's
`flutter-bridge: OK` confirmation. If the hook reports an error, report it.

Do not combine the slash command with an editing request: the hook fires on
submission, before Claude can edit. Use `/flutter-restart` instead when changes
require restart (such as `lib/main.dart`, models, constructors, pubspec, or
generated code).
