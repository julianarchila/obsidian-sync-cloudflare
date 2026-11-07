/**
 * Vault format check (no end-to-end encryption).
 *
 * The vault meta on the server records the format. A new vault is marked
 * `plain-v1` by the first device. A vault created by an older, encrypted build
 * holds a key-wrapping record instead: refuse it rather than mixing formats.
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
        message: "This vault was created with end-to-end encryption, which this version no longer supports. Use a new vault id.",
      });
    return { created: result.created };
  });
