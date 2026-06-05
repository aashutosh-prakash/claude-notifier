# Contributing

Thanks for your interest! This project is deliberately tiny — its job is to install one notification hook, safely.

## Scope

In scope:
- macOS notification reliability, install/uninstall correctness
- Security hardening (see [SECURITY.md](./SECURITY.md))
- Compatibility with new Claude Code hook payload shapes
- Notification sound customization via the `CLAUDE_NUDGE_SOUND` key in `settings.json` (`--list-sounds` / `--set-sound`, incl. `none` to silence)
- Turning off the task-complete notification via `CLAUDE_NUDGE_STOP` (`--disable-completion` / `--enable-completion`)

Out of scope (for now):
- Linux / Windows support (may reconsider — open an issue to discuss)
- Integrations with non-macOS notification systems
- A separate config file — configuration lives in the `env` block of `~/.claude/settings.json`, never a new file

Considered but not planned (open an issue if you need one):
- Per-event sounds (one global `CLAUDE_NUDGE_SOUND` for all events today)
- Suppressing the nudge when the Claude terminal is frontmost
- Custom (non-system) audio files

## Development

Zero dependencies. Requires Node.js ≥ 18.

```bash
git clone https://github.com/aashutosh-prakash/claude-nudge.git
cd claude-nudge
npm test                       # run the test suite (no install needed)
node bin/install.js --dry-run  # preview install changes
node bin/install.js --doctor   # check local install health
```

## Testing your changes against a real ~/.claude

```bash
# back up your real settings first
cp ~/.claude/settings.json ~/.claude/settings.json.local-backup

# pack and install locally
npm pack
npx ./claude-nudge-*.tgz
npx ./claude-nudge-*.tgz --test
npx ./claude-nudge-*.tgz --uninstall

# restore
mv ~/.claude/settings.json.local-backup ~/.claude/settings.json
```

## Pull requests

- Keep changes focused. Small PRs get merged faster.
- Add or update tests for behavioral changes (`test/merge.test.js`, `test/notify.test.js`).
- If you touch security-relevant code (input sanitization, AppleScript invocation, settings.json merge), call that out explicitly in the PR description.
- CI must be green before merge.

## Filing issues

Please include the output of `npx claude-nudge --doctor`, your macOS version, and your Claude Code version. A bug template is provided.

## Security issues

**Do not** open a public issue. Email `aashutosh.code@gmail.com` instead — see [SECURITY.md](./SECURITY.md).
