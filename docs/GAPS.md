# Gameplay gaps — status

Audit of rules coverage vs. real Riftbound. Updated after the gap-closing pass.
✅ implemented · ◑ partial / framework-ready · ⏳ not yet.

## Card abilities & keywords
1. ✅ **Keyword framework** — all 22 keywords parsed from card text
   (`src/engine/keywords.ts`), shown as chips in the card detail view.
2. ◑ **Per-card ability text** — common patterns auto-resolve (draw, channel,
   "deal N to a unit"); everything else is surfaced in the log for manual
   resolution. Full bespoke scripting of ~1000 cards is out of scope.
3. ✅ **Legend ability** — "★ Ability" button exhausts the legend (effect text
   resolved manually).
4. ◑ **Gear** — attaches to a target unit and grants parsed "+N Might" in combat;
   the in-match attach **picker UI** is still TODO (engine supports `targetIid`).
5. ◑ **Targeting** — the engine accepts targets for spells/gear; a click-to-target
   **UI** for damage spells is still TODO (those log "choose a target").

## Combat
6. ◑ **Reactions in showdowns** — the priority holder can now play Reaction/Action
   spells during a showdown; the full Open/Closed LIFO chain with priority resets
   is simplified.
7. ✅ **Combat keywords** — Tank (lethal-first), Assault X (+Might attacking),
   Shield X (+Might defending), Backline (no frontline), kill-order damage.
8. ✅ **Ganking** — units with Ganking move battlefield-to-battlefield.

## Scoring & end states
9. ✅ **Burn Out** — drawing from an empty deck gives the next player +1.
10. ✅ **8th-point restriction** — a winning Conquer point only counts if you
    control all battlefields that turn, else you draw a card instead.

## Resources & setup
11. ✅ **One rune pays both** — a rune can be exhausted for Energy and recycled
    for Power in the same payment.
12. ✅ **Mulligan** — set aside up to 2 → bottom of deck (no reshuffle) → redraw,
    with a card-selection UI.
13. ✅ **Chosen Champion zone** — a matching champion unit is set aside at setup
    and is always playable from the Champion Zone.
14. ✅ **Accelerate** — units with Accelerate enter ready.
15. ✅ **Temporary** — expires at the start of the controller's next turn.

## Multiplayer (3-4p)
16. ✅ **2-4 players** hotseat + online; N-seat rotation, 11-pt win.
17. ◑ **Multiplayer combat** — mover vs. combined defenders (simplified).
18. ⏳ **2v2 team mode** — only free-for-all so far.
19. ⏳ **Multiplayer catch-up economy** — unconfirmed in sources; not modeled.

## UX
20. ✅ **Concede button** in the match.
21. ✅ **Legend-ability button**.
22. ⏳ **Solo Goldfish board** still uses its own manual state (not the engine).

## Remaining (intentionally deferred)
- Exhaustive per-card effect scripting (item 2) — the long pole.
- Full reaction chain / priority system (item 6).
- In-match targeting/attach pickers (items 4, 5).
- 2v2 team scoring (item 18) and solo-board/engine merge (item 22).
