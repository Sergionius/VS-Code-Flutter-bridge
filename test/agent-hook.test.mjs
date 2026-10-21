import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const HOOK = join(root, "bridge", "agent_hook.py");

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), "pi-flutter-hook-"));
  const project = await mkdtemp(join(tmpdir(), "pi-flutter-project-"));
  const plain = await mkdtemp(join(tmpdir(), "pi-flutter-plain-"));
  const log = join(home, "sender.log");
  const sender = join(home, "bin", "flutter_refresh.sh");
  await mkdir(join(home, "bin"), { recursive: true });
  await mkdir(join(project, "lib"), { recursive: true });
  await writeFile(join(project, "pubspec.yaml"), "name: hook_test\nflutter:\n");
  await writeFile(join(project, "lib/main.dart"), "void main() {}\n");
  await writeFile(sender, [
    "#!/usr/bin/env bash",
    'printf \'%s\\n\' "$1" >> "$PI_HOOK_SENDER_LOG"',
    'echo "OK: stub $1"',
    "",
  ].join("\n"));
  await chmod(sender, 0o755);

  const run = (event, cwd = project) => {
    const result = spawnSync("python3", [HOOK], {
      input: JSON.stringify({ cwd, session_id: "s1", ...event }),
      env: { ...process.env, PI_FLUTTER_BRIDGE_HOME: home, PI_HOOK_SENDER_LOG: log },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `hook must always exit 0\n${result.stderr}`);
    return result;
  };
  const senderCalls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const state = async (session = "s1") => JSON.parse(await readFile(join(home, "state", `${session}.json`), "utf8").catch(() => "null"));

  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  });
  return { home, project, plain, run, senderCalls, state };
}

const editEvent = (file, oldText, newText) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: file, old_string: oldText, new_string: newText },
});

const stopEvent = () => ({ hook_event_name: "Stop" });

test("UI edit records reload; Stop runs the sender once and reports the summary", async (t) => {
  const s = await sandbox(t);
  await s.run(editEvent("lib/ui/feed/feed_page.dart", "Text('Old')", "Text('New')"));
  const recorded = await s.state();
  assert.equal(recorded.needsRefresh, true);
  assert.equal(recorded.needsRestart, false);
  assert.equal(typeof recorded.updatedAt, "number");

  const stop = s.run(stopEvent());
  assert.equal((await s.senderCalls()).length, 1);
  assert.equal((await s.senderCalls())[0], "reload");
  assert.match(stop.stdout, /"systemMessage": "flutter-bridge: OK: stub reload"/);
  assert.equal(await s.state(), null);
});

test("model field edit and constructor additions record restart", async (t) => {
  const s = await sandbox(t);
  await s.run(editEvent("lib/core/models/shift_model.dart", "final String name;", "final String name;\nfinal String phone;"));
  assert.equal((await s.state()).needsRestart, true);

  await s.run(editEvent("lib/feed/state.dart", "this.name,", "this.name,\nrequired this.phone,"));
  assert.equal((await s.state()).needsRestart, true);
});

test("Write and apply_patch behave like the Pi heuristics", async (t) => {
  const s = await sandbox(t);
  await s.run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "lib/feed/state.dart", content: "class S {}" } });
  assert.equal((await s.state()).needsRestart, true);

  await s.run({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: lib/ui/page.dart",
        "@@",
        " Text('Old')",
        "+Text('New')",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  });
  const state = await s.state();
  assert.equal(state.needsRestart, true, "Write of a Dart file keeps restart");
});

test("apply_patch adding a class member records restart, text-only patch stays reload", async (t) => {
  const s = await sandbox(t);
  await s.run({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: lib/ui/other_page.dart",
        "@@",
        " Text('Old')",
        "+Text('New')",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  });
  assert.deepEqual([true, false], [(await s.state()).needsRefresh, (await s.state()).needsRestart]);

  await s.run({
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Update File: lib/ui/page.dart",
        "@@",
        " final String name;",
        "+final String operatorPhone;",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  });
  assert.equal((await s.state()).needsRestart, true);
});

test("Bash code generation records restart; irrelevant paths record nothing", async (t) => {
  const s = await sandbox(t);
  await s.run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flutter pub get" } });
  assert.deepEqual([true, true], [(await s.state()).needsRefresh, (await s.state()).needsRestart]);

  await s.run(editEvent("README.md", "old", "new"));
  await s.run(editEvent("test/widget_test.dart", "old", "new"));
  await s.run({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "lib/main.dart" } });
  const unchanged = await s.state();
  assert.equal(unchanged.needsRestart, true, "state from pub get stays");
});

