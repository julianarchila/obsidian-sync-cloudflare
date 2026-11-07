# Agent notes

**Homebase** is a self-hostable replacement for Obsidian Sync that runs on the user's own Cloudflare account, plus agent access to the same notes: a headless sync CLI and an MCP endpoint. Vaults are stored unencrypted (`plain-v1`); the owner's Cloudflare account and tokens are the security boundary. Stay within `docs/SCOPE.md` (sync parity and agent access); ask the user before adding anything else, such as a web viewer or server-side AI.

## Setting it up for a user

1. Install the dependencies with `bun install`.
2. Log in to Cloudflare once with `bun alchemy profile edit --add Cloudflare`. The user has to complete the browser OAuth step.
3. Copy `.env.example` to `.env` and set `OSCF_TOKEN` (`openssl rand -hex 32`). If the user keeps secrets in a manager such as Doppler, run every command through it, for example `doppler run -- bun run deploy`.
4. Run `bun run deploy`. It prints the Worker URL; save it as `OSCF_URL`.
5. Run `bun run smoke` to verify the deployment against that URL.
6. Build the plugin with `bun run plugin:build` (or install it from a GitHub release with BRAT). See the README for the device setup, connecting Claude or ChatGPT (MCP and OAuth) and the CLI on an always-on machine.
7. A user coming from an encrypted version follows `docs/MIGRATION.md`.

## Rules

- **Alchemy owns all infrastructure.** Create, change or delete Workers, Durable Objects, R2 buckets, secrets and bindings only through `alchemy.run.ts` and `bun run deploy` / `bun run destroy`.
- **Use the `cf` CLI only to observe** (resources, logs, R2 objects, docs). Fix problems in code, never by patching resources with `cf`. Never touch resources outside this stack.
- **Never print secret values.**
- **Never point tests at a real vault or vault id.** Tests create their own `smoke-*` / `e2e-*` vault ids and use `~/ObsidianTest/vault-{a,b}`.
- **Add no new dependencies.** Hand-write small algorithms.
- **Import Effect by module only** (`effect/Effect`, never `"effect"`) in `packages/plugin` and `packages/protocol`. The plugin has a 150 KB budget, and `check:bundle` enforces both rules.

## Testing

- `bun run check`: typecheck, unit tests and the bundle guard. Run it before every PR.
  - The unit tests cover the server store on bun:sqlite and the sync engine headlessly (`packages/plugin/test/harness.ts`: in-memory server and devices).
- `bun run dev` serves everything locally on http://localhost:1337 (`ALCHEMY_STATE=local`); `bun run smoke:dev` tests it. `bun run smoke` tests the deployed Worker (`OSCF_URL`).
- Against `bun run dev`: `scripts/mcp-e2e.ts` (MCP tools, scopes, merge; needs `OSCF_MCP_CLIENTS` with a `reader` and a `work-agent` limited to `Work`, both with `"vaults":["e2e-*"]`), `scripts/oauth-e2e.ts` (connector flow), `scripts/cli-e2e.ts` (CLI, including `watch`).
- `bun run e2e` drives the real Obsidian app on macOS through [agent-desktop](https://github.com/vercel-labs/agent-desktop). It backs up and restores `obsidian.json`. Add scenarios to `SCENARIOS` in `scripts/e2e-obsidian.ts`. Notes:
  - Plugin URIs: use `do=` (`action` is reserved) and `file=` (Obsidian treats `path=` as a filesystem path).
  - A native alert can block a graceful quit; the script dismisses it and escalates to SIGTERM.
  - Run `focus-window` before taking screenshots.
- `scripts/verify-restore.ts` is a read-only restore drill. It downloads a whole vault (decrypting legacy encrypted ones) and compares it byte for byte with a local folder.

## Architecture

- `packages/protocol`: wire contract (Effect Schema).
- `packages/server`:
  - `store.ts` is the pure change log on SQLite. Renames leave a tombstone with `moved_to`, so history follows a file.
  - `vault-object.ts` is the Durable Object (hibernating WebSockets, ping auto-response). `search-index.ts` is its FTS5 index, filled by the Worker.
  - `worker.ts` handles auth, routing, R2 blobs and the retention cron.
  - `mcp.ts` (tools, scopes), `vault-ops.ts` (the Worker as a device: reads, compare-and-swap writes) and `oauth.ts` (stateless OAuth 2.1, tokens signed with a key derived from `OSCF_TOKEN`) make the MCP endpoint `/mcp/<vault>`.
- `packages/plugin/src/core`: the Effect sync engine, shared by the plugin and the CLI, with no Obsidian imports.
  - `engine.ts` is the reconcile logic (merge, conflicts, move detection).
  - `plain-codec.ts` and `plain-vault.ts`: the `plain-v1` format. `legacy/` holds the old encryption, used only to read encrypted vaults.
  - `filter.ts`: selective sync. `config.ts`: settings sync.
  - `merge.ts`: Myers diff and diff3. `links.ts`: link rewriting on moves.
  - `history.ts`: version history and recovery.
- `packages/plugin/src/obsidian`: Obsidian adapters and the sync client. Pull only happens when the server announces a newer `seq`; idle uses zero requests.
- `packages/cli`: `homebase`, the headless sync CLI (filesystem `VaultIo`, `watch` loop, `.homebaseignore`).
- `effect` 4.1 and Alchemy 2.0 beta, with no overrides or patches. The MCP server is `effect/ai/McpServer`.
