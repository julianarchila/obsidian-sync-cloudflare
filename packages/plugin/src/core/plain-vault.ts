/**
 * Vault format check. The vault meta on the server records the format: a
 * new vault is marked `plain-v1` by the first device. A vault in any other
 * format (such as one left by the end-to-end encrypted versions before 0.3)
 * is refused rather than mixed.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { RemoteError, RemoteShape } from "./services.ts";

export const PLAIN_FORMAT = "plain-v1";

export class VaultFormatError extends Data.TaggedError("VaultFormatError")<{ readonly message: string }> {}

export const isPlainMeta = (meta: string | null) => {
  if (meta === null) return false;
  try {
    return (JSON.parse(meta) as { format?: unknown }).format === PLAIN_FORMAT;
  } catch {
    return false;
  }
};

/** A vault's unique id, set when it is created ("" for vaults made before ids existed). */
const idOf = (meta: string) => {
  const id = (JSON.parse(meta) as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
};

/**
 * Open the vault, creating it (as plain, with a fresh id) if it doesn't exist.
 * The id tells devices when a vault id names a vault that was deleted and
 * created again, so they drop their saved state for the old one.
 */
export const openPlainVault = (
  remote: RemoteShape,
): Effect.Effect<{ created: boolean; instance: string }, VaultFormatError | RemoteError> =>
  Effect.gen(function* () {
    const result = yield* remote.meta(JSON.stringify({ format: PLAIN_FORMAT, id: crypto.randomUUID() }));
    if (result.meta === null || !isPlainMeta(result.meta))
      return yield* new VaultFormatError({
        message:
          "This vault uses a format this version doesn't support (for example, it was created by an encrypted version before 0.3). Use a new vault id, or delete this one (scripts/delete-vault.ts).",
      });
    return { created: result.created, instance: idOf(result.meta) };
  });
