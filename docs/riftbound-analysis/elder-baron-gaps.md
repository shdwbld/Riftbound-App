# Elder Dragon + Baron Nashor + Baron Pit — Gap Report

Generated: 2026-06-06

---

## 1. Elder Dragon (unl-118-219)

### Current state
- **Passive lethality (spell/ability paths)** — DONE.  
  `applyTargetDamage` (engine.ts:2787) checks `elderLethal` and kills any enemy whose `owner !== caster` when any nonzero damage is dealt. Both the battlefield loop and the base loop apply this.
- **On-play effect** — DONE (auto-pick).  
  engine.ts:5224–5232: on play, `strongestEnemy` picks the highest-Might enemy at each battlefield and each opponent base; calls `applyTargetDamage(..., 1, true, action.player)` (spellLike=true so `elderLethal` fires). Auto-pick is explicitly correct — the card reads "choose up to one", but since 1 damage is always lethal via the passive, giving the controller a manual target-picker would add friction with no strategic upside. Auto-picking strongest is the right UX.

### Gap — COMBAT-damage lethality

**Problem:** `applyTargetDamage` is never called during a showdown. Combat damage flows through a separate pipeline:

1. `showdownSteps` (engine.ts:4004) calls `buildAssignStep` (4683) which calls `assignDamage` (3646).
2. `assignDamage` marks a unit `defeated` only when `remaining >= hp` (line 3659). There is no Elder Dragon hook here.
3. `finalizeShowdown` (engine.ts:4100) then reads `defendersDefeated` / `attackersDefeated` from the pre-computed steps and applies saves/deaths. Again no lethality override.
4. Manual allocation is validated by `validateAllocation` (engine.ts:3904) which enforces `v > step.hp[iid]` is an error (line 3914) and only allows sub-lethal assignment to one unit at a time (kill-order, line 3920). None of this respects Elder Dragon.

**Consequence:** If the Elder Dragon controller has 10 attack Might and faces a 12-Might defender, the defender survives. The passive never fires.

### Recommended bespoke fix (two touch-points)

#### Touch-point A — `assignDamage` lethality override (engine.ts:3646)

Add an optional `elderLethal: boolean` parameter. When true and `damage > 0`, any enemy unit with `hp > 0` is immediately defeated regardless of how much damage remains:

```ts
function assignDamage(
  damage: number,
  units: EngineCard[],
  role: CombatRole,
  xpOf: (u: EngineCard) => number = () => 0,
  bonusOf: (u: EngineCard, role: CombatRole) => number = () => 0,
  elderLethal = false,   // NEW
): Set<string> {
  const defeated = new Set<string>()
  let remaining = damage
  for (const u of units) {
    if (remaining <= 0 && !elderLethal) break   // skip if no damage AND not lethal-all
    const hp = mightOf(u, role, xpOf(u)) + bonusOf(u, role)
    if (hp <= 0) continue
    if (elderLethal && damage > 0) {
      defeated.add(u.iid)   // any nonzero total attack = lethal to each enemy
    } else if (remaining >= hp) {
      defeated.add(u.iid)
      remaining -= hp
    } else {
      remaining = 0
    }
  }
  return defeated
}
```

#### Touch-point B — pass the flag from `buildAssignStep` (engine.ts:3683) and `showdownSteps` (engine.ts:4004)

`buildAssignStep` must accept an `elderLethal` flag and pass it down:

```ts
function buildAssignStep(
  dealer: PlayerId,
  side: 'attackers' | 'defenders',
  receiving: EngineCard[],
  amount: number,
  manualAllowed: boolean,
  xpOf: ...,
  bonusOf: ...,
  isTank: ...,
  elderLethal = false,   // NEW
): DamageAssignStep {
  ...
  const defeated = manual ? [] : [...assignDamage(amount, ordered, role, xpOf, bonusOf, elderLethal)]
  return { dealer, side, targets: ..., amount, manual, defeated, hp, tanks }
}
```

In `showdownSteps` (engine.ts:4004) compute `elderLethal` for the attacker's step:

```ts
const attackerIsElderPlayer = controlsUnitNamed(s, moverOwner, 'Elder Dragon')
// Attacker step: moverOwner deals to defenders — Elder Lethal when dragon is theirs
buildAssignStep(moverOwner, 'defenders', defenders, attackMight, true, xpOf, bonusOf, isTank,
  attackerIsElderPlayer && attackMight > 0)
// Defender step: the other side deals to attackers — Elder Lethal when attacker owns dragon & it's their counter
// (Elder text says "your damage is lethal" — only the Elder controller's combat damage is lethal)
buildAssignStep(atkDealer, 'attackers', attackers, defendMight, true, xpOf, bonusOf, isTank,
  controlsUnitNamed(s, atkDealer, 'Elder Dragon') && defendMight > 0)
```

