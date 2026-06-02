# Gameplay gaps — identification only

A candid audit of what the rules engine does **not** yet enforce, vs. the real
Riftbound rules (see `RULES.md`). This is a tracking list, not a work order.
Grouped by impact. ⛔ = affects correctness of normal play; ⚠️ = situational;
ℹ️ = depth/edge.

## ⛔ Card abilities & keywords (the biggest gap)
1. **Per-card ability text is not executed.** Units' "when played / when I hold /
   when defeated" triggers do nothing; spells resolve to the trash with no
   effect; gear grants nothing. The board enforces *structure*, not card text.
2. **None of the 22 keywords are enforced:** Tank, Shield X, Assault X,
   Deathknell, Accelerate, Ambush, Deflect X, Ganking, Hidden, Hunt X, Legion,
   Level N, Quick-Draw, Reaction, Repeat, Vision, Weaponmaster, Backline, Equip,
   Temporary, Action. (They're shown as text only.)
3. **Legend abilities don't work.** The Legend sits in play but its exhaust
   ability / always-on passive is never usable.
4. **Gear never attaches.** `EngineCard.attached` exists but gear can't be
   equipped to a unit and grants no Might/abilities.
5. **No targeting.** Because effects aren't scripted, there's no UI/flow to pick
   targets for spells or abilities.

## ⛔ Combat & showdown depth
6. **No reaction chain.** During a showdown the only legal move is Pass — you
   can't play Action/Reaction spells, activate abilities, or counter-move.
   (Open/Closed state + LIFO chain from RULES.md is unmodeled.)
7. **Damage assignment is fixed array-order**, not controller-chosen, and
   **Tank** (must take lethal first) / **Assault**/**Shield** (+Might while
   attacking/defending) are ignored.
8. **Battlefield-to-battlefield movement (Ganking)** isn't possible — units only
   move base→battlefield (and RETREAT battlefield→base).

## ⛔ Scoring & end states
9. **Burn Out not modeled.** Drawing from an empty Main Deck should give the
   opponent +1 point; here it silently draws nothing.
10. **8th-point restriction** (final point must come from a Hold, or conquering
    all battlefields in one turn) is not enforced — any +1 to 8 wins.

## ⚠️ Resources & setup
11. **One rune can't pay both** Energy (exhaust) **and** Power (recycle) as the
    rules allow; the engine treats them as separate runes, and only lets you
    recycle *ready* runes.
12. **Mulligan is simplified** to keep / full-hand redraw, instead of "set aside
    up to 2 → bottom of deck (no reshuffle) → redraw that many."
13. **Chosen Champion zone missing.** Champions live in the main deck; there's no
    set-aside champion that's always replayable from a Champion Zone.
14. **Accelerate** (enter ready) unmodeled — all units enter exhausted.

## ⚠️ Multiplayer (3-4p)
15. **Free-for-all only** — no **2v2 team** mode (shared points / team win).
16. **Multiplayer combat is simplified** to mover-vs-combined-defenders; real
    free-for-all combat among 3+ contesting sides isn't fully modeled.
17. **No multiplayer catch-up rule** for the 3rd/4th player (only the 1v1
    second-player +1 channel exists); exact multiplayer turn-1 economy is
    unconfirmed in sources.

## ℹ️ UX / flow gaps
18. **No concede button** in the match UI (the CONCEDE action exists in the
    engine but isn't surfaced).
19. **No legend-ability button**, no "activate ability" affordance at all.
20. **Solo Goldfish board is separate** from the engine — it's a free manual
    board and doesn't share rules/validation with Match/Online.
21. **End-of-turn cleanup** of "this turn" effects and the Rune Pool emptying are
    no-ops today (harmless only because no effects exist yet).
22. **Online is 2-player** (host + 1 guest) — 3-4p online is task #11.

## Notes
- Items 1-5 are the headline: a *complete* engine means scripting ~1,000 bespoke
  cards + 22 keywords + a reaction chain — a large, ongoing effort. A sensible
  next step is a **keyword framework** + scripting the highest-impact keywords
  (Tank, Shield, Assault, Deathknell, Vision) before per-card effects.
- None of these block the current structural game; they bound how "automated"
  and tournament-faithful play is.
