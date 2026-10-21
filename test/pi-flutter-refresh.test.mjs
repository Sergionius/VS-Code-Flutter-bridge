import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function refreshMode(toolName, path, input = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-flutter-refresh-"));
  try {
    await mkdir(join(cwd, "lib"));
    await writeFile(join(cwd, "lib/main.dart"), "void main() {}\n");
    await writeFile(join(cwd, "pubspec.yaml"), "name: test\nflutter:\n");
    const handlers = new Map();
    const calls = [];
    const extension = (await import(new URL("../pi/extensions/flutter-refresh.ts", import.meta.url))).default;
    extension({
      on(name, handler) { handlers.set(name, handler); },
      async exec(_script, args) { calls.push(args[0]); return { code: 0, stdout: "OK" }; },
    });
    const ctx = { cwd, hasUI: false };
    await handlers.get("session_start")();
    await handlers.get("tool_result")({ toolName, input: { path, ...input }, isError: false }, ctx);
    await handlers.get("agent_settled")({}, ctx);
    return calls[0];
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("new model field restarts rather than reloading stale objects", async () => {
  assert.equal(await refreshMode("edit", "lib/core/network/models/shift_screen_response_model.dart", {
    edits: [{ oldText: "final String name;", newText: "final String name;\nfinal String operatorPhone;" }],
  }), "restart");
});

test("new fields and constructor parameters outside model directories restart", async () => {
  assert.equal(await refreshMode("edit", "lib/feed/state.dart", {
    edits: [{ oldText: "final String name;", newText: "final String name;\nfinal String phone;" }],
  }), "restart");
  assert.equal(await refreshMode("edit", "lib/feed/state.dart", {
    edits: [{ oldText: "this.name,", newText: "this.name,\nrequired this.phone," }],
  }), "restart");
});

test("ordinary UI edits reload; Dart writes restart conservatively", async () => {
  assert.equal(await refreshMode("edit", "lib/ui/feed/feed_page.dart", {
    edits: [{ oldText: "Text('Old')", newText: "Text('New')" }],
  }), "reload");
  assert.equal(await refreshMode("write", "lib/feed/state.dart", { content: "class State {}" }), "restart");
});
