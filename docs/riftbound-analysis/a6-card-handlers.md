# A6 Card Handler Design: Possession · Hostile Takeover · Akshan - Mischievous

_Research date: 2026-06-06_

---

## 1. Card Verification

### 1.1 Possession
| Field | Value |
|-------|-------|
| **Confirmed id** | `ogn-203-298` (matches guess) |
| **Name** | Possession |
| **Type** | spell |
| **Energy cost** | 8 |
| **Domain** | Chaos ×3 |
| **Speed** | Action |
| **Rarity** | epic · OGN |
| **Alternates / promos** | **None** — only one entry in cards.generated.json |

**Full verbatim text:**
> [Action] (Play on your turn or in showdowns.) Choose an enemy unit at a battlefield. Take control of it and recall it. (Send it to your base. This isn't a move.)

---

### 1.2 Hostile Takeover
| Field | Value |
|-------|-------|
| **Confirmed id** | `sfd-202-221` (matches guess) |
| **Name** | Hostile Takeover |
| **Type** | spell |
| **Energy cost** | 5 |
| **Domain** | Mind ×2 |
| **Speed** | Hidden (Sorcery) |
| **Supertype** | signature (Renata Glasc) |
| **Rarity** | epic · SFD |
| **Alternates / promos** | **None** — only one entry in cards.generated.json |

**Full verbatim text:**
> [Hidden] (Hide now for :rb_rune_rainbow: to react with later for :rb_energy_0:.) Take control of an enemy unit at a battlefield. Ready it. (Start a combat if other enemies are there. Otherwise, conquer.) Lose control of that unit and recall it at end of turn. (Send it to base. This isn't a move.)

---

### 1.3 Akshan - Mischievous
| Field | Value |
|-------|-------|
| **Confirmed id** | `sfd-109-221` (matches guess) |
| **Name** | Akshan - Mischievous |
| **Type** | unit |
| **Energy cost** | 4 |
| **Might** | 4 |
| **Domain** | Body |
| **Supertype** | champion |
| **Rarity** | rare · SFD |
| **Alternates / promos** | **None** — only one entry in cards.generated.json |

**Full verbatim text:**
> [Weaponmaster] You may pay :rb_rune_body::rb_rune_body: as an additional cost to play me. When you play me, if you paid the additional cost, move an enemy gear to your base. You control it until I leave the board. If it's an Equipment, attach it to me.

---

## 2. Engine Anchors

All three cards are bespoke (the parser cannot express "take control" or "steal gear with on-leave revert"). They must be handled with explicit name checks, exactly as `Void Assault`, `Baron Nashor`, and `Azir - Ascendant` are handled.

### Key primitives (engine.ts line references)

| Primitive | Location |
|-----------|----------|
| `recallToBase(s, u)` | line 3082 — pushes unit (unchanged `owner`) to `s.players[u.owner].zones.base` exhausted |
| `recomputeControllers(s)` | line 3260 — recomputes bf controller from `u.owner` counts (NOT `controlledBy`) |
| `showdownOrConquerAfterEffectMove(s, bfIndex, iid, priorCtrl)` | line 3229 — opens showdown if enemies present, else conquer |
| `sendUnitToBase(s, iid)` | line 2592 — pulls unit off a battlefield into its `owner`'s base, exhausted |
| `pluckCardAnywhere(s, iid)` | line 1084 — removes and returns an EngineCard from any zone |
| `END_TURN cleanup block` | line 6995–7031 — per-turn revert pass; `beginTurn(s)` called at end |
| `optionalPlayCost(card)` in keywords.ts | line 301 — parses "you may pay X as an additional cost" from card text |
| `paidBonusEffect(card)` in effects.ts | line 999 — parses "if you paid the additional cost, …" clause |
| `paidAdditional` gate in PLAY_UNIT | engine.ts line 5447 — `action.payAdditionalCost && !!optPlayCost` |
| `if (paidAdditional)` block | engine.ts line 5601 — where paidBonus effects are applied |

---

## 3. How `controlledBy` Interacts with `recomputeControllers`

**Critical insight:** `EngineCard` has no `controlledBy` field. The engine does not use a per-card "controlled by" override. Battlefield control is computed entirely by `recomputeControllers` from `u.owner` counts (lines 3266-3281):

```
counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1)
```

This means:
- **Possession and Hostile Takeover cannot work by just changing `bf.controller`** — `recomputeControllers` will immediately overwrite it on the next call.
- The engine model for "take control of an enemy unit" must **mutate `u.owner`** to the casting player, so `recomputeControllers` correctly counts it for the new side.
- `recallToBase(s, u)` sends a unit to `s.players[u.owner].zones.base`, so with `u.owner` mutated, it correctly lands in the caster's base.
- For **Hostile Takeover's end-of-turn revert**, `u.owner` must be reset to the original owner before the recall, so `recallToBase` sends it back to the right player.

**No `controlledBy` field exists or needs to be added.** The pattern is: mutate `owner`, then `recallToBase`, then `recomputeControllers`.

---

## 4. Handler Designs

### 4.1 Possession (`ogn-203-298`)

**Hook:** Bespoke block inside `resolveSpellEffects` (engine.ts ~line 4582), checked by `card.name === 'Possession'`, placed before the generic `applyParsed` path.

**Effect summary:** Choose an enemy unit at ANY battlefield. Permanently change its `owner` to the caster. Recall it (send to caster's base exhausted).

**Algorithm:**

```typescript
// Inside resolveSpellEffects, after existing bespoke guards:
if (card.name === 'Possession') {
  // Auto-pick: strongest enemy unit at any battlefield (or use targets[0] if provided)
  const allEnemyAtBf = s.battlefields
    .flatMap((b, i) => b.units
      .filter(u => u.owner !== controller)
      .map(u => ({ u, bfIndex: i }))
    )
  const chosen = targets?.[0]
    ? allEnemyAtBf.find(x => x.u.iid === targets[0])
    : allEnemyAtBf.sort((a, b) => mightOf(b.u) - mightOf(a.u))[0]
  if (!chosen) return log(s, controller, `${card.name} fizzled — no enemy unit at a battlefield.`)

  const { u, bfIndex } = chosen
  const oldOwner = u.owner
  const cardName = getCard(u.cardId)?.name ?? u.iid

  // 1. Remove from battlefield
  s.battlefields[bfIndex].units = s.battlefields[bfIndex].units.filter(x => x.iid !== u.iid)

  // 2. Permanently change owner to caster (owner, NOT a temp field)
  u.owner = controller

  // 3. Recall to caster's base (recallToBase uses u.owner, now = controller)
  recallToBase(s, u)
  // recallToBase: s.players[u.owner].zones.base.push({ ...u, exhausted: true, damage: 0 })

  // 4. Recompute battlefield control
  recomputeControllers(s)

  return log(s, controller,
    `${card.name}: took control of ${cardName} (was ${s.players[oldOwner].name}'s) — recalled to your base.`)
}
```

**Targeting:** Possession is an [Action] spell. In showdown path it resolves immediately via `resolveSpellEffects`. In action-phase path it goes on the chain and resolves when the chain resolves (line 5075). The `action.targets` array carries the target iid from the UI; auto-pick is the fallback.

**Note:** `owner` mutation is permanent. There is no revert. The stolen unit is now yours forever (goes to your trash when killed, etc.).

---

### 4.2 Hostile Takeover (`sfd-202-221`)

**Hook:** Bespoke block inside `resolveSpellEffects`, checked by `card.name === 'Hostile Takeover'`. Additionally, a revert entry in the `END_TURN` cleanup block (engine.ts ~line 7001).

**Effect summary:** Temporarily change a battlefield enemy's `owner` to caster. Ready it. Trigger `showdownOrConquerAfterEffectMove` (so it can fight or conquer). Revert at end of turn: reset `owner` to original, recall to original owner's base.

**New MatchState field required:**

```typescript
// In types.ts MatchState:
/** Hostile Takeover: units temporarily stolen this turn.
 *  Reverted at END_TURN before beginTurn. */
hostileTakeoverRevert?: { iid: string; originalOwner: PlayerId }[]
```

**Algorithm (resolveSpellEffects):**

```typescript
if (card.name === 'Hostile Takeover') {
  const allEnemyAtBf = s.battlefields
    .flatMap((b, i) => b.units
      .filter(u => u.owner !== controller)
      .map(u => ({ u, bfIndex: i }))
    )
  const chosen = targets?.[0]
    ? allEnemyAtBf.find(x => x.u.iid === targets[0])
    : allEnemyAtBf.sort((a, b) => mightOf(b.u) - mightOf(a.u))[0]
  if (!chosen) return log(s, controller, `${card.name} fizzled — no enemy unit at a battlefield.`)

  const { u, bfIndex } = chosen
  const originalOwner = u.owner
  const cardName = getCard(u.cardId)?.name ?? u.iid
  const priorCtrl = s.battlefields[bfIndex].controller

  // 1. Change owner temporarily
  u.owner = controller

  // 2. Ready the unit (card says "Ready it")
  u.exhausted = false

  // 3. Register for end-of-turn revert
  if (!s.hostileTakeoverRevert) s.hostileTakeoverRevert = []
  s.hostileTakeoverRevert.push({ iid: u.iid, originalOwner })

  // 4. Recompute — unit now counts for caster's side
  recomputeControllers(s)

  // 5. Trigger showdown or conquer (card says "Start a combat if other enemies
  //    are there. Otherwise, conquer.")
  s = showdownOrConquerAfterEffectMove(s, bfIndex, u.iid, priorCtrl)

  return log(s, controller,
    `${card.name}: took control of ${cardName} until end of turn (readied).`)
}
```

**Algorithm (END_TURN cleanup, engine.ts ~line 7001):**

Insert before the "empty pool" line (~line 7027), within the `case 'END_TURN'` block:

```typescript
// Hostile Takeover: revert all temporarily stolen units at end of turn.
if (s.hostileTakeoverRevert?.length) {
  for (const entry of s.hostileTakeoverRevert) {
    const u = findUnitAnywhere(s, entry.iid)
    if (!u) continue
    // Reset owner to original, then recall to original owner's base.
    const stolenByName = s.players[u.owner].name
    u.owner = entry.originalOwner
    // Remove from wherever it currently is
    const bfi = s.battlefields.findIndex(b => b.units.some(x => x.iid === u.iid))
    if (bfi >= 0) {
      s.battlefields[bfi].units = s.battlefields[bfi].units.filter(x => x.iid !== u.iid)
    } else {
      s.players[u.owner === entry.originalOwner ? s.activePlayer : u.owner].zones.base =
        s.players[s.activePlayer].zones.base.filter(x => x.iid !== u.iid)
      // Simpler: pluckCardAnywhere handles all zones
    }
    // Use recallToBase (now u.owner = originalOwner, so it goes to their base)
    recallToBase(s, u)
    recomputeControllers(s)
    s = log(s, ender, `Hostile Takeover: ${getCard(u.cardId)?.name ?? u.iid} reverted to ${s.players[entry.originalOwner].name} and recalled.`)
  }
  s.hostileTakeoverRevert = []
}
```

**Cleaner revert using pluckCardAnywhere:**
```typescript
const pulled = pluckCardAnywhere(s, entry.iid)
if (pulled) {
  pulled.owner = entry.originalOwner
  recallToBase(s, pulled)
  recomputeControllers(s)
}
```

**Hidden timing:** Hostile Takeover has `[Hidden]` — it can be hidden facedown and revealed as a reaction for 0 Energy. The Hidden reveal path (`kind: 'revealHidden'` in engine) calls `resolveSpellEffects` with the same card, so the bespoke guard fires correctly on reveal too.

---

### 4.3 Akshan - Mischievous (`sfd-109-221`)

**Hook:** Bespoke block inside the `if (paidAdditional)` block (engine.ts line 5601), checked by `card.name === 'Akshan - Mischievous'` (or matching base name after stripping alternate-art suffix). This replaces the generic `applyParsed(paidBonusEffect(card))` call for this card.

**Additional cost mechanism:** Already fully wired:
1. `optionalPlayCost(card)` in keywords.ts (line 301) parses `:rb_rune_body::rb_rune_body:` from the text → `{ energy: 0, power: { body: 2 } }`.
2. `action.payAdditionalCost` (a boolean on `PLAY_UNIT` action) signals opt-in.
3. `paidAdditional = action.payAdditionalCost && !!optPlayCost` (line 5447) folds the body runes into `effCost` → payment covers them.
4. At line 5601, `if (paidAdditional)` fires the bonus.

**No new cost infrastructure needed.** Akshan's `[Body][Body]` cost is recognized by the existing parser.

**New EngineCard field required for on-leave revert:**

```typescript
// In types.ts EngineCard:
/** Gear stolen by Akshan - Mischievous. Records the original owner so it can
 *  be returned when Akshan leaves play. Stored as "originalOwnerPlayerId". */
akshanStolenGear?: string  // the PlayerId of the gear's original owner
```

Alternatively, attach the metadata directly on the gear's `EngineCard` instance. Or track in a `MatchState` list:

```typescript
// In types.ts MatchState:
/** Gear stolen by Akshan - Mischievous, to be returned when Akshan leaves.
 *  gearIid: the stolen gear's iid; originalOwner: who it came from;
 *  akshanIid: the Akshan instance that stole it. */
akshanStolenGears?: { gearIid: string; originalOwner: PlayerId; akshanIid: string }[]
```

**Algorithm (inside `if (paidAdditional)` block, bespoke name check):**

```typescript
if (paidAdditional && card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Akshan - Mischievous') {
  // Find an enemy gear: unattached in enemy base OR attached to an enemy unit.
  // Auto-pick (or use targets[0] if provided).
  type GearRef = { gearCardId: string; gearIid: string; originalOwner: PlayerId; host?: EngineCard }
  const enemyGears: GearRef[] = []
  for (const pl of s1.players) {
    if (pl.id === action.player) continue
    // Unattached gear in base
    for (const c of pl.zones.base) {
      if (getCard(c.cardId)?.type === 'gear')
        enemyGears.push({ gearCardId: c.cardId, gearIid: c.iid, originalOwner: pl.id })
    }
    // Attached gear on units (base or battlefield)
    for (const host of [...pl.zones.base, ...s1.battlefields.flatMap(b => b.units)]) {
      if (host.owner !== pl.id) continue
      for (const ref of host.attached) {
        const [gCardId, gIid] = ref.split('|')
        enemyGears.push({ gearCardId: gCardId, gearIid: gIid, originalOwner: pl.id, host })
      }
    }
  }
  const chosen: GearRef | undefined = targets?.[0]
    ? enemyGears.find(g => g.gearIid === targets[0])
    : enemyGears[0]  // auto-pick first (or strongest — gear has no Might, so just pick first)

  if (!chosen) {
    s1 = log(s1, action.player, `${card.name}: no enemy gear to steal.`)
  } else {
    const { gearCardId, gearIid, originalOwner, host } = chosen
    const gName = getCard(gearCardId)?.name ?? gearIid

    // 1. Remove from original location
    if (host) {
      host.attached = host.attached.filter(r => r.split('|')[1] !== gearIid)
    } else {
      s1.players[originalOwner].zones.base =
        s1.players[originalOwner].zones.base.filter(c => c.iid !== gearIid)
    }

    // 2. Register for on-leave revert (MatchState list)
    if (!s1.akshanStolenGears) s1.akshanStolenGears = []
    s1.akshanStolenGears.push({ gearIid, originalOwner, akshanIid: ci.iid })

    const isEquip = getCard(gearCardId)?.type === 'gear' && parseKeywords(getCard(gearCardId)!).equip

    if (isEquip) {
      // 3a. Attach to Akshan (find Akshan in base — he was just placed)
      const akshanInst = s1.players[action.player].zones.base.find(u => u.iid === ci.iid)
        ?? s1.battlefields.flatMap(b => b.units).find(u => u.iid === ci.iid)
      if (akshanInst) {
        akshanInst.attached.push(`${gearCardId}|${gearIid}`)
        s1 = fireAttachEquip(s1, action.player, akshanInst)
        s1 = log(s1, action.player, `${card.name}: stole ${gName} from opponent and attached it.`)
      }
    } else {
      // 3b. Non-Equipment gear: place unattached in caster's base
      s1.players[action.player].zones.base.push({
        iid: gearIid, cardId: gearCardId, owner: action.player,
        exhausted: false, damage: 0, attached: [],
      })
      s1 = log(s1, action.player, `${card.name}: stole ${gName} — it's in your base.`)
    }
  }
  // Skip the generic applyParsed / paidBonusEffect path for this card
  // (done — return or fall through to firePlayTriggers below)
}
```

**On-leave revert (when Akshan leaves the board):**

"Leaves the board" = dies (enters `fireDeaths`), is bounced to hand (`bounceUnitToHand`), or is recalled (`recallToBase` / `sendUnitToBase`). The revert must fire in all three paths.

**Implementation:** Add a helper `revertAkshanStolenGears(s, iid)` and call it from:

1. `fireDeaths` (engine.ts line 1654) — after collecting `defeated` loop, before `fireTriggers`; check if any `defeated` iid matches an `akshanIid` entry.
2. `bounceUnitToHand` (engine.ts line 2950) — after removing the unit, before the return.
3. `recallToBase` (engine.ts line 3082) — add a check that clears stolen gear before pushing to base.
4. `sendUnitToBase` (engine.ts line 2592) — same.

```typescript
function revertAkshanStolenGears(s: MatchState, leavingIid: string): void {
  if (!s.akshanStolenGears?.length) return
  const toRevert = s.akshanStolenGears.filter(e => e.akshanIid === leavingIid)
  if (!toRevert.length) return
  s.akshanStolenGears = s.akshanStolenGears.filter(e => e.akshanIid !== leavingIid)

  for (const entry of toRevert) {
    const { gearIid, originalOwner } = entry
    // Remove from wherever it currently lives (Akshan's attached list, or caster's base)
    for (const pl of s.players) {
      // Unattached in base
      const baseIdx = pl.zones.base.findIndex(c => c.iid === gearIid)
      if (baseIdx >= 0) { pl.zones.base.splice(baseIdx, 1); break }
      // Attached to a unit
      for (const host of [...pl.zones.base, ...s.battlefields.flatMap(b => b.units)]) {
        const ai = host.attached.findIndex(r => r.split('|')[1] === gearIid)
        if (ai >= 0) { host.attached.splice(ai, 1); break }
      }
    }
    // Return to original owner's base, unattached
    const gearCardId = /* preserve from entry or look up */ s.akshanStolenGears  // stored in entry? Need to add gearCardId field
    // Note: entry must also carry gearCardId to reconstruct the EngineCard.
    s.players[originalOwner].zones.base.push({
      iid: gearIid,
      cardId: /* gearCardId from entry */ '',  // see note below
      owner: originalOwner,
      exhausted: false,
      damage: 0,
      attached: [],
    })
  }
}
```

**Note on gearCardId:** The `akshanStolenGears` entry must also store `gearCardId` (not just `gearIid`) to reconstruct the EngineCard on return. Expand the type:

```typescript
akshanStolenGears?: { gearIid: string; gearCardId: string; originalOwner: PlayerId; akshanIid: string }[]
```

**Azir template comparison (engine.ts line 6536–6540):**
The Azir gear-steal is ephemeral (within one ACTIVATE_UNIT call, no revert needed):
```typescript
if (tgt.attached.length > 0) {
  const stolen = tgt.attached.splice(0, 1)[0]
  azir.attached.push(stolen)
  // No owner change, no revert registration
}
```
Akshan differs in that:
- The gear's `owner` field should be changed to the caster (or left at original, since gear owner doesn't affect `recomputeControllers`).
- A revert entry IS registered, because the effect duration is "until Akshan leaves."
- `owner` on gear EngineCards is not used by `recomputeControllers` (which only counts units), so for gear it is safe to leave `owner` at original and rely on the `akshanStolenGears` registry to track where it belongs.

---

## 5. Mechanism Difficulty Analysis

### Possession
- **Difficulty: Low.** One-shot: mutate `u.owner`, call `recallToBase`, call `recomputeControllers`. No ongoing state. Insert in `resolveSpellEffects` alongside the other bespoke guards. The only subtlety is picking the correct overload (showdown vs action-phase chain path both reach `resolveSpellEffects`).

### Hostile Takeover
- **Difficulty: Medium.** Requires a new `MatchState.hostileTakeoverRevert` list. The `END_TURN` cleanup block already runs before `beginTurn`; inserting the revert there is clean. The `[Hidden]` speed means the reveal path (`revealHidden`) must also reach `resolveSpellEffects` — confirm this flows through the same function (it does; the reveal resolves the spell for 0 Energy).

### Akshan - Mischievous
- **Difficulty: HIGH — the hardest mechanism.** The "until I leave the board" on-leave revert has no existing infrastructure. No engine field currently tracks "this unit controls foreign gear that must be returned on death/bounce/recall." The three separate leave-play paths (`fireDeaths`, `bounceUnitToHand`, `recallToBase`/`sendUnitToBase`) must each call `revertAkshanStolenGears`. Missing any one of them creates a permanent gear loss. Additionally, `akshanStolenGears` must persist in `MatchState` (serialized and cloned) across the full network round-trip.

---

## 6. Summary (4 lines)

1. **Confirmed ids:** Possession = `ogn-203-298`, Hostile Takeover = `sfd-202-221`, Akshan - Mischievous = `sfd-109-221`; no alternates or promos for any of them.
2. **Per-card hooks:** Possession → bespoke block in `resolveSpellEffects` (mutate `u.owner`, then `recallToBase`); Hostile Takeover → same + new `MatchState.hostileTakeoverRevert[]` drained in `END_TURN` (line 6995); Akshan → bespoke block inside `if (paidAdditional)` (PLAY_UNIT, line 5601) + new `MatchState.akshanStolenGears[]` registry, `revertAkshanStolenGears` called from `fireDeaths` / `bounceUnitToHand` / `recallToBase` / `sendUnitToBase`.
3. **Owner model:** There is no `controlledBy` — `recomputeControllers` reads `u.owner` counts; mutating `u.owner` is the correct and only way to implement "take control"; for Hostile Takeover the original `owner` must be stored before mutation and restored on revert.
4. **Hardest mechanism:** Akshan's on-leave revert — no existing "until-I-leave" infrastructure exists in EngineCard or MatchState; it requires a new serialized MatchState list, a shared helper function, and call-site patches in all four leave-play code paths, making it the most complex of the three.
