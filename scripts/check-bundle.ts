/**
 * Bundle guard for the Obsidian plugin (docs/SCOPE.md):
 *  - Effect may only be imported by module (`effect/Effect`), never from the
 *    `effect` barrel, which defeats tree-shaking (about +75 KB).
 *  - The minified bundle must stay under the budget.
 */
import { Glob } from "bun";

const BUDGET_BYTES = 150 * 1024;
const roots = ["packages/plugin/src", "packages/protocol/src"];

let failed = false;
for (const root of roots)
  for await (const file of new Glob("**/*.ts").scan(root)) {
    const source = await Bun.file(`${root}/${file}`).text();
    if (/from\s+["']effect["']/.test(source)) {
      console.error(`✗ ${root}/${file} imports from the "effect" barrel; import the module instead (effect/Effect, ...)`);
      failed = true;
    }
  }

const result = await Bun.$`node esbuild.config.mjs`.cwd("packages/plugin").quiet().nothrow();
if (result.exitCode !== 0) {
  console.error(result.stderr.toString());
  process.exit(1);
}
const size = Bun.file("packages/plugin/dist/main.js").size;
const ok = size <= BUDGET_BYTES;
console.log(`${ok ? "✓" : "✗"} plugin bundle ${(size / 1024).toFixed(1)} KB (budget ${BUDGET_BYTES / 1024} KB)`);
if (!ok || failed) process.exit(1);
