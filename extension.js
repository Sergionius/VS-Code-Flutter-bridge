const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const agentSetup = require('./lib/agent-setup');

const PROTOCOL_VERSION = 1;
const PI_PACKAGE_SPEC = 'git:github.com/Sergionius/flutter-agent-refresh';
const OUTPUT_CHANNEL_NAME = 'Flutter Agent Refresh';
const DEFAULT_SIGNAL_FILE = '.dart_tool/pi_flutter_refresh/request.json';
const RESPONSE_DIRECTORY = 'responses';
const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const RESPONSE_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

let lastLegacyRequestKey = '';
let processing = Promise.resolve();
let statusItem;
let statusTimer;
let outputChannel;
const processedRequestIds = new Set();

function channel() {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function spawnAsync(command, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function config() {
  return vscode.workspace.getConfiguration('piFlutterRefreshBridge');
}

function signalFile() {
  return config().get('signalFile', DEFAULT_SIGNAL_FILE) || DEFAULT_SIGNAL_FILE;
}

function normalizeFsPath(value) {
  const resolved = path.normalize(path.resolve(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left, right) {
  return normalizeFsPath(left) === normalizeFsPath(right);
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function show(message, level = 'info') {
  if (!config().get('showNotifications', true)) return;

  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.name = 'Flutter Agent Refresh';
  }

  const icon = level === 'error' ? '$(error)' : level === 'warning' ? '$(warning)' : '$(sync)';
  statusItem.text = `${icon} Flutter Agent Refresh: ${message}`;
  statusItem.tooltip = 'This message auto-hides; configure piFlutterRefreshBridge.messageTimeoutMs if needed.';
  statusItem.show();

  if (statusTimer) clearTimeout(statusTimer);
  const timeout = Math.max(1000, Number(config().get('messageTimeoutMs', 8000)) || 8000);
  statusTimer = setTimeout(() => {
    if (statusItem) statusItem.hide();
    statusTimer = undefined;
  }, timeout);
}

async function readJson(uri) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function pathExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function responseUri(folder, requestId) {
  const requestUri = vscode.Uri.joinPath(folder.uri, signalFile());
  return vscode.Uri.joinPath(requestUri, '..', RESPONSE_DIRECTORY, `${requestId}.json`);
}

async function writeJsonAtomically(uri, value) {
  const directory = vscode.Uri.joinPath(uri, '..');
  const temporary = vscode.Uri.joinPath(directory, `.${path.basename(uri.fsPath)}.${process.pid}.${Date.now()}.tmp`);
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(temporary, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
  await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
}

function response(request, status, message, performedMode = null) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    status,
    requestedMode: request.mode === 'restart' ? 'restart' : 'reload',
    performedMode,
    message,
    completedAt: Date.now(),
  };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') return 'request must be a JSON object';
  if (request.protocolVersion !== PROTOCOL_VERSION) return `unsupported protocolVersion: ${request.protocolVersion}`;
  if (typeof request.requestId !== 'string' || !REQUEST_ID_PATTERN.test(request.requestId)) return 'invalid requestId';
  if (request.mode !== 'reload' && request.mode !== 'restart') return `invalid mode: ${request.mode}`;
  if (typeof request.cwd !== 'string' || request.cwd.length === 0) return 'cwd must be a non-empty string';
  if (typeof request.createdAt !== 'number' || !Number.isFinite(request.createdAt)) return 'createdAt must be a finite number';
  const age = Date.now() - request.createdAt;
  if (age > REQUEST_MAX_AGE_MS) return 'request has expired';
  if (age < -60_000) return 'request timestamp is too far in the future';
  return undefined;
}

function activeWorkspaceDebugSession(folder) {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { error: 'No active debug session' };
  if (session.type !== 'dart') return { error: `Active debug session is '${session.type}', not 'dart'` };
  if (!session.workspaceFolder) return { error: 'Active Dart debug session has no workspace folder' };
  if (!samePath(session.workspaceFolder.uri.fsPath, folder.uri.fsPath)) {
    return { error: `Active Dart debug session belongs to ${session.workspaceFolder.uri.fsPath}` };
  }
  return { session };
}

async function executeDartCommand(mode) {
  const command = mode === 'restart' ? 'flutter.hotRestart' : 'dart.hotReload';
  await vscode.commands.executeCommand(command);
}

async function performRefresh(mode, folder) {
  const debug = activeWorkspaceDebugSession(folder);
  if (debug.error) {
    return { status: 'no_debug_session', performedMode: null, message: debug.error };
  }

  try {
    await executeDartCommand(mode);
    return { status: 'ok', performedMode: mode, message: `Flutter hot ${mode} accepted by Dart-Code` };
  } catch (error) {
    if (mode === 'reload' && config().get('reloadFallbackToRestart', true)) {
      try {
        await executeDartCommand('restart');
        return {
          status: 'ok',
          performedMode: 'restart',
          message: `Hot reload failed (${errorMessage(error)}); hot restart accepted by Dart-Code`,
        };
      } catch (restartError) {
        return {
          status: 'command_failed',
          performedMode: null,
          message: `Hot reload failed: ${errorMessage(error)}; hot restart failed: ${errorMessage(restartError)}`,
        };
      }
    }

    return { status: 'command_failed', performedMode: null, message: `Hot ${mode} failed: ${errorMessage(error)}` };
  }
}

async function writeResponse(folder, request, result) {
  await writeJsonAtomically(
    responseUri(folder, request.requestId),
    response(request, result.status, result.message, result.performedMode),
  );
}

async function executeLegacyRequest(request, folder) {
  const mode = request && request.mode === 'restart' ? 'restart' : 'reload';
  const key = `${request && request.timestamp ? request.timestamp : ''}:${mode}:${request && request.cwd ? request.cwd : ''}`;
  if (key && key === lastLegacyRequestKey) return;
  lastLegacyRequestKey = key;

  if (request && request.cwd && !samePath(request.cwd, folder.uri.fsPath)) {
    show('legacy request workspace mismatch', 'error');
    return;
  }

  const result = await performRefresh(mode, folder);
  const level = result.status === 'ok' ? (result.performedMode === mode ? 'info' : 'warning')
    : result.status === 'no_debug_session' ? 'warning' : 'error';
  show(result.message, level);
}

async function executeProtocolRequest(request, folder) {
  const requestIdIsUsable = typeof request.requestId === 'string' && REQUEST_ID_PATTERN.test(request.requestId);
  const validationError = validateRequest(request);
  if (validationError) {
    show(`invalid request: ${validationError}`, 'error');
    if (requestIdIsUsable) {
      await writeResponse(folder, { ...request, mode: request.mode === 'restart' ? 'restart' : 'reload' }, {
        status: 'invalid_request',
        performedMode: null,
        message: validationError,
      });
    }
    return;
  }

  if (processedRequestIds.has(request.requestId) || await pathExists(responseUri(folder, request.requestId))) return;
  if (processedRequestIds.size >= 1000) processedRequestIds.clear();
  processedRequestIds.add(request.requestId);

  if (!samePath(request.cwd, folder.uri.fsPath)) {
    const result = {
      status: 'workspace_mismatch',
      performedMode: null,
      message: `Request cwd ${request.cwd} does not match workspace ${folder.uri.fsPath}`,
    };
    await writeResponse(folder, request, result);
    show(result.message, 'error');
    return;
  }

  const result = await performRefresh(request.mode, folder);
  await writeResponse(folder, request, result);
  const level = result.status === 'ok' ? (result.performedMode === request.mode ? 'info' : 'warning')
    : result.status === 'no_debug_session' ? 'warning' : 'error';
  show(result.message, level);
}

async function handleSignalUri(uri, folder) {
  try {
    const request = await readJson(uri);
    if (!request || typeof request !== 'object' || request.protocolVersion === undefined || request.requestId === undefined) {
      await executeLegacyRequest(request, folder);
      return;
    }
    await executeProtocolRequest(request, folder);
  } catch (error) {
    show(`could not process request: ${errorMessage(error)}`, 'error');
  }
}

function enqueueSignalUri(uri, folder) {
  processing = processing.then(
    () => handleSignalUri(uri, folder),
    () => handleSignalUri(uri, folder),
  );
}

async function deleteIfStale(uri, now, maxAge) {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (now - stat.mtime > maxAge) await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    // Missing or concurrently deleted files need no cleanup.
  }
}

async function cleanupFolder(folder) {
  const now = Date.now();
  const requestUri = vscode.Uri.joinPath(folder.uri, signalFile());
  await deleteIfStale(requestUri, now, REQUEST_MAX_AGE_MS);

  const requestDirectory = vscode.Uri.joinPath(requestUri, '..');
  try {
    const requestName = path.basename(requestUri.fsPath);
    for (const [name, type] of await vscode.workspace.fs.readDirectory(requestDirectory)) {
      if (type === vscode.FileType.File && name.startsWith(`${requestName}.`) && name.endsWith('.tmp')) {
        await deleteIfStale(vscode.Uri.joinPath(requestDirectory, name), now, RESPONSE_CLEANUP_AGE_MS);
      }
    }
  } catch {
    // Signal directory is created on first request.
  }

  const responses = vscode.Uri.joinPath(requestDirectory, RESPONSE_DIRECTORY);
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(responses)) {
      if (type === vscode.FileType.File && (name.endsWith('.json') || name.endsWith('.tmp'))) {
        await deleteIfStale(vscode.Uri.joinPath(responses, name), now, RESPONSE_CLEANUP_AGE_MS);
      }
    }
  } catch {
    // Response directory is created on first request.
  }
}

