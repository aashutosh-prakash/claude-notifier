#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const PKG = require('../package.json');

const MATCHER = 'permission_prompt';
const RUNNER_MARKER = 'claude-notifier/notify.js';
const KEEP_BACKUPS = 5;
const COUNTDOWN_SECONDS = 3;

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const isTTY = process.stdout.isTTY;
const c = (code, str) => (isTTY ? code + str + COLOR.reset : str);

function parseArgs(argv) {
  const flags = {
    install: true,
    uninstall: false,
    test: false,
    doctor: false,
    dryRun: false,
    force: false,
    keepBackups: false,
    help: false,
    version: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--uninstall': flags.uninstall = true; flags.install = false; break;
      case '--test': flags.test = true; flags.install = false; break;
      case '--doctor': flags.doctor = true; flags.install = false; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--force': flags.force = true; break;
      case '--keep-backups': flags.keepBackups = true; break;
      case '--install': flags.install = true; break;
      case '-h': case '--help': flags.help = true; flags.install = false; break;
      case '-v': case '--version': flags.version = true; flags.install = false; break;
      default:
        process.stderr.write(`claude-notifier: unknown flag: ${arg}\n`);
        process.exit(2);
    }
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`claude-notifier — macOS notification hook for Claude Code

Usage:
  npx claude-notifier              Install the Notification hook into ~/.claude/settings.json
  npx claude-notifier --uninstall  Remove the hook (and runner directory)
  npx claude-notifier --test       Fire a sample notification to verify install
  npx claude-notifier --doctor     Diagnose install health
  npx claude-notifier --dry-run    Show what would change without writing
  npx claude-notifier --force      Skip the 3s confirm when replacing a foreign hook
  npx claude-notifier --keep-backups   On --uninstall, retain the backup directory
  npx claude-notifier --help       This text
  npx claude-notifier --version    Print version

Docs: https://github.com/aashutosh-prakash/claude-notifier
`);
}

function fail(msg, code = 1) {
  process.stderr.write(c(COLOR.red, `✗ ${msg}`) + '\n');
  process.exit(code);
}

function ensureMac() {
  if (process.platform !== 'darwin') {
    fail(`claude-notifier only supports macOS. Detected platform: ${process.platform}`);
  }
}

