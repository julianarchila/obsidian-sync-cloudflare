// alchemy.run.ts reads a few env vars at deploy time (Bun provides process).
declare var process: { env: Record<string, string | undefined> };