function registerWatcher(context, folder) {
  const pattern = new vscode.RelativePattern(folder, signalFile());
  const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  watcher.onDidCreate((uri) => enqueueSignalUri(uri, folder), null, context.subscriptions);
  watcher.onDidChange((uri) => enqueueSignalUri(uri, folder), null, context.subscriptions);
  context.subscriptions.push(watcher);

  cleanupFolder(folder).then(async () => {
    const uri = vscode.Uri.joinPath(folder.uri, signalFile());
    if (await pathExists(uri)) enqueueSignalUri(uri, folder);
  }, (error) => show(`cleanup failed: ${errorMessage(error)}`, 'warning'));
}

function commandFolder() {
  const sessionFolder = vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.workspaceFolder;
  return sessionFolder || (vscode.workspace.workspaceFolders || [])[0];
}

async function runManual(mode) {
  const folder = commandFolder();
  if (!folder) {
    show('no workspace folder is open', 'error');
    return;
  }
  const result = await performRefresh(mode, folder);
  const level = result.status === 'ok' ? (result.performedMode === mode ? 'info' : 'warning')
    : result.status === 'no_debug_session' ? 'warning' : 'error';
  show(result.message, level);
}

function agentDiagnosticLines() {
  const home = homeDir();
  const lines = [];

  const bridge = agentSetup.bridgeStatus({ homeDir: home });
  lines.push(`sender: ${bridge.senderInstalled ? (bridge.senderExecutable ? 'OK' : 'INSTALLED BUT NOT EXECUTABLE') : 'MISSING'} (${bridge.sender})`);
  lines.push(`hook script: ${bridge.hookInstalled ? 'OK' : 'MISSING'} (${bridge.hook})`);

  const pi = agentSetup.piPackageStatus({ homeDir: home });
  lines.push(`Pi package: ${pi.installed ? 'OK' : 'not installed'} (${pi.directory})`);

  for (const agent of Object.keys(agentSetup.AGENTS)) {
    const label = agentSetup.AGENTS[agent].label;
    const skill = agentSetup.skillStatus(agent, { homeDir: home });
    const hooks = agentSetup.hooksStatus(agent, { homeDir: home });
    lines.push(`${label} skill: ${skill === 'ours' ? 'OK' : skill === 'foreign' ? 'FOREIGN (not managed by this bridge)' : 'not installed'} (${agentSetup.skillDirectory(agent, home)})`);
    lines.push(`${label} hooks: ${hooks.invalid ? 'INVALID JSON (fix manually)' : hooks.configured ? 'OK' : 'not configured'} (${hooks.file})`);
  }
  return lines;
}

