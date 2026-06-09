'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { sanitize, resolveEvent, decorateMessage, resolveSound, isStopDisabled, buildOsascriptArgs, SCRIPT_LINES, EVENT_DEFAULTS, RUNNER_VERSION, MAX_MESSAGE_LEN, MAX_SUBTITLE_LEN, MAX_SOUND_LEN } = require('../bin/notify.js');
const { HOOK_CONFIGS, buildNotifyPayload } = require('../bin/install.js');
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

// Run notify.js with a fake `osascript` shimmed onto PATH so we can observe
// whether a notification was actually dispatched. The runner swallows osascript
// failures and exits 0 regardless, so the exit code alone cannot distinguish
// "notified" from "suppressed" — the marker file can.
function runNotifyTracked(stdinPayload, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
  const marker = path.join(dir, 'called');
  const fakeBin = path.join(dir, 'osascript');
  // Derive the marker from the shim's own dir ($0) — never interpolate the temp
  // path into the shell body, or a TMPDIR containing a quote/$/backtick would
  // corrupt the script or inject. The shim ignores its osascript args by design.
  fs.writeFileSync(fakeBin, '#!/bin/sh\necho 1 > "$(dirname "$0")/called"\n');
  fs.chmodSync(fakeBin, 0o755);
  // Hermetic base: drop any ambient CLAUDE_NUDGE_* the dev/CI shell (or a prior
  // --disable-completion) exports, so dispatch detection reflects only the
  // payload + explicit extraEnv. extraEnv (which may re-add them, or set its own
  // PATH) is applied next; PATH is prefixed last so the shim dir always shadows
  // the real osascript regardless of what extraEnv passed.
  const env = { ...process.env };
  delete env.CLAUDE_NUDGE_STOP;
  delete env.CLAUDE_NUDGE_SOUND;
  Object.assign(env, extraEnv);
  env.PATH = `${dir}${path.delimiter}${env.PATH}`;
  try {
    const r = spawnSync('node', [NOTIFY], { input: stdinPayload, encoding: 'utf8', timeout: 5000, env });
    return { status: r.status, called: fs.existsSync(marker) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('notify.js: valid JSON event dispatches a notification', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'Notification', message: 'hi', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: exits 0 on malformed JSON (never blocks Claude)', () => {
  const r = runNotify('not json at all {{{');
  assert.equal(r.status, 0);
});

test('notify.js: exits 0 on empty input', () => {
  const r = runNotify('');
  assert.equal(r.status, 0);
});

test('notify.js: injection-style payload reaches osascript inertly (argv separation defeats it)', () => {
  // hook_event_name is required so the payload reaches buildOsascriptArgs at all;
  // `called === true` proves osascript WAS invoked with the hostile string as a
  // positional argv item (inert data), not a shell-interpolated command.
  const hostile = JSON.stringify({
    hook_event_name: 'Notification',
    message: 'hi " ; do shell script "say pwned"',
    cwd: '/tmp/\\\\"escape',
  });
  const r = runNotifyTracked(hostile);
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: CR/LF bomb payload is dispatched without breaking osascript', () => {
  const r = runNotifyTracked('{"hook_event_name":"Notification","message":"line1\\nline2\\r\\nline3","cwd":"/tmp"}');
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: oversized message (>200 chars) is clamped and dispatched', () => {
  const payload = JSON.stringify({ hook_event_name: 'Notification', message: 'A'.repeat(2000), cwd: '/tmp' });
  const r = runNotifyTracked(payload);
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: recognized event with no message or cwd uses defaults and dispatches', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'Notification' }));
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('resolveEvent: maps known hook events', () => {
  assert.equal(resolveEvent({ hook_event_name: 'Notification' }), 'Notification');
  assert.equal(resolveEvent({ hook_event_name: 'Stop' }), 'Stop');
});

test('resolveEvent: returns null for case-variant, unknown, or missing events', () => {
  // Claude Code emits PascalCase event names only (verified against the hooks
  // docs). A lowercase "stop" comes from a foreign host bridging the same hook
  // config (e.g. Cursor) and must NOT be treated as a notifiable event — no
  // fail-safe fallback to Notification.
  assert.equal(resolveEvent({ hook_event_name: 'stop' }), null);
  assert.equal(resolveEvent({ hook_event_name: 'STOP' }), null);
  assert.equal(resolveEvent({ hook_event_name: 'notification' }), null);
  assert.equal(resolveEvent({}), null);
  assert.equal(resolveEvent({ hook_event_name: 'UnknownEvent' }), null);
  assert.equal(resolveEvent({ hook_event_name: 'SubagentStop' }), null);
  assert.equal(resolveEvent({ hook_event_name: 42 }), null);
});

test('resolveEvent: inherited Object.prototype keys are not treated as events', () => {
  // A bracket lookup with a truthiness test would match inherited members
  // (EVENT_DEFAULTS['valueOf'] is Object.prototype.valueOf, a truthy function),
  // firing a malformed notification and bypassing the CLAUDE_NUDGE_STOP opt-out.
  for (const k of ['constructor', 'valueOf', 'toString', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    assert.equal(resolveEvent({ hook_event_name: k }), null, `${k} must not resolve to an event`);
  }
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

test('resolveSound: silent sentinels map to "" (no sound clause)', () => {
  for (const v of ['none', 'off', 'silent', 'mute', 'None', 'OFF']) {
    assert.equal(resolveSound({ CLAUDE_NUDGE_SOUND: v }, EVENT_DEFAULTS.Stop), '', `${v} should silence`);
  }
});

test('buildOsascriptArgs: empty sound omits the "sound name" clause (silent)', () => {
  // The script must contain a branch that displays with no `sound name` when snd is "".
  assert.ok(SCRIPT_LINES.includes('display notification msg with title "Claude Code"'));
  assert.ok(SCRIPT_LINES.includes('if snd is "" then'));
  // The arg vector still carries exactly three positional values after `--`.
  const args = buildOsascriptArgs('m', 's', '');
  const sep = args.indexOf('--');
  assert.deepEqual(args.slice(sep + 1), ['m', 's', '']);
});

test('isStopDisabled: off/false/0/no disable; unset/on/empty keep enabled', () => {
  for (const v of ['off', 'false', '0', 'no', 'Off', ' OFF ']) {
    assert.equal(isStopDisabled({ CLAUDE_NUDGE_STOP: v }), true, `${JSON.stringify(v)} should disable`);
  }
  assert.equal(isStopDisabled({}), false);
  assert.equal(isStopDisabled({ CLAUDE_NUDGE_STOP: 'on' }), false);
  assert.equal(isStopDisabled({ CLAUDE_NUDGE_STOP: '' }), false);
});

test('notify.js: Stop with CLAUDE_NUDGE_STOP=off is suppressed (no dispatch)', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/proj' }), { CLAUDE_NUDGE_STOP: 'off' });
  assert.equal(r.status, 0);
  assert.equal(r.called, false);
});

test('notify.js: genuine PascalCase Stop dispatches a notification', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'Stop', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: genuine PascalCase Notification dispatches a notification', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'Notification', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
  assert.equal(r.called, true);
});

test('notify.js: foreign-host lowercase "stop" (e.g. Cursor) is suppressed', () => {
  const r = runNotifyTracked(JSON.stringify({ hook_event_name: 'stop', cwd: '/tmp/proj' }));
  assert.equal(r.status, 0);
  assert.equal(r.called, false);
});

test('notify.js: unknown or missing event dispatches nothing', () => {
  assert.equal(runNotifyTracked('{}').called, false);
  assert.equal(runNotifyTracked(JSON.stringify({ hook_event_name: 'SubagentStop' })).called, false);
});

test('install: --test/--set-sound preview payload resolves to a notifiable event', () => {
  // fireNotification (install.js) sends this payload to the runner via stdin. It
  // MUST carry a recognized hook_event_name, or the exact-match resolver returns
  // null and --test / the --set-sound preview silently fire nothing while still
  // printing success — defeating the one-time macOS permission grant.
  const payload = JSON.parse(buildNotifyPayload('hello'));
  assert.equal(payload.message, 'hello');
  assert.equal(resolveEvent(payload), 'Notification');
});

test('installed hook events and EVENT_DEFAULTS are kept in lockstep (both directions)', () => {
  // notify.js dispatches only events present in EVENT_DEFAULTS (exact match, no
  // fallback). A wired event missing a default would be silently dropped; a
  // default with no wired event is dead config wired to nothing. Enforce both.
  const installed = HOOK_CONFIGS.map((cfg) => cfg.event);
  const defined = Object.keys(EVENT_DEFAULTS);
  for (const ev of installed) {
    assert.ok(EVENT_DEFAULTS[ev], `installed event ${ev} missing from EVENT_DEFAULTS (silent drop)`);
  }
  for (const ev of defined) {
    assert.ok(installed.includes(ev), `EVENT_DEFAULTS key ${ev} is not wired by any HOOK_CONFIGS entry`);
  }
});

test('RUNNER_VERSION: repo source carries the dev placeholder stamp', () => {
  assert.equal(RUNNER_VERSION, '0.0.0-dev');
});
