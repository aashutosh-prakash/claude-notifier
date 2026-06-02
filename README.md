# claude-nudge

> macOS notifications for [Claude Code](https://claude.com/claude-code) — fires when Claude needs your input **and** when a task finishes, so you don't have to watch the terminal.

**macOS only.** Two nudges are installed by default:

- **Permission prompt** — Sosumi chime, body is the permission message (e.g. "Allow Bash `rm -rf`?"). Fires on the `Notification.permission_prompt` hook.
- **Task complete** — Glass chime, body is `Task complete`. Fires on the `Stop` hook when Claude finishes its response.

Both show `Claude Code` as the title and the current project directory as the subtitle.

---

## Install

```bash
npx claude-nudge
npx claude-nudge --test      # fire a sample notification + grant macOS permission
```

That's it. The installer:

1. Adds a `Notification` hook (matcher `permission_prompt`) **and** a `Stop` hook to `~/.claude/settings.json`.
2. Copies the runner to `~/.claude/claude-nudge/notify.js` (stable path, survives `npm` cache cleanup). The runner picks the right message + sound based on the hook event it receives.
3. Backs up your prior `settings.json` to `~/.claude/.claude-nudge-backups/` (mode `0600`, 5 most recent kept).

## Update

`npx` caches packages, so `npx claude-nudge` may run a stale version. Pin `@latest` to force a fresh fetch and re-copy the runner:

```bash
npx claude-nudge@latest
```

## Uninstall

```bash
npx claude-nudge --uninstall                # fully remove hook + runner + backups
npx claude-nudge --uninstall --keep-backups # keep the backup directory
```

## Commands

| Command | Purpose |
|---|---|
| `npx claude-nudge` | Install both hooks |
| `npx claude-nudge --test` | Fire a sample notification (also triggers the one-time macOS permission prompt) |
| `npx claude-nudge --doctor` | Diagnose install health (platform, settings.json, runner, osascript) |
| `npx claude-nudge --dry-run` | Show proposed changes without writing anything |
| `npx claude-nudge --uninstall` | Remove both hooks and the runner directory |
| `npx claude-nudge --force` | Skip the 3-second abort window when replacing an existing foreign `permission_prompt` hook |
| `npx claude-nudge --help` | Show help |
| `npx claude-nudge --version` | Print version |

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
+             "command": "/Users/<you>/.claude/claude-nudge/notify.js"
+           }
+         ]
+       }
+     ],
+     "Stop": [
+       {
+         "hooks": [
+           {
+             "type": "command",
+             "command": "/Users/<you>/.claude/claude-nudge/notify.js"
+           }
+         ]
+       }
+     ]
+   }
  }
```

If you already have other `Notification` matchers or other `Stop` hooks, **they are preserved**. If you already have a `permission_prompt` entry that isn't from claude-nudge, the installer warns you and gives a 3-second window to abort (or use `--force`). Foreign `Stop` entries are never replaced — claude-nudge simply appends its own alongside them.

### Note on the Stop hook

The `Stop` hook fires at the end of every main-agent turn, so you will get a "Task complete" notification after each response — including short back-and-forth exchanges. If that's too noisy, uninstall with `--uninstall` (which removes both hooks) or edit `~/.claude/settings.json` by hand to drop just the `Stop` entry.

## macOS permission prompt

The first time a notification fires, macOS asks your terminal (iTerm, Terminal, VS Code, etc.) for Notification permission. Running `npx claude-nudge --test` immediately after install triggers this prompt up front, so the first *real* Claude notification isn't silently swallowed.

If you dismissed the prompt, re-enable via **System Settings → Notifications → [your terminal app]**.

## Known limitation: notifications attribute to "Script Editor"

Notifications are fired via `osascript`, which macOS always attributes to **Script Editor** (the AppleScript host app). Two visible consequences:

- The icon badge on the notification is the Script Editor scroll icon.
- **Clicking the notification opens Script Editor with an Untitled document.** Don't click — the notification is purely informational.

This is a macOS platform behavior, not a bug in claude-nudge. The only way to change attribution is to fire notifications via `UNUserNotificationCenter` from a properly identified app bundle, which requires a notarized native binary — an ad-hoc-signed AppleScript applet (`osacompile`) is silently rejected by macOS 13+ Notification Center for new bundles, so we keep the `osascript` path which works out of the box.

## Privacy

- All processing is local. **Zero network calls.**
- **Zero runtime dependencies.**
- **Zero telemetry.**
- **Zero npm lifecycle scripts** (no `preinstall`/`postinstall`).

The project directory name (the basename of `cwd`) appears as the notification subtitle. This is visible in macOS notification history and on lock screen. If you work in directories with names you'd rather not display (e.g., `~/Projects/private-project/`), adjust lock-screen visibility in System Settings or consider renaming the folder.

## Verifying the publish

```bash
npm audit signatures claude-nudge
```

This package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — attestations linking the tarball back to the GitHub build that produced it.

## Requirements

- macOS (Darwin) — Linux/Windows support not included
- Node.js ≥ 18
- Claude Code CLI installed (duh)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs welcome at [aashutosh-prakash/claude-nudge](https://github.com/aashutosh-prakash/claude-nudge).

## Security

See [SECURITY.md](./SECURITY.md) for disclosure policy and security properties. Report vulnerabilities privately to `aashutosh.code@gmail.com`.

## License

MIT — see [LICENSE](./LICENSE).

---

*Unofficial, community-maintained. Not affiliated with Anthropic.*
