<img src="assets/icon.svg" width="64" height="64" alt="">

# Homebase

**A self-hosted replacement for Obsidian Sync, end-to-end encrypted, running on your own Cloudflare account.**

You deploy one Worker with one command and install the **Homebase** plugin on your devices. Your vault then syncs in real time. Your notes are encrypted on your devices before they leave them, and the server only ever stores ciphertext.

| | Obsidian Sync | Homebase |
|---|---|---|
| Real-time sync across devices | ✅ | ✅ |
| End-to-end encryption | ✅ | ✅ Always on |
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
Homebase plugin ──HTTPS──▶ Worker ──▶ R2                encrypted chunks (≤8 MB), content-addressed
       ▲                     │
       └──── WebSocket ──────┴──▶ Durable Object         change log: one SQLite row per file version
                                  (one per vault)         + `seq` cursor, live "something changed" pushes
```

- **Change log.** Each vault is a Durable Object holding one SQLite row per file version and a global cursor. Devices catch up with "changes since my cursor". Every write is a compare-and-swap on the file's version, so concurrent edits are detected rather than lost.
- **Big first syncs stay usable.** Notes download before large attachments, and edits you make during a long download are uploaded between files instead of waiting for it to finish.
- **Real time with no idle cost.** The plugin keeps a WebSocket open, and the server pushes a notice when something changes. Idle connections hibernate, and keep-alive pings are answered without waking the Durable Object. An open but idle Obsidian makes **zero billable requests**. After the computer wakes from sleep, the network comes back or the app returns to the foreground, the plugin checks the connection, reconnects if it died and catches up on its own.
- **Encryption.** See [Security](#security).
- **Conflicts.**
  - Edits to different parts of a Markdown note are merged with a three-way merge.
  - Overlapping edits keep both versions: yours is saved as `note (conflict <device> <date>).md`.
  - JSON settings merge key by key.
- **Offline.** Edits made offline, or while Obsidian is closed, are found by the next scan and converge like any other change.
- **History and retention.** Every version is kept. A daily cron deletes versions older than `OSCF_RETENTION_DAYS` (365 by default) along with chunks nobody references anymore.

## Security

- **Vault key.** Each vault has a random 256-bit key, wrapped with your **vault password** (PBKDF2-SHA256, 600,000 iterations). The password never leaves your device. The server stores only the wrapped key and a check value that lets a device reject a wrong password before syncing anything.
- **What gets encrypted, and how.** All keys are derived from the vault key with HKDF.
  - Paths become HMAC-SHA256 ids.
  - Metadata (real path, size, mtime, hash) is sealed with AES-256-GCM and bound to its path id.
  - File chunks are sealed with AES-256-GCM and padded to 4 KiB, so sizes leak little.
  - Identical chunks produce identical ciphertext within a vault, which enables dedup. Like Obsidian Sync, this reveals whether two chunks of your vault are equal, and nothing else.
- **The deploy token** (`OSCF_TOKEN`) authenticates devices to your Worker. Without your password it gives no access to note contents.
- **Changing the password** only re-wraps the vault key, so nothing is re-encrypted and other devices keep syncing. **If you lose the password, the data cannot be recovered.**

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
   - **Device name:** used in conflict file names.
   - **Vault password:** creates the vault's encryption.

   Then press *Save & connect*. The status bar shows `☁ synced` once the upload finishes.
3. **On every other device,** use the same server URL, token, vault id and vault password. Start from an empty vault, and Homebase downloads everything.

Each device can choose to remember the derived key, which never includes the password. *Lock vault* forgets it.

## Using it

- **Sync status:** tap the cloud icon in the ribbon (on mobile, in the left sidebar) to open the status panel. It shows the current state, a progress bar with files and MB for long transfers, the last sync time, and an activity log of what was downloaded, uploaded, deleted, merged or kept as a conflict. On desktop the status bar shows the same progress. Long transfers announce their start and end with a notice.
- **Version history:** right-click a file, then *Version history*, or use the command palette. It shows every version, a diff against the current one, and *Restore*.
- **Recover deleted files:** command *Recover deleted files*.
- **Selective sync and settings sync:** *Settings → Homebase*. Changes from other devices to settings apply after reloading Obsidian.
- **Change vault password:** *Settings → Homebase*.
- **URIs:** `obsidian://homebase?vault=<name>&do=history&file=<path>`, `do=deleted`, `do=sync`, `do=status`.
- **Verify your backup:** `bun scripts/verify-restore.ts <vault-id> <local-vault-folder> <password-file>` downloads and decrypts the whole vault as a new device would, then compares it byte for byte with your local copy. Instead of a password file you can pass the device's `.obsidian/plugins/homebase/data.json`, which holds the remembered key.

## Limitations

- **Tested on desktop (macOS) and Android** (emulator, Obsidian 1.15). iOS should work through the same APIs, but it is untested. On mobile, Obsidian only syncs while the app is open.
- **One deploy token per deployment.** There are no per-user accounts or shared vaults.
- **No interoperability with Obsidian Sync.** Pick one.
- **File names:** Android and Windows don't allow `\ / : * ? < > " |` in file names, but macOS does. Files whose names a device can't store are skipped on that device, and listed in the status panel and activity log, while everything else keeps syncing. Rename them (for example on the Mac) to sync them there. The Obsidian Web Clipper's `safe_name` filter avoids such names.
- **Never synced:** plugin caches (`plugins/*/cache`), workspace layouts, and Homebase's own settings, which hold the token and key.

## Development

```sh
bun run check        # typecheck + unit tests (server store, sync engine, crypto, merge) + bundle guard
bun run dev          # Worker + Durable Object + R2 emulated locally on http://localhost:1337
bun run smoke:dev    # two in-memory devices against the dev server
bun run plugin:dev   # watch build; OBSIDIAN_VAULT=/path/to/test-vault writes straight into a vault
bun run e2e          # drives the real Obsidian app (macOS, needs agent-desktop) against OSCF_URL
bun run release      # builds the plugin and publishes a GitHub release
```

| Path | What |
|---|---|
| `alchemy.run.ts` | All infrastructure: Worker, Durable Object, R2 bucket, retention cron |
| `packages/protocol` | Wire contract (Effect Schema) |
| `packages/server` | Change-log store, Durable Object, Worker (auth, routing, blobs, retention) |
| `packages/plugin` | `src/core`: the sync engine (Effect, headless-testable). `src/obsidian`: Obsidian adapters and UI |
| `docs/SCOPE.md` | Design decisions and milestones |
| `AGENTS.md` | Notes for coding agents working on (or deploying) this repo |

## License

[MIT](LICENSE)
