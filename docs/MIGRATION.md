# Migrating from an encrypted vault

Versions up to 0.2.x encrypted every vault end to end with a vault password. Later versions store vaults unencrypted (`plain-v1`), so agents can reach your notes through the CLI and the MCP endpoint. The two formats don't mix: the new plugin refuses an encrypted vault ("This vault was created with end-to-end encryption…"), and you move to a **new vault id**.

Your notes are already in plain text on every device, so nothing has to be decrypted: the first device uploads them to the new vault and the others join it. What doesn't carry over is the old vault's version history and deleted-file list. They stay readable in the old vault until you remove it.

## Steps

1. **Back up.** Copy your vault folder somewhere safe (with its `.obsidian` folder).
2. **Verify the old vault (optional).** Check that your device matches what the server holds, using the old password or a device's `data.json` (it holds the remembered key):

   ```sh
   bun scripts/verify-restore.ts <old-vault-id> <path-to-your-vault> <password-file>
   ```

3. **Deploy the new version:** `bun run deploy`.
4. **Update the plugin on every device** (BRAT updates it, or copy the new release). On load it removes the old remembered key from its settings.
5. **On the device with the most complete copy,** open *Settings → Homebase*, set a **new vault id** (for example `personal-2`) and press *Save & connect*. It creates the vault and uploads everything. Wait until the status shows `☁ synced`.
6. **On each other device,** set the same new vault id. Files identical to the server's are adopted without a transfer, files only this device has are uploaded, and a file that differs from the server's is kept twice: the server's version at its path and this device's as a conflict copy. Bring every device up to date with the old vault before switching to keep that to zero.
7. **Agents:** point the CLI (`homebase init … --vault personal-2`) and MCP connectors (`/mcp/personal-2`) at the new id.

Do the switch with every device on the new version. A device still running an old version keeps syncing the old vault, and the two drift apart.

## Afterwards

The old vault's data (its index in the Durable Object and its encrypted chunks in R2) is no longer used. It costs only storage. There is no per-vault delete command yet; `bun run destroy` removes the whole deployment, so don't use it for this.
