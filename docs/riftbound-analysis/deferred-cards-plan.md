# Deferred-cards implementation plan (2026-06-04)

Grounded by two Sonnet research passes (codebase touchpoints + online card rulings/errata) synthesized on Opus. Covers the ~24 cards deferred after the 13-gap pass. Strategy the user set: **hard-code the unique one-offs first, group the shared-infra cards, then work sequentially.**

## Errata / fact corrections that change the work (from online research)
- **Teemo - Strategist** — official errata REMOVED the "or I'm played from [Hidden]" trigger. It is now **defend-only**. So it needs only a hand-coded defend handler; the `fromHidden` infra is NOT required for it.
- **Adaptatron** — has **no "return me"** clause. Real text: "When I conquer, you may kill a gear. If you do, buff me." (Our earlier note was wrong.)
- **Yone - Blademaster** — errata "that was **uncontrolled**" (not "open battlefield"). Condition = the conquered bf had no controller immediately before.
- **Karma - Channeler** — errata "(Runes aren't cards.)" → `recycleCard` must EXCLUDE rune recycling.
- **Jax - Unmatched** — errata "Your Equipment **everywhere** have [Quick-Draw]" (was "in your hand").
- Sim already has: **Gold tokens** (`spawnGold`/`GOLD_TOKEN_ID`), **Champion Zone** (`p.champion`), **XP** (`p.xp`), **Ganking** (`unitHasGanking`). The Brush card (`unl-t03-219`) already exists as a battlefield-type card (no script). The only NEW object is a **token battlefield** (mutating `BattlefieldState.cardId` mid-match).

---

## PHASE 1 — Unique one-offs, engine-only, hard-code by base name (no new infra)
Lowest risk, highest clarity, no dependencies. Each is a `fireTriggers` per-card branch or a small targeted fix. Batch into a few commits.

