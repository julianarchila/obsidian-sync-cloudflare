import builtins from "builtin-modules";
import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
// Set OBSIDIAN_VAULT=/path/to/vault to build straight into a test vault.
const outdir = process.env.OBSIDIAN_VAULT
  ? `${process.env.OBSIDIAN_VAULT}/.obsidian/plugins/homebase`
  : "dist";

await mkdir(outdir, { recursive: true });
// The manifest lives at the repo root (BRAT and the Obsidian directory read it there).
await copyFile("../../manifest.json", `${outdir}/manifest.json`);
await copyFile("styles.css", `${outdir}/styles.css`);

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  outfile: `${outdir}/main.js`,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  treeShaking: true,
  logLevel: "info",
});

if (watch) await context.watch();
else {
  await context.rebuild();
  await context.dispose();
}
