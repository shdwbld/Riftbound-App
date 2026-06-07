# A3 Group 5 Recon — Bespoke Move-Enemy Cards

> Recon date: 2026-06-06  
> Analyst: subagent (Sonnet 4.6)  
> Engine reference: `src/engine/engine.ts` (6830 lines), `src/engine/triggers.ts`, `src/engine/effects.ts`

---

## Key Engine Primitives (read these first)

| Helper | Location | Purpose |
|---|---|---|
| `moveUnit` effect flag | `effects.ts:584`, `engine.ts:4503` | Generic "Move an enemy unit" — triggers `offerChoice` with `kind:'moveToBf'` |
| `RESOLVE_CHOICE` / `moveToBf` | `engine.ts:5745–5761` | Picks destination bf; calls `pluckCardAnywhere` + pushes to dest bf + calls `showdownOrConquerAfterEffectMove` |
| `sendUnitToBase` | `engine.ts:2326` | Removes unit from any bf and puts it in its owner's base (exhausted) |
| `pluckCardAnywhere` | `engine.ts:1021` | Removes and returns an `EngineCard` from any zone |
| `showdownOrConquerAfterEffectMove` | `engine.ts:2963` | Opens showdown or awards conquer after an effect-driven move |
| `offerChoice` | `engine.ts:2342` | Sets `s.pendingChoice` (idempotent if one exists; drops when options empty) |
| `collectSelf(s,player,'move',iids)` | `engine.ts:2926` | Fires "when I move" self-triggers inside `moveUnits` |
| `fireCombatTriggers` | `engine.ts:4079` | Fires 'attack'/'defend' triggers at showdown open (before math) |
| `firePlayTriggers(…, true)` | `engine.ts:5623` | `fromHidden=true` flag — used in REVEAL path |
| `parseTriggers` / PATTERNS | `triggers.ts:156` | `event:'move', scope:'self'` pattern at line 104 |

---

## CONFIRMED WORKING — Charm & Skyward Strike

**Charm** (`ogn-043-298`): "Move an enemy unit."  
**Skyward Strike** (`unl-038-219`): "Move an enemy unit. [Level 6] [Stun] an enemy unit."

Both parse via `effects.ts:584` → `e.moveUnit = true`. In `resolveSpellEffects` at `engine.ts:4503–4514`, the first targeted enemy gets an `offerChoice` of `kind:'moveToBf'`, then `RESOLVE_CHOICE` at `engine.ts:5745–5761` executes the move. **Confirmed working — skip.**

---

## Isolate (unl-124-219) — ALREADY HANDLED

**Verbatim text:** "Move an enemy unit from a battlefield to its base. Then, if there's an enemy unit alone at that battlefield, draw 1."

**Status:** DONE. The `moveToBase` branch in `resolveSpellEffects` at `engine.ts:4485–4501` handles Isolate by name:
- Line 4494: `if (card.name === 'Isolate' && srcBf >= 0)` — checks if exactly one enemy remains at the source bf → draws 1.

**Nothing to add.** Note for main dev: the draw-if-alone check is bespoke and already present.

---

## 1. Dragon's Rage (ogn-258-298)

**Verbatim text:** "Move an enemy unit. Then do this: Choose another enemy unit at its destination. They deal damage equal to their Mights to each other."

### Current status
- `e.moveUnit = true` parsed by `effects.ts:584` → `RESOLVE_CHOICE` moves the unit.
- **Missing:** post-move collision. After the unit lands at its destination, the spell is supposed to pick a SECOND enemy at that same destination and make the two units deal mutual Might damage. The current `moveToBf` resolver (`engine.ts:5745–5761`) does nothing after the move beyond `showdownOrConquerAfterEffectMove`.

