<img src="assets/icon.svg" width="64" height="64" alt="">

# Homebase

**A self-hosted replacement for Obsidian Sync on your own Cloudflare account, with your AI agents built in.**

You deploy one Worker with one command and install the **Homebase** plugin on your devices. Your vault then syncs in real time. The same notes are open to your agents: connect Claude or ChatGPT with just a URL (MCP), or keep a synced folder on an always-on machine for shell agents such as Claude Code (`homebase` CLI). Agent edits merge with yours, are recorded under the agent's name, and can be undone.

Free and open source. Personal software: each person runs their own instance.

| | Obsidian Sync | Homebase |
|---|---|---|
| Real-time sync across devices | ✅ | ✅ |
| Encryption | ✅ End to end | In transit and at rest (Cloudflare); not end to end, so agents can read notes. See [Security](#security) |
| AI agents (Claude, ChatGPT, Claude Code, scripts) | ❌ | ✅ MCP endpoint with OAuth, and a headless CLI |
| Version history and deleted-file recovery | 1 to 12 months | ✅ Configurable, 365 days by default |
| Conflict handling | Merge for Markdown | ✅ 3-way merge for Markdown, key merge for JSON settings |
| Selective sync (folders, file types) | ✅ | ✅ |
| Settings, themes, snippets, plugins, hotkeys | ✅ | ✅ Per-device toggles |
| Offline edits | ✅ | ✅ |
| Max file size | 5 or 200 MB | No practical limit (8 MB chunks) |
| Price | $4–10/month | **$0** on Cloudflare's free plans for a personal vault |
| Who holds your data | Obsidian | **You** (your Cloudflare account) |

## How it works

```
Homebase plugin ─┐
homebase CLI ────┼─HTTPS─▶ Worker ──▶ R2                 file chunks (≤8 MB), content-addressed
Claude, ChatGPT ─┘  (MCP)    │
       ▲                     │
       └──── WebSocket ──────┴──▶ Durable Object         change log: one SQLite row per file version
                                  (one per vault)         + `seq` cursor, live pushes, search index
```

- **Change log.** Each vault is a Durable Object holding one SQLite row per file version and a global cursor. Devices catch up with "changes since my cursor". Every write is a compare-and-swap on the file's version, so concurrent edits are detected rather than lost.
- **Big first syncs stay usable.** Notes download before large attachments, and edits you make during a long download are uploaded between files instead of waiting for it to finish.
- **Real time with no idle cost.** The plugin keeps a WebSocket open, and the server pushes a notice when something changes. Idle connections hibernate, and keep-alive pings are answered without waking the Durable Object. An open but idle Obsidian makes **zero billable requests**. After the computer wakes from sleep, the network comes back or the app returns to the foreground, the plugin checks the connection, reconnects if it died and catches up on its own.
- **Agents are devices too.** MCP edits and CLI edits go through the same change log, so they merge with yours, show up in history under the agent's name (`mcp:claude`, `cli-vm`) and can be undone.
- **Conflicts.**
  - Edits to different parts of a Markdown note are merged with a three-way merge.
  - Overlapping edits keep both versions: yours is saved as `note (conflict <device> <date>).md`.
  - JSON settings merge key by key.
- **Offline.** Edits made offline, or while Obsidian is closed, are found by the next scan and converge like any other change.
- **History and retention.** Every version is kept. A daily cron deletes versions older than `OSCF_RETENTION_DAYS` (365 by default) along with chunks nobody references anymore.

## Security

Homebase stores your notes **unencrypted** in your own Cloudflare account, so your agents and the search index can read them. Versions up to 0.2 were end-to-end encrypted; 0.3 can't open those vaults, so connect your devices to a new vault id.

- **In transit and at rest:** HTTPS everywhere; Cloudflare encrypts R2 and Durable Object storage at rest. Cloudflare, as your infrastructure provider, could technically read your data, as with iCloud or Google Drive.
- **The deploy token** (`OSCF_TOKEN`) gives full access to your vaults. Keep it secret, and use 2FA on your Cloudflare account. If it leaks, set a new one and redeploy: that also revokes every connected agent.
- **Agents get scoped access.** Each connection (OAuth, or a static token in `OSCF_MCP_CLIENTS`) is limited to the vaults you chose, read-only or read-write, and optionally to some folders. Settings folders (`.obsidian`) and hidden files are never exposed. Every change records which connection made it, and nothing is lost: deletions and overwrites stay in history.

## Cost

Homebase is built for Cloudflare's **free** plans:

| Resource | Free allowance | A typical personal vault |
|---|---|---|
| Workers / Durable Object requests | 100,000 / day each | Only when you or another device change something |
| Durable Object SQLite storage | 5 GB | A few MB of index |
| R2 storage | 10 GB / month (then $0.015/GB) | The size of your vault plus history |
| R2 operations | 1M writes, 10M reads / month | Small |

If you outgrow it, Workers Paid is $5/month. The Free plan allows 10 ms of CPU per request. Chunk verification fits in practice; if you see errors on very large files, Workers Paid lifts that limit.

## Deploy

You need a Cloudflare account (the free plan is enough), [Bun](https://bun.sh), and `openssl`.

```sh
git clone https://github.com/julianarchila/obsidian-sync-cloudflare && cd obsidian-sync-cloudflare
bun install
bun alchemy profile edit --add Cloudflare   # one-time browser login to your Cloudflare account
cp .env.example .env                        # set OSCF_TOKEN=$(openssl rand -hex 32)
bun run deploy                              # prints your Worker URL; put it in .env as OSCF_URL
bun run smoke                               # end-to-end check against your deployment
```

Deployment is managed by [Alchemy](https://alchemy.run), and its state lives in your own Cloudflare account. Run `bun run destroy` to remove everything. If you keep secrets in a manager, run the commands through it, for example `doppler run -- bun run deploy`.

## Install the plugin

- **With BRAT (recommended):** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose *Add beta plugin*, and paste `julianarchila/obsidian-sync-cloudflare`.
- **Manually:** download `main.js` and `manifest.json` from the [latest release](https://github.com/julianarchila/obsidian-sync-cloudflare/releases) into `<vault>/.obsidian/plugins/homebase/`, then enable **Homebase** under *Settings → Community plugins*.

## Set up your devices

1. **Move the vault out of other sync services first** (iCloud, Google Drive, Dropbox, Obsidian Sync). Two sync engines on one folder will corrupt it. Keep a backup.
2. **On the first device,** open *Settings → Homebase* and fill in:
   - **Server URL:** your `OSCF_URL`.
   - **Token:** your `OSCF_TOKEN`.
   - **Vault id:** any short name, such as `personal`.
   - **Device name:** used in conflict file names and history.

   Then press *Save & connect*. The status bar shows `☁ synced` once the upload finishes.
3. **On every other device,** use the same server URL, token and vault id. Start from an empty vault, and Homebase downloads everything.

## Using it

- **Sync status:** tap the cloud icon in the ribbon (on mobile, in the left sidebar) to open the status panel. It shows the current state, a progress bar with files and MB for long transfers, the last sync time, and an activity log of what was downloaded, uploaded, deleted, merged or kept as a conflict. On desktop the status bar shows the same progress. Long transfers announce their start and end with a notice.
- **Version history:** right-click a file, then *Version history*, or use the command palette. It shows every version, a diff against the current one, and *Restore*.
- **Recover deleted files:** command *Recover deleted files*.
- **Selective sync and settings sync:** *Settings → Homebase*. Changes from other devices to settings apply after reloading Obsidian.
- **URIs:** `obsidian://homebase?vault=<name>&do=history&file=<path>`, `do=deleted`, `do=sync`, `do=status`.
- **Verify your backup:** `bun scripts/verify-restore.ts <vault-id> <local-vault-folder>` downloads the whole vault as a new device would, then compares it byte for byte with your local copy.

## Connect your AI agents

### Claude, ChatGPT and other MCP clients

Add a custom connector with the URL `https://<your-worker>/mcp/<vault-id>`. The connector opens a Homebase page where you approve it: enter your deploy token, and choose read-only or read-write access and, optionally, the folders it may see. The connection name you pick is how its changes appear in history.

- **Claude:** *Settings → Connectors → Add custom connector*. Works on the web, desktop and mobile apps.
- **ChatGPT:** in developer mode, add a custom connector (app) with the same URL.
- **Claude Code:** `claude mcp add --transport http homebase https://<your-worker>/mcp/<vault-id>`, then `/mcp` to sign in.

The agent gets tools to list, read, search and find backlinks; to create, edit, append, move (links are updated) and delete notes; and to see history, compare versions, undo one change or restore a version. Edits carry the version the agent read: if you changed the note meanwhile, both edits are merged, and if they overlap the agent is told what changed instead of overwriting it.

**Static tokens** (scripts, clients without OAuth): set `OSCF_MCP_CLIENTS` to a JSON array before deploying, for example `[{"name":"scripts","token":"<openssl rand -hex 32>","access":"read","folders":["Work"],"vaults":["personal"]}]`, and send `Authorization: Bearer <token>`. `vaults` is required; `prefix-*` matches by prefix.

### A synced folder for shell agents

Run `homebase watch` on an always-on machine (a VM or home server) to keep a plain folder in sync. Agents such as Claude Code or Codex then work on it with ordinary tools (`rg`, `sed`, Python), and their edits reach your devices within a couple of seconds. See [`packages/cli/README.md`](packages/cli/README.md) for setup, `homebase mv` (moves with link rewriting), `.homebaseignore` and a systemd unit.

## Limitations

- **Tested on desktop (macOS) and Android** (emulator, Obsidian 1.15). iOS should work through the same APIs, but it is untested. On mobile, Obsidian only syncs while the app is open.
- **One owner per deployment.** There are no per-user accounts or shared vaults. Devices share the deploy token. OAuth connections can only be revoked all at once (by rotating the token).
- **No interoperability with Obsidian Sync.** Pick one.
- **File names:** Android and Windows don't allow `\ / : * ? < > " |` in file names, but macOS does. Files whose names a device can't store are skipped on that device, and listed in the status panel and activity log, while everything else keeps syncing. Rename them (for example on the Mac) to sync them there. The Obsidian Web Clipper's `safe_name` filter avoids such names.
- **Never synced:** plugin caches (`plugins/*/cache`), workspace layouts, and Homebase's own settings, which hold the token.

## Development

```sh
bun run check        # typecheck + unit tests (server store, sync engine, merge, links) + bundle guard
bun run dev          # Worker + Durable Object + R2 emulated locally on http://localhost:1337
bun run smoke:dev    # two in-memory devices and the MCP endpoint against the dev server
bun scripts/mcp-e2e.ts    # MCP tools, scopes and merges against the dev server
bun scripts/oauth-e2e.ts  # the connector OAuth flow against the dev server
bun scripts/cli-e2e.ts    # the headless CLI, including watch
bun run plugin:dev   # watch build; OBSIDIAN_VAULT=/path/to/test-vault writes straight into a vault
bun run e2e          # drives the real Obsidian app (macOS, needs agent-desktop) against OSCF_URL
bun run release      # builds the plugin and publishes a GitHub release
```

| Path | What |
|---|---|
| `alchemy.run.ts` | All infrastructure: Worker, Durable Object, R2 bucket, retention cron |
| `packages/protocol` | Wire contract (Effect Schema) |
| `packages/server` | Change-log store, Durable Object, Worker (auth, routing, blobs, retention), MCP endpoint, OAuth |
| `packages/plugin` | `src/core`: the sync engine (Effect, headless-testable), shared with the CLI. `src/obsidian`: Obsidian adapters and UI |
| `packages/cli` | `homebase`, headless sync for always-on machines and shell agents |
| `docs/SCOPE.md` | Design decisions and milestones |
| `AGENTS.md` | Notes for coding agents working on (or deploying) this repo |

## License

[MIT](LICENSE)
