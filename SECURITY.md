# Security Policy

## Reporting

Report vulnerabilities privately to **aashutosh.code@gmail.com**. Do not open a public GitHub issue.

I will acknowledge within 7 days and aim to publish a fix or explanation within 90 days.

## Security properties

These are load-bearing invariants — regressions are security bugs:

- **Zero runtime dependencies.** `package.json` declares no `dependencies` or `devDependencies`; verified in CI.
- **Zero npm lifecycle scripts.** No `preinstall` / `install` / `postinstall` / `prepare` etc. `npm install` and `npx` do not execute anything beyond the `bin` commands the user invokes. Verified in CI via the published tarball's `package.json`.
- **Argv-based `osascript` invocation.** User-supplied notification text is passed to `osascript` via `argv`, not string interpolation — no AppleScript or shell injection is possible. See `bin/notify.js`.
- **Input sanitization.** All stdin-derived strings have control characters stripped (`\x00-\x1F`, `\x7F`) and are length-clamped before reaching `osascript`.
- **Atomic, symlink-safe settings writes.** `~/.claude/settings.json` is written via `tmp + rename`, and the installer refuses to write through a symlink pointing outside `~/.claude/`.
- **Restrictive backup permissions.** Backup directory mode `0700`, backup file mode `0600` — contents may include tokens from `settings.json`.
- **Published with npm provenance.** Verify with `npm audit signatures claude-notifier`. Releases are published from GitHub Actions via OIDC trusted publishing; no long-lived `NPM_TOKEN` in repo secrets.

## Out of scope

- Vulnerabilities in Claude Code itself, Node.js, or macOS — report upstream.
