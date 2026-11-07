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
homebase restore-deleted Archive ~/vault  # every deleted file under a folder
cd ~/vault/Notes && homebase mv idea.md ../Projects/idea.md   # move and update [[links]]
```

File arguments are relative to the current directory (or absolute). Without a `[dir]`, commands find the synced folder by looking upward from the current directory, like git.

`homebase mv` moves a file and rewrites links to it in other notes: `[[wikilinks]]` by name or path, with `#heading`, `|alias` and `![[embeds]]`, and Markdown links (vault paths, paths relative to the note, `/rooted` paths, `#anchors`, `<angle brackets>`). The moved note's own relative links are re-pointed from its new folder. Links inside code are left alone. Pass `--no-links` to skip all of that. A plain `mv` also syncs as a move, but leaves links alone. Moves keep the file's history, also when the file was edited in the same pass (same file name in another folder).

`init` writes `<dir>/.homebase/config.json` (server URL, vault id, device name). The token is never stored there: it is read from `$OSCF_TOKEN` at run time, from another variable (`--token-env NAME`), or from a file (`--token-file PATH`). Sync state lives in `<dir>/.homebase/state.json`.

Never synced:
- hidden files and folders (anything starting with `.`), as in Obsidian: `.homebase/`, `.obsidian/`, `.git/`, `.vscode/`, `.DS_Store`, editor locks;
- common junk: `node_modules/`, `__pycache__/`, `*.tmp`, `*.orig`, `*.swp`, `*~`, `Thumbs.db`, …;
- anything in `<dir>/.homebaseignore`, one gitignore-like pattern per line (`*`, `**`, `?`, a trailing `/` for folders, a leading `/` to anchor at the root). `init` creates an empty one. It is local to this folder, and `watch` reloads it when it changes.

Ignoring a path that already synced stops syncing it in both directions: the local file stays, the server keeps its last version (other devices still have it), and later edits on either side don't travel.

Files are written atomically (temp file, then rename). A damaged `state.json` stops the CLI instead of starting over (which could bring back files deleted elsewhere); move it away to resync from scratch.

## How `watch` works

- Listens to the vault's WebSocket and pulls only when the server announces a newer change.
- Watches the folder. Any file event triggers a scan of the whole folder after a 1 s debounce. The scan only stats unchanged files and makes no request unless something changed. Events alone aren't enough: on macOS, Bun reports only a few paths for a burst of writes or deletes.
- Rescans every 5 minutes as a safety net. Reconnects with backoff, and after sleep. A failed sync is retried with backoff (5 s up to 5 min).
- If the server isn't reachable at start (boot, network down), it waits and retries instead of exiting.
- If the folder can't be watched (on Linux, the inotify watch limit: one watch per folder), it logs how to raise the limit and scans every 10 s instead. To raise it: `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-inotify.conf && sudo sysctl --system`.
- On SIGINT or SIGTERM it pushes pending edits, then exits.
- Each change scans the whole folder (stat only, in parallel): about 1 s end to end on a small vault, about 2.3 s with 20k files.

## systemd

```ini
# ~/.config/systemd/user/homebase.service
[Unit]
Description=Homebase sync for ~/vault

[Service]
# Absolute paths: user units don't get your shell's PATH. Use the output of `command -v bun`.
ExecStart=/home/me/.bun/bin/bun /home/me/homebase/packages/cli/src/main.ts watch /home/me/vault
EnvironmentFile=/home/me/.config/homebase/env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Put `OSCF_TOKEN=…` in `~/.config/homebase/env` (mode 600). Then run `systemctl --user enable --now homebase`, and `loginctl enable-linger $USER` so it keeps running without a login session. Logs: `journalctl --user -u homebase -f`. On machines where users have very large UIDs (e.g. GCP OS Login), journald stores user-unit logs in the system journal: use `sudo journalctl _SYSTEMD_USER_UNIT=homebase.service -f`, or add yourself to the `systemd-journal` group.

The unit has no network dependency on purpose (`network-online.target` doesn't exist for user units): `watch` waits for the server itself.

## Testing

`bun scripts/cli-e2e.ts` (from the repo root, with `bun run dev` running) drives two folders on a fresh `e2e-cli-*` vault. It covers one-shot sync, merge, conflicts, binaries, history, ignore rules, and `watch`, including bursts of 200 files.