1. **Yone - Blademaster** (`sfd-116-221`) — conquer handler: if the conquered bf was uncontrolled before, deal `mightOf(self)` to the strongest enemy unit in a base. *Needs "was-uncontrolled" context threaded to the conquer trigger (capture pre-conquer controller).*
2. **Twisted Fate - Gambler** (`ogn-200-298`) — attack handler: pop top of `runeDeck`, read `produces`, recycle to bottom, branch: Fury → 2 to an enemy here + 1 to all other enemies here; Mind → draw 1; Order → stun an enemy here.
3. **Teemo - Strategist** (`ogn-121-298`) — defend handler: peek top 5 of mainDeck, count `[Hidden]` in their text, deal that to the chosen/strongest enemy at its bf, recycle the 5. (Defend-only per errata.)
4. **Adaptatron** (`ogn-056-298`) — conquer handler: optional kill a controlled gear (auto-pick lowest-value), and only then buff self. Suppress the generic auto-buff for this card.
5. **Blitzcrank - Impassive** (`ogn-067-298`) — (a) gate the on-play "move an enemy unit to here" on being played to a battlefield (`ambushBf != null`); (b) parse/handle "return me" on hold (self-bounce to hand).
6. **Rell - Magnetic** (`sfd-024-221`) — attack handler: optionally play an Equipment (≤2 Energy) from hand free, attach to Rell, fire `fireAttachEquip`.
7. **Jax - Unmatched** (`sfd-054-221`) — at PLAY_GEAR, if the controller's legend is Jax - Unmatched, treat the gear as `quickDraw` (reaction speed already exists) + auto-attach on play to a friendly unit.
8. **Teemo - Swift Scout** (`ogn-263-298`) — extend `bounceUnitToHand` to also search `p.champion` (Champion Zone) so the bounce ability can retrieve a Teemo from there.
9. **Gearhead** (`sfd-068-221`) — fix the dead `gearMight` icon regex (drop the trailing `\b` after `:rb_might:`) so static `+N :rb_might:` gear counts, then host-aware double for Gearhead. *Low live impact (no static-Might gear in dataset today) but fixes a latent bug.*
10. **Rek'Sai - Breacher** (`sfd-029-221`) — at all non-hand play sites (`playUnitFromTrash`, `revealPlayFromDeck`, `peekBanishPlay`, REVEAL unit branch) enter the unit **ready** when the controller has Breacher in play (Accelerate aura; approximate as free-ready).
11. **Royal Entourage** (`sfd-039-221`) — new `readyLegend`/`exhaustLegend` ParsedEffect fields + apply in `applyParsed`; on-play ready or exhaust a legend (auto-pick: exhaust an opponent's / ready your own per benefit).
12. **Strike Down** (`sfd-107-221`) — new `damageEqualToMight` + `detach` ParsedEffect fields (or a spell-name hand-code): chosen equipped friendly deals its Might to an enemy, then detach one Equipment.

## PHASE 2 — Shared-infra groups (small infra, unlocks 2+ cards each)
13. **G-recycle-events** — add `recycleRune` + `recycleCard` TriggerEvents + PATTERNS + dispatch (RECYCLE_RUNE site fires `recycleRune`; card-recycle sites — VISION_DECIDE, deck-dig "recycle the rest", spell-replay — fire `recycleCard`, **runes excluded**). Unlocks **Sivir - Battle Mistress** (recycleRune → optional exhaust for Gold) + **Karma - Channeler** (recycleCard → buff a friendly).
14. **G-spend-buff** — add `spendBuff` TriggerEvent + dispatch at every buff-spend cost site. Unlocks **Fae Dragon** (spend buff → Gold token). *Confirm Fae Dragon's on-play "buff up to four" already works (it should: `buff:4`).*
15. **G-gained-xp** — add `PlayerState.xpGainedThisTurn` (set at all XP-gain sites, clear at turn start) + `conditionalMight` & `unitHasGanking` branches. Unlocks **Wily Newtfish**.
16. **G-from-hidden** — thread a `fromHidden` flag from the REVEAL handler into `firePlayTriggers` → `playTriggerMatches` so "when you play a card from [Hidden]" only fires on reveal-plays. Unlocks **Ember Monk**. (Teemo-Strategist no longer needs this per errata.)

## PHASE 3 — Equip-attach edge cases (LOW)
17. **G-equip-attach-extras** — extend the PLAY_UNIT Weaponmaster block to (a) also search units' `.attached` arrays (re-seat already-attached gear) and (b) charge the multi-component gear's Energy cost minus one rainbow. Affects **Armed Assailant**, **Sentinel Adept**, **Yone - Blademaster** (Weaponmaster half). *Basic 1-rune-from-hand Weaponmaster already works, so this is edge-case polish.*

## PHASE 4 — Higher-cost (action-schema / UI / new game object) — confirm scope before starting
18. **Azir - Ascendant** (`sfd-050-221`) — engine-only but bespoke: activated position-swap (move self ↔ chosen friendly unit; preserve exhaustion) + optional Equipment steal (new `pendingChoice` kind). Once-per-turn.
19. **Bard - Mercurial** (`sfd-079-221`) — needs an ACTION-SCHEMA change: `legendExhaust?: boolean` on PLAY_UNIT (optional additional cost) + a "move any number of your units to an open battlefield" multi-select placement choice flow. **Touches the play action + UI.**
20. **multi-activated-ability + `abilityIndex`** — ACTION-SCHEMA + UI change: `unitActivatedAbility` returns an array (split on `::`), ACTIVATE_UNIT gains `abilityIndex`, UI shows multiple ability buttons. Unlocks **Jax - Grandmaster At Arms** (2nd re-seat ability) and is a prerequisite for **Heimerdinger - Inventor** (borrow all friendly `[Exhaust]` abilities — additionally needs a borrowed-ability aggregation + selection UI; **highest complexity**).
21. **Ivern - Green Father** (`unl-195-219`) — NEW GAME OBJECT (token battlefield): allow mutating `BattlefieldState.cardId` mid-match; add a `Brush` battlefieldScript (Bird/Cat/Dog/Poro/Ivern +1 Might here); on conquer/hold optionally exhaust Ivern to replace that bf with Brush; optional swap-back on score (can be deferred/manual). Fix the trigger to also fire on "conquer **or hold**".
22. **Svellsongur** (`sfd-059-221`) — dynamic text-copy: while attached, the host unit's printed abilities are also exposed on the Equipment. Architecturally significant; lowest priority.

---

## Notes
- Auto-resolve pure-benefit picks; surface a `pendingChoice` only for genuine player decisions (gear to kill, legend ready/exhaust, units to move). Commit surgically (parallel committers on `main`); `tsc` → `vitest` → `vite build` per batch with tests.
- Phase 4 items are real scope decisions (UI + a new object). Greenlight Phases 1–3 first; decide Phase 4 item-by-item.

---

## Implementation status (final — 2026-06-04)

All deferred-card phases executed via the economical-hybrid (Opus integrator + 2 isolated Sonnet worktree agents on the separable cards).

- **Phase 1** (12 unique one-offs) — ✅ done. Yone, Twisted Fate, Teemo-Strategist, Adaptatron, Blitzcrank (hold-recall only), Rell, Jax-Unmatched, Teemo-Swift Scout, Gearhead, Rek'Sai-Breacher, Royal Entourage, Strike Down.
- **Phase 2** (shared infra) — ✅ recycleRune/recycleCard/spendBuff events, xpGainedThisTurn, fromHidden (Sivir, Karma, Fae Dragon, Wily Newtfish, Ember Monk).
- **Phase 3** — ✅ Weaponmaster re-seats already-attached / base gear.
- **Phase 4a Azir-Ascendant** — ✅ position swap + Equipment steal, once/turn (Sonnet agent).
- **Phase 4b Bard-Mercurial** — ✅ engine-only auto-resolve (exhaust legend → move a unit to conquer an open battlefield); no action-schema/UI change needed.
- **Phase 4c Jax-Grandmaster** — ✅ re-seat already-attached Equipment via the extended forge-attach flow (`controlledEquipOptions`). ⏸ **Heimerdinger - Inventor DEFERRED.**
- **Phase 4d Ivern-Green Father** — ✅ Brush token-battlefield (new `BattlefieldState.cardId` mutation capability + `Brush` battlefieldScript) (Sonnet agent).
- **Phase 4e Svellsongur** — ⏸ **DEFERRED.**

### Final deferrals (documented, intentional)
- **Heimerdinger - Inventor** (borrow ALL friendly `[Exhaust]` abilities) and **Svellsongur** (runtime text-copy of the host's abilities onto the Equipment) both require a **multi-activated-ability surfacing UI** (an `abilityIndex` on ACTIVATE_UNIT + ability-selection buttons). That directly conflicts with the project's auto-resolve / no-manual-buttons directive, and both are single low-impact cards — so they're left as documented one-offs rather than forcing UI that fights the design.
- **Blitzcrank's play-to-a-battlefield pull** — the engine has no battlefield-play path for non-Ambush units; only the hold-recall half is modeled.
- **Bard's full "move ANY number of units"** — auto-resolves to one unit conquering one open battlefield (the clear-benefit case).

Suite: 441 passing. Commits: `165856d`..`89f2259`.
