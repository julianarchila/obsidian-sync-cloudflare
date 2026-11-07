/**
 * Per-file metadata stored with each server entry (`Entry.meta`): JSON with
 * the path, content hash, size and mtime. Entries are keyed by the path itself.
 *
 * Metadata is not authenticated, so it must agree with the path the server
 * indexes: a mismatch (or a path escaping the vault) is rejected rather than
 * written somewhere unexpected.
 */
import * as Effect from "effect/Effect";

import { type FileMeta, MetaError } from "./services.ts";

/** Relative, no `..`/`.`/empty segments, no NUL or backslash. */
export const isSafePath = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/[\\\0]/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export const encodeMeta = (meta: FileMeta) => JSON.stringify(meta);

export const decodeMeta = (path: string, raw: string): Effect.Effect<FileMeta, MetaError> =>
  Effect.try({
    try: () => JSON.parse(raw) as FileMeta,
    catch: () => new MetaError({ message: "Invalid metadata" }),
  }).pipe(
    Effect.filterOrFail(
      (meta) => typeof meta?.path === "string" && meta.path === path && isSafePath(meta.path),
      () => new MetaError({ message: `Metadata does not match its path: ${path}` }),
    ),
  );
