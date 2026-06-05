#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const PKG = require('../package.json');

const MATCHER = 'permission_prompt';
const RUNNER_MARKER = 'claude-nudge/notify.js';
const KEEP_BACKUPS = 5;
const COUNTDOWN_SECONDS = 3;

// The single env var that overrides the notification sound for every event.
// Lives in the `env` block of ~/.claude/settings.json; read by notify.js.
const SOUND_ENV = 'CLAUDE_NUDGE_SOUND';
// Directories macOS searches for `sound name`, in its real precedence order
// (per-user → local → system). We enumerate them so discovery (--list-sounds)
// and validation (--set-sound) share one source of truth and pick up
// user-installed sounds automatically. listSounds() dedupes first-dir-wins, so
// a user's ~/Library/Sounds override shadows the system entry — matching how
// macOS itself resolves the name at play time.
const SOUND_DIRS = [
  path.join(os.homedir(), 'Library', 'Sounds'),
  '/Library/Sounds',
  '/System/Library/Sounds',
];
// Only formats macOS notification `sound name` actually resolves. The 14 system
// sounds are all .aiff; .caf is also honored. We deliberately exclude .wav/.mp3/
// .m4a: listing them would let --set-sound accept a name that validates but then
// plays nothing (macOS silently falls back to the default alert) — the exact
// "set but silent" confusion the validation step exists to prevent.
const SOUND_EXTS = new Set(['.aiff', '.aif', '.caf']);

// Hooks we install. `matcher: null` means the event has no matcher-based
// dedup key (Stop fires once per agent turn); we identify our own entry
// solely via RUNNER_MARKER in the command path.
const HOOK_CONFIGS = [
  { event: 'Notification', matcher: MATCHER, label: 'permission prompts' },
  { event: 'Stop', matcher: null, label: 'task complete' },
];

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
    listSounds: false,
    setSound: null,
  };
  // `--set-sound` takes a value, accepted as either `--set-sound NAME` or
  // `--set-sound=NAME`. An index loop lets us consume the following token.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Only value-taking flags accept `--flag=value`. Splitting `=` for every
    // flag would silently accept junk like `--test=foo`; keep that an error.
    let inlineValue = null;
    let name = arg;
    if (arg.startsWith('--set-sound=')) {
      name = '--set-sound';
      inlineValue = arg.slice('--set-sound='.length);
    }
    switch (name) {
      case '--uninstall': flags.uninstall = true; flags.install = false; break;
      case '--test': flags.test = true; flags.install = false; break;
      case '--doctor': flags.doctor = true; flags.install = false; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--force': flags.force = true; break;
      case '--keep-backups': flags.keepBackups = true; break;
      case '--install': flags.install = true; break;
      case '--list-sounds': flags.listSounds = true; flags.install = false; break;
      case '--set-sound': {
        const value = inlineValue !== null ? inlineValue : argv[++i];
        // Reject missing value AND empty inline value (`--set-sound=`) the same
        // way, so both forms give the same exit code and message.
        if (value === undefined || value === '' || value.startsWith('-')) {
          process.stderr.write('claude-nudge: --set-sound requires a sound name (e.g. --set-sound Hero)\n');
          process.exit(2);
        }
        flags.setSound = value;
        flags.install = false;
        break;
      }
      case '-h': case '--help': flags.help = true; flags.install = false; break;
      case '-v': case '--version': flags.version = true; flags.install = false; break;
      default:
        process.stderr.write(`claude-nudge: unknown flag: ${arg}\n`);
        process.exit(2);
    }
  }
  return flags;
}

function printHelp() {
  process.stdout.write(`claude-nudge — macOS notification hook for Claude Code

Usage:
  npx claude-nudge              Install Notification (permission) + Stop (task-complete) hooks into ~/.claude/settings.json
  npx claude-nudge --uninstall  Remove both hooks, the runner directory, and the CLAUDE_NUDGE_SOUND config
  npx claude-nudge --test       Fire a sample notification to verify install
  npx claude-nudge --doctor     Diagnose install health
  npx claude-nudge --list-sounds      List available notification sounds
  npx claude-nudge --set-sound NAME   Set the notification sound for all events
  npx claude-nudge --dry-run    Show what would change without writing
  npx claude-nudge --force      Skip the 3s confirm when replacing a foreign hook
  npx claude-nudge --keep-backups   On --uninstall, retain the backup directory
  npx claude-nudge --help       This text
  npx claude-nudge --version    Print version

Docs: https://github.com/aashutosh-prakash/claude-nudge
`);
}

