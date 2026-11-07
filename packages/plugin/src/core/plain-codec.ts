/**
 * No-encryption codec: path ids are the paths and metadata is JSON.
 *
 * Metadata is not authenticated, so it must agree with the path id the
 * server indexes: a mismatch (or a path escaping the vault) is rejected
 * rather than written somewhere unexpected.
 */
import * as Effect from "effect/Effect";

import { CodecError, type CodecShape, type FileMeta } from "./services.ts";

/** Relative, no `..`/`.`/empty segments, no NUL or backslash. */
export const isSafePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/[\\\0]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export const plainCodec: CodecShape = {
  pathId: (path) => Effect.succeed(path),
  sealMeta: (_pathId, meta) => Effect.succeed(JSON.stringify(meta)),
  openMeta: (pathId, sealed) =>
    Effect.try({
      try: () => JSON.parse(sealed) as FileMeta,
      catch: () => new CodecError({ message: "Invalid metadata" }),
    }).pipe(
      Effect.filterOrFail(
        (meta) => typeof meta?.path === "string" && meta.path === pathId && isSafePath(meta.path),
        () => new CodecError({ message: `Metadata does not match its path: ${pathId}` }),
      ),
    ),
  sealChunk: (plain) => Effect.succeed(plain),
  openChunk: (sealed) => Effect.succeed(sealed),
};
