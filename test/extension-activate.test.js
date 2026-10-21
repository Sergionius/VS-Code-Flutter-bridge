'use strict';

// Smoke tests for activation and the Set Up Agent / Remove wizard flows with a
// mocked VS Code API. The mock answers wizard dialogs by inspecting message
// text, so the real command handlers run end to end against a temporary HOME.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');
const setup = require('../lib/agent-setup');

function makeVscodeMock() {
  const subscriptions = [];
  const registered = new Map();
  const statusMessages = [];

  const vscode = {
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: async (message, options, ...buttons) => {
        statusMessages.push(message);
        if (message.includes('Set up Flutter refresh for')) return buttons.includes('Install') ? 'Install' : undefined;
        if (message.includes('Remove Flutter refresh for')) return buttons.includes('Remove') ? 'Remove' : undefined;
        if (message.includes('Remove it too?')) return buttons.includes('Remove sender') ? 'Remove sender' : undefined;
        return undefined;
      },
      showWarningMessage: async (message, options, ...buttons) => {
        statusMessages.push(message);
        if (message.includes('Remove Flutter refresh for')) return buttons.includes('Remove') ? 'Remove' : undefined;
        if (message.includes('Remove it too?')) return buttons.includes('Remove sender') ? 'Remove sender' : undefined;
        return undefined;
      },
      showErrorMessage: async () => undefined,
      showQuickPick: async (items) => (Array.isArray(items) ? items.filter((item) => item.picked !== false) : items[0]),
      withProgress: async (_options, task) => task(),
    },
    commands: {
      registerCommand: (id, handler) => registered.set(id, handler),
      executeCommand: async () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (key, fallback) => (key === 'showNotifications' ? false : fallback) }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
    },
    debug: { activeDebugSession: null },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    extensions: { all: [] },
    env: { clipboard: { writeText: async () => undefined } },
    StatusBarAlignment: { Left: 1 },
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1 },
  };
  return { vscode, subscriptions, registered, statusMessages };
}

function loadExtensionWithMock(vscodeMock) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad(request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../extension.js')];
    return require('../extension.js');
  } finally {
    Module._load = originalLoad;
  }
}

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flutter-ext-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[require.resolve('../extension.js')];
  });
  const context = {
    extensionPath: REPO_ROOT,
    extension: { packageJSON: { version: '0.4.0-test' } },
    subscriptions: [],
  };
  return { home, context };
}

test('activation installs the shared sender and registers all commands', (t) => {
  const box = sandbox(t);
  const mock = makeVscodeMock();
  const extension = loadExtensionWithMock(mock.vscode);

  extension.activate(box.context);
  assert.deepEqual([...mock.registered.keys()].sort(), [
    'piFlutterRefreshBridge.diagnose',
    'piFlutterRefreshBridge.hotReload',
    'piFlutterRefreshBridge.hotRestart',
    'piFlutterRefreshBridge.removeAgentIntegration',
    'piFlutterRefreshBridge.setUpAgent',
  ]);
  assert.equal(fs.existsSync(path.join(box.home, '.pi-flutter-bridge', 'bin', 'flutter_refresh.sh')), true);
  assert.equal(fs.existsSync(path.join(box.home, '.pi-flutter-bridge', 'hooks', 'agent_hook.py')), true);
  extension.deactivate();
});

test('setUpAgent installs skill and hooks for Codex through the wizard', (t) => {
  const box = sandbox(t);
  const mock = makeVscodeMock();
  const extension = loadExtensionWithMock(mock.vscode);
  extension.activate(box.context);

  mock.vscode.window.showQuickPick = async (items, options) => {
    if (options && options.canPickMany) return items; // skill + hooks both selected
    return items.find((item) => item.value === 'codex');
  };
  return mock.registered.get('piFlutterRefreshBridge.setUpAgent')().then(() => {
    assert.equal(setup.skillStatus('codex', { homeDir: box.home }), 'ours');
    assert.equal(setup.hooksStatus('codex', { homeDir: box.home }).configured, true);
    extension.deactivate();
  });
});

test('removeAgentIntegration removes skill, hooks, and the shared sender', async (t) => {
  const box = sandbox(t);
  const mock = makeVscodeMock();
  const extension = loadExtensionWithMock(mock.vscode);
  extension.activate(box.context);

  setup.installSkill('claude', { homeDir: box.home, sourceRoot: REPO_ROOT });
  setup.addAgentHooks('claude', { homeDir: box.home });

  mock.vscode.window.showQuickPick = async (items) => items.find((item) => item.value === 'claude');
  await mock.registered.get('piFlutterRefreshBridge.removeAgentIntegration')();

  assert.equal(setup.skillStatus('claude', { homeDir: box.home }), 'missing');
  assert.equal(setup.hooksStatus('claude', { homeDir: box.home }).configured, false);
  assert.equal(fs.existsSync(path.join(box.home, '.pi-flutter-bridge')), false);
  extension.deactivate();
});

test('activation offers removal of legacy local.* extension copies', async (t) => {
  const box = sandbox(t);
  const mock = makeVscodeMock();
  const extensionsDir = path.join(box.home, '.vscode', 'extensions');
  const current = path.join(extensionsDir, 'sergionius.flutter-agent-refresh-0.4.0');
  const legacy = path.join(extensionsDir, 'local.pi-flutter-refresh-bridge-0.3.0');
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.symlinkSync(REPO_ROOT, current, 'dir');

  mock.vscode.window.showWarningMessage = async () => 'Remove old copies';
  const extension = loadExtensionWithMock(mock.vscode);
  extension.activate({ ...box.context, extensionPath: current });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(current), true);
  extension.deactivate();
});

test('diagnose writes a full report without a workspace or debug session', async (t) => {
  const box = sandbox(t);
  const mock = makeVscodeMock();
  const lines = [];
  mock.vscode.window.createOutputChannel = () => ({
    clear() {},
    appendLine: (line) => lines.push(line),
    show() {},
    dispose() {},
  });
  const extension = loadExtensionWithMock(mock.vscode);
  extension.activate(box.context);
  setup.installSkill('claude', { homeDir: box.home, sourceRoot: REPO_ROOT });

  await mock.registered.get('piFlutterRefreshBridge.diagnose')();
  const report = lines.join('\n');
  assert.match(report, /extension 0\.4\.0-test/);
  assert.match(report, /\nsender: OK/);
  assert.match(report, /\n    hook script: OK/);
  assert.doesNotMatch(report, /\\n    hook script/);
  assert.doesNotMatch(report, /sender: sender:/);
  assert.match(report, /Pi package: not installed/);
  assert.match(report, /Codex skill: not installed/);
  assert.match(report, /Claude Code skill: OK .*manual requests require a shell tool/);
  assert.match(report, /Claude Code hooks: not configured/);
  assert.match(report, /Flutter workspace: no/);
  assert.match(report, /active debug session: none/);
  extension.deactivate();
});
