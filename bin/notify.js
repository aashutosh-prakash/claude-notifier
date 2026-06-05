#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Stamped with the package version by install.js at copy time (see
// stampRunnerVersion in install.js). Stays at this dev placeholder when the
// runner is executed straight from the repo. --doctor reads it back off disk
// to detect a stale runner after a package update.
const RUNNER_VERSION = '0.0.0-dev';

const MAX_MESSAGE_LEN = 200;
const MAX_SUBTITLE_LEN = 100;
const MAX_SOUND_LEN = 50;

const EVENT_DEFAULTS = {
  Notification: { message: 'Permission required', sound: 'Sosumi', emoji: '🔔' },
  Stop: { message: 'Task complete', sound: 'Glass', emoji: '✅' },
};

// AppleScript split across separate `-e` flags so we can branch on an empty
// subtitle. `display notification ... subtitle ""` raises macOS error -1700
// ("Can't make item 2 into type Unicode text") on some versions, so the
// empty-subtitle case must skip the `subtitle` clause entirely.
// buildOsascriptArgs always passes exactly three argv items (message,
// subtitle, sound), so we read them positionally without count guards.
const SCRIPT_LINES = [
  'on run argv',
  'set msg to (item 1 of argv) as text',
  'set sub to (item 2 of argv) as text',
  'set snd to (item 3 of argv) as text',
  'if sub is "" then',
  'display notification msg with title "Claude Code" sound name snd',
  'else',
  'display notification msg with title "Claude Code" subtitle sub sound name snd',
  'end if',
  'end run',
];

function buildOsascriptArgs(message, subtitle, sound) {
  const args = [];
  for (const line of SCRIPT_LINES) { args.push('-e', line); }
  args.push('--', message, subtitle, sound);
  return args;
}

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  const stripped = str.replace(/[\x00-\x1F\x7F]/g, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}

function resolveEvent(payload) {
  const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  return EVENT_DEFAULTS[name] ? name : 'Notification';
}

// Prepend the event emoji to the (already sanitized + clamped) body. Applied
// after sanitize so the trusted emoji is never stripped and the untrusted text
// stays length-bounded on its own.
function decorateMessage(emoji, message) {
  return emoji ? `${emoji} ${message}` : message;
}

// A single optional override (CLAUDE_NUDGE_SOUND) applies to every event; when
// unset, each event keeps its own default sound (see EVENT_DEFAULTS). The value
// is sanitized + clamped like all other osascript-bound strings — it is set by
// the user in settings.json, so it is treated as untrusted input. An invalid
// sound name does not error: macOS falls back to the default alert sound.
function resolveSound(env, defaults) {
  // Sanitize the override FIRST, then fall back: a non-empty but control-char-only
  // value strips to '' and must still fall through to the default — never to
  // `sound name ""`, which raises osascript error -1700 and drops the notification.
  const chosen = sanitize(env.CLAUDE_NUDGE_SOUND, MAX_SOUND_LEN);
  return chosen || defaults.sound;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`claude-nudge: failed to parse stdin JSON: ${err.message}\n`);
  }

  const event = resolveEvent(payload);
  const defaults = EVENT_DEFAULTS[event];
  const rawMessage = sanitize(payload.message || defaults.message, MAX_MESSAGE_LEN);
  const message = decorateMessage(defaults.emoji, rawMessage);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const subtitle = sanitize(cwd ? path.basename(cwd) : '', MAX_SUBTITLE_LEN);

  try {
    execFileSync(
      'osascript',
      buildOsascriptArgs(message, subtitle, resolveSound(process.env, defaults)),
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
  } catch (err) {
    process.stderr.write(`claude-nudge: osascript failed: ${err.message}\n`);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  sanitize,
  resolveEvent,
  decorateMessage,
  resolveSound,
  buildOsascriptArgs,
  SCRIPT_LINES,
  RUNNER_VERSION,
  MAX_MESSAGE_LEN,
  MAX_SUBTITLE_LEN,
  MAX_SOUND_LEN,
  EVENT_DEFAULTS,
};
