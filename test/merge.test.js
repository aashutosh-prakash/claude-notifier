'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
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
  parseArgs,
  settingsEnvStrings,
  removeOurEnv,
  MATCHER,
  RUNNER_MARKER,
  HOOK_CONFIGS,
  SOUND_ENV,
} = require('../bin/install.js');

const RUNNER = `/Users/test/.claude/claude-nudge/notify.js`;
const notificationEntry = () => buildOurEntry(RUNNER, MATCHER);
const stopEntry = () => buildOurEntry(RUNNER, null);

const loadFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('HOOK_CONFIGS: installs both permission_prompt and Stop', () => {
  const events = HOOK_CONFIGS.map((c) => c.event).sort();
  assert.deepEqual(events, ['Notification', 'Stop']);
  const withMatcher = HOOK_CONFIGS.find((c) => c.event === 'Notification');
  const noMatcher = HOOK_CONFIGS.find((c) => c.event === 'Stop');
  assert.equal(withMatcher.matcher, MATCHER);
  assert.equal(noMatcher.matcher, null);
});

test('buildOurEntry: Notification entry has matcher field', () => {
  const e = notificationEntry();
  assert.equal(e.matcher, MATCHER);
  assert.equal(e.hooks.length, 1);
  assert.equal(e.hooks[0].type, 'command');
  assert.ok(e.hooks[0].command.includes(RUNNER_MARKER));
});

test('buildOurEntry: Stop entry omits matcher field', () => {
  const e = stopEntry();
  assert.ok(!('matcher' in e));
  assert.ok(e.hooks[0].command.includes(RUNNER_MARKER));
});

test('isOurHookEntry: ours is recognized for both entry shapes', () => {
  assert.equal(isOurHookEntry(notificationEntry()), true);
  assert.equal(isOurHookEntry(stopEntry()), true);
});

test('isOurHookEntry: foreign is rejected', () => {
  const foreign = {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: '/usr/local/bin/something-else' }],
  };
  assert.equal(isOurHookEntry(foreign), false);
});

test('mergeHook: appends Notification into empty settings', () => {
  const { next, action } = mergeHook({}, 'Notification', MATCHER, notificationEntry());
  assert.equal(action, 'appended');
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Notification[0].matcher, MATCHER);
});

test('mergeHook: appends Stop into empty settings (no matcher)', () => {
  const { next, action } = mergeHook({}, 'Stop', null, stopEntry());
  assert.equal(action, 'appended');
  assert.equal(next.hooks.Stop.length, 1);
  assert.ok(!('matcher' in next.hooks.Stop[0]));
});

test('mergeHook: Stop replaces ours by command marker (idempotent)', () => {
  const first = mergeHook({}, 'Stop', null, stopEntry()).next;
  const { next, action } = mergeHook(first, 'Stop', null, stopEntry());
  assert.equal(action, 'replaced-ours');
  assert.equal(next.hooks.Stop.length, 1);
});

test('mergeHook: Stop coexists with pre-existing foreign Stop entries (appends)', () => {
  const base = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-stop' }] }],
    },
  };
  const { next, action } = mergeHook(base, 'Stop', null, stopEntry());
  assert.equal(action, 'appended');
  assert.equal(next.hooks.Stop.length, 2);
});

test('mergeAllHooks: installs both hooks into empty settings', () => {
  const { next, actions } = mergeAllHooks({}, RUNNER);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((a) => a.action === 'appended'));
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Stop.length, 1);
});

test('mergeAllHooks: idempotent — second install replaces our own', () => {
  const first = mergeAllHooks({}, RUNNER).next;
  const { next, actions } = mergeAllHooks(first, RUNNER);
  assert.ok(actions.every((a) => a.action === 'replaced-ours'));
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Stop.length, 1);
});

test('mergeHook: preserves unrelated top-level keys', () => {
  const before = loadFixture('with-statusline.json');
  const { next } = mergeAllHooks(before, RUNNER);
  assert.deepEqual(next.statusLine, before.statusLine);
  assert.deepEqual(next.permissions, before.permissions);
});

