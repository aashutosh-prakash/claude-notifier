'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  mergeHook,
  removeHook,
  isOurHookEntry,
  buildOurEntry,
  findForeignEntry,
  parseArgs,
  MATCHER,
  RUNNER_MARKER,
} = require('../bin/install.js');

const RUNNER = `/Users/test/.claude/claude-nudge/notify.js`;
const ourEntry = () => buildOurEntry(RUNNER);

const loadFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('buildOurEntry produces the expected shape', () => {
  const e = ourEntry();
  assert.equal(e.matcher, MATCHER);
  assert.equal(e.hooks.length, 1);
  assert.equal(e.hooks[0].type, 'command');
  assert.ok(e.hooks[0].command.includes(RUNNER_MARKER));
});

test('isOurHookEntry: ours is recognized', () => {
  assert.equal(isOurHookEntry(ourEntry()), true);
});

test('isOurHookEntry: foreign is rejected', () => {
  const foreign = {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: '/usr/local/bin/something-else' }],
  };
  assert.equal(isOurHookEntry(foreign), false);
});

test('mergeHook: appends into empty settings', () => {
  const { next, action } = mergeHook({}, ourEntry());
  assert.equal(action, 'appended');
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Notification[0].matcher, MATCHER);
});

test('mergeHook: preserves unrelated top-level keys', () => {
  const before = loadFixture('with-statusline.json');
  const { next } = mergeHook(before, ourEntry());
  assert.deepEqual(next.statusLine, before.statusLine);
  assert.deepEqual(next.permissions, before.permissions);
});

test('mergeHook: preserves other Notification matchers (non-clobbering)', () => {
  const before = loadFixture('other-matcher.json');
  const { next, action } = mergeHook(before, ourEntry());
  assert.equal(action, 'appended');
  assert.equal(next.hooks.Notification.length, 2);
  const idle = next.hooks.Notification.find((e) => e.matcher === 'idle');
  assert.ok(idle, 'idle matcher should survive');
  assert.equal(idle.hooks[0].command, '/usr/local/bin/idle-notify');
  // Other hook types also survive
  assert.ok(next.hooks.PreToolUse);
});

test('mergeHook: replaces our own entry (idempotent)', () => {
  const first = mergeHook({}, ourEntry()).next;
  const { next, action } = mergeHook(first, ourEntry());
  assert.equal(action, 'replaced-ours');
  assert.equal(next.hooks.Notification.length, 1);
});

test('mergeHook: flags foreign permission_prompt as replaced-foreign', () => {
  const before = loadFixture('foreign-matcher.json');
  const { next, action } = mergeHook(before, ourEntry());
  assert.equal(action, 'replaced-foreign');
  assert.equal(next.hooks.Notification.length, 1);
  assert.ok(isOurHookEntry(next.hooks.Notification[0]));
});

test('mergeHook: does not mutate input', () => {
  const before = loadFixture('with-statusline.json');
  const snapshot = JSON.stringify(before);
  mergeHook(before, ourEntry());
  assert.equal(JSON.stringify(before), snapshot);
});

test('findForeignEntry: detects foreign but not ours', () => {
  assert.ok(findForeignEntry(loadFixture('foreign-matcher.json')));
  const afterOurs = mergeHook({}, ourEntry()).next;
  assert.equal(findForeignEntry(afterOurs), null);
  assert.equal(findForeignEntry({}), null);
});

test('removeHook: removes only our entry, preserves others', () => {
  const base = loadFixture('other-matcher.json');
  const withOurs = mergeHook(base, ourEntry()).next;
  const { next, removed } = removeHook(withOurs);
  assert.equal(removed, true);
  assert.ok(next.hooks.Notification);
  assert.equal(next.hooks.Notification.length, 1);
  assert.equal(next.hooks.Notification[0].matcher, 'idle');
  assert.ok(next.hooks.PreToolUse);
  assert.ok(next.statusLine);
});

test('removeHook: does NOT remove foreign permission_prompt', () => {
  const foreign = loadFixture('foreign-matcher.json');
  const { next, removed } = removeHook(foreign);
  assert.equal(removed, false);
  assert.equal(next.hooks.Notification.length, 1);
});

test('removeHook: cleans up empty Notification array and empty hooks object', () => {
  const settings = mergeHook({}, ourEntry()).next;
  const { next, removed } = removeHook(settings);
  assert.equal(removed, true);
  assert.equal(next.hooks, undefined);
});

test('removeHook: preserves other hooks keys when Notification becomes empty', () => {
  const base = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
  const withOurs = mergeHook(base, ourEntry()).next;
  const { next, removed } = removeHook(withOurs);
  assert.equal(removed, true);
  assert.ok(next.hooks.PreToolUse);
  assert.equal(next.hooks.Notification, undefined);
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