function diagnosticBridgeLines() {
  return agentDiagnosticLines().join('\\n    ');
}

function duplicateExtensionLines() {
  try {
    const copies = vscode.extensions.all.filter(
      (extension) => extension.packageJSON && [agentSetup.EXTENSION_NAME, 'pi-flutter-refresh-bridge'].includes(extension.packageJSON.name),
    );
    if (copies.length > 1) {
      return [`WARNING: ${copies.length} copies of this extension are active (${copies.map((copy) => copy.id).join(', ')}). Uninstall the duplicates to avoid double refreshes.`];
    }
  } catch {
    // The extension API is unavailable in some test harnesses.
  }
  return [];
}

function ensureBridgeFiles(context) {
  try {
    agentSetup.installBridgeFiles({
      homeDir: homeDir(),
      sourceRoot: context.extensionPath,
      extensionVersion: context.extension.packageJSON.version,
    });
  } catch (error) {
    show(`could not install the shared sender: ${errorMessage(error)}`, 'warning');
  }
}

const WIZARD_AGENTS = {
  pi: { label: 'Pi', detail: 'Automatic refresh through the Pi package (runs pi install).' },
  codex: { label: 'Codex', detail: 'Skill in ~/.codex/skills + optional automatic hooks in ~/.codex/hooks.json (trust them via /hooks in Codex).' },
  claude: { label: 'Claude Code', detail: 'Skill in ~/.claude/skills + optional automatic hooks in ~/.claude/settings.json.' },
};

