import * as Effect from "effect/Effect";

export const toHex = (bytes: Uint8Array) => {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
};

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

export const sha256 = (bytes: Uint8Array) =>
  Effect.promise(async () => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", asBuffer(bytes)))));

export const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const split = (bytes: Uint8Array, size: number): Uint8Array[] => {
  if (bytes.byteLength === 0) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) out.push(bytes.subarray(i, i + size));
  return out;
};

export const encodeText = (text: string) => new TextEncoder().encode(text);
export const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
