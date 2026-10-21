'use strict';

// Installer, remover, and status checks for agent integrations. This module
// must stay free of the VS Code API so tests can drive it with a fake home
// directory. The extension passes context.extensionPath as sourceRoot.

const fs = require('fs');
const path = require('path');

const EXTENSION_NAME = 'flutter-agent-refresh';
const SKILL_NAME = 'flutter-refresh';
const SKILL_MARKER = '<!-- pi-flutter-bridge -->';
const HOOK_MARKER = path.join('.pi-flutter-bridge', 'hooks', 'agent_hook.py');
const PI_PACKAGE_REPO = 'flutter-agent-refresh';
const PI_PACKAGE_DIR = path.join('.pi', 'agent', 'git', 'github.com', 'Sergionius', PI_PACKAGE_REPO);

const AGENTS = {
  codex: { label: 'Codex', skillsDir: path.join('.codex', 'skills'), hooksFile: path.join('.codex', 'hooks.json') },
  claude: { label: 'Claude Code', skillsDir: path.join('.claude', 'skills'), hooksFile: path.join('.claude', 'settings.json') },
};

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeFileAtomically(target, content, mode) {
  ensureDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, target);
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function filesIdentical(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  if (fs.statSync(left).size !== fs.statSync(right).size) return false;
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function copyExecutable(source, target) {
  ensureDirectory(path.dirname(target));
  writeFileAtomically(target, fs.readFileSync(source), 0o755);
}

// --- Shared bridge files (~/.pi-flutter-bridge) ---

function bridgeHomeDir(homeDir = osHome()) {
  return path.join(homeDir, '.pi-flutter-bridge');
}

function osHome() {
  return process.env.HOME || require('os').homedir();
}

function senderPath(homeDir) {
  return path.join(bridgeHomeDir(homeDir), 'bin', 'flutter_refresh.sh');
}

function hookScriptPath(homeDir) {
  return path.join(bridgeHomeDir(homeDir), 'hooks', 'agent_hook.py');
}

function installBridgeFiles({ homeDir, sourceRoot, extensionVersion }) {
  const source = {
    sender: path.join(sourceRoot, 'bridge', 'flutter_refresh.sh'),
    hook: path.join(sourceRoot, 'bridge', 'agent_hook.py'),
  };
  for (const file of Object.values(source)) {
    if (!fs.existsSync(file)) throw new Error(`bundled file is missing: ${file}`);
  }
  const target = { sender: senderPath(homeDir), hook: hookScriptPath(homeDir) };
  const updated = !(filesIdentical(source.sender, target.sender) && filesIdentical(source.hook, target.hook));
  if (updated) {
    copyExecutable(source.sender, target.sender);
    copyExecutable(source.hook, target.hook);
    writeFileAtomically(
      path.join(bridgeHomeDir(homeDir), 'version.json'),
      `${JSON.stringify({ extensionVersion: extensionVersion || null, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return { sender: target.sender, hook: target.hook, updated };
}

function bridgeStatus({ homeDir }) {
  const sender = senderPath(homeDir);
  const hook = hookScriptPath(homeDir);
  return {
    home: bridgeHomeDir(homeDir),
    sender,
    senderInstalled: fs.existsSync(sender),
    senderExecutable: fs.existsSync(sender) && (fs.statSync(sender).mode & 0o111) !== 0,
    hook,
    hookInstalled: fs.existsSync(hook),
  };
}

function removeBridgeHome({ homeDir }) {
  fs.rmSync(bridgeHomeDir(homeDir), { recursive: true, force: true });
}

// --- Skills ---

function skillDirectory(agent, homeDir, skillName = SKILL_NAME) {
  return path.join(homeDir, AGENTS[agent].skillsDir, skillName);
}

function skillStatus(agent, { homeDir }, skillName = SKILL_NAME) {
  const file = path.join(skillDirectory(agent, homeDir, skillName), 'SKILL.md');
  if (!fs.existsSync(file)) return 'missing';
  return fs.readFileSync(file, 'utf8').includes(SKILL_MARKER) ? 'ours' : 'foreign';
}

function installSkill(agent, { homeDir, sourceRoot }, skillName = SKILL_NAME) {
  const directory = skillDirectory(agent, homeDir, skillName);
  const file = path.join(directory, 'SKILL.md');
  const status = skillStatus(agent, { homeDir }, skillName);
  if (status === 'foreign') return { installed: false, reason: `${file} already exists and was not installed by this bridge`, path: file };

  const template = fs.readFileSync(path.join(sourceRoot, 'templates', 'skills', skillName, 'SKILL.md'), 'utf8');
  if (status === 'ours' && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === template) {
    return { installed: true, updated: false, path: file };
  }
  writeFileAtomically(file, template);
  return { installed: true, updated: true, path: file };
}

function removeSkill(agent, { homeDir }, skillName = SKILL_NAME) {
  const directory = skillDirectory(agent, homeDir, skillName);
  const status = skillStatus(agent, { homeDir }, skillName);
  if (status === 'missing') return { removed: false, reason: 'not installed', path: directory };
  if (status === 'foreign') return { removed: false, reason: `${directory} was not installed by this bridge`, path: directory };
  fs.rmSync(directory, { recursive: true, force: true });
  return { removed: true, path: directory };
}

// --- Hook configuration (Codex hooks.json / Claude settings.json) ---

function hookCommand(homeDir) {
  return `python3 "${hookScriptPath(homeDir)}"`;
}

function hookEntries(agent, homeDir) {
  const command = hookCommand(homeDir);
  if (agent === 'codex') {
    return {
      PostToolUse: [{
        matcher: 'Edit|Write|apply_patch|Bash',
        hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'flutter-bridge: tracking Flutter changes' }],
      }],
      Stop: [{
        hooks: [{ type: 'command', command, timeout: 30, statusMessage: 'flutter-bridge: refresh' }],
      }],
    };
  }
  return {
    PostToolUse: [{
      matcher: 'Edit|Write|Bash',
      hooks: [{ type: 'command', command, timeout: 10 }],
    }],
    Stop: [{
      hooks: [{ type: 'command', command, timeout: 30 }],
    }],
  };
}

function isOurMatcherGroup(group) {
  const hooks = group && Array.isArray(group.hooks) ? group.hooks : [];
  return hooks.some((hook) => typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER));
}

function hooksFile(agent, homeDir) {
  return path.join(homeDir, AGENTS[agent].hooksFile);
}

function addAgentHooks(agent, { homeDir }) {
  const file = hooksFile(agent, homeDir);
  let settings;
  try {
    settings = readJsonIfExists(file);
  } catch (error) {
    throw new Error(`${file} is not valid JSON; it was not modified (${error.message})`);
  }
  settings = settings && typeof settings === 'object' ? settings : {};
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

  const entries = hookEntries(agent, homeDir);
  const changed = [];
  for (const [event, groups] of Object.entries(entries)) {
    settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    if (settings.hooks[event].some(isOurMatcherGroup)) continue;
    settings.hooks[event].push(...groups);
    changed.push(event);
  }
  if (changed.length > 0) {
    writeFileAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { file, changed };
}

function removeAgentHooks(agent, { homeDir }) {
  const file = hooksFile(agent, homeDir);
  if (!fs.existsSync(file)) return { file, changed: [] };
  let settings;
  try {
    settings = readJsonIfExists(file);
  } catch (error) {
    throw new Error(`${file} is not valid JSON; it was not modified (${error.message})`);
  }
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') {
    return { file, changed: [] };
  }

  const changed = [];
  for (const event of ['PostToolUse', 'Stop']) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    let modified = false;
    for (const group of groups) {
      if (!isOurMatcherGroup(group)) {
        kept.push(group);
        continue;
      }
      const foreign = (group.hooks || []).filter(
        (hook) => !(typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER)),
      );
      if (foreign.length > 0) kept.push({ ...group, hooks: foreign });
      modified = true;
    }
    if (!modified) continue;
    changed.push(event);
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed.length > 0) writeFileAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, changed };
}

function hooksStatus(agent, { homeDir }) {
  const file = hooksFile(agent, homeDir);
  try {
    const settings = readJsonIfExists(file);
    if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') {
      return { file, configured: false };
    }
    const configured = ['PostToolUse', 'Stop'].every((event) => Array.isArray(settings.hooks[event])
      && settings.hooks[event].some(isOurMatcherGroup));
    return { file, configured };
  } catch {
    return { file, configured: false, invalid: true };
  }
}

// Claude slash commands use a host-run hook: the model does not need Bash.
const CLAUDE_MANUAL_SKILLS = ['flutter-reload', 'flutter-restart'];
const MANUAL_HOOK_EVENT = 'UserPromptExpansion';
const MANUAL_HOOK_MATCHER = 'flutter-reload|flutter-restart';

function claudeManualStatus({ homeDir }) {
  const skills = CLAUDE_MANUAL_SKILLS.map((name) => skillStatus('claude', { homeDir }, name));
  const file = hooksFile('claude', homeDir);
  try {
    const settings = readJsonIfExists(file);
    const groups = settings && settings.hooks && settings.hooks[MANUAL_HOOK_EVENT];
    const configured = Array.isArray(groups) && groups.some((group) =>
      group.matcher === MANUAL_HOOK_MATCHER && isOurMatcherGroup(group));
    return { file, configured: Boolean(configured), skills };
  } catch {
    return { file, configured: false, invalid: true, skills };
  }
}

function addClaudeManualHook({ homeDir }) {
  const file = hooksFile('claude', homeDir);
  let settings;
  try {
    settings = readJsonIfExists(file);
  } catch (error) {
    throw new Error(`${file} is not valid JSON; it was not modified (${error.message})`);
  }
  settings = settings && typeof settings === 'object' ? settings : {};
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = Array.isArray(settings.hooks[MANUAL_HOOK_EVENT]) ? settings.hooks[MANUAL_HOOK_EVENT] : [];
  if (groups.some((group) => group.matcher === MANUAL_HOOK_MATCHER && isOurMatcherGroup(group))) {
    return { file, changed: false };
  }
  groups.push({ matcher: MANUAL_HOOK_MATCHER, hooks: [{
    type: 'command', command: hookCommand(homeDir), timeout: 30,
    statusMessage: 'flutter-bridge: manual refresh',
  }] });
  settings.hooks[MANUAL_HOOK_EVENT] = groups;
  writeFileAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, changed: true };
}

function removeClaudeManualHook({ homeDir }) {
  const file = hooksFile('claude', homeDir);
  if (!fs.existsSync(file)) return { file, changed: false };
  let settings;
  try {
    settings = readJsonIfExists(file);
  } catch (error) {
    throw new Error(`${file} is not valid JSON; it was not modified (${error.message})`);
  }
  const groups = settings && settings.hooks && settings.hooks[MANUAL_HOOK_EVENT];
  if (!Array.isArray(groups)) return { file, changed: false };
  const kept = groups.flatMap((group) => {
    if (group.matcher !== MANUAL_HOOK_MATCHER || !isOurMatcherGroup(group)) return [group];
    const foreign = group.hooks.filter((hook) => !(typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER)));
    return foreign.length ? [{ ...group, hooks: foreign }] : [];
  });
  if (kept.length === groups.length && kept.every((group, index) => group === groups[index])) return { file, changed: false };
  if (kept.length) settings.hooks[MANUAL_HOOK_EVENT] = kept;
  else delete settings.hooks[MANUAL_HOOK_EVENT];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeFileAtomically(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, changed: true };
}

// --- Pi package ---

function piPackageDir(homeDir) {
  return path.join(homeDir, PI_PACKAGE_DIR);
}

function piPackageStatus({ homeDir }) {
  const directory = piPackageDir(homeDir);
  const settingsFile = path.join(homeDir, '.pi', 'agent', 'settings.json');
  let configuredSource;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    configuredSource = (settings.packages || []).map((entry) => typeof entry === 'string' ? entry : entry.source)
      .find((source) => typeof source === 'string'
        && /(?:\/|:)Sergionius\/(?:flutter-agent-refresh|VS-Code-Flutter-bridge)(?:\.git)?(?:@[^/]*)?$/i.test(source));
  } catch {
    // If settings are missing or invalid, never claim a package can be safely removed.
  }
  const installedDirectory = configuredSource && /VS-Code-Flutter-bridge/i.test(configuredSource)
    ? path.join(homeDir, '.pi', 'agent', 'git', 'github.com', 'Sergionius', 'VS-Code-Flutter-bridge')
    : directory;
  return { directory: installedDirectory, source: configuredSource, installed: Boolean(configuredSource) };
}

module.exports = {
  AGENTS,
  EXTENSION_NAME,
  HOOK_MARKER,
  SKILL_MARKER,
  SKILL_NAME,
  addAgentHooks,
  bridgeHomeDir,
  bridgeStatus,
  hookCommand,
  hookEntries,
  hooksFile,
  hooksStatus,
  CLAUDE_MANUAL_SKILLS,
  claudeManualStatus,
  addClaudeManualHook,
  removeClaudeManualHook,
  installBridgeFiles,
  installSkill,
  piPackageDir,
  piPackageStatus,
  removeAgentHooks,
  removeBridgeHome,
  removeSkill,
  senderPath,
  skillDirectory,
  skillStatus,
  hookScriptPath,
};