async function pickAgent(placeHolder) {
  const items = Object.entries(WIZARD_AGENTS).map(([value, agent]) => ({ label: agent.label, detail: agent.detail, value }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked ? picked.value : undefined;
}

async function pickComponents(agent) {
  const items = [
    { label: 'flutter-refresh skill', picked: true, value: 'skill', detail: 'Rules for choosing reload or restart and calling the shared sender.' },
    { label: 'Automatic hooks', picked: false, value: 'hooks', detail: 'PostToolUse + Stop events run the refresh automatically at the end of each turn.' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `What should be installed for ${WIZARD_AGENTS[agent].label}?`,
  });
  if (!picked) return undefined;
  return { skill: picked.some((item) => item.value === 'skill'), hooks: picked.some((item) => item.value === 'hooks') };
}

async function installPiPackage(update = false, source = PI_PACKAGE_SPEC) {
  const check = await spawnAsync('pi', ['--version'], 15_000);
  if (check.error) {
    const choice = await vscode.window.showErrorMessage(
      `The 'pi' command was not found. Install Pi first and run this setup again, or install the package yourself:\n\npi install ${PI_PACKAGE_SPEC}`,
      { modal: true },
      'Copy install command',
    );
    if (choice === 'Copy install command') vscode.env.clipboard.writeText(`pi install ${PI_PACKAGE_SPEC}`);
    return { installed: false };
  }

  const action = update ? 'Update' : 'Install';
  const args = [update ? 'update' : 'install', source];
  const confirmed = await vscode.window.showInformationMessage(
    `${action} the Pi package?\n\npi ${args.join(' ')}\n\nThe shared sender is already installed at ${agentSetup.senderPath(homeDir())}.`,
    { modal: true },
    action,
  );
  if (confirmed !== action) return { installed: false, cancelled: true };

  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Flutter Agent Refresh: ${action.toLowerCase()}ing Pi package` }, async () => {
    const result = await spawnAsync('pi', args);
    if (result.error) {
      vscode.window.showErrorMessage(`pi ${args[0]} failed: ${result.stderr.trim() || errorMessage(result.error)}`);
      return { installed: false };
    }
    return { installed: true, output: result.stdout };
  });
}

async function setUpAgent(context, agent = undefined) {
  ensureBridgeFiles(context);
  const chosen = agent || await pickAgent('Set up Flutter refresh for which agent?');
  if (!chosen) return;
  const options = { homeDir: homeDir(), sourceRoot: context.extensionPath, extensionVersion: context.extension.packageJSON.version };

  try {
    if (chosen === 'pi') {
      const status = agentSetup.piPackageStatus(options);
      const result = await installPiPackage(status.installed, status.source || PI_PACKAGE_SPEC);
      if (result.installed) {
        vscode.window.showInformationMessage(
          `Pi package ${status.installed ? 'updated' : 'installed'}.\n\nRun /reload in Pi, then start your Flutter app with Run/Debug in this window.`,
          { modal: true },
        );
      }
      return;
    }

    const components = await pickComponents(chosen);
    if (!components) return;
    if (!components.skill && !components.hooks) {
      vscode.window.showInformationMessage('Nothing selected; no changes were made.', { modal: true });
      return;
    }

    const label = WIZARD_AGENTS[chosen].label;
    const plan = [];
    if (components.skill) plan.push(`• skill → ${agentSetup.skillDirectory(chosen, homeDir())}`);
    if (components.hooks) plan.push(`• automatic hooks → ${agentSetup.hooksFile(chosen, homeDir())} (only this bridge's entries are added)`);
    const confirmed = await vscode.window.showInformationMessage(
      `Set up Flutter refresh for ${label}?\n\n${plan.join('\n')}\n\nExisting settings are preserved; running this again is safe.`,
      { modal: true },
      'Install',
    );
    if (confirmed !== 'Install') return;

    const summary = [];
    if (components.skill) {
      const skill = agentSetup.installSkill(chosen, options);
      summary.push(skill.installed ? `skill ${skill.updated ? 'installed' : 'already up to date'} → ${skill.path}` : `skill SKIPPED: ${skill.reason}`);
    }
    if (components.hooks) {
      try {
        const hooks = agentSetup.addAgentHooks(chosen, options);
        summary.push(`hooks ${hooks.changed.length > 0 ? `added (${hooks.changed.join(', ')})` : 'already configured'} → ${hooks.file}`);
      } catch (error) {
        summary.push(`hooks FAILED: ${errorMessage(error)}`);
      }
    }

    const notes = chosen === 'codex'
      ? '\n\nOpen Codex and run /hooks once to review and trust the new hooks; they do not run before that.'
      : '\n\nRestart Claude Code sessions to load the new hooks.';
    const choice = await vscode.window.showInformationMessage(
      `${label} setup:\n\n${summary.map((line) => `• ${line}`).join('\n')}${notes}`,
      { modal: true },
      'Run Diagnostics',
    );
    if (choice === 'Run Diagnostics') diagnose(context);
  } catch (error) {
    vscode.window.showErrorMessage(`Set Up Agent failed: ${errorMessage(error)}`, { modal: true });
  }
}

function agentStillNeedsBridge(agent, home) {
  if (agent === 'pi') return agentSetup.piPackageStatus({ homeDir: home }).installed;
  return agentSetup.skillStatus(agent, { homeDir: home }) === 'ours' || agentSetup.hooksStatus(agent, { homeDir: home }).configured;
}

async function removeAgentIntegration(context) {
  const agent = await pickAgent('Remove Flutter refresh integration for which agent?');
  if (!agent) return;
  const home = homeDir();
  const options = { homeDir: home };
  const label = WIZARD_AGENTS[agent].label;

  try {
    if (agent === 'pi') {
      const status = agentSetup.piPackageStatus(options);
      if (!status.installed) {
        vscode.window.showInformationMessage(`The Pi package is not installed (${status.directory}).`, { modal: true });
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Remove the Pi package?\n\npi remove ${status.source}\n\nThe shared sender and other agents are not affected. Run /reload in Pi afterwards.`,
        { modal: true },
        'Remove',
      );
      if (confirmed !== 'Remove') return;
      const result = await spawnAsync('pi', ['remove', status.source]);
      if (result.error) {
        vscode.window.showErrorMessage(`pi remove failed: ${result.stderr.trim() || errorMessage(result.error)}`);
        return;
      }
      vscode.window.showInformationMessage(`Removed ${status.source}. Run /reload in Pi.`, { modal: true });
      return;
    }

    const plan = [];
    const skillState = agentSetup.skillStatus(agent, options);
    if (skillState === 'ours') plan.push(`• skill ${agentSetup.skillDirectory(agent, home)}`);
    if (skillState === 'foreign') plan.push(`• skill ${agentSetup.skillDirectory(agent, home)} is foreign and will be left untouched`);
    const hooks = agentSetup.hooksStatus(agent, options);
    if (hooks.configured || hooks.invalid) plan.push(`• hook entries in ${hooks.file}${hooks.invalid ? ' (INVALID JSON — fix manually)' : ''}`);
    if (plan.length === 0) {
      vscode.window.showInformationMessage(`Nothing is installed for ${label}.`, { modal: true });
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Remove Flutter refresh for ${label}?\n\n${plan.join('\n')}\n\nOnly pieces installed by this bridge are removed.`,
      { modal: true },
      'Remove',
    );
    if (confirmed !== 'Remove') return;

    const summary = [];
    const skill = agentSetup.removeSkill(agent, options);
    if (skill.removed) summary.push(`skill removed (${skill.path})`);
    else if (skill.reason !== 'not installed') summary.push(`skill kept: ${skill.reason}`);
    try {
      const removed = agentSetup.removeAgentHooks(agent, options);
      if (removed.changed.length > 0) summary.push(`hook entries removed from ${removed.file}`);
    } catch (error) {
      summary.push(`hooks FAILED: ${errorMessage(error)}`);
    }

    const others = ['pi', 'codex', 'claude'].filter((other) => other !== agent).some((other) => agentStillNeedsBridge(other, home));
    const bridge = agentSetup.bridgeStatus(options);
    if (!others && bridge.senderInstalled) {
      const removeSender = await vscode.window.showWarningMessage(
        `No other agent uses the shared sender. Remove it too?\n\n${bridge.home}`,
        { modal: true },
        'Remove sender',
      );
      if (removeSender === 'Remove sender') {
        agentSetup.removeBridgeHome(options);
        summary.push(`shared sender removed (${bridge.home})`);
      }
    }
    vscode.window.showInformationMessage(`${label} integration removed:\n\n${summary.map((line) => `• ${line}`).join('\n') || '• nothing to remove'}`, { modal: true });
  } catch (error) {
    vscode.window.showErrorMessage(`Remove integration failed: ${errorMessage(error)}`, { modal: true });
  }
}

function diagnose(context) {
  const folder = commandFolder();
  const session = vscode.debug.activeDebugSession;
  let flutterWorkspace = false;
  if (folder) {
    try {
      const root = folder.uri.fsPath;
      const pubspec = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8');
      flutterWorkspace = /^\s*flutter:\s*$/m.test(pubspec) || fs.existsSync(path.join(root, 'lib', 'main.dart'));
    } catch {
      // No pubspec.yaml in this workspace folder.
    }
  }
  const lines = [
    `extension ${context.extension.packageJSON.version} / protocol ${PROTOCOL_VERSION}`,
    `workspace: ${folder ? folder.uri.fsPath : 'none'}`,
    `Flutter workspace: ${flutterWorkspace ? 'yes' : 'no'}`,
    `signal: ${folder ? vscode.Uri.joinPath(folder.uri, signalFile()).fsPath : 'unavailable'}`,
    `active debug session: ${session ? `${session.name} (${session.type})` : 'none'}`,
    `session workspace: ${session && session.workspaceFolder ? session.workspaceFolder.uri.fsPath : 'none'}`,
    `sender: ${diagnosticBridgeLines()}`,
    `duplicates: ${duplicateExtensionLines().join(' ') || 'none'}`,
  ];
  channel().clear();
  channel().appendLine(lines.join('\n'));
  channel().show(true);
  const healthy = Boolean(session && folder && session.type === 'dart' && session.workspaceFolder
    && samePath(session.workspaceFolder.uri.fsPath, folder.uri.fsPath));
  show(healthy ? 'diagnostics complete; see the Flutter Agent Refresh output'
    : 'diagnostics found issues; see the Flutter Agent Refresh output', healthy ? 'info' : 'warning');
}

function detectLegacyCopies(context) {
  try {
    const extensionsDir = path.dirname(context.extensionPath);
    return fs.readdirSync(extensionsDir)
      .filter((name) => /^(?:local\.pi-flutter-refresh-bridge-|sergionius\.pi-flutter-refresh-bridge-)/.test(name)
        && path.join(extensionsDir, name) !== context.extensionPath)
      .map((name) => path.join(extensionsDir, name));
  } catch {
    return [];
  }
}

async function offerLegacyCleanup(context) {
  const legacy = detectLegacyCopies(context);
  if (legacy.length === 0) return;
  const choice = await vscode.window.showWarningMessage(
    `Flutter Agent Refresh found old extension copies:\n\n${legacy.join('\n')}\n\nKeeping both copies causes duplicate refreshes.`,
    'Remove old copies',
  );
  if (choice !== 'Remove old copies') return;
  try {
    for (const directory of legacy) fs.rmSync(directory, { recursive: true, force: true });
    vscode.window.showInformationMessage('Old copies removed. Run Developer: Reload Window to finish.', { modal: true });
  } catch (error) {
    vscode.window.showErrorMessage(`Could not remove old copies: ${errorMessage(error)}`);
  }
}

function activate(context) {
  ensureBridgeFiles(context);
  offerLegacyCleanup(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('piFlutterRefreshBridge.hotReload', () => runManual('reload')),
    vscode.commands.registerCommand('piFlutterRefreshBridge.hotRestart', () => runManual('restart')),
    vscode.commands.registerCommand('piFlutterRefreshBridge.diagnose', () => diagnose(context)),
    vscode.commands.registerCommand('piFlutterRefreshBridge.setUpAgent', () => setUpAgent(context)),
    vscode.commands.registerCommand('piFlutterRefreshBridge.removeAgentIntegration', () => removeAgentIntegration(context)),
  );

  for (const folder of vscode.workspace.workspaceFolders || []) registerWatcher(context, folder);

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.added) registerWatcher(context, folder);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('piFlutterRefreshBridge.signalFile')) {
      show('signalFile changed; reload the VS Code window to recreate watchers', 'warning');
    }
  }));
}

function deactivate() {
  if (statusTimer) clearTimeout(statusTimer);
  if (statusItem) statusItem.dispose();
}

module.exports = { activate, deactivate };
