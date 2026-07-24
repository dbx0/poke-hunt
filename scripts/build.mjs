// Produce a distributable build: minify the JS with terser into dist/, copy the
// static assets verbatim, and zip it as poke-hunt-<version>.zip.
// Run: `npm run build`. The clean source stays in the repo; the zip ships minified.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ver = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;

console.log("Building Poke Hunt v" + ver + " ...");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1) minify the three scripts with terser
const JS = ["content.js", "engine.js", "inject.js"];
for (const f of JS) {
  execSync(`npx --yes terser "${join(root, f)}" --compress --mangle -o "${join(dist, f)}"`, { stdio: "inherit" });
}

// 2) copy everything the extension ships verbatim
cpSync(join(root, "manifest.json"), join(dist, "manifest.json"));
for (const d of ["ui", "data", "assets"]) {
  if (existsSync(join(root, d))) cpSync(join(root, d), join(dist, d), { recursive: true });
}

// 3) zip the dist contents (entries relative to dist/, so manifest.json is at the root)
const out = join(root, `poke-hunt-${ver}.zip`);
rmSync(out, { force: true });
execSync(`cd "${dist}" && zip -r -X "${out}" . -x '*.DS_Store' >/dev/null`, { stdio: "inherit" });

const rawKB = (n) => (n / 1024).toFixed(0) + "kB";
const src = JS.reduce((a, f) => a + readFileSync(join(root, f)).length, 0);
const min = JS.reduce((a, f) => a + readFileSync(join(dist, f)).length, 0);
console.log(`\nMinified JS: ${rawKB(src)} -> ${rawKB(min)}`);
console.log("Built: " + out);
