/**
 * No-encryption codec: path ids are the paths and metadata is JSON. Used by
 * tests and as the baseline before end-to-end encryption (crypto-codec.ts).
 */
import * as Effect from "effect/Effect";

import { CodecError, type CodecShape, type FileMeta } from "./services.ts";

export const plainCodec: CodecShape = {
  pathId: (path) => Effect.succeed(path),
  sealMeta: (_pathId, meta) => Effect.succeed(JSON.stringify(meta)),
  openMeta: (_pathId, sealed) =>
    Effect.try({
      try: () => JSON.parse(sealed) as FileMeta,
      catch: () => new CodecError({ message: "Invalid metadata" }),
    }),
  sealChunk: (plain) => Effect.succeed(plain),
  openChunk: (sealed) => Effect.succeed(sealed),
};
