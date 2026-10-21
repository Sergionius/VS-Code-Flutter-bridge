import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getDoctorReport, syncVsCodeBridge } from "../pi/extensions/bridge-tools.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("Pi manifest exposes only Flutter extension entry points", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./pi/extensions/*.ts"]);
  assert.equal(manifest.icon, "assets/icon.png");
  const commands = [];
  const handlers = [];
  const pi = {
    on(name) { handlers.push(name); },
    registerCommand(name) { commands.push(name); },
  };
  for (const name of ["flutter-refresh", "bridge-tools"]) {
    const extension = await import(`../pi/extensions/${name}.ts`);
    extension.default(pi);
  }
  assert.deepEqual(commands, ["pi-flutter-bridge-doctor", "pi-flutter-bridge-sync"]);
  assert.deepEqual(handlers.sort(), ["agent_settled", "session_start", "tool_result"]);
});

test("VS Code sync is idempotent, retains the source and removes old installs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-flutter-vscode-"));
  const previousEnv = process.env.PI_FLUTTER_BRIDGE_EXTENSIONS_DIR;
  process.env.PI_FLUTTER_BRIDGE_EXTENSIONS_DIR = directory;
  try {
    const legacy = join(directory, "local.pi-flutter-refresh-bridge-0.1.0");
    await mkdir(legacy);
    await writeFile(join(legacy, "obsolete"), "old");
    const first = await syncVsCodeBridge({ extensionsDir: directory });
    const second = await syncVsCodeBridge({ extensionsDir: directory });
    assert.equal(first.destination, second.destination);
    assert.equal(first.removedLegacy.length, 1);
    assert.deepEqual(second.removedLegacy, []);
    assert.equal(JSON.parse(await readFile(join(second.destination, "package.json"), "utf8")).version, first.version);
    for (const relative of ["lib/agent-setup.js", "bridge/flutter_refresh.sh", "bridge/agent_hook.py", "templates/skills/flutter-refresh/SKILL.md", "assets/icon.png", "assets/preview.png"]) {
      assert.ok((await readFile(join(second.destination, relative))).length > 0, `${relative} is present in a synced extension`);
    }
    assert.match((await getDoctorReport()).lines.join("\n"), /VS Code bridge installed: OK/);
  } finally {
    if (previousEnv === undefined) delete process.env.PI_FLUTTER_BRIDGE_EXTENSIONS_DIR;
    else process.env.PI_FLUTTER_BRIDGE_EXTENSIONS_DIR = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
