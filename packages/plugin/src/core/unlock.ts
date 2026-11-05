/**
 * Unlock (or create) a vault's encryption before any sync, and change its password.
 *
 *  - New vault: a random vault key is created and wrapped with the password (first device wins).
 *  - Existing vault: the password unwraps the vault key, or a remembered vault key is verified.
 *  - Password change: the same vault key is re-wrapped; no data is re-encrypted and other
 *    devices that remember the key keep working.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { createVault, openVault, parseVaultRecord, verifyMasterKey, wrapVaultKey } from "./crypto-codec.ts";
import type { RemoteError, RemoteShape } from "./services.ts";

export class UnlockError extends Data.TaggedError("UnlockError")<{
  readonly reason: "NeedPassword" | "WrongPassword" | "BadRecord";
  readonly isNewVault: boolean;
}> {}

export interface Unlocked {
  /** The vault key (what the codec and the "remember key" option use). */
  readonly master: Uint8Array;
  readonly created: boolean;
}

export const unlockVault = (
  remote: RemoteShape,
  input: { readonly password?: string; readonly rememberedKey?: Uint8Array; readonly iterations?: number },
): Effect.Effect<Unlocked, UnlockError | RemoteError> =>
  Effect.gen(function* () {
    const existing = yield* remote.meta();

    if (existing.meta === null) {
      if (!input.password) return yield* new UnlockError({ reason: "NeedPassword", isNewVault: true });
      const { vaultKey, record } = yield* createVault(input.password, input.iterations);
      const result = yield* remote.meta(JSON.stringify(record));
      if (result.created) return { master: vaultKey, created: true };
      // Another device created the vault at the same moment: unlock theirs instead.
      return yield* unlockVault(remote, input);
    }

    const record = parseVaultRecord(existing.meta);
    if (record === null) return yield* new UnlockError({ reason: "BadRecord", isNewVault: false });

    if (input.rememberedKey && (yield* verifyMasterKey(input.rememberedKey, record)))
      return { master: input.rememberedKey, created: false };
    if (!input.password) return yield* new UnlockError({ reason: "NeedPassword", isNewVault: false });

    const vaultKey = yield* openVault(input.password, record);
    if (vaultKey === null) return yield* new UnlockError({ reason: "WrongPassword", isNewVault: false });
    return { master: vaultKey, created: false };
  });

export class PasswordChangeError extends Data.TaggedError("PasswordChangeError")<{
  readonly reason: "WrongKey" | "BadRecord" | "Concurrent";
}> {}

/** Re-wrap the vault key with a new password (atomic on the server). */
export const changeVaultPassword = (
  remote: RemoteShape,
  vaultKey: Uint8Array,
  newPassword: string,
  iterations?: number,
): Effect.Effect<void, PasswordChangeError | RemoteError> =>
  Effect.gen(function* () {
    const { meta } = yield* remote.meta();
    const record = meta === null ? null : parseVaultRecord(meta);
    if (meta === null || record === null) return yield* new PasswordChangeError({ reason: "BadRecord" });
    if (!(yield* verifyMasterKey(vaultKey, record))) return yield* new PasswordChangeError({ reason: "WrongKey" });
    const next = yield* wrapVaultKey(vaultKey, newPassword, iterations);
    const result = yield* remote.replaceMeta(meta, JSON.stringify(next));
    if (!result.replaced) return yield* new PasswordChangeError({ reason: "Concurrent" });
  });
