# homebase CLI

Headless Homebase sync: keeps a plain folder of notes in sync with your vault, without Obsidian. Use it on an always-on machine (a VM or a home server) so agents and scripts can work on your notes with ordinary tools (`rg`, `sed`, Python, editors). Their edits sync to your devices like any other device's.

It runs the same sync engine as the plugin: three-way merge for Markdown, conflict copies when edits overlap, version history and recovery.

## Usage

Run with Bun from the repo (`bun packages/cli/src/main.ts …`), or link the `homebase` bin.

```sh
export OSCF_TOKEN=…                      # the deploy token (or use --token-file)
homebase init ~/vault --url https://<your-worker> --vault personal --device vm
homebase sync ~/vault                    # one pass, then exit
homebase watch ~/vault                   # keep syncing until stopped
homebase status ~/vault                  # cursor, tracked files, pending local changes, last result
homebase history Notes/idea.md ~/vault
homebase restore Notes/idea.md --version 3 ~/vault
homebase deleted ~/vault
homebase restore-deleted Notes/old.md ~/vault
```

`init` writes `<dir>/.homebase/config.json` (server URL, vault id, device name). The token is never stored there: it is read from `$OSCF_TOKEN` at run time, from another variable (`--token-env NAME`), or from a file (`--token-file PATH`). Sync state lives in `<dir>/.homebase/state.json`.

Never synced: `.homebase/`, `.obsidian/`, `.git/`, `node_modules/`, `.trash/`, `.DS_Store`, and editor temp files (`*.swp`, `*~`, `.#*`). Files are written atomically (temp file, then rename).

## How `watch` works

- Listens to the vault's WebSocket and pulls only when the server announces a newer change.
- Watches the folder. Any file event triggers a scan of the whole folder after a 1 s debounce. The scan only stats unchanged files and makes no request unless something changed. Events alone aren't enough: on macOS, Bun reports only a few paths for a burst of writes or deletes.
- Rescans every 5 minutes as a safety net. Reconnects with backoff, and after sleep.
- On SIGINT or SIGTERM it pushes pending edits, then exits.

## systemd

```ini
# ~/.config/systemd/user/homebase.service
[Unit]
Description=Homebase sync for ~/vault
After=network-online.target

[Service]
ExecStart=/home/me/.bun/bin/bun /home/me/homebase/packages/cli/src/main.ts watch /home/me/vault
EnvironmentFile=/home/me/.config/homebase/env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Put `OSCF_TOKEN=…` in `~/.config/homebase/env` (mode 600). Then run `systemctl --user enable --now homebase`, and `loginctl enable-linger $USER` so it keeps running without a login session. Logs: `journalctl --user -u homebase -f`.

## Testing

`bun scripts/cli-e2e.ts` (from the repo root, with `bun run dev` running) drives two folders on a fresh `e2e-cli-*` vault. It covers one-shot sync, merge, conflicts, binaries, history, ignore rules, and `watch`, including bursts of 200 files.