### Engine anchors
- `engine.ts:5745` — `if (pc.kind === 'moveToBf')` block — this is where the collision must be added.
- `engine.ts:4322` — comment listing Dragon's Rage in the `dealMight.target='mutual'` group — but that path never fires because Dragon's Rage is a spell that first does a `moveToBf` choice, then needs a second step.

### Plan
1. **Detect Dragon's Rage in `RESOLVE_CHOICE`**: inside the `moveToBf` branch (`engine.ts:5757`), after `showdownOrConquerAfterEffectMove`, check `getCard(pc.payload_sourceCardId?)?.name === "Dragon's Rage"`.  
   - Problem: the current `pendingChoice` payload only carries the moved unit's iid (`payload: t`, the enemy's iid). The card id is not stored. **Fix:** add a `sourceCardId` field to the pendingChoice payload (encoded in `payload` as JSON `{unitIid, cardId}`), or check `pc.prompt` contains "Dragon" (fragile). Cleaner: add `sourceCardId?: string` to the `pendingChoice` type in `types.ts`.
2. After the move completes (dest = `dest`, moved unit = `card`):
   - Find all OTHER enemy units at `dest` (enemies of the caster, not the moved unit's owner).  
   - If any exist, pick the strongest as the collision target (or offer a choice — text says "choose", so `offerChoice` with a new `kind:'dragonsRageCollision'` and payload carrying both iids).
3. In a new `case 'dragonsRageCollision'` in `RESOLVE_CHOICE` at `engine.ts:5710+`:
   - Retrieve both units by iid, compute `mightOf` each, apply mutual damage via `applyTargetDamage`, fire `fireDeaths`.
4. Add `'dragonsRageCollision'` to the `pendingChoice.kind` union in `types.ts:291`.

---

## 2. Temptation (sfd-129-221)

**Verbatim text:** "[Repeat] :rb_energy_2: (You may pay the additional cost to repeat this spell's effect.) Move an enemy unit to a location where there's a unit with the same controller."

### Current status
- `e.moveUnit = true` → `offerChoice` with `kind:'moveToBf'` fires normally.
- **Missing:** destination constraint. The parser builds `dests` as ALL battlefields except the unit's current location (`engine.ts:4497–4511`). Temptation requires the destination to already have a unit controlled by the moved unit's controller.
- [Repeat] itself is handled by the chain system (`engine.ts:5066`) — that part works.

### Engine anchors
- `engine.ts:4492–4514` — the `e.moveUnit` block in `resolveSpellEffects` — filter `dests` here.

### Plan
1. In `resolveSpellEffects`, inside the `if (e.moveUnit)` block at `engine.ts:4503`:
   ```ts
   // Temptation: destination must have a unit with the same controller as the moved unit
   const filteredDests = card.name === 'Temptation'
     ? dests.filter(({ i }) =>
         s.battlefields[i].units.some(u => u.owner === mu.owner))
     : dests
   offerChoice(s, { ..., options: filteredDests.map(({ i }) => ...) })
   ```
2. No changes to `RESOLVE_CHOICE` — the moveToBf resolver is destination-agnostic.
3. Note: if no valid destination exists, `filteredDests` will be empty and `offerChoice` is a no-op → spell silently does nothing, which is correct (no legal target).

---

## 3. Iascylla (unl-050-219)

**Verbatim text:** "When I hold, at the start of your next Main Phase, you may move an enemy unit to this battlefield."

### Current status
- The `event:'hold', scope:'self'` PATTERN in `triggers.ts:95` would match "When I hold …" → parseTriggers fires at `engine.ts:3217` via `collectSelf(s, ap, 'hold', heldUnitIids)`.
- The clause "at the start of your next Main Phase, you may move an enemy unit to this battlefield" is **deferred** (next turn). The generic trigger resolver would try to apply `e.moveUnit = true` immediately, which is wrong.
- **Missing:** deferred-next-turn storage. There is no `nextTurnEffect` field in `PlayerState` or `MatchState`.

### Engine anchors
- `engine.ts:3217` — where self hold triggers fire.
- `engine.ts:3052` — `fireTriggers(s, collectGlobal(s, ap, 'startOfTurn'))` — where deferred effects would need to re-trigger.
- `types.ts:103` (`PlayerState`) — where a new `pendingNextTurnPulls?: {bfIndex: number, sourceCardId: string}[]` field would live.

### Plan
1. Add `pendingNextTurnPulls?: { bfIndex: number; sourceCardId: string }[]` to `PlayerState` in `types.ts`.
2. In `fireTriggers` in `engine.ts:1140`, add a bespoke handler block for Iascylla's hold event:
   ```ts
   if (ability.event === 'hold' && srcName === 'Iascylla' && sourceIid) {
     const bi = battlefieldOf(s, sourceIid)
     if (bi >= 0) {
       if (!p.pendingNextTurnPulls) p.pendingNextTurnPulls = []
       p.pendingNextTurnPulls.push({ bfIndex: bi, sourceCardId: 'unl-050-219' })
       s = log(s, player, `${label}: Iascylla — will offer enemy pull at start of next turn.`)
     }
     handled = true
   }
   ```
3. In `beginTurn` / `fireTriggers` at the `startOfTurn` site (`engine.ts:3052`), after firing startOfTurn triggers, drain `p.pendingNextTurnPulls`:
   ```ts
   if (p.pendingNextTurnPulls?.length) {
     for (const pending of p.pendingNextTurnPulls) {
       // offer pullEnemyToBf(s, player, pending.bfIndex) — see SHARED HELPERS
     }
     p.pendingNextTurnPulls = []
   }
   ```
4. The pull offer: `offerChoice` with `kind:'moveToBf'` reversed — the enemy units are the options, the destination is fixed. **Requires a new `kind:'pullEnemyToBf'`** (or use existing `moveToBf` with options listing enemy unit iids and payload = destination bf index).
   - Cleanest: add `kind:'iascyllaActivate'` or reuse `moveToBf` where options = enemy unit iids and payload = `bfIndex:N`.

---

## 4. Imposing Challenger (unl-105-219)

**Verbatim text:** "When I move, you may move an enemy unit here with less Might than me to a different battlefield."

### Current status
- `event:'move', scope:'self'` pattern at `triggers.ts:104` matches "When I move …" → collected by `collectSelf(s2, player, 'move', moved.map(u=>u.iid))` at `engine.ts:2926`, fired by `fireTriggers` at `engine.ts:2926`.
- The clause "move an enemy unit here with less Might than me to a different battlefield" — the generic resolver does not know how to express "less Might than me" filtering or "to a different battlefield".
- **Missing:** bespoke handler in `fireTriggers` (in `engine.ts:1140+`).

### Engine anchors
- `engine.ts:2926` — self 'move' triggers fire here.
- `engine.ts:1140` — `fireTriggers` — add bespoke handler block here (after the existing attack/defend bespoke blocks ~line 1215).

### Plan
1. In `fireTriggers`, add after the existing attack handlers:
   ```ts
   if (ability.event === 'move' && srcName === 'Imposing Challenger' && sourceIid) {
     const self = findUnitAnywhere(s, sourceIid)
     const bi = sourceIid ? battlefieldOf(s, sourceIid) : -1
     if (self && bi >= 0) {
       const myMight = mightOf(self)
       const weaker = s.battlefields[bi].units.filter(u =>
         u.owner !== player && mightOf(u) < myMight && getCard(u.cardId)?.type === 'unit'
       )
       // Offer: pick which enemy to push away
       const otherBfs = s.battlefields
         .map((_, i) => i).filter(i => i !== bi)
         .map(i => ({ iid: `bf:${i}`, label: bfBaseNameAt(s, i) || `Battlefield ${i+1}` }))
       if (weaker.length && otherBfs.length) {
         // Two-step: first pick enemy unit, then pick destination
         // Use a new pendingChoice kind or auto-pick weakest enemy, strongest other bf
         const target = weaker.reduce((lo, u) => mightOf(u) < mightOf(lo) ? u : lo)
         // Auto-push to strongest contested bf (or pick via offerChoice for full fidelity)
         offerChoice(s, { player, kind: 'moveToBf', bfIndex: bi,
           prompt: `Imposing Challenger — move ${getCard(target.cardId)?.name} to which battlefield?`,
           options: otherBfs, payload: target.iid })
         s = log(s, player, `${label}: Imposing Challenger may push a weaker enemy away.`)
       }
     }
     handled = true
   }
   ```
2. The existing `moveToBf` RESOLVE_CHOICE handler already moves the unit and calls `showdownOrConquerAfterEffectMove`. No new kind needed.

---

## 5. Irresistible Faefolk (unl-112-219)

**Verbatim text:** "When I move to a battlefield, you may move an enemy unit to that battlefield."

### Current status
- `event:'move', scope:'self'` pattern matches. Fires in `collectSelf` at `engine.ts:2926`.
- Blitzcrank - Impassive has an identical "pull enemy to my battlefield" on play (`engine.ts:5281–5295`). However Blitzcrank's is on-play (bespoke), not a move trigger.
- **Missing:** bespoke handler in `fireTriggers` for the move event.

### Engine anchors
- Same as Imposing Challenger: `engine.ts:2926` fires the trigger; add handler at `engine.ts:1140+` near line 1383+.

### Plan
1. Add in `fireTriggers`:
   ```ts
   if (ability.event === 'move' && srcName === 'Irresistible Faefolk' && sourceIid) {
     const dest = battlefieldOf(s, sourceIid)
     if (dest >= 0) {
       pullEnemyToBf(s, player, dest) // see SHARED HELPERS below
       s = log(s, player, `${label}: Irresistible Faefolk — may pull an enemy here.`)
     }
     handled = true
   }
   ```
2. `pullEnemyToBf` is a shared helper that offers a choice of enemy units from other bfs, destination fixed (see SHARED HELPERS section).

---

## 6. Sinister Poro (unl-137-219)

**Verbatim text:** "When I attack, you may pay :rb_energy_1: to move an enemy unit here to its base."

### Current status
- `event:'attack', scope:'self'` pattern at `triggers.ts:97` matches "When I attack …". Fires in `fireCombatTriggers` → `collectCombat(u,'attack')` at `engine.ts:4107`.
- The clause "you may pay 1 Energy to move an enemy unit here to its base" — requires an optional energy payment + enemy-at-this-bf selection + `sendUnitToBase`.
- Generic handler cannot express the optional energy payment.
- **Missing:** bespoke handler in `fireTriggers` at `engine.ts:1140+`.

### Engine anchors
- `engine.ts:4107` — attack triggers collected.
- `engine.ts:4121` — `fireTriggers(s, combatFired, bfIndex)` — bfIndex is passed.
- `engine.ts:1140` — bespoke blocks in `fireTriggers`.
- `makeBfApi(s).payEnergy` — energy payment helper (used by Emperor's Dais etc.).

### Plan
1. Add in `fireTriggers` (after `Rell - Magnetic` handler ~line 1415):
   ```ts
   if (ability.event === 'attack' && srcName === 'Sinister Poro' && sourceIid) {
     const bi = battlefieldOf(s, sourceIid)
     const enemies = bi >= 0 ? s.battlefields[bi].units.filter(u =>
       u.owner !== player && getCard(u.cardId)?.type === 'unit') : []
     if (enemies.length && makeBfApi(s).payEnergy(player, 1)) {
       // Auto-target weakest enemy (or lowest Might). Optional → auto-pay only if affordable and there's a target.
       const victim = enemies.reduce((lo, u) => mightOf(u) < mightOf(lo) ? u : lo)
       sendUnitToBase(s, victim.iid)
       s = log(s, player, `${label}: Sinister Poro paid 1 Energy — moved ${getCard(victim.cardId)?.name} to its base.`)
     }
     handled = true
   }
   ```
2. **Note on "you may":** strictly this should prompt the player. Since `offerChoice` only supports one pending choice at a time and combat is a strict sequence, auto-pay conservatively (only when there's a target AND energy available). If the team prefers prompt-first, add `kind:'sinitserPoroAttack'` to pendingChoice.

---

## 7. Evelynn - Entrancing (unl-141-219)

**Verbatim text:** "[Hidden] (Hide now for :rb_rune_rainbow: to react with later for :rb_energy_0:.) [Backline] (I must be assigned combat damage last.) When you play me from face down on your turn, you may move an enemy unit at a different location to my battlefield."

### Current status
- REVEAL path at `engine.ts:5618–5623`:
  - Line 5619: pushes unit to `s.battlefields[bfi].units` (where `bfi` = the bf where Evelynn was facedown).
  - Line 5623: `firePlayTriggers(s, player, ci.iid, card, 0, true)` — `fromHidden=true`.
- `firePlayTriggers` at `engine.ts:1627` collects `'play', scope:'global'` triggers. Evelynn's text is "when you play me from face down" — `scope:'self'` with `fromHidden` filter.
- `parseTriggers` would generate `event:'play', scope:'self'` via the pattern at `triggers.ts:106` for "when you play me".
- The `fromHidden` filter at `engine.ts:1637` keeps it only when `fromHidden=true` — correctly.
- **Missing:** the clause "move an enemy unit at a different location to my battlefield" — the generic resolver would parse `moveUnit=true` but without knowing "my battlefield" is the destination, not a free choice. Needs bespoke handling.

### Engine anchors
- `engine.ts:5618–5623` — REVEAL unit path; `bfi` is Evelynn's battlefield index.
- `engine.ts:1627–1645` — `firePlayTriggers` — from here, bespoke play-from-hidden handler can be injected before `fireTriggers` is called.
- `engine.ts:1140+` — alternative: add bespoke block in `fireTriggers` checking `fromHidden` implicitly via the trigger's text.

### Plan
Option A (cleanest): Add a bespoke block after `applyParsed(s, s.players[action.player], onPlayEffect(card), bfi, ci.iid)` at `engine.ts:5622`, directly in the REVEAL case:
```ts
// Evelynn - Entrancing: pull an enemy at a DIFFERENT location to bfi
if (card.name.startsWith('Evelynn') && /when you play me from face down/i.test(card.text ?? '')) {
  pullEnemyToBf(s, action.player, bfi, { excludeBf: bfi })
  s = log(s, action.player, `Evelynn - Entrancing: may pull an enemy to her battlefield.`)
}
```
- `pullEnemyToBf(s, player, destBf, { excludeBf })` — see SHARED HELPERS.
- `excludeBf: bfi` ensures only enemies at OTHER locations are eligible.

Option B: Handle in `fireTriggers` by detecting `srcName === 'Evelynn - Entrancing'` on `event:'play'`, then calling `pullEnemyToBf` with the source's current bf.

**Recommend Option A** — the battlefield index is immediately available in the REVEAL case.

---

## 8. Void Assault (unl-202-219)

**Verbatim text:** "Move a friendly unit, then move an enemy unit. (If they both move to a battlefield you don't control, you're the attacker.)"

### Current status
- `e.moveUnit = true` from `effects.ts:583–585` (matches "move … enemy units?"). The "move a friendly unit" part is NOT parsed — the regex at `effects.ts:583` matches any unit; but the spell involves two distinct targets: a friendly unit (player picks destination) + an enemy unit (player picks destination).
- The parser currently captures only one `moveUnit = true` flag; there is no `moveFriendly` or sequenced two-move structure.
- The "(If they both move to a battlefield you don't control, you're the attacker.)" parenthetical is about the role in any resulting showdown — this is non-trivial.
- **Fully missing:** dual-move sequencing, attacker-role injection.

### Engine anchors
- `engine.ts:4503–4514` — `e.moveUnit` block — add Void Assault special case here.
- `engine.ts:5745–5761` — `moveToBf` resolver — would need to recognize a "second step" for Void Assault.
- `engine.ts:2876–2955` — `moveUnits` function — where `moverOwner` is set; the showdown opens with the mover as the "attacker-side".
- `types.ts:291` — `pendingChoice.kind` union — add `'voidAssaultFriendly'` and `'voidAssaultEnemy'`.

### Plan
1. In `resolveSpellEffects`, add a Void Assault early-return block:
   ```ts
   if (card.name === 'Void Assault') {
     // Step 1: offer the player to pick a friendly unit to move
     const friendly = [...p.zones.base, ...s.battlefields.flatMap(b => b.units)]
       .filter(u => u.owner === controller && !u.exhausted && getCard(u.cardId)?.type === 'unit')
       .map(u => ({ iid: u.iid, label: getCard(u.cardId)?.name ?? u.iid }))
     offerChoice(s, { player: controller, kind: 'voidAssaultFriendly', bfIndex: -1,
       prompt: 'Void Assault — choose a friendly unit to move.', options: friendly })
     return s
   }
   ```
2. Add `'voidAssaultFriendly'` and `'voidAssaultEnemy'` to `pendingChoice.kind` in `types.ts:291`.
3. In `RESOLVE_CHOICE`, after existing moveToBf block:
   ```ts
   if (pc.kind === 'voidAssaultFriendly') {
     // action.iid = friendly unit iid, second choice: pick destination
     // ... offer destination choice, store friendly unit iid in payload
     // then pendingChoice = { kind: 'voidAssaultFriendlyDest', payload: friendlyIid, ... }
   }
   if (pc.kind === 'voidAssaultFriendlyDest') {
     // move friendly unit to chosen bf (via pluckCardAnywhere + push + recomputeControllers)
     // then offer enemy unit pick → kind:'voidAssaultEnemy'
   }
   if (pc.kind === 'voidAssaultEnemy') {
     // action.iid = enemy unit iid, offer dest → kind:'voidAssaultEnemyDest', payload carries both iids + friendly dest
   }
   if (pc.kind === 'voidAssaultEnemyDest') {
     // move enemy, then check: if both landed at a bf the controller does NOT control,
     // open showdown with controller as the "mover" (attacker) via:
     //   s.showdown.movedUnit = friendlyUnit.iid (or a synthetic flag)
     // call showdownOrConquerAfterEffectMove with the enemy's dest bf
   }
   ```
4. **Attacker role:** `moveUnits` at `engine.ts:2919` emits `{kind:'move'}` and at `engine.ts:2929–2940` sets `s.showdown.priority` to `nextShowdownPriority`. For effect-driven moves, `showdownOrConquerAfterEffectMove` uses `movedOwner` as the showdown initiator. For Void Assault the caster is always the attacker regardless of which unit moved where. In the `voidAssaultEnemyDest` resolver, set `s.showdown.movedUnit = friendlyUnitIid` (the caster's unit) so the showdown logic sees the caster's side as the mover/attacker.

---

## 9. Blast Cone (unl-133-219)

**Verbatim text:** "When you play this, you may move an enemy unit. When you move an enemy unit, you may exhaust this to [Stun] it. (It doesn't deal combat damage this turn.)"

### Current status
**Part 1:** "When you play this, you may move an enemy unit" — spells resolve via `resolveSpellEffects`. `e.moveUnit = true` from the parser → `offerChoice(moveToBf)` fires. This part works.

**Part 2:** "When you move an enemy unit, you may exhaust this to [Stun] it." — this is a **reactive trigger** on ANY enemy move by the controller (not just Blast Cone's own effect). There is no `'moveEnemy'` trigger event in the engine. The existing `TriggerEvent` union (`triggers.ts:17–43`) has `'move'` (a unit the player controls makes a Standard Move), but NOT "enemy unit is moved."

**Missing:** A reactive trigger site when any enemy unit is effect-moved.

### Engine anchors
- `engine.ts:5745–5761` — `moveToBf` resolver — the only place where effect-moves of enemy units land.
- `engine.ts:2876` — `moveUnits` — friendly player moves, NOT enemies.
- `engine.ts:4503–4514` — `e.moveUnit` block — this triggers the choice; the result is resolved in `moveToBf`.
- No existing "enemy move" event hook.

### Plan
**Part 1:** Already works — skip.

**Part 2 — Reactive exhaust-to-stun:**

Option A (simplest — event hook in moveToBf resolver):
After an enemy unit is moved in the `moveToBf` RESOLVE_CHOICE block (`engine.ts:5756`), add:
```ts
// Fire "when you move an enemy unit" reactive triggers
// The mover's controller = action.player; the moved card is `card` (enemy)
const blast = [...s.players[action.player].zones.base, ...s.battlefields.flatMap(b=>b.units)]
  .find(u => u.owner === action.player && getCard(u.cardId)?.name === 'Blast Cone' && !u.exhausted)
if (blast && card.owner !== action.player) {
  blast.exhausted = true
  const movedUnit = s.battlefields[dest].units.find(u => u.iid === card.iid)
  if (movedUnit) {
    movedUnit.stunned = true
    emit({ kind: 'stun', iid: movedUnit.iid, player: action.player })
    s = log(s, action.player, `Blast Cone: exhausted to [Stun] the moved enemy.`)
    s = fireStun(s, action.player)
  }
}
```
- This is auto-pay (optional = "you may"). Strictly should prompt; but auto-pay is always correct if Blast Cone is ready.

Option B (more modular): Add a `'moveEnemy'` TriggerEvent, emit it from `moveToBf` resolver, and collect it. However, adding a new TriggerEvent requires changes in `triggers.ts`, `TRIGGER_EVENTS` array, and `TriggerEvent` union. Overkill for one card.

**Recommend Option A** — inline bespoke check in the `moveToBf` resolver.

---

## SHARED HELPERS

### `pullEnemyToBf(s, player, destBfIndex, opts?)`

Needed by: Iascylla (deferred), Irresistible Faefolk, Imposing Challenger (partial), Evelynn - Entrancing, and potentially Sinister Poro (different — it goes to base).

Suggested signature (add near `sendUnitToBase` at `engine.ts:2326`):
```ts
/** Offer the player to pull an enemy unit from another battlefield to `destBfIndex`.
 *  opts.excludeBf = do not offer enemies already at destBfIndex (default: destBfIndex).
 *  Uses offerChoice(kind:'moveToBf') with fixed dest encoded in options as
 *  a single "bf:N" option — CALLER immediately passes destination; player picks UNIT.
 *  Because moveToBf's RESOLVE_CHOICE reads action.iid as the destination "bf:N",
 *  we need a DIFFERENT pendingChoice kind where action.iid = enemy unit iid and
 *  payload = destBfIndex.
 */
function offerPullEnemyToBf(
  s: MatchState,
  player: PlayerId,
  destBfIndex: number,
  prompt: string,
): void {
  const enemies = s.battlefields
    .flatMap((b, bi) => bi === destBfIndex ? [] : b.units.filter(
      u => u.owner !== player && getCard(u.cardId)?.type === 'unit'
    ))
    .map(u => ({ iid: u.iid, label: getCard(u.cardId)?.name ?? u.iid }))
  offerChoice(s, {
    player,
    kind: 'pullEnemyToBf',        // NEW kind
    bfIndex: destBfIndex,
    prompt,
    options: enemies,
    payload: String(destBfIndex), // destination index
  })
}
```

Then add `'pullEnemyToBf'` to `pendingChoice.kind` in `types.ts:291` and handle in `RESOLVE_CHOICE`:
```ts
if (pc.kind === 'pullEnemyToBf') {
  if (action.iid !== null) {
    const dest = pc.bfIndex
    const pulled = pluckCardAnywhere(s, action.iid)
    if (pulled && s.battlefields[dest]) {
      const priorCtrl = s.battlefields[dest].controller
      s.battlefields[dest].units.push(pulled)
      recomputeControllers(s)
      s = log(s, action.player, `Pulled ${getCard(pulled.cardId)?.name} to ${bfBaseNameAt(s, dest) || `Battlefield ${dest+1}`}.`)
      s = showdownOrConquerAfterEffectMove(s, dest, pulled.iid, priorCtrl)
    }
  } else {
    s = log(s, action.player, 'Pull — declined.')
  }
  return ok(s)
}
```

---

## Summary Table

| Card | ID | Status | Primary Anchor | New pendingChoice kinds |
|---|---|---|---|---|
| Charm | ogn-043-298 | DONE | — | — |
| Skyward Strike | unl-038-219 | DONE | — | — |
| Isolate | unl-124-219 | DONE | engine.ts:4494 | — |
| Dragon's Rage | ogn-258-298 | MISSING collision | engine.ts:5745 | `'dragonsRageCollision'` |
| Temptation | sfd-129-221 | MISSING dest filter | engine.ts:4503 | none |
| Iascylla | unl-050-219 | MISSING deferred | types.ts + engine.ts:3052 | `'pullEnemyToBf'` (shared) |
| Imposing Challenger | unl-105-219 | MISSING bespoke | engine.ts:2926 trigger | reuses `'moveToBf'` |
| Irresistible Faefolk | unl-112-219 | MISSING bespoke | engine.ts:2926 trigger | `'pullEnemyToBf'` (shared) |
| Sinister Poro | unl-137-219 | MISSING bespoke | engine.ts:4107 combat | none (auto-pay) |
| Evelynn - Entrancing | unl-141-219 | MISSING bespoke | engine.ts:5622 REVEAL | `'pullEnemyToBf'` (shared) |
| Void Assault | unl-202-219 | MISSING entirely | engine.ts:4276 resolveSpell | `'voidAssaultFriendly'` + `'voidAssaultFriendlyDest'` + `'voidAssaultEnemy'` + `'voidAssaultEnemyDest'` |
| Blast Cone | unl-133-219 | Part 1 works; Part 2 missing | engine.ts:5756 moveToBf | none (inline bespoke) |

---

## Implementation Order Recommendation

1. **`pullEnemyToBf` helper** — unblocks Iascylla, Irresistible Faefolk, Imposing Challenger (partial), Evelynn. Add to `types.ts:291` and `engine.ts` near `engine.ts:2342`.
2. **Temptation dest filter** — 3-line change in `engine.ts:4503`.
3. **Isolate** — already done, no action.
4. **Irresistible Faefolk + Imposing Challenger** — bespoke blocks in `fireTriggers` (`engine.ts:1383+`).
5. **Evelynn** — bespoke block in REVEAL case (`engine.ts:5622`).
6. **Sinister Poro** — bespoke attack block in `fireTriggers` (`engine.ts:1404+`).
7. **Iascylla** — add `pendingNextTurnPulls` to `PlayerState` in `types.ts:103`, drain in `engine.ts:3052`.
8. **Dragon's Rage** — add `sourceCardId` to pendingChoice or store in payload JSON; add `'dragonsRageCollision'` choice kind.
9. **Blast Cone Part 2** — inline check in `moveToBf` resolver (`engine.ts:5756`).
10. **Void Assault** — largest lift; 4 new choice kinds + multi-step resolver logic.
