/**
 * Publish a plugin release on GitHub (installable with BRAT or manually).
 *
 *   bun run release          # releases the version in manifest.json
 *   bun run release 0.2.0    # bumps manifest.json + versions.json first (commit the bump yourself)
 *
 * Obsidian/BRAT conventions: the tag equals the manifest version (no "v"),
 * and the release carries main.js, manifest.json and styles.css.
 */
import { $ } from "bun";

const manifestPath = "manifest.json";
const manifest = await Bun.file(manifestPath).json();
const next = process.argv[2];

if (next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`Invalid version: ${next}`);
  manifest.version = next;
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const versions = await Bun.file("versions.json").json();
  versions[next] = manifest.minAppVersion;
  await Bun.write("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`Bumped to ${next}. Commit and push manifest.json + versions.json, then run \`bun run release\`.`);
  process.exit(0);
}

const version: string = manifest.version;
if ((await $`git status --porcelain`.text()).trim()) throw new Error("Working tree is not clean.");
if ((await $`git rev-parse --abbrev-ref HEAD`.text()).trim() !== "main") throw new Error("Release from main.");
await $`git fetch -q origin main`;
if ((await $`git rev-parse HEAD`.text()) !== (await $`git rev-parse origin/main`.text()))
  throw new Error("Local main is not in sync with origin/main.");
if ((await $`git tag -l ${version}`.text()).trim()) throw new Error(`Tag ${version} already exists. Bump the version.`);

await $`bun run check`;
await $`bun run plugin:build`;
await $`gh release create ${version} packages/plugin/dist/main.js manifest.json packages/plugin/styles.css --title ${`Homebase ${version}`} --generate-notes`;
console.log(`Released ${version}.`);
