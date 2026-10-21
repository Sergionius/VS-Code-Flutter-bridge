'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const setup = require('../lib/agent-setup');

const SOURCE_ROOT = path.join(__dirname, '..');

function sandbox(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-flutter-bridge-home-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, options: { homeDir: home, sourceRoot: SOURCE_ROOT, extensionVersion: '0.4.0-test' } };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('installBridgeFiles installs an executable sender and hook script idempotently', (t) => {
  const box = sandbox(t);
  const first = setup.installBridgeFiles(box.options);
  assert.equal(fs.existsSync(first.sender), true);
  assert.equal((fs.statSync(first.sender).mode & 0o111) !== 0, true);
  assert.equal(fs.existsSync(first.hook), true);
  assert.equal(readJson(path.join(box.home, '.pi-flutter-bridge', 'version.json')).extensionVersion, '0.4.0-test');
  assert.equal(first.updated, true);

  const second = setup.installBridgeFiles(box.options);
  assert.equal(second.updated, false);

  setup.removeBridgeHome({ homeDir: box.home });
  const status = setup.bridgeStatus({ homeDir: box.home });
  assert.equal(status.senderInstalled, false);
  assert.equal(status.hookInstalled, false);
});

test('installSkill installs the template for both agents and is idempotent', (t) => {
  const box = sandbox(t);
  for (const agent of ['codex', 'claude']) {
    const first = setup.installSkill(agent, box.options);
    assert.equal(first.installed, true);
    assert.equal(first.updated, true);
    assert.equal(fs.readFileSync(first.path, 'utf8').includes(setup.SKILL_MARKER), true);
    assert.equal(setup.skillStatus(agent, { homeDir: box.home }), 'ours');

    const second = setup.installSkill(agent, box.options);
    assert.equal(second.installed, true);
    assert.equal(second.updated, false);

    const removed = setup.removeSkill(agent, { homeDir: box.home });
    assert.equal(removed.removed, true);
    assert.equal(setup.skillStatus(agent, { homeDir: box.home }), 'missing');
  }
});

test('installSkill never overwrites a foreign skill and removeSkill keeps it', (t) => {
  const box = sandbox(t);
  const directory = setup.skillDirectory('codex', box.home);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'mine, not the bridge');

  const result = setup.installSkill('codex', box.options);
  assert.equal(result.installed, false);
  assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), 'mine, not the bridge');

  const removed = setup.removeSkill('codex', { homeDir: box.home });
  assert.equal(removed.removed, false);
  assert.equal(fs.existsSync(path.join(directory, 'SKILL.md')), true);
});

test('addAgentHooks merges into existing settings without duplicates and preserves foreign entries', (t) => {
  const box = sandbox(t);
  const settingsFile = path.join(box.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: { SOMETHING: 'keep' },
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
    },
  }, null, 2));

  const added = setup.addAgentHooks('claude', { homeDir: box.home });
  assert.deepEqual(added.changed.sort(), ['PostToolUse', 'Stop']);
  const afterFirst = readJson(settingsFile);
  assert.equal(afterFirst.env.SOMETHING, 'keep');
  assert.equal(afterFirst.hooks.PostToolUse.length, 2);
  assert.equal(afterFirst.hooks.Stop.length, 2);
  assert.equal(afterFirst.hooks.PostToolUse[0].hooks[0].command, 'echo foreign');

  const again = setup.addAgentHooks('claude', { homeDir: box.home });
  assert.deepEqual(again.changed, []);
  const afterSecond = readJson(settingsFile);
  assert.equal(afterSecond.hooks.PostToolUse.length, 2);

  const removed = setup.removeAgentHooks('claude', { homeDir: box.home });
  assert.deepEqual(removed.changed.sort(), ['PostToolUse', 'Stop']);
  const afterRemoval = readJson(settingsFile);
  assert.equal(afterRemoval.env.SOMETHING, 'keep');
  assert.equal(afterRemoval.hooks.PostToolUse.length, 1);
  assert.equal(afterRemoval.hooks.Stop.length, 1);
  assert.equal(afterRemoval.hooks.PostToolUse[0].hooks[0].command, 'echo foreign');
});

