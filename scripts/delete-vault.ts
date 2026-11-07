/**
 * Delete a whole vault on the server: its change log, history, search index
 * and every stored blob. Devices keep their local files. The id can be used
 * again afterwards; devices that connect to the new vault notice it is a
 * different one and join it from scratch.
 *
 *   bun scripts/delete-vault.ts <vault-id> --yes
 *
 * Uses OSCF_URL and OSCF_TOKEN. There is no undo.
 */
const [vaultId, flag] = process.argv.slice(2);
if (!vaultId || flag !== "--yes") {
  console.error("usage: bun scripts/delete-vault.ts <vault-id> --yes   (deletes the vault and its history for good)");
  process.exit(1);
}
const serverUrl = process.env.OSCF_URL;
const token = process.env.OSCF_TOKEN;
if (!serverUrl || !token) throw new Error("OSCF_URL and OSCF_TOKEN are required");

const id = encodeURIComponent(vaultId);
const response = await fetch(`${serverUrl}/v1/vaults/${id}/destroy?confirm=${id}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
console.log(response.status, await response.text());
process.exit(response.ok ? 0 : 1);
