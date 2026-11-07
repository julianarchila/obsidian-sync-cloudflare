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
const PLAIN_META = JSON.stringify({ format: PLAIN_FORMAT });

export class VaultFormatError extends Data.TaggedError("VaultFormatError")<{ readonly message: string }> {}

export const isPlainMeta = (meta: string | null) => {
  if (meta === null) return false;
  try {
    return (JSON.parse(meta) as { format?: unknown }).format === PLAIN_FORMAT;
  } catch {
    return false;
  }
};

/** Open the vault, creating it (as plain) if it doesn't exist. Returns whether it was created. */
export const openPlainVault = (remote: RemoteShape): Effect.Effect<{ created: boolean }, VaultFormatError | RemoteError> =>
  Effect.gen(function* () {
    const result = yield* remote.meta(PLAIN_META);
    if (!isPlainMeta(result.meta))
      return yield* new VaultFormatError({
        message: "This vault uses a format this version doesn't support (for example, it was created by an encrypted version before 0.3). Use a new vault id.",
      });
    return { created: result.created };
  });