test('mergeHook: preserves other Notification matchers (non-clobbering)', () => {
  const before = loadFixture('other-matcher.json');
  const { next, actions } = mergeAllHooks(before, RUNNER);
  const notifAction = actions.find((a) => a.event === 'Notification');
  assert.equal(notifAction.action, 'appended');
  assert.equal(next.hooks.Notification.length, 2);
  const idle = next.hooks.Notification.find((e) => e.matcher === 'idle');
  assert.ok(idle, 'idle matcher should survive');
  assert.equal(idle.hooks[0].command, '/usr/local/bin/idle-notify');
  assert.ok(next.hooks.PreToolUse);
});

test('mergeHook: flags foreign permission_prompt as replaced-foreign', () => {
  const before = loadFixture('foreign-matcher.json');
  const { next, action } = mergeHook(before, 'Notification', MATCHER, notificationEntry());
  assert.equal(action, 'replaced-foreign');
  assert.equal(next.hooks.Notification.length, 1);
  assert.ok(isOurHookEntry(next.hooks.Notification[0]));
});

test('mergeHook: does not mutate input', () => {
  const before = loadFixture('with-statusline.json');
  const snapshot = JSON.stringify(before);
  mergeAllHooks(before, RUNNER);
  assert.equal(JSON.stringify(before), snapshot);
});

test('findForeignEntry: detects foreign permission_prompt but not ours', () => {
  assert.ok(findForeignEntry(loadFixture('foreign-matcher.json')));
  const afterOurs = mergeAllHooks({}, RUNNER).next;
  assert.equal(findForeignEntry(afterOurs), null);
  assert.equal(findForeignEntry({}), null);
});

test('findForeignEntry: returns null for Stop (no matcher-based collision)', () => {
  const base = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-stop' }] }],
    },
  };
  assert.equal(findForeignEntry(base, 'Stop', null), null);
});

test('findAllForeignEntries: reports Notification foreign only', () => {
  const foreigns = findAllForeignEntries(loadFixture('foreign-matcher.json'));
  assert.equal(foreigns.length, 1);
  assert.equal(foreigns[0].event, 'Notification');
  assert.equal(foreigns[0].matcher, MATCHER);
});

test('removeAllHooks: removes both our entries, preserves others', () => {
  const base = loadFixture('other-matcher.json');
  const withOurs = mergeAllHooks(base, RUNNER).next;
  const { next, removed } = removeAllHooks(withOurs);
  assert.equal(removed, true);
  assert.ok(next.hooks.Notification);
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Notification[0].matcher, 'idle');
  assert.ok(next.hooks.PreToolUse);
  assert.ok(next.statusLine);
  assert.equal(next.hooks.Stop, undefined);
});

test('removeAllHooks: preserves foreign Stop hooks', () => {
  const base = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-stop' }] }],
    },
  };
  const withOurs = mergeAllHooks(base, RUNNER).next;
  assert.equal(withOurs.hooks.Stop.length, 2);
  const { next, removed } = removeAllHooks(withOurs);
  assert.equal(removed, true);
  assert.equal(next.hooks.Stop.length, 1);
  assert.equal(next.hooks.Stop[0].hooks[0].command, '/usr/local/bin/other-stop');
});

test('removeAllHooks: does NOT remove foreign permission_prompt', () => {
  const foreign = loadFixture('foreign-matcher.json');
  const { next, removed } = removeAllHooks(foreign);
  assert.equal(removed, false);
  assert.equal(next.hooks.Notification.length, 1);
});

test('removeAllHooks: cleans up empty arrays and empty hooks object', () => {
  const settings = mergeAllHooks({}, RUNNER).next;
  const { next, removed } = removeAllHooks(settings);
  assert.equal(removed, true);
  assert.equal(next.hooks, undefined);
});

test('removeAllHooks: preserves other hooks keys', () => {
  const base = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
  const withOurs = mergeAllHooks(base, RUNNER).next;
  const { next, removed } = removeAllHooks(withOurs);
  assert.equal(removed, true);
  assert.ok(next.hooks.PreToolUse);
  assert.equal(next.hooks.Notification, undefined);
  assert.equal(next.hooks.Stop, undefined);
});

