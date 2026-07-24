<p align="center">
  <img src="assets/pokehunt-logo.png" alt="Poke Hunt" width="440">
</p>

<p align="center">
  The smartest hunting, farming & capture companion for <a href="https://poke.idleworld.online/play">Poke Idle World</a>.
</p>

<p align="center">
  <a href="https://poke-hunt.com"><b>Download & install → poke-hunt.com</b></a>
</p>

---

**Poke Hunt** is a browser extension (Chrome & Firefox, Manifest V3) that adds a
button to the in-game dock. Click it and a panel opens that reads your **currently
active Pokémon** and tells you the best place to be — for XP, for money, for
catching a target — then teleports you there in one click.

Everything is computed locally from bundled game data. The extension is read-only
except for teleporting (which just triggers the game's own travel). No automation,
no economy writes, no data leaves your browser.

## Features

- **⚔ XP farm** — the best hunt for your active Pokémon right now, plus a full
  leveling plan (best hunt per level band up to the cap), ranked by XP/h.
- **💰 Loot farm** — the same, ranked by money/h from item sell prices.
- **🎯 Capture** — search any target and see which of *your* Pokémon catches it
  fastest (by type advantage + hits-to-kill), with quality-on-capture odds.
- **⭐ Favorites** — every teleport is tracked (including travel through the game's
  own map); star the hunts you farm most and jump back with one click.
- **Account-aware** — auto-detects and factors in **VIP** (+50% XP), active
  **boosts** (pokexp / loot), your **clan** (type-matched combat bonus), and the
  **Prestige Trainer Bonus**, shown as badges.
- **One-click Teleport / Switch & Go** — drives the game's own map travel, so
  player, enemies, combat and server state are all set up correctly.
- **Update notifications** — the panel tells you when a newer version is available.

## Install

Grab the latest build and setup guide (Chrome & Firefox) at **[poke-hunt.com](https://poke-hunt.com)**.

## How it works

The math is ported from the community piwtools calculator and verified against the
game's own formulas: enemy stats at hunt level → type-effectiveness damage →
hits-to-kill → a per-creature kills/hour productivity table → XP/h and money/h.
All game data is bundled, so calculations run fully offline; the extension only
talks to the game's own domain.

- **`inject.js`** (page world) — hooks the game's WebSocket to read live Pokémon
  data and observe hunt entries; bridges commands back for teleport.
- **`content.js`** (isolated world) — reads the active Pokémon from the DOM,
  injects the dock button, renders the panel (in a Shadow DOM so game CSS can't
  interfere), and drives teleports.
- **`engine.js`** — a pure, dependency-free routing/ranking engine (also unit-tested
  in Node).

## Layout

```
manifest.json      MV3 manifest (MAIN-world WS hook + isolated-world UI)
inject.js          page-world WebSocket hook + teleport bridge
content.js         active-poke reader, dock button, panel UI, teleport, favorites
engine.js          pure route / capture engine (ported, verified formulas)
ui/modal.css       panel styles (Shadow DOM, isolated from the game)
data/
  creatures.json   species stats, huntLevel, experience, loot, attacks
  hunts.json       hunt registry (slug, name, level, area)
  items.json       item sell prices (for loot $/h)
  speeds.json      per-creature kills/hour productivity table
  typechart.json   type-effectiveness matrix
  clans.json       clan roster (types + combat bonus by rank)
  meta.json        bundled-data version (shown in the panel)
assets/
  *.png            icons + logo
  sprites/*.png    bundled PokeAPI creature sprites (local, no external calls)
scripts/
  build.mjs          minify (terser) + zip a distributable build
  refresh-data.mjs   regenerate data/ from live sources + bump the data version
  bundle-sprites.mjs download the sprites the current data needs
test/              node test suite for the engine
```

## Development

```bash
npm test        # run the engine test suite
npm run build   # minify with terser + produce poke-hunt-<version>.zip
npm run refresh # refresh bundled game data after a game patch, then bump the version
```

`npm run refresh` pulls fresh data from the game's public endpoints
(`/game/creatures.json`, `/game/items.json`, `/api/game/map-markers`) and the
piwtools bundle, downloads any new sprites, and writes a new `data/meta.json`
version. Extraction is content-anchored (not tied to minified variable names), so
it survives upstream rebuilds and fails loudly rather than writing bad data.

## Privacy & scope

No data is collected, stored remotely, or shared. The extension reads game state
locally and calls only the game's own domain (same server the game already uses).
The single write action is **Teleport**, which triggers the game's normal travel —
the server stays authoritative and validates everything. Full policy at
[poke-hunt.com](https://poke-hunt.com).

## Credits & notice

Game data comes from Poke Idle World's public endpoints; combat/productivity data
from the community **piwtools** calculator; creature sprites from **PokeAPI**.
Pokémon is a trademark of Nintendo / Game Freak — this is an unofficial fan tool,
not affiliated with or endorsed by them.

Made with 💜 by [bx0](https://x.com/maldbx0).
