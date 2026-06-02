# In-game gaps — during a live match

Gaps observed while actually playing a match (UX + mechanics that surface in the
moment of play, as opposed to the rules-coverage list in `GAPS.md`).
✅ fixed · ◑ partial · ⏳ open.

## Viewing & information
1. ✅ **Can't view cards during mulligan** — clicking a card only toggled
   set-aside; now tapping opens the full card, with a separate "Set aside"
   control. *(reported by user; fixed)*
2. ⏳ **No combat preview** — before resolving a showdown you can't see each
   side's total Might (with Assault/Shield applied) or who would die.
3. ⏳ **No "what changed" feedback** — channel/draw/score happen silently at turn
   start; only the log records it. No highlight/toast for points scored,
   cards drawn, or units defeated.
4. ⏳ **Exhausted vs ready isn't obvious** — units rotate 90°, but there's no
   clear "ready/exhausted" badge; runes dim but it's subtle.
5. ⏳ **No turn / phase banner** — whose turn and which phase isn't prominent
   (only small chips in the toolbar).
6. ◑ **Attached gear isn't shown on its unit** — gear grants +Might but the
   board doesn't draw it attached, so you can't tell a unit is buffed.

## Actions you can't take yet
7. ⏳ **No targeting picker** — damage spells and gear that need a target log
   "resolve manually" instead of letting you click a unit. (Engine supports it.)
8. ⏳ **Can't activate unit/gear exhaust abilities** — units with a `:exhaust:`
   ability have no button to use it.
9. ⏳ **Can't retreat units via the UI** — the engine has RETREAT
   (battlefield → base) but there's no button.
10. ⏳ **No manual rune payment** — auto-pay always picks the runes; you can't
    choose which runes to exhaust/recycle (matters for color planning).
11. ⏳ **No undo in ruled matches** — only the solo Goldfish board has undo;
    a misclick in Match/Online can't be taken back.
12. ⏳ **No play confirmation / cost preview** — clicking Play immediately
    commits; you don't see the cost it will auto-pay first.

## Combat & abilities depth
13. ◑ **Showdown = Pass only (mostly)** — you can play a Reaction spell now, but
    can't choose damage-assignment order, declare blocks, or respond with units.
14. ◑ **Legend ability is generic** — the "★ Ability" button just exhausts the
    legend; its specific effect is left to manual resolution.
15. ⏳ **Hidden/facedown units** aren't representable on the board.
16. ⏳ **Per-card triggered text** beyond common patterns (draw/channel/deal) is
    only logged, not executed.

## Presentation
17. ⏳ **No animations** for attacks, damage, defeat, or scoring — state just
    snaps to the new value.
18. ⏳ **No score-to-win progress** indicator (e.g., 5/8 pips).
19. ⏳ **4-player layout is cramped** on small screens — opponent mats stack but
    get tight.
20. ⏳ **No match history / replay** of what happened.