test('parseArgs: defaults to install', () => {
  const f = parseArgs([]);
  assert.equal(f.install, true);
  assert.equal(f.uninstall, false);
  assert.equal(f.dryRun, false);
});

test('parseArgs: --uninstall turns off install', () => {
  const f = parseArgs(['--uninstall']);
  assert.equal(f.uninstall, true);
  assert.equal(f.install, false);
});

test('parseArgs: combines flags', () => {
  const f = parseArgs(['--uninstall', '--keep-backups', '--dry-run']);
  assert.equal(f.uninstall, true);
  assert.equal(f.keepBackups, true);
  assert.equal(f.dryRun, true);
});

test('parseArgs: --test / --doctor / --help / --version set their flags', () => {
  assert.equal(parseArgs(['--test']).test, true);
  assert.equal(parseArgs(['--doctor']).doctor, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-v']).version, true);
});

test('parseArgs: --list-sounds and --set-sound (both forms) set flags', () => {
  assert.equal(parseArgs(['--list-sounds']).listSounds, true);
  assert.equal(parseArgs(['--set-sound', 'Hero']).setSound, 'Hero');
  assert.equal(parseArgs(['--set-sound=Hero']).setSound, 'Hero');
  // value-taking flags turn off the default install action
  assert.equal(parseArgs(['--set-sound', 'Hero']).install, false);
  assert.equal(parseArgs(['--list-sounds']).install, false);
});

test('settingsEnvStrings: returns only string-valued env keys', () => {
  assert.deepEqual(settingsEnvStrings({ env: { A: 'x', B: 2, C: 'y', D: null } }), { A: 'x', C: 'y' });
  assert.deepEqual(settingsEnvStrings({}), {});
  assert.deepEqual(settingsEnvStrings({ env: 'notanobject' }), {});
  assert.deepEqual(settingsEnvStrings({ env: ['a'] }), {});
});

test('removeOurEnv: strips CLAUDE_NUDGE_SOUND and drops an emptied env block', () => {
  const r = removeOurEnv({ env: { [SOUND_ENV]: 'Hero' }, hooks: {} });
  assert.equal(r.removed, true);
  assert.equal('env' in r.next, false); // emptied env block dropped
  assert.deepEqual(r.next, { hooks: {} });
});

test('removeOurEnv: preserves other env keys', () => {
  const r = removeOurEnv({ env: { [SOUND_ENV]: 'Hero', FOO: 'bar' } });
  assert.equal(r.removed, true);
  assert.deepEqual(r.next.env, { FOO: 'bar' });
});

test('removeOurEnv: no-op when key absent or env missing', () => {
  assert.equal(removeOurEnv({ env: { FOO: 'bar' } }).removed, false);
  assert.equal(removeOurEnv({ hooks: {} }).removed, false);
  assert.equal(removeOurEnv({}).removed, false);
});

test('removeOurEnv: does not mutate the input', () => {
  const input = { env: { [SOUND_ENV]: 'Hero', FOO: 'bar' } };
  removeOurEnv(input);
  assert.deepEqual(input.env, { [SOUND_ENV]: 'Hero', FOO: 'bar' });
});

test('stampRunnerVersion: injects the version into the runner constant', () => {
  const src = "const RUNNER_VERSION = '0.0.0-dev';\nconst x = 1;";
  const out = stampRunnerVersion(src, '1.2.3');
  assert.ok(out.includes("const RUNNER_VERSION = '1.2.3';"));
  assert.equal(extractRunnerVersion(out), '1.2.3');
});

test('extractRunnerVersion: returns null when no stamp is present', () => {
  assert.equal(extractRunnerVersion('nothing here'), null);
});

test('stampRunnerVersion: round-trips against the real runner source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'notify.js'), 'utf8');
  // repo copy carries the dev placeholder until install stamps it
  assert.equal(extractRunnerVersion(src), '0.0.0-dev');
  assert.equal(extractRunnerVersion(stampRunnerVersion(src, '9.9.9')), '9.9.9');
});