function fail(msg, code = 1) {
  process.stderr.write(c(COLOR.red, `✗ ${msg}`) + '\n');
  process.exit(code);
}

function ensureMac() {
  if (process.platform !== 'darwin') {
    fail(`claude-nudge only supports macOS. Detected platform: ${process.platform}`);
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
    runnerDir: path.join(claudeDir, 'claude-nudge'),
    runner: path.join(claudeDir, 'claude-nudge', 'notify.js'),
    backupDir: path.join(claudeDir, '.claude-nudge-backups'),
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

// The runner is copied to ~/.claude/ verbatim, so it can't `require` our
// package.json. We bake the version into its `RUNNER_VERSION` constant at copy
// time; --doctor reads it back to flag a runner left stale by a package update.
function stampRunnerVersion(source, version) {
  return source.replace(
    /const RUNNER_VERSION = '[^']*';/,
    () => `const RUNNER_VERSION = '${version}';`
  );
}

function extractRunnerVersion(source) {
  const m = source.match(/const RUNNER_VERSION = '([^']*)';/);
  return m ? m[1] : null;
}

function installRunner(p) {
  ensureDir(p.runnerDir, 0o755);
  const src = path.join(__dirname, 'notify.js');
  const stamped = stampRunnerVersion(fs.readFileSync(src, 'utf8'), PKG.version);
  fs.writeFileSync(p.runner, stamped, { mode: 0o755 });
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

function buildOurEntry(runnerPath, matcher) {
  const entry = {};
  if (matcher != null) entry.matcher = matcher;
  entry.hooks = [{ type: 'command', command: runnerPath }];
  return entry;
}

function mergeHook(settings, event, matcher, ourEntry) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
  if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
  const arr = next.hooks[event];

  if (matcher != null) {
    const idx = arr.findIndex((e) => e && e.matcher === matcher);
    if (idx === -1) {
      arr.push(ourEntry);
      return { next, action: 'appended' };
    }
    const wasOurs = isOurHookEntry(arr[idx]);
    arr[idx] = ourEntry;
    return { next, action: wasOurs ? 'replaced-ours' : 'replaced-foreign' };
  }

  const idx = arr.findIndex((e) => isOurHookEntry(e));
  if (idx === -1) {
    arr.push(ourEntry);
    return { next, action: 'appended' };
  }
  arr[idx] = ourEntry;
  return { next, action: 'replaced-ours' };
}

function removeHook(settings, event, matcher) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (!next.hooks || !Array.isArray(next.hooks[event])) return { next, removed: false };
  const arr = next.hooks[event];
  const before = arr.length;
  const keep = matcher != null
    ? (e) => !(e && e.matcher === matcher && isOurHookEntry(e))
    : (e) => !isOurHookEntry(e);
  next.hooks[event] = arr.filter(keep);
  const removed = next.hooks[event].length < before;
  if (next.hooks[event].length === 0) delete next.hooks[event];
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { next, removed };
}

function mergeAllHooks(settings, runnerPath) {
  let current = settings;
  const actions = [];
  for (const cfg of HOOK_CONFIGS) {
    const entry = buildOurEntry(runnerPath, cfg.matcher);
    const { next, action } = mergeHook(current, cfg.event, cfg.matcher, entry);
    current = next;
    actions.push({ event: cfg.event, matcher: cfg.matcher, label: cfg.label, action });
  }
  return { next: current, actions };
}

function removeAllHooks(settings) {
  let current = settings;
  let anyRemoved = false;
  for (const cfg of HOOK_CONFIGS) {
    const { next, removed } = removeHook(current, cfg.event, cfg.matcher);
    current = next;
    if (removed) anyRemoved = true;
  }
  return { next: current, removed: anyRemoved };
}

