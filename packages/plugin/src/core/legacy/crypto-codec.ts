/**
 * LEGACY: Homebase no longer encrypts vaults. This codec only remains so the
 * restore drill (scripts/verify-restore.ts) can read vaults created by the
 * older, end-to-end encrypted versions before they are migrated
 * (docs/MIGRATION.md). The plugin and CLI never import it.
 *
 * End-to-end encryption (M1). The server only ever sees:
 *   - path ids:  HMAC-SHA256(K_path, path)              (stable, opaque)
 *   - metadata:  AES-256-GCM(K_meta, json, aad=pathId)  (random nonce; bound to its path)
 *   - chunks:    AES-256-GCM(K_data, padded chunk)      (nonce = HMAC(K_nonce, chunk): deterministic,
 *                                                         so identical chunks dedupe; sizes padded to 4 KiB)
 *
 * Keys (key wrapping, so the password can change without re-encrypting anything):
 *   vault key  = 32 random bytes, created once per vault -> HKDF-SHA256 subkeys per purpose
 *   wrapping   = AES-256-GCM(KEK, vault key), KEK = PBKDF2-SHA256(password, salt, 600k)
 * The vault record on the server holds the salt, the iteration count, the
 * wrapped vault key and a check value sealed with the vault key (lets a
 * remembered key be verified without the password).
 */
import * as Aead from "effect/crypto/Aead";
import * as Kdf from "effect/crypto/Kdf";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { concat, decodeText, encodeText, toHex } from "../bytes.ts";
import { CodecError, type CodecShape, type FileMeta } from "../services.ts";

export const PBKDF2_ITERATIONS = 600_000;
const PAD_TO = 4096;
const CHUNK_AAD = encodeText("oscf-chunk-v1");
const CHECK_PLAINTEXT = "oscf-vault-check-v1";

/** Stored per vault on the server (`/meta`). Contains nothing usable without the password. */
export interface VaultRecord {
  readonly v: 2;
  readonly kdf: "pbkdf2-sha256";
  readonly iterations: number;
  readonly salt: string;
  /** AES-GCM(KEK, vault key). */
  readonly wrapped: string;
  /** AES-GCM(K_check, CHECK_PLAINTEXT) under the vault key. */
  readonly check: string;
}

