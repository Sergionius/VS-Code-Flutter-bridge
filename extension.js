const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 1;
const DEFAULT_SIGNAL_FILE = '.dart_tool/pi_flutter_refresh/request.json';
const RESPONSE_DIRECTORY = 'responses';
const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
const RESPONSE_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

let lastLegacyRequestKey = '';
let processing = Promise.resolve();
let statusItem;
let statusTimer;
const processedRequestIds = new Set();

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
    statusItem.name = 'Pi Flutter Refresh Bridge';
  }

  const icon = level === 'error' ? '$(error)' : level === 'warning' ? '$(warning)' : '$(sync)';
  statusItem.text = `${icon} Pi Flutter Bridge: ${message}`;
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
  const command = mode === 'restart' ? 'dart.hotRestart' : 'dart.hotReload';
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

function diagnose() {
  const folder = commandFolder();
  const session = vscode.debug.activeDebugSession;
  const details = [
    `extension 0.2.0 / protocol ${PROTOCOL_VERSION}`,
    `workspace: ${folder ? folder.uri.fsPath : 'none'}`,
    `signal: ${folder ? vscode.Uri.joinPath(folder.uri, signalFile()).fsPath : 'unavailable'}`,
    `active debug session: ${session ? `${session.name} (${session.type})` : 'none'}`,
    `session workspace: ${session && session.workspaceFolder ? session.workspaceFolder.uri.fsPath : 'none'}`,
  ].join(' | ');
  show(details, session && folder && session.type === 'dart' && session.workspaceFolder
    && samePath(session.workspaceFolder.uri.fsPath, folder.uri.fsPath) ? 'info' : 'warning');
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('piFlutterRefreshBridge.hotReload', () => runManual('reload')),
    vscode.commands.registerCommand('piFlutterRefreshBridge.hotRestart', () => runManual('restart')),
    vscode.commands.registerCommand('piFlutterRefreshBridge.diagnose', diagnose),
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
