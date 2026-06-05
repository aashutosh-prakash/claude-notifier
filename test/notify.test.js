'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { sanitize, resolveEvent, decorateMessage, resolveSound, EVENT_DEFAULTS, RUNNER_VERSION, MAX_MESSAGE_LEN, MAX_SUBTITLE_LEN, MAX_SOUND_LEN } = require('../bin/notify.js');
const NOTIFY = path.join(__dirname, '..', 'bin', 'notify.js');

// On non-macOS (CI Linux), osascript is absent; the runner's try/catch swallows
// the error and still exits 0. Tests assert exit code + stderr shape rather
// than actual notification rendering.

function runNotify(stdinPayload) {
  return spawnSync('node', [NOTIFY], {
    input: stdinPayload,
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('sanitize: strips control chars', () => {
  assert.equal(sanitize('hello\x00\x07\x1Fworld', 100), 'helloworld');
  assert.equal(sanitize('a\nb\rc\tdef', 100), 'abcdef');
});

test('sanitize: strips DEL (0x7F)', () => {
  assert.equal(sanitize('foo\x7Fbar', 100), 'foobar');
});

test('sanitize: clamps to max length', () => {
  const input = 'x'.repeat(500);
  assert.equal(sanitize(input, MAX_MESSAGE_LEN).length, MAX_MESSAGE_LEN);
});

test('sanitize: returns empty string for non-string input', () => {
  assert.equal(sanitize(null, 100), '');
  assert.equal(sanitize(undefined, 100), '');
  assert.equal(sanitize(42, 100), '');
  assert.equal(sanitize({}, 100), '');
});

test('sanitize: preserves printable unicode', () => {
  assert.equal(sanitize('héllo — 🚀 café', 100), 'héllo — 🚀 café');
});

test('sanitize: message and subtitle have different clamps', () => {
  assert.ok(MAX_MESSAGE_LEN > MAX_SUBTITLE_LEN);
});

test('notify.js: exits 0 on valid JSON input', () => {
  const r = runNotify(JSON.stringify({ message: 'hi', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 on malformed JSON (never blocks Claude)', () => {
  const r = runNotify('not json at all {{{');
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 on empty input', () => {
  const r = runNotify('');
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 on injection-style payload (argv separation defeats it)', () => {
  // If string interpolation were used, these would break out.
  const hostile = JSON.stringify({
    message: 'hi " ; do shell script "say pwned"',
    cwd: '/tmp/\\\\"escape',
  });
  const r = runNotify(hostile);
  assert.equal(r.status, 0);
  // And importantly: no unexpected side-effect execution. We can't fully
  // assert "nothing ran" from inside Node, but argv-to-osascript separation
  // guarantees the hostile string is treated as data, not code.
});

test('notify.js: exits 0 with CR/LF bomb payload', () => {
  const r = runNotify('{"message":"line1\\nline2\\r\\nline3","cwd":"/tmp"}');
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 with oversized message (>200 chars)', () => {
  const payload = JSON.stringify({ message: 'A'.repeat(2000), cwd: '/tmp' });
  const r = runNotify(payload);
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 when payload has no message or cwd', () => {
  const r = runNotify('{}');
  assert.equal(r.status, 0);
});

test('resolveEvent: maps known hook events', () => {
  assert.equal(resolveEvent({ hook_event_name: 'Notification' }), 'Notification');
  assert.equal(resolveEvent({ hook_event_name: 'Stop' }), 'Stop');
});

test('resolveEvent: falls back to Notification for unknown or missing', () => {
  assert.equal(resolveEvent({}), 'Notification');
  assert.equal(resolveEvent({ hook_event_name: 'UnknownEvent' }), 'Notification');
  assert.equal(resolveEvent({ hook_event_name: 'SubagentStop' }), 'Notification');
  assert.equal(resolveEvent({ hook_event_name: 42 }), 'Notification');
});

test('EVENT_DEFAULTS: Stop uses a different message and sound than Notification', () => {
  assert.notEqual(EVENT_DEFAULTS.Stop.message, EVENT_DEFAULTS.Notification.message);
  assert.notEqual(EVENT_DEFAULTS.Stop.sound, EVENT_DEFAULTS.Notification.sound);
  assert.equal(EVENT_DEFAULTS.Stop.message, 'Task complete');
});

test('EVENT_DEFAULTS: each event carries a distinct emoji', () => {
  assert.equal(EVENT_DEFAULTS.Notification.emoji, '🔔');
  assert.equal(EVENT_DEFAULTS.Stop.emoji, '✅');
  assert.notEqual(EVENT_DEFAULTS.Stop.emoji, EVENT_DEFAULTS.Notification.emoji);
});

test('decorateMessage: prefixes the emoji with a space', () => {
  assert.equal(decorateMessage('✅', 'Task complete'), '✅ Task complete');
  assert.equal(decorateMessage('🔔', 'Allow Bash'), '🔔 Allow Bash');
});

test('decorateMessage: returns the message unchanged when no emoji', () => {
  assert.equal(decorateMessage('', 'plain'), 'plain');
  assert.equal(decorateMessage(undefined, 'plain'), 'plain');
});

test('notify.js: exits 0 for Stop payload (no message field)', () => {
  const r = runNotify(JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
});

test('resolveSound: falls back to the per-event default when env unset', () => {
  assert.equal(resolveSound({}, EVENT_DEFAULTS.Notification), EVENT_DEFAULTS.Notification.sound);
  assert.equal(resolveSound({}, EVENT_DEFAULTS.Stop), EVENT_DEFAULTS.Stop.sound);
});

test('resolveSound: CLAUDE_NUDGE_SOUND overrides every event', () => {
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: 'Hero' }, EVENT_DEFAULTS.Notification), 'Hero');
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: 'Hero' }, EVENT_DEFAULTS.Stop), 'Hero');
});

test('resolveSound: empty or strip-to-empty override falls through to default (never "")', () => {
  // Both a literal empty string AND a control-char-only value (which sanitizes
  // to '') must fall back to the default — returning '' would become
  // `sound name ""` and silently drop the notification (osascript -1700).
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: '' }, EVENT_DEFAULTS.Stop), EVENT_DEFAULTS.Stop.sound);
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: '\x01\x02' }, EVENT_DEFAULTS.Stop), EVENT_DEFAULTS.Stop.sound);
});

test('resolveSound: sanitizes and clamps the override (osascript-bound)', () => {
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: 'He\x00ro' }, EVENT_DEFAULTS.Stop), 'Hero');
  const long = 'x'.repeat(200);
  assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: long }, EVENT_DEFAULTS.Stop).length, MAX_SOUND_LEN);
});

test('RUNNER_VERSION: repo source carries the dev placeholder stamp', () => {
  assert.equal(RUNNER_VERSION, '0.0.0-dev');
});
