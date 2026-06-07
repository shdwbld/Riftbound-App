# Missed Auras & Triggers — Fix Campaign Plan

**Status:** QUEUED. Do **after A6** (steal/take/give CONTROL family), then this.
**Findings source:** `docs/riftbound-analysis/missed-auras-triggers.md` (the audit; card ids + root causes).
**Already done (not in this plan):** Volibear - Relentless Storm legend aura (commit `0cbf487`),
Volibear - Furious split = free manual placement (`6ba89f5`), Ahri - Nine-Tailed Fox (already wired
at `fireCombatTriggers`).

## Working discipline
- **Consult `C:\Users\bisma\Downloads\Riftbound MSC\Riftbound Core Rules v1.2.pdf` first** for any rule.
- **Re-verify every file:line anchor before editing** — line numbers drift (this repo has parallel committers).
- Grep card text from `src/data/cards.generated.json` via `node -e` (huge one-line file; never Read it).
- **Gate each batch:** `npx tsc --noEmit` → `npx vitest run` → `npx vite build`. One commit per batch.
- Add a focused test per card (fires only when its real condition holds; does NOT fire otherwise).

---

## Phase 0 — Shared infrastructure (build first; later batches depend on it)

1. **New `TriggerEvent`s** (`src/engine/triggers.ts`): `'hide'`, `'opponentMove'`.
   - Add to the `TriggerEvent` union + the `PATTERNS` table ("when you hide a card…", "when an opponent
     moves to a battlefield other than mine…").
   - Fire sites (engine.ts): `'hide'` from the `HIDE` action handler; `'opponentMove'` from the `MOVE`/
     move-resolution path for OTHER players' moves (mirror `fireOpponentUnitPlay`).
2. **New parsed condition kinds** (in `playTriggerMatches` and/or `conditionalMight`):
   - `energySpentOnSpellsAtLeast N` — `energySpentOnSpellsThisTurn` is already tracked (Revna).
   - `totalMightAtLeast N` — sum `mightOf` of the controller's OTHER friendly units (Kinkou Initiate).
   - `powerCostAtLeast N` — parse the played card's Power-cost threshold (Yordle Explorer). `playTriggerMatches`
     currently only parses `:rb_energy_N:` thresholds.
3. **from-face-down regex** — `firePlayTriggers` gates "from hidden" on `/\bfrom \[?hidden\]?/i`. Extend the
   reveal-play detection so cards saying **"from face down"** match too (Katarina b, Black Market Broker).
   First verify how a reveal-play sets `fromHidden` (the `HIDE`/`REVEAL`/play-for-0 path) and feed both phrasings.
4. **"during a showdown" gate** — in `playTriggerMatches`/`firePlayTriggers`, when the trigger text matches
   `/during a showdown/i`, require `s.showdown != null` (Fresh Beans).
5. **Optional-cost machinery** — the `optional` flag on `TriggeredAbility` and "you may pay <cost>" / "exhaust
   me|this" clauses are never read in `fireTriggers`. Add: when a fired trigger is optional AND has a payable
   cost, either auto-pay if it's pure upside (per the auto-resolve preference) or open a Pay/Skip `pendingChoice`.
   **Reuse the pattern already added** for "exhaust me to channel N exhausted" in `firePlayTriggers`/`fireBecomesState`
   (Volibear - Relentless, Fiora) — generalize it; do NOT double-handle those.
6. **`powerSpentThisTurn`** on `PlayerState` — increment in `applyPayment` (count Power runes spent). Cleared in
   `beginTurn`/sandbox `clearTurnState` (Sivir - Mercenary).

---

## Batch 1 — Over-fire bug fixes (trivial/small; HIGHEST value — cards do the WRONG thing today)
- **Katarina - Reckless** (`unl-023-219`): (a) "when you hide a card, ready me" → Phase-0 #1 `'hide'` event.
  (b) "play a card from face down → deal 2 to an enemy" → Phase-0 #3 (today fires on EVERY play).
- **Black Market Broker** (`sfd-121-221`): "from face down → Gold token exhausted" → Phase-0 #3.
- **Fresh Beans** (`unl-011-219`): "play a unit during a showdown, may exhaust this to draw 1" → Phase-0 #4 gate
  + Phase-0 #5 optional exhaust-to-draw.
- **Revna the Lorekeeper** (`unl-005-219`): "play a spell, if spent 4+ Energy, ready me" → Phase-0 #2
  `energySpentOnSpellsAtLeast`.
- **Kinkou Initiate** (`unl-097-219`): self play-trigger "draw 1 if other units' total Might ≥ 5" → Phase-0 #2
  `totalMightAtLeast`.
- **Yordle Explorer** (`sfd-100-221`): "play a card with Power cost ≥ 2 → draw 1" → Phase-0 #2 `powerCostAtLeast`.

## Batch 2 — Optional-cost enforcement
- Phase-0 #5 machinery.
- **Blood Rose** (`unl-109-219`): "you may pay 1 Energy to gain 1 XP" — today the XP is FREE; charge/offer it.
- **Fresh Beans** exhaust-to-draw (with the Batch-1 showdown gate).
- Regression-check: the already-working "exhaust me to channel N" (Volibear - Relentless, Fiora - Grand Duelist)
  must keep working and not double-fire.

## Batch 3 — Silent static auras (do nothing today)
- **Tianna Crownguard** (`sfd-060-221`): "while at a battlefield, opponents can't gain points." Add
  `tiannaCrownguardBlocksScore(s, scorer)` guard at ALL THREE scoring sites: `awardPoints`, `BfApi.score()`,
  and the `p.points += e.score` site. Blocks when an OPPONENT of `scorer` controls Tianna at a battlefield.
- **Eager Apprentice** (`ogn-084-298`): "your spells cost 1 less (min 1)." In `effectiveCostOf`, when
  `card.type === 'spell'`, subtract 1 Energy (floor at 1 of the card's energy) per Eager Apprentice the caster
  controls at a battlefield.
- **Allay, Eager Admirer** (`unl-041-219`): "your other units here have [Deflect]." In `deflectSurcharge`,
  extend the `unitGrantedKeywordHere` regex to also match `"your other units here have \[deflect\]"` (it only
  matches "**friendly** units here…" today).
- **Volibear - Imposing** (`ogn-158-298`): "when an opponent moves to a battlefield other than mine, draw 1."
  Phase-0 #1 `'opponentMove'` event; draw 1 for the controller when an opponent moves to a bf ≠ this unit's.

## Batch 4 — Engine-touch (new state)
- **Sivir - Mercenary** (`sfd-143-221`): "if you've spent ≥2 Power this turn, I have +2 Might and [Ganking]."
  Phase-0 #6 `powerSpentThisTurn` → new branch in `conditionalMight` (+2) AND `unitHasGanking` (true).
- **Jhin - Virtuoso** (`unl-181-219`): "when you play a spell costing 4+ Energy, you may banish it; when four are
  banished with me, recycle them + channel 4 + draw 1." New `EngineCard.jhinBanished?: string[]`; bespoke handler
  in `fireTriggers` (the generic `ParsedEffect` has no `banishPlayedCard`). Offer the banish (optional), count to 4,
  then the payoff. Fully bespoke.

---

## Out of scope but flagged (decide separately)
- **Damage persistence:** `finalizeShowdown` clears SURVIVOR damage to 0 at combat end. If Riftbound damage
  persists until end of turn, that's a separate model change affecting all combat — verify in the rulebook before
  touching (relevant to whether split-damage counters on survivors should carry over).
- **Sandbox [Mighty] toggle** uses a buff-proxy; real `[Mighty]` = `mightOf >= 5` (`STATES`). Minor sandbox-only polish.
- **No generic `'enemyAttacks'` TriggerEvent:** Ahri - Nine-Tailed Fox is bespoke in `fireCombatTriggers`; any
  future "when an enemy unit attacks a battlefield you control" card needs its own handler or a new event.
