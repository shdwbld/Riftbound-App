# Source register

External and local sources for this research. Re-pull web sources at execution
time — the meta shifts between sets/patches.

## Meta tier lists & deck guides (web)
- **riftbound.gg** — tier list + per-legend strategy guides
  - https://riftbound.gg/tier-list/
  - https://riftbound.gg/irelia-blade-dancer-guide/ (example per-deck guide)
- **riftdecks.com** — tier list, top-decks database, domain/metagame stats
  - https://riftdecks.com/legends · https://riftdecks.com/riftbound-decks
- **mobalytics.gg/riftbound** — tier list + decklists with tournament placements
  - https://mobalytics.gg/riftbound/tier-list · https://mobalytics.gg/riftbound/decks
- **riftmana.com** — Unleashed meta tier list + deck lists
  - https://riftmana.com/meta-tier-list/ · https://riftmana.com/decks/
- **metafy.gg/riftbound** — written strategy guides ("The Riftbound Library")
  - https://metafy.gg/@riftbound-library/guides
- **piltoverarchive.com** — community decklists
  - https://piltoverarchive.com/decks
- **riftbound-deck.org** — cards, decks & meta

## Symbol / icon reference
- **riftboundsymbols.com/riftbound-icons** — every card symbol explained
  (Name→Meaning table + example cards showing placement).
  Saved locally: `C:\Users\bisma\Downloads\Riftbound Icons_ Every Card Symbol Explained.html`

## Local (this repo)
- `src/data/cards.generated.json` — full card pool (set prefixes: ogn = Origins,
  ogs, sfd, **unl = Unleashed** [current meta], opp, pr). Used to map meta cards →
  our engine and flag cards we don't have.
- `src/engine/effects.ts` / `keywords.ts` / `triggers.ts` / `engine.ts` — the
  current text→behavior parser (the target of the gap analysis).

## Meta snapshot at start (June 2026, "Unleashed")
- **Tier 1:** Master Yi - Wuju Bladesman (~8% share), Irelia - Blade Dancer,
  LeBlanc - Deceiver, Diana.
- **Tier 2:** Vex, Sivir.
- Tournaments referenced: Suzhou, Sydney, Xi'an, Chengdu (S2 Regional Opens).
