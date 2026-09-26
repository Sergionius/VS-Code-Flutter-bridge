const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flutter-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = { uri: { fsPath: root } };
  const commands = [];
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => key === 'showNotifications' ? false : fallback }),
      fs: {
        stat: async (uri) => fs.promises.stat(uri.fsPath),
        createDirectory: async (uri) => fs.promises.mkdir(uri.fsPath, { recursive: true }),
        writeFile: async (uri, bytes) => fs.promises.writeFile(uri.fsPath, bytes),
        rename: async (from, to) => fs.promises.rename(from.fsPath, to.fsPath),
      },
    },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    debug: {
      activeDebugSession: options.session === undefined
        ? { type: 'dart', workspaceFolder: folder }
        : options.session,
    },
    commands: {
      executeCommand: async (command) => {
        commands.push(command);
        if (options.failCommands?.includes(command)) throw new Error(`${command} failed`);
      },
    },
  };
  const bridge = { exports: {} };
  vm.runInNewContext(`${source}\nmodule.exports.executeProtocolRequest = executeProtocolRequest;`, {
    module: bridge,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    require: (name) => name === 'vscode' ? vscode : require(name),
  }, { filename: 'extension.js' });
  const request = (id, overrides = {}) => ({
    protocolVersion: 1,
    requestId: id,
    mode: 'reload',
    cwd: root,
    createdAt: Date.now(),
    ...overrides,
  });
  const result = (id) => JSON.parse(fs.readFileSync(
    path.join(root, '.dart_tool/pi_flutter_refresh/responses', `${id}.json`), 'utf8',
  ));
  return { folder, commands, request, result, execute: bridge.exports.executeProtocolRequest };
}

test('acknowledges a valid hot reload and does not repeat the request', async (t) => {
  const h = harness(t);
  const request = h.request('reload-1');
  await h.execute(request, h.folder);
  await h.execute(request, h.folder);
  assert.deepEqual(h.commands, ['dart.hotReload']);
  assert.equal(h.result(request.requestId).status, 'ok');
  assert.equal(h.result(request.requestId).performedMode, 'reload');
});

test('falls back to hot restart when reload fails', async (t) => {
  const h = harness(t, { failCommands: ['dart.hotReload'] });
  await h.execute(h.request('fallback-1'), h.folder);
  assert.deepEqual(h.commands, ['dart.hotReload', 'flutter.hotRestart']);
  assert.equal(h.result('fallback-1').performedMode, 'restart');
});

test('reports command failure if both attempts fail', async (t) => {
  const h = harness(t, { failCommands: ['dart.hotReload', 'flutter.hotRestart'] });
  await h.execute(h.request('failure-1'), h.folder);
  assert.equal(h.result('failure-1').status, 'command_failed');
  assert.equal(h.result('failure-1').performedMode, null);
});

test('rejects requests from another workspace without invoking Dart-Code', async (t) => {
  const h = harness(t);
  await h.execute(h.request('other-workspace', { cwd: '/another/workspace' }), h.folder);
  assert.equal(h.result('other-workspace').status, 'workspace_mismatch');
  assert.deepEqual(h.commands, []);
});

test('reports a missing debug session', async (t) => {
  const h = harness(t, { session: null });
  await h.execute(h.request('no-session'), h.folder);
  assert.equal(h.result('no-session').status, 'no_debug_session');
  assert.deepEqual(h.commands, []);
});

test('rejects expired requests with a usable ID', async (t) => {
  const h = harness(t);
  await h.execute(h.request('expired-1', { createdAt: Date.now() - 10 * 60_000 }), h.folder);
  assert.equal(h.result('expired-1').status, 'invalid_request');
  assert.deepEqual(h.commands, []);
});