test("Stop without recorded changes is silent and does not call the sender", async (t) => {
  const s = await sandbox(t);
  const stop = s.run(stopEvent());
  assert.equal(stop.stdout.trim(), "{}");
  assert.equal((await s.senderCalls()).length, 0);
});

test("Stop stays exit 0 and informative when the sender is missing", async (t) => {
  const s = await sandbox(t);
  await rm(join(s.home, "bin"), { recursive: true, force: true });
  await s.run(editEvent("lib/ui/page.dart", "a", "b"));
  const stop = s.run(stopEvent());
  assert.match(stop.stdout, /sender not installed/);
  assert.equal((await s.senderCalls()).length, 0);
});

test("different sessions keep independent state", async (t) => {
  const s = await sandbox(t);
  await s.run({ hook_event_name: "PostToolUse", tool_name: "Edit", session_id: "s2", tool_input: { file_path: "lib/ui/a.dart", old_string: "a", new_string: "b" } });
  assert.equal(await s.state(), null, "s1 has no state");
  s.run({ hook_event_name: "Stop", session_id: "s2" });
  assert.equal((await s.senderCalls())[0], "reload");
});

test("explicit skill invocation suppresses the automatic Stop refresh", async (t) => {
  const s = await sandbox(t);
  s.run(editEvent("lib/ui/page.dart", "a", "b"));
  assert.equal((await s.state()).needsRefresh, true);
  s.run({
    hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_input: { command: "bash ~/.pi-flutter-bridge/bin/flutter_refresh.sh reload" },
  });
  assert.equal(await s.state(), null);
  s.run(stopEvent());
  assert.deepEqual(await s.senderCalls(), []);
});

test("Claude manual slash commands send exactly once without a model shell", async (t) => {
  const s = await sandbox(t);
  const prompt = (name, args = "") => ({ hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: name, command_args: args });
  await s.run(editEvent("lib/ui/page.dart", "Text('Old')", "Text('New')"));
  const reload = JSON.parse(s.run(prompt("flutter-reload")).stdout);
  assert.match(reload.systemMessage, /OK: stub reload/);
  assert.equal(reload.hookSpecificOutput.hookEventName, "UserPromptExpansion");
  assert.match(reload.hookSpecificOutput.additionalContext, /OK: stub reload.*already sent/);
  assert.equal(await s.state(), null);
  assert.equal(JSON.parse(s.run(stopEvent()).stdout).systemMessage, undefined);
  const restart = JSON.parse(s.run(prompt("flutter-restart")).stdout);
  assert.match(restart.systemMessage, /OK: stub restart/);
  assert.deepEqual(await s.senderCalls(), ["reload", "restart"]);
  const blocked = JSON.parse(s.run(prompt("flutter-reload", "edit a file")).stdout);
  assert.equal(blocked.decision, "block");
  assert.deepEqual(await s.senderCalls(), ["reload", "restart"]);
  assert.equal(JSON.parse(s.run(prompt("flutter-reload"), s.plain).stdout).decision, "block");
});

test("a failed sender reports the error rather than the initial REQUESTED line", async (t) => {
  const s = await sandbox(t);
  const sender = join(s.home, "bin", "flutter_refresh.sh");
  await writeFile(sender, "#!/usr/bin/env bash\necho 'REQUESTED: Flutter hot reload'\necho 'NO_DEBUG_SESSION: none' >&2\nexit 3\n");
  s.run(editEvent("lib/ui/page.dart", "a", "b"));
  const output = s.run(stopEvent());
  assert.match(output.stdout, /NO_DEBUG_SESSION: none/);
  assert.doesNotMatch(output.stdout, /REQUESTED/);
});

test("non-Flutter directories record nothing and stay silent", async (t) => {
  const s = await sandbox(t);
  await s.run(editEvent("lib/ui/page.dart", "a", "b"), s.plain);
  assert.equal(await s.state(), null);
  const stop = s.run(stopEvent(), s.plain);
  assert.equal(stop.stdout.trim(), "{}");
  assert.equal((await s.senderCalls()).length, 0);
});

test("agent started in a subdirectory of a Flutter project still refreshes", async (t) => {
  const s = await sandbox(t);
  const subdir = join(s.project, "lib", "ui");
  await mkdir(subdir, { recursive: true });
  await s.run(editEvent("page.dart", "a", "b"), subdir);
  assert.equal((await s.state()).needsRefresh, true);
});
