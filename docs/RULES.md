# Riftbound Rules Reference (engine basis)

Condensed from official Riot/UVS Core Rules v1.3 + community parses. This is the
spec the rules engine (`src/engine/`) implements. Standard 1v1 constructed.
Items marked ⚠️ are simplified or pending verification in the engine.

## Win & scoring
- **8 points** to win 1v1 (11 in 2v2).
- **Conquer:** +1 point the moment you take sole control of a battlefield.
- **Hold:** +1 per battlefield you control, scored at the **start of your turn**.
- **Burn Out:** opponent drawing from an empty Main Deck gives you +1. ⚠️ not yet modeled.
- ⚠️ **8th-point restriction** (final point can't come from an ordinary single-hold;
  must be a hold or conquering all battlefields same turn, else draw) — not yet enforced.

## Turn structure (A-B-C-D-Action-End)
1. **Awaken** — ready all your runes/units/gear/legend.
2. **Beginning** — score Hold points, resolve start-of-turn triggers.
3. **Channel** — channel **2** runes (the player going **second channels 3** on turn 1).
4. **Draw** — draw 1, then rune pool empties.
5. **Action** — play units/spells/gear, move units (moving can start a showdown).
6. **End** — expire "this turn" effects, clear marked damage, pass.

## Setup
- Starting hand **4**. Mulligan: set aside up to 2 → bottom of deck (no reshuffle) → redraw that many. ⚠️ engine uses simplified keep/redraw.
- **2 battlefields** in play (each player brings one).
- First player random/agreed.

## Resources
- Held in the **Rune Pool**. **Energy** = exhaust any ready rune (+1, color-agnostic).
  **Power** = recycle a rune of the matching domain (to bottom of rune deck) → +1 of that domain.
- A single rune can give **both**: exhaust for energy, then recycle for power. ⚠️ engine treats them as distinct runes.
- Rune deck = **12**. Pool is a per-window resource (empties end of turn).

## Showdown / combat
- Begins when you move unit(s) to a battlefield. **Open** (no enemy) vs **Combat** (enemy present).
- Attacker acts first in the showdown window; Open→Closed state once an Action is played; Reactions resolve via a LIFO chain.
- **Damage is simultaneous**: each side deals total Might as damage, assigned in **kill-order** (fill one unit to lethal before the next). Unit defeated when marked damage ≥ Might → Trash. Marked damage clears after combat.
- Control is **presence-based**: you hold a battlefield when you have unit(s) there and the opponent has none. Both sides wiped → neutral.
- ⚠️ engine models simultaneous kill-order damage but not Tank-driven assignment order, reactions, or the chain.

## Card types & timing
- **Units** — permanents; enter **exhausted**; played in Action phase.
- **Spells** — one-shot → Trash. Speed = default (sorcery), **Action**, or **Reaction** (keyword-driven, not separate types). ⚠️ engine plays spells but resolves their text manually.
- **Gear** — ongoing upgrades in Base. ⚠️ attach/effects manual.
- **Battlefields** — placed at setup, not played.
- **Runes** — channeled, not played from hand.

## Legend & Chosen Champion
- **Legend** sits in the Legend Zone from turn 1, can't leave, defines the deck's two domains, often has an exhaust ability. ⚠️ engine tracks the legend card but not its abilities.
- **Chosen Champion** — a unit set aside in the Champion Zone, always playable from there. ⚠️ not yet modeled (champions go in the main deck for now).

## Keywords (Origins, 22)
Accelerate, Action, Ambush, Assault X, Backline, Deathknell, Deflect X, Equip,
Ganking, Hidden, Hunt X, Legion, Level N, Quick-Draw, Reaction, Repeat, Shield X,
Tank, Temporary, Vision, Weaponmaster. ⚠️ recognized as text; not yet auto-enforced.

See `git log` / research notes for full sources (official rules pages, riftwatcher,
runesandrift, riftboundguide, etc.).
