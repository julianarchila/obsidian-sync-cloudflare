import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as State from "alchemy/State";
import * as Effect from "effect/Effect";

import SyncWorker from "./packages/server/src/worker.ts";

export default Alchemy.Stack(
  "ObsidianSync",
  {
    providers: Cloudflare.providers(),
    // Default: state lives in your own Cloudflare account (a Durable Object), in a
    // dedicated store so it never conflicts with other Alchemy projects' store versions.
    // ALCHEMY_STATE=local keeps it in ./.alchemy instead (handy for `bun run dev`).
    state:
      process.env.ALCHEMY_STATE === "local"
        ? State.localState()
        : Cloudflare.state({
            workerName: "alchemy-state-store-obsidian-sync",
            // Optional (.env): pin the account so a login against another account can't deploy elsewhere.
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
          }),
  },
  Effect.gen(function* () {
    const worker = yield* SyncWorker;
    return { url: worker.url };
  }),
);
