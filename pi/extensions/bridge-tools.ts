import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = join(ROOT, "bridge", "flutter_refresh.sh");
const STABLE_SENDER = resolve(homedir(), ".pi-flutter-bridge", "bin", "flutter_refresh.sh");
const LEGACY_PREFIXES = ["local.pi-flutter-refresh-bridge-", "sergionius.pi-flutter-refresh-bridge-"];

type Manifest = { name: string; publisher: string; version: string };

async function manifest(directory = ROOT): Promise<Manifest> {
  const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Partial<Manifest>;
  if (!value.name || !value.publisher || !value.version) throw new Error("bridge manifest is missing name, publisher, or version");
  return value as Manifest;
}

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try { await access(path, mode); return true; } catch { return false; }
}

function vscodeExtensionsDir(override?: string): string {
  return resolve(override ?? process.env.PI_FLUTTER_BRIDGE_EXTENSIONS_DIR
    ?? process.env.PI_TOOLKIT_VSCODE_EXTENSIONS_DIR ?? join(homedir(), ".vscode", "extensions"));
}

export async function syncVsCodeBridge(options: { extensionsDir?: string } = {}) {
  const source = await manifest();
  const extensionsDir = vscodeExtensionsDir(options.extensionsDir);
  const directoryName = `${source.publisher}.${source.name}-${source.version}`;
  const destination = join(extensionsDir, directoryName);
  const temporary = join(extensionsDir, `.${directoryName}.tmp-${process.pid}-${Date.now()}`);
  const backup = join(extensionsDir, `.${directoryName}.backup-${process.pid}-${Date.now()}`);
  await mkdir(extensionsDir, { recursive: true });
  try {
    await mkdir(temporary);
    // The legacy sync command remains usable for source installs. Copy every
    // runtime dependency of extension.js, not just the extension entry point.
    for (const file of ["package.json", "extension.js", "README.md", "LICENSE", "CHANGELOG.md", "lib", "bridge", "templates"]) {
      await cp(join(ROOT, file), join(temporary, file), { recursive: true });
    }
    const copied = await manifest(temporary);
    if (copied.version !== source.version || copied.name !== source.name || copied.publisher !== source.publisher) {
      throw new Error("bridge verification failed after copy");
    }
    const hadDestination = await exists(destination);
    if (hadDestination) await rename(destination, backup);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (hadDestination) await rename(backup, destination);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const removedLegacy: string[] = [];
  for (const entry of await readdir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === directoryName) continue;
    const isLegacy = LEGACY_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
    const isOwnOldVersion = entry.name.startsWith(`${source.publisher}.${source.name}-`);
    if (!isLegacy && !isOwnOldVersion) continue;
    const path = join(extensionsDir, entry.name);
    await rm(path, { recursive: true, force: true });
    removedLegacy.push(path);
  }
  return { destination, version: source.version, removedLegacy };
}

export async function getDoctorReport(): Promise<{ lines: string[]; healthy: boolean }> {
  const lines: string[] = [];
  const helperReady = await exists(HELPER, constants.X_OK);
  lines.push(`Flutter helper: ${helperReady ? "OK" : "MISSING/NOT EXECUTABLE"} (${HELPER})`);
  const senderReady = await exists(STABLE_SENDER, constants.X_OK);
  lines.push(`Shared sender: ${senderReady ? "OK" : "not installed; the package copy is used"} (${STABLE_SENDER})`);
  let healthy = helperReady;
  try {
    const source = await manifest();
    lines.push(`VS Code bridge source: OK (${source.publisher}.${source.name}@${source.version})`);
    const installed = join(vscodeExtensionsDir(), `${source.publisher}.${source.name}-${source.version}`);
    const installedReady = await exists(join(installed, "package.json"));
    lines.push(`VS Code bridge installed: ${installedReady ? "OK" : "NOT SYNCED"} (${installed})`);
    healthy &&= installedReady;
  } catch (error) {
    healthy = false;
    lines.push(`VS Code bridge source: FAILED (${error instanceof Error ? error.message : String(error)})`);
  }
  return { lines, healthy };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-flutter-bridge-doctor", {
    description: "Check the Flutter helper and installed VS Code bridge",
    handler: async (_args, ctx) => {
      try {
        const report = await getDoctorReport();
        ctx.ui.notify(report.lines.join("\n"), report.healthy ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Flutter bridge doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.registerCommand("pi-flutter-bridge-sync", {
    description: "Install or update this package's VS Code Flutter bridge",
    handler: async (_args, ctx) => {
      try {
        const result = await syncVsCodeBridge();
        ctx.ui.notify(`VS Code bridge ${result.version} synced to ${result.destination}. Run “Developer: Reload Window” in VS Code.`, "info");
      } catch (error) {
        ctx.ui.notify(`Flutter bridge sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