test('addAgentHooks creates a Codex hooks.json from scratch and removeAgentHooks drops empty events', (t) => {
  const box = sandbox(t);
  const hooksFile = path.join(box.home, '.codex', 'hooks.json');

  setup.addAgentHooks('codex', { homeDir: box.home });
  const created = readJson(hooksFile);
  assert.equal(created.hooks.PostToolUse[0].matcher.includes('apply_patch'), true);
  assert.equal(created.hooks.Stop.length, 1);
  assert.equal(setup.hooksStatus('codex', { homeDir: box.home }).configured, true);

  setup.removeAgentHooks('codex', { homeDir: box.home });
  const afterRemoval = readJson(hooksFile);
  assert.equal(afterRemoval.hooks, undefined);
  assert.equal(setup.hooksStatus('codex', { homeDir: box.home }).configured, false);
});

test('addAgentHooks keeps a mixed matcher group but removes only its own hook handlers', (t) => {
  const box = sandbox(t);
  const hooksFile = path.join(box.home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const mixed = {
    hooks: {
      Stop: [{
        hooks: [
          { type: 'command', command: 'echo foreign' },
          { type: 'command', command: `python3 "${setup.hookScriptPath(box.home)}"` },
        ],
      }],
    },
  };
  fs.writeFileSync(hooksFile, JSON.stringify(mixed, null, 2));

  const added = setup.addAgentHooks('codex', { homeDir: box.home });
  assert.deepEqual(added.changed, ['PostToolUse']);
  assert.equal(readJson(hooksFile).hooks.Stop.length, 1);

  setup.removeAgentHooks('codex', { homeDir: box.home });
  const after = readJson(hooksFile);
  assert.equal(after.hooks.Stop[0].hooks.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo foreign');
});

test('invalid JSON settings abort without modifying the file', (t) => {
  const box = sandbox(t);
  const settingsFile = path.join(box.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{ not json');

  assert.throws(() => setup.addAgentHooks('claude', { homeDir: box.home }), /not valid JSON/);
  assert.throws(() => setup.removeAgentHooks('claude', { homeDir: box.home }), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ not json');
  assert.equal(setup.hooksStatus('claude', { homeDir: box.home }).invalid, true);
});

test('pi package status follows configured source, not an orphaned checkout directory', (t) => {
  const box = sandbox(t);
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).installed, false);
  const directory = setup.piPackageDir(box.home);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).installed, false);
  const settingsFile = path.join(box.home, '.pi', 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ packages: [
    'git:git@github.com:Sergionius/VS-Code-Flutter-bridge.git',
  ] }));
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).source,
    'git:git@github.com:Sergionius/VS-Code-Flutter-bridge.git');
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).installed, true);
  fs.writeFileSync(settingsFile, JSON.stringify({ packages: ['git:github.com/Sergionius/flutter-agent-refresh'] }));
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).source,
    'git:github.com/Sergionius/flutter-agent-refresh');
  assert.equal(setup.piPackageStatus({ homeDir: box.home }).installed, true);
});

test('packaging: VSIX keeps runtime files and excludes tests and Pi package files', () => {
  const vscodeignore = fs.readFileSync(path.join(SOURCE_ROOT, '.vscodeignore'), 'utf8');
  for (const excluded of ['test/**', 'pi/**', '.github/**']) {
    assert.equal(vscodeignore.includes(excluded), true, `.vscodeignore must exclude ${excluded}`);
  }
  for (const required of [
    'extension.js',
    'lib/agent-setup.js',
    'bridge/flutter_refresh.sh',
    'bridge/agent_hook.py',
    'templates/skills/flutter-refresh/SKILL.md',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
  ]) {
    assert.equal(fs.existsSync(path.join(SOURCE_ROOT, required)), true, `${required} must exist for packaging`);
  }
});
