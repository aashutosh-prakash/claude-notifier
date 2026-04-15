# Contributing

Thanks for your interest! This project is deliberately tiny — its job is to install one notification hook, safely.

## Scope

In scope:
- macOS notification reliability, install/uninstall correctness
- Security hardening (see [SECURITY.md](./SECURITY.md))
- Compatibility with new Claude Code hook payload shapes

Out of scope (for now):
- Linux / Windows support (may reconsider — open an issue to discuss)
- Customization via CLI flags (planned for v0.2 via `~/.claude/claude-notifier.json`)
- Integrations with non-macOS notification systems

## Development

Zero dependencies. Requires Node.js ≥ 18.

```bash
git clone https://github.com/aashutosh-prakash/claude-notifier.git
cd claude-notifier
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
npx ./claude-notifier-*.tgz
npx ./claude-notifier-*.tgz --test
npx ./claude-notifier-*.tgz --uninstall

# restore
mv ~/.claude/settings.json.local-backup ~/.claude/settings.json
```

## Pull requests

- Keep changes focused. Small PRs get merged faster.
- Add or update tests for behavioral changes (`test/merge.test.js`, `test/notify.test.js`).
- If you touch security-relevant code (input sanitization, AppleScript invocation, settings.json merge), call that out explicitly in the PR description.
- CI must be green before merge.

## Filing issues

Please include the output of `npx claude-notifier --doctor`, your macOS version, and your Claude Code version. A bug template is provided.

## Security issues

**Do not** open a public issue. Email `aashutosh.code@gmail.com` instead — see [SECURITY.md](./SECURITY.md).