// The subset of settings.json `env` safe to pass to a child process: only
// string-valued keys (process env values must be strings).
function settingsEnvStrings(settings) {
  const out = {};
  const env = settings && settings.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

// Strip the one env key claude-nudge owns (CLAUDE_NUDGE_SOUND) so --uninstall
// leaves nothing behind, and drop an `env` block that becomes empty. Pure;
// returns a new object. Other env keys the user set are preserved.
function removeOurEnv(settings) {
  if (!settings || !settings.env || typeof settings.env !== 'object' ||
      Array.isArray(settings.env) || !(SOUND_ENV in settings.env)) {
    return { next: settings, removed: false };
  }
  const next = JSON.parse(JSON.stringify(settings));
  delete next.env[SOUND_ENV];
  if (Object.keys(next.env).length === 0) delete next.env;
  return { next, removed: true };
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

async function confirmForeignReplace(foreigns, force) {
  if (force || !isTTY) return true;
  for (const f of foreigns) {
    process.stdout.write(c(COLOR.yellow, `⚠  Existing ${f.event}${f.matcher ? '.' + f.matcher : ''} hook detected (not from claude-nudge):`) + '\n');
    process.stdout.write(c(COLOR.dim, '   ' + JSON.stringify(f.entry, null, 2).replace(/\n/g, '\n   ')) + '\n');
  }
  process.stdout.write(`It will be replaced. Backup will be written first. Press Ctrl-C within ${COUNTDOWN_SECONDS}s to abort, or re-run with --force to skip this prompt.\n`);
  for (let i = COUNTDOWN_SECONDS; i > 0; i--) {
    process.stdout.write(`\r  continuing in ${i}s... `);
    await sleep(1000);
  }
  process.stdout.write('\r  continuing now.           \n');
  return true;
}

function findForeignEntry(settings, event = 'Notification', matcher = MATCHER) {
  if (matcher == null) return null;
  const arr = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const idx = arr.findIndex((e) => e && e.matcher === matcher);
  if (idx === -1) return null;
  if (isOurHookEntry(arr[idx])) return null;
  return arr[idx];
}

function findAllForeignEntries(settings) {
  const out = [];
  for (const cfg of HOOK_CONFIGS) {
    const foreign = findForeignEntry(settings, cfg.event, cfg.matcher);
    if (foreign) out.push({ event: cfg.event, matcher: cfg.matcher, entry: foreign });
  }
  return out;
}

async function cmdInstall(p, flags) {
  ensureDir(p.claudeDir, 0o755);
  const settingsBefore = readSettings(p.settings);

  const foreigns = findAllForeignEntries(settingsBefore);
  if (foreigns.length > 0 && !flags.dryRun) {
    await confirmForeignReplace(foreigns, flags.force);
  }

  const { next, actions } = mergeAllHooks(settingsBefore, p.runner);

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

  const hookLines = actions.map((a) => {
    const name = a.matcher ? `${a.event}.${a.matcher}` : a.event;
    return `  hook    : ${name}  (${a.label}, ${a.action})`;
  });
  const box = [
    c(COLOR.green, '✓ claude-nudge installed'),
    ...hookLines,
    `  runner  : ${p.runner}`,
    `  backup  : ${backupPath || '(no previous settings to back up)'}`,
    `  next    : ${c(COLOR.cyan, 'npx claude-nudge --test')}  ${c(COLOR.dim, '(fires a sample notification)')}`,
  ];
  process.stdout.write(box.join('\n') + '\n');
}

async function cmdUninstall(p, flags) {
  if (!fs.existsSync(p.settings)) {
    process.stdout.write('Nothing to uninstall: ~/.claude/settings.json does not exist.\n');
    return;
  }
  const settingsBefore = readSettings(p.settings);
  const hooksResult = removeAllHooks(settingsBefore);
  const envResult = removeOurEnv(hooksResult.next);
  const next = envResult.next;
  const removed = hooksResult.removed;
  const changed = removed || envResult.removed;

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
  if (changed) atomicWrite(p.settings, afterStr, 0o644);
  removeRunnerDir(p);
  if (!flags.keepBackups && fs.existsSync(p.backupDir)) {
    fs.rmSync(p.backupDir, { recursive: true, force: true });
  }

  const lines = [
    c(COLOR.green, '✓ claude-nudge uninstalled'),
    `  hook    : ${removed ? 'removed' : '(not found — nothing to remove)'}`,
    ...(envResult.removed ? [`  config  : ${SOUND_ENV} removed from settings.json env`] : []),
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
    fail('Runner not installed yet. Run `npx claude-nudge` first.');
  }
  const payload = JSON.stringify({
    message: 'Test notification — claude-nudge is working',
    cwd: process.cwd(),
  });
  // Inject settings.json's `env` into the child, mirroring what Claude Code's
  // hook executor does at runtime. Without this, a configured CLAUDE_NUDGE_SOUND
  // (which lives only in settings.json, not the shell) would be invisible and
  // --test would play the default — making the documented "--set-sound then
  // --test to hear it" flow misleading.
  const childEnv = { ...process.env, ...settingsEnvStrings(readSettings(p.settings)) };
  try {
    execSync(`echo ${JSON.stringify(payload)} | ${JSON.stringify(p.runner)}`, { stdio: 'inherit', env: childEnv });
    process.stdout.write(c(COLOR.green, '✓ sample notification fired') + '\n');
    process.stdout.write(c(COLOR.dim, '  If you did not see it, check System Settings → Notifications for your terminal app.') + '\n');
    process.stdout.write(c(COLOR.dim, '  Also make sure Focus / Do Not Disturb is off (Control Center → Focus) — it silences banners.') + '\n');
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
  process.stdout.write(c(COLOR.cyan, 'claude-nudge doctor') + '\n');
  let allOk = true;
  allOk = check(`platform is macOS`, process.platform === 'darwin', `detected ${process.platform}`) && allOk;
  allOk = check(`node >= 18`, Number(process.versions.node.split('.')[0]) >= 18, `detected ${process.versions.node}`) && allOk;

  const settingsExists = fs.existsSync(p.settings);
  allOk = check(`~/.claude/settings.json exists`, settingsExists, 'run `npx claude-nudge` to create') && allOk;

  if (settingsExists) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(p.settings, 'utf8') || '{}'); allOk = check('settings.json parses as JSON', true) && allOk; }
    catch (err) { allOk = check('settings.json parses as JSON', false, err.message) && allOk; settings = {}; }

    let firstRunner = null;
    for (const cfg of HOOK_CONFIGS) {
      const arr = settings.hooks && Array.isArray(settings.hooks[cfg.event]) ? settings.hooks[cfg.event] : [];
      const ours = arr.find((e) => {
        if (!isOurHookEntry(e)) return false;
        if (cfg.matcher != null) return e.matcher === cfg.matcher;
        return true;
      });
      const name = cfg.matcher ? `${cfg.event}.${cfg.matcher}` : cfg.event;
      allOk = check(`hook entry present (${name} → claude-nudge, ${cfg.label})`, !!ours, 'not installed; run `npx claude-nudge`') && allOk;
      if (ours && !firstRunner) firstRunner = ours.hooks[0].command;
    }

    if (firstRunner) {
      const runnerExists = fs.existsSync(firstRunner);
      allOk = check(`runner path exists: ${firstRunner}`, runnerExists, 'reinstall with `npx claude-nudge`') && allOk;
      if (runnerExists) {
        const mode = fs.statSync(firstRunner).mode & 0o777;
        allOk = check(`runner is executable`, (mode & 0o111) !== 0, `mode is ${mode.toString(8)}`) && allOk;

        let rv = null;
        try { rv = extractRunnerVersion(fs.readFileSync(firstRunner, 'utf8')); } catch { /* ignore */ }
        if (!rv || rv === '0.0.0-dev') {
          process.stdout.write(`  ${c(COLOR.dim, '·')} ${c(COLOR.dim, `runner version: ${rv || 'unknown'} (installed before version stamping)`)}\n`);
        } else if (rv === PKG.version) {
          check(`runner version: ${rv} (matches package)`, true);
        } else {
          check(`runner version: ${rv}`, true);
          process.stdout.write(c(COLOR.yellow, `    ⚠ package is ${PKG.version} — runner is stale; run \`npx claude-nudge@latest\` to update it`) + '\n');
        }
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

// Enumerate the sound names macOS will accept, deduped (case-insensitively,
// first directory wins) and sorted. Returns [{ name, dir }] preserving the
// on-disk casing so --set-sound can store the canonical name.
function listSounds() {
  const seen = new Map(); // lowercased name -> { name, dir }
  for (const dir of SOUND_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!SOUND_EXTS.has(ext)) continue;
      const name = entry.slice(0, -ext.length);
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { name, dir });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cmdListSounds() {
  const sounds = listSounds();
  if (sounds.length === 0) {
    process.stdout.write(c(COLOR.yellow, 'No sounds found in ' + SOUND_DIRS.join(', ')) + '\n');
    return;
  }
  process.stdout.write(c(COLOR.cyan, 'Available notification sounds:') + '\n');
  for (const { name } of sounds) process.stdout.write('  ' + name + '\n');
  process.stdout.write(c(COLOR.dim, `\nSet one with:  npx claude-nudge --set-sound ${sounds[0].name}`) + '\n');
}

function cmdSetSound(p, name, flags) {
  const dryRun = !!(flags && flags.dryRun);

  // Install guard, mirroring cmdTest: a sound is only ever read by the hook
  // runner, so configuring one for an uninstalled tool would write an orphan
  // env block and then suggest --test, which fails its own guard. Skipped under
  // --dry-run, which writes nothing and must stay read-only and non-fatal.
  if (!dryRun && !fs.existsSync(p.runner)) {
    fail('Runner not installed yet. Run `npx claude-nudge` first.');
  }

  const sounds = listSounds();
  const match = sounds.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    const lower = name.toLowerCase();
    const near = sounds
      .filter((s) => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()))
      .slice(0, 3)
      .map((s) => s.name);
    const hint = near.length ? `  Did you mean: ${near.join(', ')}?\n` : '';
    const body = c(COLOR.red, `✗ "${name}" is not an available sound.`) + '\n' + c(COLOR.dim, hint) +
      c(COLOR.dim, '  Run `npx claude-nudge --list-sounds` to see all available sounds.') + '\n';
    // In --dry-run, a typo is reported as a preview, not a hard abort — dry-run
    // is a read-only, non-fatal path everywhere else.
    if (dryRun) { process.stdout.write(body); return; }
    process.stderr.write(body);
    process.exit(1);
  }

  const settings = readSettings(p.settings);
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) settings.env = {};
  const prev = settings.env[SOUND_ENV];

  // No-op: already set to this exact value. Skip the backup+write so repeated
  // runs don't churn the (size-limited) backup rotation and evict real backups.
  if (prev === match.name) {
    if (dryRun) {
      process.stdout.write(c(COLOR.yellow, `── dry-run: notification sound already set to "${match.name}" (no change) ──`) + '\n');
    } else {
      process.stdout.write(c(COLOR.green, `✓ notification sound already set to "${match.name}"`) +
        c(COLOR.dim, ' (no change)') + '\n');
    }
    return;
  }

  if (dryRun) {
    process.stdout.write(c(COLOR.yellow, '── dry-run: would set notification sound ──') + '\n');
    process.stdout.write(`  ${SOUND_ENV}: ${prev ? `"${prev}" → ` : ''}"${match.name}"  in ${p.settings}\n`);
    return;
  }

  settings.env[SOUND_ENV] = match.name;
  backupSettings(p);
  ensureDir(p.claudeDir, 0o755);
  atomicWrite(p.settings, serializeSettings(settings), 0o644);

  // prev !== match.name here (the equal case returned above), so the only
  // question is whether there was a previous value to report.
  process.stdout.write(c(COLOR.green, `✓ notification sound set to "${match.name}"`) +
    (prev ? c(COLOR.dim, ` (was "${prev}")`) : '') + '\n');
  process.stdout.write(c(COLOR.dim, `  Wrote ${SOUND_ENV} to ${p.settings}. Run \`npx claude-nudge --test\` to hear it.`) + '\n');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) { printHelp(); return; }
  if (flags.version) { process.stdout.write(PKG.version + '\n'); return; }

  if (flags.dryRun && process.platform !== 'darwin') {
    process.stdout.write(c(COLOR.yellow, `⚠  --dry-run on non-macOS (${process.platform}) — showing what would happen on macOS\n`));
  } else {
    ensureMac();
  }
  const home = ensureHomedirSafe();
  const p = paths(home);

  if (flags.doctor) return cmdDoctor(p);
  if (flags.listSounds) return cmdListSounds();
  if (flags.setSound !== null) return cmdSetSound(p, flags.setSound, flags);
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
  mergeAllHooks,
  removeAllHooks,
  isOurHookEntry,
  buildOurEntry,
  findForeignEntry,
  findAllForeignEntries,
  stampRunnerVersion,
  extractRunnerVersion,
  serializeSettings,
  listSounds,
  settingsEnvStrings,
  removeOurEnv,
  paths,
  MATCHER,
  RUNNER_MARKER,
  KEEP_BACKUPS,
  HOOK_CONFIGS,
  SOUND_ENV,
};
