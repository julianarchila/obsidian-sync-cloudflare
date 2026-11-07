# v1 scope

v1 is the first version good enough to hold a real vault. It targets one user per deployment, on desktop.

## Product goal

A drop-in replacement for Obsidian Sync that anyone can self-host on their own Cloudflare account with one command, and that lets the owner's AI agents work on the same notes: shell agents through a synced folder (headless CLI), chat apps such as Claude and ChatGPT through an MCP endpoint. Agent changes go through the same change log as devices, so they merge, are attributed and can be undone.

Free, open source personal software: each person deploys their own single-tenant instance. A web viewer and server-side AI stay out of scope until explicitly planned.

## Decisions

| Topic | Decision |
|---|---|
| Users | One owner. One shared deploy token. |
| Devices | Desktop only (macOS). Mobile comes after v1. |
| Encryption | None at the application level since M7 (`plain-v1`): the Worker must read notes for MCP and search. TLS in transit, R2 and Durable Object storage at rest. The owner's Cloudflare account (2FA) and tokens are the boundary. Was end-to-end encryption in M1–M6; the code remains in `core/legacy/` to read old vaults (`docs/MIGRATION.md`). |
| Agent access | Folder (CLI) for shell agents, MCP for chat apps. One change log, so both converge with devices. Writes carry a version: compare-and-swap, three-way merge on the server when the caller read an older version, explicit refusal when edits overlap. |
| Connector auth | OAuth 2.1 (PKCE S256, dynamic client registration, client ID metadata documents) with stateless tokens signed by a key derived from `OSCF_TOKEN`. The owner approves each connection with the deploy token and picks vault, read or write access and folders. Static tokens with the same scopes in `OSCF_MCP_CLIENTS`. |
| Vault index | A custom Durable Object with an append-only change log (one SQLite row per file version, plus a `seq` cursor). This replaces Yielded Sync, which stores the whole index as one JSON row (2 MB cap, so only about 7k files, rewritten on every change). Vault size stops mattering, and the log doubles as version history. |
| File size | No practical limit. Files are split into chunks of about 8 MB, each encrypted and content-addressed, plus a manifest. This stays under the Workers request-body limit (100 MB on Free and Pro zones) and dedupes unchanged chunks across versions. |
| Client architecture | Effect powers the sync engine: reconcile, queue and concurrency, retries, WebSocket lifecycle, crypto and protocol validation with `Schema` shared with `packages/protocol`. The Obsidian glue (events, settings, UI) stays plain TypeScript. The vault, network and clock are Layers, so the engine is tested headlessly in `bun test`, beyond the slower agent-desktop end-to-end runs. |
| Bundle | The plugin imports Effect only by module (`effect/Effect`, `effect/Schema`, `effect/crypto/Aead`, …), never from the `effect` barrel. CI checks this. Measured with esbuild: the planned feature set is about 97 KB minified (33 KB gzip) with module imports, versus about 450 KB with barrel imports and 513 KB today with Yielded. Budget: 150 KB minified. |
| Offline | A requirement in every milestone, not a feature of its own. Edits made offline or while Obsidian is closed must converge on reconnect without data loss. |
| Audience | Self-hosters: one `bun run deploy` on your own Cloudflare account. |

## Milestones

Each milestone is a PR. It is done only when `typecheck`, `smoke`/`smoke:dev` and the Obsidian end-to-end run (agent-desktop, two test vaults) pass. Every new behavior gets an end-to-end scenario, including an offline variant.

### M0: Change-log index (replaces Yielded) ✅ (#3)

- **Durable Object per vault**, backed by SQLite:
  - A `versions` table with one row per accepted version: path id, version, hash or manifest, size, mtime, device, deleted, `seq`, time.
  - The current state is the latest row per path.
- **Writes** are compare-and-swap on `baseVersion`, which is naturally idempotent. A retried write whose current server entry already carries our hash counts as a success.
- **Reads:**
  - `changes since <seq>` for catch-up.
  - WebSocket hibernation to push new `seq` values to connected devices.
  - A full listing only on first sync.
- **Plugin:**
  - Persists its cursor.
  - Reconciles incrementally: it hashes only files whose `mtime` or size changed since the base.
  - Detects offline renames by matching hashes.
- **Removes** Yielded, the bun patch and the `effect` override.
- **Restructures the plugin.** The engine becomes Effect code behind Layers (`VaultIo`, `Remote`, `Clock`), with headless `bun test` coverage of the reconcile matrix. A bundle check enforces module-only Effect imports and the 150 KB budget.
- **Done when:**
  - All existing end-to-end scenarios pass.
  - The offline scenario passes: close vault B, edit, delete and rename on both sides, reopen B, and everything converges.
  - A synthetic vault with 20k files syncs, and a single edit writes O(1) rows.
  - The plugin bundle stays under 150 KB minified.

### M1: End-to-end encryption ✅ (#4)

This changes the data format, so it comes first. Existing test data is wiped.

- **Vault setup.** On first connection, a device creates the vault: random salt, PBKDF2 parameters, and an encrypted verification record stored on the server. Other devices enter the password, and the verification record rejects a wrong password before any sync happens.
- **Encrypted, chunked contents.**
  - Files are split into chunks of about 8 MB.
  - Each chunk is encrypted with AES-256-GCM and a random nonce, and stored in R2 under the hash of its ciphertext.
  - An encrypted manifest lists the chunks of a file version.
  - The server never sees plaintext, and no request exceeds a few MB.
