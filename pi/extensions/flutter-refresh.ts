import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(PACKAGE_ROOT, "scripts/flutter_refresh.sh");

let needsFlutterRefresh = false;
let needsRestart = false;
let changedPaths = new Set<string>();
let refreshInProgress = false;

function envDisabled() {
  return process.env.PI_FLUTTER_REFRESH_DISABLED === "1";
}

function normalizeProjectPath(cwd: string, rawPath: string) {
  if (!rawPath) return "";
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absolute;
  return rel.split(sep).join("/");
}

function isFlutterProject(cwd: string) {
  const pubspec = resolve(cwd, "pubspec.yaml");
  if (!existsSync(pubspec)) return false;
  if (existsSync(resolve(cwd, "lib/main.dart"))) return true;
  try {
    return /^\s*flutter:\s*$/m.test(readFileSync(pubspec, "utf8"));
  } catch {
    return false;
  }
}

function isAppRelevantPath(projectPath: string) {
  if (!projectPath || projectPath.startsWith("../") || projectPath.startsWith("/")) return false;
  if (projectPath.startsWith("test/") || projectPath.startsWith("docs/")) return false;
  if (projectPath === "pubspec.yaml" || projectPath === "pubspec.lock") return true;
  if (projectPath.startsWith("lib/") && projectPath.endsWith(".dart")) return true;
  if (projectPath.startsWith("assets/") || projectPath.startsWith("config/")) return true;
  if (projectPath.startsWith("lib/l10n/") && projectPath.endsWith(".arb")) return true;
  if (projectPath.includes("/generated/") || projectPath.includes(".g.dart") || projectPath.includes(".freezed.dart")) return true;
  return false;
}

function isRestartPath(projectPath: string) {
  const name = basename(projectPath);
  if (projectPath === "pubspec.yaml" || projectPath === "pubspec.lock") return true;
  if (projectPath === "lib/main.dart") return true;
  if (/(^|\/)locale_(ru|en)\.dart$/i.test(projectPath)) return true;
  if (/(^|\/)(bootstrap|di|inject|injection|routes?|router|app_config|firebase_options)\b/i.test(projectPath)) return true;
  if (/\.g\.dart$|\.freezed\.dart$/.test(name)) return true;
  return false;
}

function isModelPath(projectPath: string) {
  return projectPath.endsWith(".dart") && /(^|\/)(models?\/|[^/]*_model\.dart$)/i.test(projectPath);
}

function addsClassMember(input: any) {
  const oldText = String(input.oldText ?? "");
  const newText = String(input.newText ?? "");
  // Only added lines matter: replacing an existing value or method body is reloadable.
  const previous = new Set(oldText.split(/\r?\n/).map((line) => line.trim()));
  return newText.split(/\r?\n/).some((line) => {
    const added = line.trim();
    if (!added || previous.has(added) || /^(?:return|throw|await|yield|break|continue|case)\b/.test(added)) return false;
    return /^(?:(?:static|late|final|const|covariant)\s+)*(?:[\w<>?, ]+\s+)?get\s+\w+\b/.test(added)
      || /^(?:(?:static|late|final|const|covariant)\s+)*(?:[\w<>?, ]+\s+)+\w+\s*(?:[;=])/.test(added)
      || /\b(?:required\s+)?this\.\w+\b/.test(added);
  });
}

function markPath(cwd: string, rawPath: string, input?: any, toolName?: string) {
  const projectPath = normalizeProjectPath(cwd, rawPath);
  if (!isAppRelevantPath(projectPath)) return;
  needsFlutterRefresh = true;
  changedPaths.add(projectPath);
  if (isRestartPath(projectPath) || isModelPath(projectPath)
    || (projectPath.endsWith(".dart") && (toolName === "write" || (toolName === "edit" &&
      (Array.isArray(input?.edits) ? input.edits : [input]).some(addsClassMember))))) needsRestart = true;
}

function markFromBashCommand(command: string) {
  if (!command) return;
  const lower = command.toLowerCase();
  if (/(flutter\s+pub\s+get|dart\s+run\s+build_runner|flutter\s+gen-l10n|fluttergen|build_runner)/.test(lower)) {
    needsFlutterRefresh = true;
    needsRestart = true;
    changedPaths.add("<generated-by-bash>");
    return;
  }
  if (/\b(lib\/[^\s'\"]+\.dart|pubspec\.yaml|assets\/|config\/)\b/.test(command)) {
    needsFlutterRefresh = true;
    changedPaths.add("<bash-mentioned-flutter-path>");
    if (/\b(?:models?\/[^\s'\"]+|[^\s'\"]+_model\.dart)\b/i.test(command)) needsRestart = true;
  }
}

function lastLine(text: string) {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    needsFlutterRefresh = false;
    needsRestart = false;
    changedPaths = new Set<string>();
    refreshInProgress = false;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (envDisabled() || event.isError) return;

    const input = (event as any).input ?? {};
    if (event.toolName === "write" || event.toolName === "edit") {
      markPath(ctx.cwd, String(input.path ?? ""), input, event.toolName);
      return;
    }

    if (event.toolName === "bash") {
      markFromBashCommand(String(input.command ?? ""));
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (envDisabled() || refreshInProgress || !needsFlutterRefresh) return;
    if (!isFlutterProject(ctx.cwd)) return;

    refreshInProgress = true;
    const mode = needsRestart ? "restart" : "reload";
    const paths = [...changedPaths].slice(0, 5).join(", ");

    try {
      if (ctx.hasUI) {
        ctx.ui.notify(`flutter-refresh: ${mode} after changes${paths ? ` (${paths})` : ""}`, "info");
      }

      const result = await pi.exec(SCRIPT, [mode], { cwd: ctx.cwd, timeout: 30_000, signal: ctx.signal });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const summary = lastLine(output) || `exit code ${result.code}`;

      if (ctx.hasUI) {
        const isWarning = summary.startsWith("SKIPPED") || summary.startsWith("NO_DEBUG_SESSION");
        const level = result.code === 0 ? (isWarning ? "warning" : "info") : (isWarning ? "warning" : "error");
        ctx.ui.notify(`flutter-refresh: ${summary}`, level as any);
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`flutter-refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      needsFlutterRefresh = false;
      needsRestart = false;
      changedPaths = new Set<string>();
      refreshInProgress = false;
    }
  });
}