**Note on `manual` suppression:** When `elderLethal` is true and the attacker has 1+ damage, every enemy is lethalled regardless of distribution choice. The `manual` flag becomes irrelevant on that step (you can force `manual = false` when `elderLethal` is true to skip the pause).

#### Touch-point C — `validateAllocation` (engine.ts:3904)

If for any reason a manual step is still shown when Elder Dragon is in play, `validateAllocation` will incorrectly reject `v < hp` as sub-lethal. Either suppress manual steps (preferred) or pass `elderLethal` to `validateAllocation` and skip the kill-order check when it is true.

### On-play auto-pick note

The card text is "choose up to one enemy unit at each location." The current auto-pick (strongest enemy) is acceptable for a simulator — it is always the optimal play since 1 damage is lethal and strongest-first mirrors expected play. No manual target picker is needed unless the design calls for player agency (e.g. choosing which enemy NOT to kill). Current approach is correct.

---

## 2. Baron Nashor (unl-147-219)

### Current state
- **+2 friendly aura** — DONE (engine.ts:2252–2253).
- **Targeting immunity** — DONE (`untargetableByEnemy`, engine.ts:6629–6636).
- **On-play Baron Pit effect** — MISSING entirely.

### Gap — Baron Pit on-play

**Card text:** "As you play me, add the Baron Pit battlefield token to the board if it's not there already. If you do, I enter there."