- **Encrypted paths.** Index paths are encrypted deterministically, so the same path always maps to the same id and the server can still use them as keys. File sizes are padded or bucketed to limit metadata leakage.
- **Binding.** The path id is used as AAD, so a blob cannot be swapped onto another file.
- **Key handling.** The derived key never leaves the device. The plugin keeps it in memory, and optionally caches it in local plugin data, behind a setting.
- **Done when:**
  - R2 objects and index entries are opaque (checked with `cf`).
  - A wrong password is rejected.
  - A file of 300 MB or more round-trips.
  - All end-to-end scenarios, including offline, pass with encryption on.

### M2: Selective sync ✅ (#5)

- Excluded folders, plus toggles for file types (images, audio, video, PDF, other).
- Excluded files are neither uploaded nor downloaded. Changing a setting reconciles: newly included files sync, and newly excluded files are left in place locally.
- **Done when:** end-to-end tests show that an excluded folder never reaches the other vault, and that removing the exclusion syncs it.

### M3: Markdown merge ✅ (#6)

- A concurrent edit to a `.md` file runs a 3-way merge with the last synced version as base. The plugin downloads and decrypts the base by its hash.
- Clean merges produce no conflict copy. Overlapping hunks fall back to the current behavior: the remote version wins the path and the local version becomes a conflict copy.
- Binary and other files keep the conflict-copy behavior.
- **Done when:** end-to-end tests show that edits to different paragraphs on A and B both survive, including when B made its edits offline, and that overlapping edits produce a conflict copy.

### M4: Version history and recovery ✅ (#7)

- Version data already exists, because the M0 change log keeps every version. M4 adds the UI and retention on top of it.
- **Plugin UI:**
  - A "Version history" view on a file lists its versions, shows a decrypted diff against the current version, and can restore one.
  - A "Deleted files" view can restore deleted files.
  - If retention has pruned a long-offline device's base version, merges fall back to a conflict copy. Nothing is lost.
- **Retention:** a configurable window, 12 months by default. A scheduled Worker deletes expired records and any blob no longer referenced by a live or retained version.
- **Done when:** a file edited three times can be restored to version 1 in the other vault, a deleted file can be recovered, and a retention run in dev with a short window removes only expired blobs.

### M5: Settings sync ✅ (#8)

- Syncs `.obsidian/` through `vault.adapter`. Each category has its own toggle: main settings, appearance, themes and snippets, community plugin list, plugins (code and data), and hotkeys.
- **Always excluded:** `workspace*.json`, caches, and this plugin's own `data.json`, which holds the token and sync state.
- `.json` config files are merged by key on conflict.
- **Done when:** end-to-end tests show that a theme, a hotkey and a snippet changed in A appear in B, and that this plugin's data is never synced.

### M6: Real-vault migration ✅ (encrypted format)

1. **Dry run.** Copy the real vault to a test location (read-only on the original), sync it into a new remote vault, and verify a second test vault reproduces it byte for byte.
2. **Cutover.** Move the real vault out of any other sync service (iCloud, Google Drive, Dropbox, Obsidian Sync), because running two sync engines on one folder corrupts data. Then connect it to the plugin. The owner decides when.
3. A fresh backup of the vault exists before cutover.

## Agent access (v2)

### M7: Plain vaults (#4, draft)

- Vault meta records `plain-v1`; the plugin creates and opens plain vaults, refuses encrypted ones with a clear message, and drops the stored key from its settings.
- Path ids are real paths and metadata is JSON, validated against its path id (an unsafe path is skipped, never written).
- **Done when:** unit tests, smoke and the Obsidian end-to-end run pass on plain vaults; `docs/MIGRATION.md` covers moving an encrypted vault.

### M8: Headless CLI (#4, draft)

- `homebase init | sync | watch | status | history | restore | deleted | restore-deleted | mv`, same engine as the plugin.
- `watch`: WebSocket pulls, file events trigger a stat-only scan, polling when the folder can't be watched, retries with backoff, waits for the server at start.
- Moves are first-class: history follows a renamed file, a move edited in the same pass keeps its history, an offline move doesn't duplicate a file edited elsewhere, receiving devices reuse local bytes. `mv` rewrites links.
- `.homebaseignore`; hidden files never sync.
- **Done when:** `scripts/cli-e2e.ts` passes on macOS and Linux, including bursts and `watch`; the systemd unit in the CLI README works.

### M9: MCP endpoint and OAuth (#4, draft: adding a real connector needs a deploy)

- Stateless MCP (2026-07-28, `effect/ai/McpServer`) at `/mcp/<vault>`: read, search (FTS5), backlinks, versioned writes with merge, moves with link rewriting, history, diff, targeted undo, recovery, images.
- Per-connection access (read or write), folder and vault scopes; every change attributed as `mcp:<connection>`.
- OAuth for connectors (see Decisions).
- **Done when:** `scripts/mcp-e2e.ts` and `scripts/oauth-e2e.ts` pass, field tests with real agents show no silent overwrites, and a connector is added from Claude with only the URL.

## Out of scope for now

- Mobile (iOS and Android).
- Shared vaults and multiple users.
- Per-device tokens for the plugin and CLI. They share the deploy token, which now also guards contents: keep it secret, rotate it if it leaks (rotation also revokes every OAuth connection).
- Revoking a single OAuth connection (only all at once, by rotating the token).
- Public polish: setup wizard, community-plugin or BRAT listing, docs for other self-hosters, and scrubbing the prod URL from `AGENTS.md`.

## Testing offline

The Obsidian app cannot have its network cut on its own, so "offline" is simulated by closing a vault, editing its files on disk, and reopening it. This exercises the same code path as reconnecting after a network loss: the reconcile and the catch-up from the cursor.

