# Riftbound — Online Simulator (unofficial)

A free, fan-made platform to browse cards, build decks, and play **Riftbound**
(the League of Legends TCG) online with an auto-enforcing rules engine. Not
affiliated with or endorsed by Riot Games. **Free forever — no paywalls.**

## Features

- **Card database** — 1,000+ cards across all sets with official artwork
  (hot-linked from Riot's CDN), full search, filter (domain/type/set), sort,
  and a detail view with rules text, flavor, and artist.
- **Deck builder** — pick a champion legend, build a 40-card main deck + 12 runes
  + battlefields, with live legality validation, energy curve & domain analytics,
  a sample-hand tester, and text import/export.
- **Solo goldfish** — a free-form manual board (move cards, channel runes, track
  points) with undo/rewind, to test draws and sequencing.
- **Ruled match (hotseat)** — full auto-enforced rules: turn phases, resource
  payment (auto-pay), legal timing, combat/showdowns, conquering, win condition.
- **Online multiplayer** — create/join with a 4-char room code. Works same-device
  (two tabs) out of the box; true cross-device with Supabase Realtime.

## Stack

- React 19 + TypeScript + Vite + Tailwind CSS v4 (route-level code splitting)
- Pure deterministic rules engine in TypeScript (`src/engine`), Vitest-tested
- Supabase Realtime for optional cross-device online play

## Develop

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production build
npm test         # rules-engine tests
```

### Optional: cross-device online play

Copy `.env.example` to `.env` and set your Supabase project's URL + anon key.
Without it, online play falls back to same-device (two-tab) mode. No database
tables are needed — it uses ephemeral Realtime broadcast channels.

## Deploy (Vercel)

The app is a static SPA. Import the repo into Vercel — it auto-detects Vite
(`vercel.json` pins the build to `npm run build` → `dist` and rewrites all
routes to `index.html` for client-side routing).

For cross-device online play, add the two env vars in **Vercel → Project →
Settings → Environment Variables**:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon / publishable key>
```

Use only the **anon (publishable)** key — it is safe to ship to the browser.
Never add the `service_role` / secret key. The app builds and runs without
these (online play just falls back to same-device).

## Project layout

```
src/
  types/       core data model (cards, decks)
  data/        card dataset (generated from Riftcodex; see scripts/)
  lib/         deck storage, validation, stats
  engine/      pure rules engine + tests (state, reduce, autopay, setup)
  net/         multiplayer transport (BroadcastChannel + Supabase)
  components/  shared UI (Layout, CardTile, BoardCard, MatchBoard, modals)
  pages/       routed pages (Home, Cards, Decks, Builder, Goldfish, Match, Online)
scripts/
  ingest-cards.mjs   refresh card data from the Riftcodex API
docs/
  RULES.md     the rules spec the engine implements (+ what's simplified)
```

## Card data

`src/data/cards.generated.json` is produced by `node scripts/ingest-cards.mjs`,
which pulls the full card list from the Riftcodex API and normalizes it into our
`Card` type. Artwork is hot-linked from the official Riot CDN — never re-hosted.
Re-run the script when a new set releases.

## Rules coverage

The engine fully enforces the **structural game** (phases, costs, timing, combat,
conquering, win). Per-card bespoke ability text and some keywords are surfaced
for manual resolution rather than fully scripted — see `docs/RULES.md` for the
exact list of what's enforced vs. simplified.

## Legal

Unofficial, fan-made, and free. Riftbound and League of Legends are trademarks of
Riot Games, Inc. No official Riot assets are bundled; card art is hot-linked from
Riot's own CDN. Not endorsed by or affiliated with Riot Games.