**Key facts from recon:**
- Baron Pit card exists: id `unl-t01-219`, name `"Baron Pit"`, type `"battlefield"`, in `src/data/extraCards.json` (line 1–11). No `text` field yet.
- `MatchState.battlefields` is a fixed-length array initialized once at game start (engine.ts:4683): `s.battlefields = bfIds.map(...)`. The engine has no mechanism to add a 4th slot to this array mid-game — it only has in-place replacement (Ivern's `s.battlefields[targetBf].cardId = BRUSH_ID`, engine.ts:1458).
- `moveUnits` validates `toBattlefield >= battlefields.length` as an error (engine.ts:2850).

**Cleanest bespoke approach:**

Use the Ivern precedent (in-place replacement) rather than truly appending a new slot. On-play:

1. Check if any existing battlefield already has `cardId === 'unl-t01-219'` (Baron Pit already on board → skip).
2. If not present, pick a target slot. The natural choice: **the battlefield with the fewest total units** (least disruption), or any uncontrolled battlefield, or simply the last slot. The rule text doesn't specify which existing battlefield is replaced — it just says "add Baron Pit to the board." Since a 4th slot is impossible without a UI overhaul, replace the least-contested existing slot (or make it a `pendingChoice` if the player should choose).
3. Set `s.battlefields[targetSlot].cardId = 'unl-t01-219'`. Existing units at that slot remain.
4. Then move Baron Nashor itself from its post-play base position to `targetSlot`. Use the same `s.battlefields[targetSlot].units.push(baronUnit)` + remove from base pattern that `showdownOrConquerAfterEffectMove` uses.

**Implementation location:** Add a bespoke block immediately after `firePlayTriggers` for `'Baron Nashor'` in the `PLAY_UNIT` handler (engine.ts:~5220, same region as the Elder Dragon block at 5224). Pattern:

```ts
if (card.name === 'Baron Nashor') {
  const BARON_PIT_ID = 'unl-t01-219'
  const alreadyOnBoard = s1.battlefields.some((b) => b.cardId === BARON_PIT_ID)
  if (!alreadyOnBoard) {
    // Pick the slot to replace: prefer uncontrolled, else fewest units, else index 0.
    const slotIdx = (() => {
      const empty = s1.battlefields.findIndex((b) => b.controller == null)
      if (empty >= 0) return empty
      return s1.battlefields.reduce((best, b, i) => b.units.length < s1.battlefields[best].units.length ? i : best, 0)
    })()
    s1.battlefields[slotIdx].cardId = BARON_PIT_ID
    recomputeControllers(s1)
    s1 = log(s1, action.player, `Baron Nashor: added Baron Pit (slot ${slotIdx + 1}).`)
    // Move Baron Nashor itself to that slot (it was just placed on base by the play flow).
    const baronIdx = s1.players[action.player].zones.base.findIndex((u) => u.iid === ci.iid)
    if (baronIdx >= 0) {
      const baron = s1.players[action.player].zones.base.splice(baronIdx, 1)[0]
      s1.battlefields[slotIdx].units.push({ ...baron, exhausted: true })
      recomputeControllers(s1)
      s1 = log(s1, action.player, `Baron Nashor entered Baron Pit.`)
      // Check for showdown or conquer.
      s1 = showdownOrConquerAfterEffectMove(s1, slotIdx, ci.iid, s1.battlefields[slotIdx].controller)
    }
  }
}
```

**Important caveat — UI rendering:** `MatchBoard.tsx:1312` renders `match.battlefields.map(...)` — it already handles a dynamic-length array, so adding (or replacing) a battlefield slot will render correctly. The in-place replacement approach means no new UI slots are needed.

---

## 3. Baron Pit (unl-t01-219) — Battlefield Token

### Current state

Card data: exists in `src/data/extraCards.json` (line 1–11) with `type: "battlefield"`, but **no `text` field** and **no `bfScript` entry** in `battlefieldScripts.ts`. The card's ability ("Units can move here from anywhere.") is completely unimplemented.

### Verbatim text (from Baron Nashor card data parenthetical)

> "Units can move here from anywhere."

### Gap — Movement override

**How movement works:**

In `moveUnits` (engine.ts:2842–2884), when a unit is moving from one battlefield to another (not from base), it must pass the `unitHasGanking` check (engine.ts:2870):

```ts
const hasGank = unitHasGanking(s, gankU) || !!bfScriptAt(s, i)?.grantsGanking
if (!hasGank)
  return fail(state, 'Only units with Ganking can move between battlefields.')
```

Currently `grantsGanking` is a source-battlefield flag (Windswept Hillock: units AT the Hillock can move to any other bf). "Move here from anywhere" is the **destination**-side version: any unit at any other battlefield may move to Baron Pit regardless of Ganking.

The validation check on line 2870 only consults `bfScriptAt(s, i)` where `i` is the **source** battlefield index. There is no destination-side bypass.

### Recommended fix

Add a second flag `grantsGankingDest?: boolean` to `BattlefieldScript` (`battlefieldScripts.ts:51`):

```ts
/** Any unit at any battlefield can move TO here (Baron Pit). */
grantsGankingDest?: boolean
```

Register it in `SCRIPTS` (`battlefieldScripts.ts:88`):

```ts
'Baron Pit': { grantsGankingDest: true },
```

In `moveUnits` (engine.ts:2866–2872), after computing `hasGank`, add a destination check:

```ts
const destAllowsIncoming = !!bfScriptAt(s, toBattlefield)?.grantsGankingDest
const hasGank = unitHasGanking(s, gankU) || !!bfScriptAt(s, i)?.grantsGanking || destAllowsIncoming
if (!hasGank)
  return fail(state, 'Only units with Ganking can move between battlefields.')
```

Also add the `text` field to Baron Pit in `extraCards.json`:

```json
"text": "Units can move here from anywhere."
```

---

## Summary of all gaps

| Card | Gap | File:Lines | Status |
|------|-----|-----------|--------|
| Elder Dragon | Combat-damage lethality not applied | engine.ts:3646–3666 (`assignDamage`), 3683–3702 (`buildAssignStep`), 4004–4029 (`showdownSteps`) | MISSING |
| Elder Dragon | `validateAllocation` allows sub-lethal allocation that violates elder rule | engine.ts:3904–3925 | Needs suppression of manual step |
| Baron Nashor | On-play: add Baron Pit to board + enter there | engine.ts:~5224 (PLAY_UNIT handler) | MISSING |
| Baron Pit | No `text` field in extraCards.json | src/data/extraCards.json:1–11 | MISSING |
| Baron Pit | No `bfScript` entry → "move here from anywhere" not implemented | src/engine/battlefieldScripts.ts:88+ | MISSING |
| Baron Pit | No destination-side Ganking bypass in `moveUnits` | engine.ts:2866–2872 | MISSING |

---

## New flags / symbols needed

- `grantsGankingDest?: boolean` on `BattlefieldScript` (`battlefieldScripts.ts`)
- Optional `elderLethal?: boolean` param on `assignDamage` + `buildAssignStep`

No new `MatchState` fields needed. `pendingChoice` could optionally be used for Baron Nashor's slot selection, but auto-pick (least-contested slot) is simpler and sufficient.
