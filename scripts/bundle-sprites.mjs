// Downloads the PokeAPI front sprites the extension needs into assets/sprites/.
// Sprite id = each creature's base National-Dex form (variants reuse the base
// looktype). Run via `node scripts/bundle-sprites.mjs` or the refresh script.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPRITE_URL = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

export function neededSpriteIds() {
  const creatures = JSON.parse(readFileSync(join(root, "data", "creatures.json"), "utf8")).creatures;
  const looktypeToBase = {};
  for (const c of creatures) {
    if (c.pokeId <= 1025 && c.looktype != null) {
      if (looktypeToBase[c.looktype] == null || c.pokeId < looktypeToBase[c.looktype]) looktypeToBase[c.looktype] = c.pokeId;
    }
  }
  const ids = new Set();
  for (const c of creatures) ids.add((c.looktype != null && looktypeToBase[c.looktype]) || c.pokeId);
  return [...ids].sort((a, b) => a - b);
}

export async function bundleSprites({ force = false } = {}) {
  const dir = join(root, "assets", "sprites");
  mkdirSync(dir, { recursive: true });
  const ids = neededSpriteIds();
  let downloaded = 0, skipped = 0, missing = 0;

  // modest concurrency to be gentle on the source
  const queue = ids.slice();
  async function worker() {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const out = join(dir, id + ".png");
      if (!force && existsSync(out)) { skipped++; continue; }
      try {
        const r = await fetch(SPRITE_URL(id));
        if (!r.ok) { missing++; continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(out, buf);
        downloaded++;
      } catch { missing++; }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`sprites: ${ids.length} needed | downloaded ${downloaded}, cached ${skipped}, unavailable ${missing}`);
  return { needed: ids.length, downloaded, skipped, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes("--force");
  bundleSprites({ force }).catch((e) => { console.error(e); process.exit(1); });
}
