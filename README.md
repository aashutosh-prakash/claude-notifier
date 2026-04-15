# claude-notifier

> macOS notifications for [Claude Code](https://claude.com/claude-code) permission prompts — so you don't have to watch the terminal.

**macOS only.** When Claude needs your input (to run a command, write a file, etc.), a native macOS notification fires with the Sosumi chime, the project directory as subtitle, and the permission message as body.

---

## Install

```bash
npx claude-notifier
npx claude-notifier --test      # fire a sample notification + grant macOS permission
```

That's it. The installer:

1. Adds a `Notification` hook to `~/.claude/settings.json` under the `permission_prompt` matcher.
2. Copies the runner to `~/.claude/claude-notifier/notify.js` (stable path, survives `npm` cache cleanup).
3. Backs up your prior `settings.json` to `~/.claude/.claude-notifier-backups/` (mode `0600`, 5 most recent kept).

## Uninstall

```bash
npx claude-notifier --uninstall                # fully remove hook + runner + backups
npx claude-notifier --uninstall --keep-backups # keep the backup directory
```

## Commands

| Command | Purpose |
|---|---|
| `npx claude-notifier` | Install the hook |
| `npx claude-notifier --test` | Fire a sample notification (also triggers the one-time macOS permission prompt) |
| `npx claude-notifier --doctor` | Diagnose install health (platform, settings.json, runner, permissions) |
| `npx claude-notifier --dry-run` | Show proposed changes without writing anything |
| `npx claude-notifier --uninstall` | Remove the hook and the runner directory |
| `npx claude-notifier --force` | Skip the 3-second abort window when replacing an existing foreign `permission_prompt` hook |
| `npx claude-notifier --help` | Show help |
| `npx claude-notifier --version` | Print version |

## What it writes to `settings.json`

```diff
  {
    "statusLine": { ... },
    "permissions": { ... },
+   "hooks": {
+     "Notification": [
+       {
+         "matcher": "permission_prompt",
+         "hooks": [
+           {
+             "type": "command",
+             "command": "/Users/<you>/.claude/claude-notifier/notify.js"
+           }
+         ]
+       }
+     ]
+   }
  }
```

If you already have other `Notification` matchers, **they are preserved**. If you already have a `permission_prompt` entry that isn't from claude-notifier, the installer warns you and gives a 3-second window to abort (or use `--force`).

## macOS permission prompt

The first time a notification fires, macOS asks your terminal (iTerm, Terminal, VS Code, etc.) for Notification permission. Running `npx claude-notifier --test` immediately after install triggers this prompt up front, so the first *real* Claude notification isn't silently swallowed.

If you dismissed the prompt, re-enable via **System Settings → Notifications → [your terminal app]**.

## Known limitation: notifications attribute to "Script Editor"

Notifications are fired via `osascript`, which macOS always attributes to **Script Editor** (the AppleScript host app). Two visible consequences:

- The icon badge on the notification is the Script Editor scroll icon.
- **Clicking the notification opens Script Editor with an Untitled document.** Don't click — the notification is purely informational.

This is a macOS platform behavior, not a bug in claude-notifier. The only way to change attribution is to fire notifications via `UNUserNotificationCenter` from a properly identified app bundle, which requires a compiled Swift or Objective-C binary. Planned for v0.2 — will compile at install time if Xcode Command Line Tools (`swift`) are available, fall back to osascript otherwise.

## Privacy

- All processing is local. **Zero network calls.**
- **Zero runtime dependencies.**
- **Zero telemetry.**
- **Zero npm lifecycle scripts** (no `preinstall`/`postinstall`).

The project directory name (the basename of `cwd`) appears as the notification subtitle. This is visible in macOS notification history and on lock screen. If you work in directories with names you'd rather not display (e.g., `~/Projects/private-project/`), adjust lock-screen visibility in System Settings or consider renaming the folder.

## Verifying the publish

```bash
npm audit signatures claude-notifier
```

This package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — attestations linking the tarball back to the GitHub build that produced it.

## Requirements

- macOS (Darwin) — Linux/Windows support not included
- Node.js ≥ 18
- Claude Code CLI installed (duh)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs welcome at [aashutosh-prakash/claude-notifier](https://github.com/aashutosh-prakash/claude-notifier).

## Security

See [SECURITY.md](./SECURITY.md) for disclosure policy and security properties. Report vulnerabilities privately to `aashutosh.code@gmail.com`.

## License

MIT — see [LICENSE](./LICENSE).

---

*Unofficial, community-maintained. Not affiliated with Anthropic.*
