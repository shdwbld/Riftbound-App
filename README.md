# Riftbound — Online Simulator (unofficial)

A fan-made platform to build decks and play **Riftbound** (the League of Legends
TCG) online, with a full auto-enforcing rules engine. Not affiliated with or
endorsed by Riot Games.

## Status

Built in phases. Current: **Phase 1 — Foundation** ✅

| Phase | Milestone |
|-------|-----------|
| 1 | Foundation: scaffold, card data model, seed cards, app shell |
| 2 | Card database + deck builder |
| 3 | Solo play board (manual) |
| 4 | Auto-enforced rules engine |
| 5 | Online room-code multiplayer (Supabase) |
| 6 | Polish & QoL (rewind, sealed, etc.) |

## Stack

- React 19 + TypeScript + Vite
- Tailwind CSS v4
- Vitest (rules-engine tests)
- Supabase (auth + realtime + DB) — added in Phase 5

## Develop

```bash
npm install
npm run dev      # start dev server
npm run build    # typecheck + production build
npm test         # run tests
```

## Project layout

```
src/
  types/      core data model (cards, decks) — stable contract
  data/       seed card data (placeholder; replaced with real data in Phase 2)
  components/ shared UI (Layout, CardTile)
  pages/      routed pages (Home, Cards, Decks, Play)
```

## Card data

`src/data/cards.ts` is **placeholder** seed data so the UI and (later) the rules
engine have something to run against. It does not reflect official card values.
Phase 2 replaces it with a real, legally-sourced card database while keeping the
`Card` type in `src/types/cards.ts` as the stable contract.

## Legal

This is an unofficial, fan-made tool. Riftbound and League of Legends are
trademarks of Riot Games, Inc. No official Riot assets are bundled.