function ensureHomedirSafe() {
  const home = os.homedir();
  if (!home || !path.isAbsolute(home)) {
    fail(`Could not resolve a valid home directory (got: ${JSON.stringify(home)})`);
  }
  if (/[;$`"'\\\n\r]/.test(home)) {
    fail(`Home directory contains shell-meta characters and is unsafe for hook installation: ${home}`);
  }
  return home;
}

function paths(home) {
  const claudeDir = path.join(home, '.claude');
  return {
    claudeDir,
    settings: path.join(claudeDir, 'settings.json'),
    runnerDir: path.join(claudeDir, 'claude-notifier'),
    runner: path.join(claudeDir, 'claude-notifier', 'notify.js'),
    backupDir: path.join(claudeDir, '.claude-notifier-backups'),
  };
}

function ensureDir(dir, mode) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode });
  }
  if (mode !== undefined) {
    try { fs.chmodSync(dir, mode); } catch { /* best effort */ }
  }
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const stat = fs.lstatSync(settingsPath);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(settingsPath);
    const resolved = path.resolve(path.dirname(settingsPath), target);
    const claudeDir = path.dirname(settingsPath);
    if (!resolved.startsWith(claudeDir + path.sep) && resolved !== claudeDir) {
      fail(`Refusing to write: ~/.claude/settings.json is a symlink pointing outside ~/.claude/ (target: ${resolved})`);
    }
  }
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); }
  catch (err) { fail(`Could not read ${settingsPath}: ${err.message}`); }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (err) { fail(`${settingsPath} is not valid JSON: ${err.message}`); }
}

function atomicWrite(filePath, contents, mode) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, contents, { mode: mode !== undefined ? mode : 0o644 });
  fs.renameSync(tmp, filePath);
}

function serializeSettings(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function isoTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupSettings(p) {
  if (!fs.existsSync(p.settings)) return null;
  ensureDir(p.backupDir, 0o700);
  const backupPath = path.join(p.backupDir, `settings.json.${isoTimestamp()}`);
  const contents = fs.readFileSync(p.settings);
  fs.writeFileSync(backupPath, contents, { mode: 0o600 });
  rotateBackups(p.backupDir, KEEP_BACKUPS);
  return backupPath;
}

function rotateBackups(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir)
    .filter((n) => n.startsWith('settings.json.'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of entries.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* ignore */ }
  }
}

function installRunner(p) {
  ensureDir(p.runnerDir, 0o755);
  const src = path.join(__dirname, 'notify.js');
  const contents = fs.readFileSync(src);
  fs.writeFileSync(p.runner, contents, { mode: 0o755 });
}

function removeRunnerDir(p) {
  if (fs.existsSync(p.runnerDir)) {
    fs.rmSync(p.runnerDir, { recursive: true, force: true });
  }
}

function isOurHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(RUNNER_MARKER));
}

function buildOurEntry(runnerPath) {
  return {
    matcher: MATCHER,
    hooks: [
      { type: 'command', command: runnerPath },
    ],
  };
}

function mergeHook(settings, ourEntry) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
  if (!Array.isArray(next.hooks.Notification)) next.hooks.Notification = [];
  const arr = next.hooks.Notification;
  const idx = arr.findIndex((e) => e && e.matcher === MATCHER);
  let action;
  if (idx === -1) {
    arr.push(ourEntry);
    action = 'appended';
  } else if (isOurHookEntry(arr[idx])) {
    arr[idx] = ourEntry;
    action = 'replaced-ours';
  } else {
    arr[idx] = ourEntry;
    action = 'replaced-foreign';
  }
  return { next, action };
}

function removeHook(settings) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks || !Array.isArray(next.hooks.Notification)) return { next, removed: false };
  const arr = next.hooks.Notification;
  const before = arr.length;
  next.hooks.Notification = arr.filter((e) => !(e && e.matcher === MATCHER && isOurHookEntry(e)));
  const removed = next.hooks.Notification.length < before;
  if (next.hooks.Notification.length === 0) delete next.hooks.Notification;
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, removed };
}

function simpleDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(c(COLOR.red, `- ${a[i]}`));
    if (b[i] !== undefined) out.push(c(COLOR.green, `+ ${b[i]}`));
  }
  return out.join('\n');
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function confirmForeignReplace(existingEntry, force) {
  if (force || !isTTY) return true;
  process.stdout.write(c(COLOR.yellow, '⚠  Existing permission_prompt hook detected (not from claude-notifier):') + '\n');
  process.stdout.write(c(COLOR.dim, '   ' + JSON.stringify(existingEntry, null, 2).replace(/\n/g, '\n   ')) + '\n');
  process.stdout.write(`It will be replaced. Backup will be written first. Press Ctrl-C within ${COUNTDOWN_SECONDS}s to abort, or re-run with --force to skip this prompt.\n`);
  for (let i = COUNTDOWN_SECONDS; i > 0; i--) {
    process.stdout.write(`\r  continuing in ${i}s... `);
    await sleep(1000);
  }
  process.stdout.write('\r  continuing now.           \n');
  return true;
}

function findForeignEntry(settings) {
  const arr = settings && settings.hooks && Array.isArray(settings.hooks.Notification) ? settings.hooks.Notification : [];
  const idx = arr.findIndex((e) => e && e.matcher === MATCHER);
  if (idx === -1) return null;
  if (isOurHookEntry(arr[idx])) return null;
  return arr[idx];
}

async function cmdInstall(p, flags) {
  ensureDir(p.claudeDir, 0o755);
  const settingsBefore = readSettings(p.settings);

  const foreign = findForeignEntry(settingsBefore);
  if (foreign) {
    await confirmForeignReplace(foreign, flags.force);
  }

  const ourEntry = buildOurEntry(p.runner);
  const { next, action } = mergeHook(settingsBefore, ourEntry);

  const beforeStr = serializeSettings(settingsBefore);
  const afterStr = serializeSettings(next);

  if (flags.dryRun) {
    process.stdout.write(c(COLOR.cyan, '── dry-run: proposed changes to ~/.claude/settings.json ──') + '\n');
    process.stdout.write(simpleDiff(beforeStr, afterStr) + '\n');
    process.stdout.write(c(COLOR.cyan, '── would also: ──') + '\n');
    process.stdout.write(`  write runner: ${p.runner}\n`);
    process.stdout.write(`  write backup: ${p.backupDir}/settings.json.<timestamp>\n`);
    return;
  }

  const backupPath = backupSettings(p);
  installRunner(p);
  atomicWrite(p.settings, afterStr, 0o644);

  const box = [
    c(COLOR.green, '✓ claude-notifier installed'),
    `  hook    : ~/.claude/settings.json  (Notification.${MATCHER}, ${action})`,
    `  runner  : ${p.runner}`,
    `  backup  : ${backupPath || '(no previous settings to back up)'}`,
    `  next    : ${c(COLOR.cyan, 'npx claude-notifier --test')}  ${c(COLOR.dim, '(fires a sample notification)')}`,
  ];
  process.stdout.write(box.join('\n') + '\n');
}

async function cmdUninstall(p, flags) {
  if (!fs.existsSync(p.settings)) {
    process.stdout.write('Nothing to uninstall: ~/.claude/settings.json does not exist.\n');
    return;
  }
  const settingsBefore = readSettings(p.settings);
  const { next, removed } = removeHook(settingsBefore);

  const beforeStr = serializeSettings(settingsBefore);
  const afterStr = serializeSettings(next);

  if (flags.dryRun) {
    process.stdout.write(c(COLOR.cyan, '── dry-run: proposed uninstall changes ──') + '\n');
    process.stdout.write(simpleDiff(beforeStr, afterStr) + '\n');
    process.stdout.write(`  would remove runner dir: ${p.runnerDir}\n`);
    if (!flags.keepBackups) process.stdout.write(`  would remove backup dir: ${p.backupDir}\n`);
    return;
  }

  const backupPath = backupSettings(p);
  if (removed) atomicWrite(p.settings, afterStr, 0o644);
  removeRunnerDir(p);
  if (!flags.keepBackups && fs.existsSync(p.backupDir)) {
    fs.rmSync(p.backupDir, { recursive: true, force: true });
  }

  const lines = [
    c(COLOR.green, '✓ claude-notifier uninstalled'),
    `  hook    : ${removed ? 'removed' : '(not found — nothing to remove)'}`,
    `  runner  : ${p.runnerDir} removed`,
    `  backup  : ${flags.keepBackups ? `retained at ${p.backupDir}` : 'removed (use --keep-backups to retain next time)'}`,
  ];
  if (!flags.keepBackups && backupPath) {
    lines.push(c(COLOR.dim, `  (a final backup was written before cleanup: ${backupPath} — but it was just removed with the backup dir)`));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function cmdTest(p) {
  if (!fs.existsSync(p.runner)) {
    fail('Runner not installed yet. Run `npx claude-notifier` first.');
  }
  const payload = JSON.stringify({
    message: 'Test notification — claude-notifier is working',
    cwd: process.cwd(),
  });
  try {
    execSync(`echo ${JSON.stringify(payload)} | ${JSON.stringify(p.runner)}`, { stdio: 'inherit' });
    process.stdout.write(c(COLOR.green, '✓ sample notification fired') + '\n');
    process.stdout.write(c(COLOR.dim, '  If you did not see it, check System Settings → Notifications for your terminal app.') + '\n');
  } catch (err) {
    fail(`Failed to fire test notification: ${err.message}`);
  }
}

function check(label, ok, hint) {
  const mark = ok ? c(COLOR.green, '✓') : c(COLOR.red, '✗');
  process.stdout.write(`  ${mark} ${label}${ok ? '' : c(COLOR.dim, '  — ' + hint)}\n`);
  return ok;
}

function cmdDoctor(p) {
  process.stdout.write(c(COLOR.cyan, 'claude-notifier doctor') + '\n');
  let allOk = true;
  allOk = check(`platform is macOS`, process.platform === 'darwin', `detected ${process.platform}`) && allOk;
  allOk = check(`node >= 18`, Number(process.versions.node.split('.')[0]) >= 18, `detected ${process.versions.node}`) && allOk;

  const settingsExists = fs.existsSync(p.settings);
  allOk = check(`~/.claude/settings.json exists`, settingsExists, 'run `npx claude-notifier` to create') && allOk;

  if (settingsExists) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(p.settings, 'utf8') || '{}'); allOk = check('settings.json parses as JSON', true) && allOk; }
    catch (err) { allOk = check('settings.json parses as JSON', false, err.message) && allOk; settings = {}; }

    const arr = settings.hooks && Array.isArray(settings.hooks.Notification) ? settings.hooks.Notification : [];
    const ours = arr.find((e) => e && e.matcher === MATCHER && isOurHookEntry(e));
    allOk = check(`hook entry present (Notification.${MATCHER} → claude-notifier)`, !!ours, 'not installed; run `npx claude-notifier`') && allOk;

    if (ours) {
      const cmd = ours.hooks[0].command;
      const runnerExists = fs.existsSync(cmd);
      allOk = check(`runner path exists: ${cmd}`, runnerExists, 'reinstall with `npx claude-notifier`') && allOk;
      if (runnerExists) {
        const mode = fs.statSync(cmd).mode & 0o777;
        allOk = check(`runner is executable`, (mode & 0o111) !== 0, `mode is ${mode.toString(8)}`) && allOk;
      }
    }
  }

  let osascriptOk = false;
  try { execFileSync('which', ['osascript'], { stdio: 'ignore' }); osascriptOk = true; } catch { /* noop */ }
  allOk = check(`osascript is available`, osascriptOk, 'macOS normally ships this — check PATH') && allOk;

  process.stdout.write('\n');
  process.stdout.write(c(COLOR.dim, 'Note: notifications are fired via osascript and attribute to Script Editor on macOS.\n      Clicking a notification opens Script Editor — do not click, it is informational.\n') + '\n');
  if (allOk) process.stdout.write(c(COLOR.green, 'All checks passed.') + '\n');
  else { process.stdout.write(c(COLOR.yellow, 'Some checks failed. See hints above.') + '\n'); process.exit(1); }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) { printHelp(); return; }
  if (flags.version) { process.stdout.write(PKG.version + '\n'); return; }

  ensureMac();
  const home = ensureHomedirSafe();
  const p = paths(home);

  if (flags.doctor) return cmdDoctor(p);
  if (flags.test) return cmdTest(p);
  if (flags.uninstall) return cmdUninstall(p, flags);
  return cmdInstall(p, flags);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(c(COLOR.red, `✗ ${err.stack || err.message || err}`) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  mergeHook,
  removeHook,
  isOurHookEntry,
  buildOurEntry,
  findForeignEntry,
  serializeSettings,
  paths,
  MATCHER,
  RUNNER_MARKER,
  KEEP_BACKUPS,
};
