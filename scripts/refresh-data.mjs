// Refresh the extension's bundled data from the live sources, bump the data
// version, and download any new sprites. Run: `node scripts/refresh-data.mjs`.
//
// Sources:
//   game  https://poke.idleworld.online/game/creatures.json    -> data/creatures.json
//   game  https://poke.idleworld.online/game/items.json        -> data/items.json
//   game  https://poke.idleworld.online/api/game/map-markers   -> data/hunts.json  (.hunts)
//   piw   https://piwtools.vercel.app/calculator (index-*.js)   -> data/speeds.json (eC)
//                                                                 data/typechart.json (aC)
//                                                                 data/clans.json (Uv)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bundleSprites } from "./bundle-sprites.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = "https://poke.idleworld.online";
const PIW = "https://piwtools.com.br";
const dataPath = (f) => join(root, "data", f);
const writeJson = (f, obj) => writeFileSync(dataPath(f), JSON.stringify(obj));

async function getText(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " HTTP " + r.status); return r.text(); }
async function getJson(u) { return JSON.parse(await getText(u)); }

// balanced-slice a {…} or […] literal starting at `open`, then eval it
function balancedFrom(src, open) {
  const o = src[open], c = o === "{" ? "}" : "]";
  let depth = 0, j = open;
  for (; j < src.length; j++) { const ch = src[j]; if (ch === o) depth++; else if (ch === c && --depth === 0) { j++; break; } }
  return new Function("return (" + src.slice(open, j) + ")")();
}

// Content-anchored extractors (minified var names change per PIW build, so we
// locate each dataset by the shape of its contents instead of its variable).
function extractSpeeds(src) {
  const p = src.indexOf("hit1:");                 // per-creature entry key
  if (p < 0) throw new Error("speeds: no hit1: key");
  const inner = src.lastIndexOf("{", p);          // opening brace of the first entry
  let k = inner - 1;
  while (/\s/.test(src[k])) k--;
  if (src[k] !== ":") throw new Error("speeds: unexpected shape");
  k--;
  while (k >= 0 && /[\w"']/.test(src[k])) k--;     // skip the numeric/quoted key
  while (/\s/.test(src[k])) k--;
  if (src[k] !== "{") throw new Error("speeds: outer object not found");
  return balancedFrom(src, k);
}
function extractTypechart(src) {
  const p = src.indexOf("NORMAL:{ROCK:");          // type-chart signature
  if (p < 0) throw new Error("typechart: signature not found");
  return balancedFrom(src, src.lastIndexOf("{", p));
}
function extractClans(src) {
  const p = src.indexOf('id:"none"');              // first clan entry
  if (p < 0) throw new Error("clans: signature not found");
  return balancedFrom(src, src.lastIndexOf("[", p));
}

async function main() {
  console.log("Refreshing data...\n");

  // --- game-authoritative data ---
  const creatures = await getJson(GAME + "/game/creatures.json");
  writeJson("creatures.json", creatures);
  console.log("creatures.json <- /game/creatures.json (" + (creatures.creatures || creatures).length + ")");

  const items = await getJson(GAME + "/game/items.json");
  writeJson("items.json", items);
  console.log("items.json     <- /game/items.json (" + (items.items || items).length + ")");

  const markers = await getJson(GAME + "/api/game/map-markers");
  const hunts = markers.hunts || markers;
  writeJson("hunts.json", hunts);
  console.log("hunts.json     <- /api/game/map-markers (" + hunts.length + ")");

  // --- PIW calculator bundle (productivity table + type chart + clans) ---
  // piwtools is a third party and has gone unreliable/stale. If it can't be reached or
  // parsed, KEEP the existing bundled speeds/typechart/clans instead of crashing the
  // whole refresh — the game-authoritative data above is what matters most.
  let piwBundle = "kept-existing";
  try {
    const page = await getText(PIW + "/calculator");
    const asset = (page.match(/\/assets\/index-[A-Za-z0-9_]+\.js/) || [])[0];
    if (!asset) throw new Error("no bundle in /calculator");
    const bundle = await getText(PIW + asset);
    piwBundle = asset;
    console.log("PIW bundle     <- " + asset);
    const speeds = extractSpeeds(bundle);
    writeJson("speeds.json", speeds);
    console.log("speeds.json    <- productivity table (" + Object.keys(speeds).length + " creatures)");
    writeJson("typechart.json", extractTypechart(bundle));
    writeJson("clans.json", extractClans(bundle));
    console.log("typechart.json + clans.json updated from PIW");
  } catch (e) {
    console.log("PIW unavailable (" + e.message + ") — keeping existing speeds/typechart/clans");
  }

  // --- sprites (download any new ids) ---
  console.log("");
  await bundleSprites();

  // --- version + timestamp ---
  const files = ["creatures.json", "hunts.json", "items.json", "speeds.json", "typechart.json", "clans.json"];
  const hash = createHash("sha256");
  for (const f of files) hash.update(readFileSync(dataPath(f)));
  const version = hash.digest("hex").slice(0, 8);
  const meta = { version: version, updatedAt: new Date().toISOString().slice(0, 10), piwBundle: piwBundle };
  writeJson("meta.json", meta);
  console.log("\nmeta.json      -> version " + version + " (" + meta.updatedAt + ")");
  console.log("\nDone. If the version changed, bump manifest.json and reload the extension.");
}

main().catch((e) => { console.error("\nRefresh failed:", e.message); process.exit(1); });
