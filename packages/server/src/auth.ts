import * as Redacted from "effect/Redacted";

/**
 * Bearer token from the `Authorization` header, or `?token=` for WebSocket
 * upgrades (browser/Electron WebSockets cannot set headers).
 */
export const readToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return new URL(request.url).searchParams.get("token") ?? undefined;
};

/** Constant-time string comparison. */
export const safeEqual = (a: string, b: string) => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
};

export const isAuthorized = (request: Request, secret: Redacted.Redacted<string>) => {
  const token = readToken(request);
  return token !== undefined && safeEqual(token, Redacted.value(secret));
};
