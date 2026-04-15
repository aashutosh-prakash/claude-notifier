#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MAX_MESSAGE_LEN = 200;
const MAX_SUBTITLE_LEN = 100;
const DEFAULT_MESSAGE = 'Permission required';

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  const stripped = str.replace(/[\x00-\x1F\x7F]/g, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
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
    process.stderr.write(`claude-notifier: failed to parse stdin JSON: ${err.message}\n`);
  }

  const message = sanitize(payload.message || DEFAULT_MESSAGE, MAX_MESSAGE_LEN);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const subtitle = sanitize(cwd ? path.basename(cwd) : '', MAX_SUBTITLE_LEN);

  try {
    execFileSync(
      'osascript',
      [
        '-e', 'on run argv',
        '-e', 'display notification item 1 of argv with title "Claude Code" subtitle item 2 of argv sound name "Sosumi"',
        '-e', 'end run',
        '--', message, subtitle,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
  } catch (err) {
    process.stderr.write(`claude-notifier: osascript failed: ${err.message}\n`);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { sanitize, MAX_MESSAGE_LEN, MAX_SUBTITLE_LEN, DEFAULT_MESSAGE };
