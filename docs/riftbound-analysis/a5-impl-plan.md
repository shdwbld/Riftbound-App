# A5 Implementation Dossier — Persistent / cascading + bespoke singles

> Consolidated 2026-06-06 from the A5 dossier agent + `a5-recon-cascading.md` + `a5-recon-singles.md`.
> Anchors current as of the A4 commits. Scope expanded per user to **15 cards** (11 scoped + 4 cross-event).
> Each sub-batch is gated `tsc → vitest → build → surgical commit + push`. Opus implements `engine.ts`
> serially (one hot file). See the two recon docs for the full per-card reasoning.

## New fields

| Field | Location | Type / default |
|-------|----------|----------------|
| `ParsedEffect.recycleFromTrash` | `effects.ts` (after `opponentDiscards`) + `EMPTY_EFFECT` | `number`, `0` |
| `MatchState.asheBanishPending?` | `types.ts` (after `sandbox?`) **+ `clone()` engine.ts:67–77** | `{ banishedIid:string; owner:PlayerId; victimId:PlayerId }[]` |
| `PlayerState.namedTag?` | `types.ts` (near `azirSwappedThisTurn?`); cleared at game start | `string` |
| `pendingChoice.kind` union | `types.ts` | add `'insightfulInvestigator' \| 'nameTag'` |
| `EngineCard.cantMoveThisTurn?` (Vex - Apathetic) | `types.ts`; wiped at END_TURN | `boolean` |
| New `TriggerEvent`s | `triggers.ts` union + `TRIGGER_EVENTS` + `PATTERNS` | `'opponentPlayUnit'`, `'opponentScore'`, `'bounce'` |

## Per-card approach (sub-batch order)

**A5-1 forcedDiscardCascade** — `fireDiscard(s, foe.id, [card])` after the trash branch (engine.ts:722);
collect + `fireDiscard(s, foe.id, discardedCards)` in `opponentDiscards` (728–739); delete the stale
"can't fire the log-cloning trigger pass" comment (705–707). Cards: Mindsplitter, Bewitching Spirit
(Sabotage recycles → moot). ⚠️ Prove `fireDiscard`/`fireTriggers` mutate `s` in place.

**A5-2 Vex - Mocking** — `fireStun(s, player, bfIndex?)` (engine.ts:1798); pass `battlefieldOf(stunnedIid)`
at the 4 call sites (~1242, ~1341, ~5782, ~6457). Pure plumbing.

**A5-3 Caitlyn - Patrolling** — ACTIVATE_UNIT `dealMight.dealer='self'` branch (after ~6420):
`combatMightAt` → `applyTargetDamage` (auto-pick strongest enemy at her BF) → `fireDeaths`. Combat order:
`damageOrder` (3924) rank=3 for `/must be assigned combat damage last/`; mirror Tank-first guard in
`validateManualAllocation` / `autoDistribute`.

**A5-4 Carnivorous Snapvine** (ogn-149-298) — bespoke PLAY_UNIT: auto-pick highest-Might enemy,
`applyTargetDamage` both directions (mutual), `fireDeaths`, skip generic applyParsed.

**A5-5 Dr. Mundo recycle** — `ParsedEffect.recycleFromTrash` + parse `/recycle N from your trash/` as effect;
`applyParsed` moves N trash→deck. startOfTurn trigger then auto-resolves. Might auras already live
(engine.ts:2534/2535) — SKIP. Draven - Showboat likewise already done (2534) — SKIP.

**A5-6 Ashe - Focused** — `MatchState.asheBanishPending[]` (+ ⚠️ `clone()`); set on banish branch
(engine.ts:721) when source text `/when they hold, return it/`; drain in hold phase (after ~3459) for
`victimId === ap`; purge for eliminated (`out`) players.

**A5-7 Insightful Investigator** — `pendingChoice.kind += 'insightfulInvestigator'`; bespoke PLAY_UNIT guard
with **early return** (suppress unconditional `opponentHandStrip`); if caster XP ≥ 2, PaymentModal-style
pay-2-XP / decline prompt; on pay: −2 XP, strip highest-cost card from victim, `fireDiscard`, **victim** draws 1.

**A5-8 Arise! + The List** — Arise!: extract `countEquipmentOwned(s, player)` (from Ornn ~engine.ts:4037);
bespoke PLAY_SPELL spawns N Sand Soldiers, readies last 2, skip generic. The List: `PlayerState.namedTag`;
PLAY_GEAR `offerChoice 'nameTag'`; RESOLVE_CHOICE sets it; ACTIVATE_UNIT (unl-138-219) filters target by
`namedTag` → −2 Might this turn; `pendingChoice.kind += 'nameTag'`.

**A5-9 A5 UI** (MatchPage.tsx + OnlinePage.tsx) — free-form text-input modal for `'nameTag'`;
PaymentModal-style yes/no for `'insightfulInvestigator'`. Never `window.confirm`.

**A5-10 Cross-event cards** —
- `opponentPlayUnit` event: fire collection for non-active players when a unit is played at a BF →
  **Vex - Apathetic** stuns it + `cantMoveThisTurn`.
- `opponentScore` event: hook score-emit sites (605/2138/3440/3704); collectGlobal for opponents →
  **Sumpworks Map** ([Temporary]) draws 1.
- `bounce` BF passive: hook bounce-to-hand path; if unit's BF hosts **Ripper's Bay**, offer owner
  pay-1-energy → channel-1-rune-exhausted.
- **Bone Skewer** (bespoke spell, no new event): opponent reveals hand → auto-pick a unit → play it to that
  BF ignoring all costs → stun it.

## Blockers / gotchas

1. **Insightful Investigator double-strip** — `opponentHandStrip` regex matches its text unconditionally; the
   bespoke handler MUST early-return before generic resolution.
2. **`clone()` gap** — `asheBanishPending` must be added to `clone()` (engine.ts:67–77) or it wipes every action.
3. **The List UI** — `'nameTag'` needs a free-form text input in MatchPage + OnlinePage (only UI in A5 besides
   the Insightful Investigator yes/no).
4. **Stale comment** — engine.ts:705–707 "applyParsed can't fire the log-cloning trigger pass" is wrong; remove.

## Already done — SKIP
- Draven - Showboat Might aura (engine.ts:2534; test engine.test.ts:4899).
- Dr. Mundo - Expert Might aura (engine.ts:2535; test engine.test.ts:4911) — only the recycle-3 trigger is missing.