export const cryptoLayer = Layer.mergeAll(Kdf.layerWebCrypto, Aead.layerWebCrypto, Mac.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

const b64 = (bytes: Uint8Array) => Base64.encode(bytes);
const unb64 = (text: string): Effect.Effect<Uint8Array, CodecError> => {
  const decoded = Base64.decode(text);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(new CodecError({ message: "Invalid base64" }));
};

const normalizePassword = (password: string) => encodeText(password.normalize("NFKC"));

/** PBKDF2: slow on purpose. Returns the 32-byte key-encryption key (KEK). */
export const deriveMasterKey = (password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS) =>
  Effect.gen(function* () {
    const kdf = yield* Kdf.Kdf;
    return yield* kdf.derive(Kdf.pbkdf2({ hash: Kdf.pbkdf2Sha256.hash, iterations }), normalizePassword(password), {
      salt,
      length: 32,
    });
  }).pipe(Effect.provide(cryptoLayer), Effect.orDie);

interface Keys {
  readonly path: Mac.Key;
  readonly nonce: Mac.Key;
  readonly meta: Aead.Key;
  readonly data: Aead.Key;
  readonly check: Aead.Key;
}

const subkeys = (master: Uint8Array) =>
  Effect.gen(function* () {
    const kdf = yield* Kdf.Kdf;
    const derive = (info: string) =>
      kdf.derive(Kdf.hkdfSha256, master, { salt: new Uint8Array(32), length: 32, info: encodeText(`oscf/${info}`) });
    return {
      path: yield* Mac.key(Mac.hmacSha256, yield* derive("path")),
      nonce: yield* Mac.key(Mac.hmacSha256, yield* derive("nonce")),
      meta: yield* Aead.key(Aead.aes256Gcm, yield* derive("meta")),
      data: yield* Aead.key(Aead.aes256Gcm, yield* derive("data")),
      check: yield* Aead.key(Aead.aes256Gcm, yield* derive("check")),
    } satisfies Keys;
  });

const sealWith = (key: Aead.Key, plain: Uint8Array, aad: Uint8Array, nonce?: Uint8Array) =>
  Effect.gen(function* () {
    const aead = yield* Aead.Aead;
    const random = yield* SecureRandom.SecureRandom;
    const n = nonce ?? (yield* random.randomBytes(12));
    return concat([n, yield* aead.encrypt(key, plain, { nonce: n, aad })]);
  });

const openWith = (key: Aead.Key, sealed: Uint8Array, aad: Uint8Array) =>
  Effect.gen(function* () {
    if (sealed.byteLength < 12 + 16) return yield* new CodecError({ message: "Ciphertext too short" });
    const aead = yield* Aead.Aead;
    return yield* aead
      .decrypt(key, sealed.subarray(12), { nonce: sealed.subarray(0, 12), aad })
      .pipe(Effect.mapError(() => new CodecError({ message: "Decryption failed (wrong key or tampered data)" })));
  });

const WRAP_AAD = encodeText("oscf-vault-key-v2");
const CHECK_AAD = encodeText("check");

const randomBytes = (n: number) =>
  Effect.gen(function* () {
    return yield* (yield* SecureRandom.SecureRandom).randomBytes(n);
  }).pipe(Effect.provide(SecureRandom.layerWebCrypto));

export const randomSalt = randomBytes(16);

/** Record for `vaultKey` protected by `password` (new vault, or a password change). */
export const wrapVaultKey = (vaultKey: Uint8Array, password: string, iterations = PBKDF2_ITERATIONS) =>
  Effect.gen(function* () {
    const salt = yield* randomSalt;
    const kek = yield* Aead.key(Aead.aes256Gcm, yield* deriveMasterKey(password, salt, iterations));
    const wrapped = yield* sealWith(kek, vaultKey, WRAP_AAD);
    const keys = yield* subkeys(vaultKey);
    const check = yield* sealWith(keys.check, encodeText(CHECK_PLAINTEXT), CHECK_AAD);
    return {
      v: 2,
      kdf: "pbkdf2-sha256",
      iterations,
      salt: b64(salt),
      wrapped: b64(wrapped),
      check: b64(check),
    } satisfies VaultRecord;
  }).pipe(Effect.provide(cryptoLayer), Effect.orDie);

/** A brand-new vault: random vault key, wrapped with the password. */
export const createVault = (password: string, iterations = PBKDF2_ITERATIONS) =>
  Effect.gen(function* () {
    const vaultKey = yield* randomBytes(32);
    return { vaultKey, record: yield* wrapVaultKey(vaultKey, password, iterations) };
  });

/** Unwrap the vault key with a password; null when the password is wrong. */
export const openVault = (password: string, record: VaultRecord) =>
  Effect.gen(function* () {
    const salt = yield* unb64(record.salt).pipe(Effect.option);
    const wrapped = yield* unb64(record.wrapped).pipe(Effect.option);
    if (salt._tag === "None" || wrapped._tag === "None") return null;
    const kek = yield* Aead.key(Aead.aes256Gcm, yield* deriveMasterKey(password, salt.value, record.iterations)).pipe(
      Effect.orDie,
    );
    const key = yield* openWith(kek, wrapped.value, WRAP_AAD).pipe(Effect.option);
    return key._tag === "Some" && key.value.byteLength === 32 ? key.value : null;
  }).pipe(Effect.provide(cryptoLayer));

/** Is this the vault key of `record`? (For keys remembered on a device.) */
export const verifyMasterKey = (vaultKey: Uint8Array, record: VaultRecord) =>
  Effect.gen(function* () {
    const keys = yield* subkeys(vaultKey).pipe(Effect.orDie);
    const sealed = yield* unb64(record.check).pipe(Effect.option);
    if (sealed._tag === "None") return false;
    const opened = yield* openWith(keys.check, sealed.value, CHECK_AAD).pipe(Effect.option);
    return opened._tag === "Some" && decodeText(opened.value) === CHECK_PLAINTEXT;
  }).pipe(Effect.provide(cryptoLayer));

export const parseVaultRecord = (text: string): VaultRecord | null => {
  try {
    const record = JSON.parse(text) as VaultRecord;
    return record.v === 2 && record.kdf === "pbkdf2-sha256" && typeof record.wrapped === "string" ? record : null;
  } catch {
    return null;
  }
};

/** The encrypting codec for an unlocked vault. */
export const makeCryptoCodec = (master: Uint8Array) =>
  Effect.gen(function* () {
    const keys = yield* subkeys(master);
    const mac = yield* Mac.Mac;
    const services = yield* Effect.context<Aead.Aead | SecureRandom.SecureRandom>();
    const run = <A, E>(effect: Effect.Effect<A, E, Aead.Aead | SecureRandom.SecureRandom>) =>
      effect.pipe(Effect.provideContext(services));

    const pathIds = new Map<string, string>();

    const codec: CodecShape = {
      pathId: (path) =>
        Effect.gen(function* () {
          const cached = pathIds.get(path);
          if (cached) return cached;
          const id = toHex(yield* mac.sign(keys.path, encodeText(path.normalize("NFC"))));
          pathIds.set(path, id);
          return id;
        }).pipe(Effect.orDie),

      sealMeta: (pathId, meta) =>
        run(sealWith(keys.meta, encodeText(JSON.stringify(meta)), encodeText(pathId))).pipe(Effect.map(b64), Effect.orDie),

      openMeta: (pathId, sealed) =>
        Effect.gen(function* () {
          const plain = yield* run(openWith(keys.meta, yield* unb64(sealed), encodeText(pathId)));
          return JSON.parse(decodeText(plain)) as FileMeta;
        }),

      sealChunk: (plain) =>
        Effect.gen(function* () {
          const padded = new Uint8Array(Math.ceil((plain.byteLength + 4) / PAD_TO) * PAD_TO);
          new DataView(padded.buffer).setUint32(0, plain.byteLength);
          padded.set(plain, 4);
          const nonce = (yield* mac.sign(keys.nonce, plain)).subarray(0, 12);
          return yield* run(sealWith(keys.data, padded, CHUNK_AAD, nonce));
        }).pipe(Effect.orDie),

      openChunk: (sealed) =>
        Effect.gen(function* () {
          const padded = yield* run(openWith(keys.data, sealed, CHUNK_AAD));
          const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
          if (length > padded.byteLength - 4) return yield* new CodecError({ message: "Bad chunk length" });
          return padded.slice(4, 4 + length);
        }),
    };
    return codec;
  }).pipe(Effect.provide(cryptoLayer), Effect.orDie);
