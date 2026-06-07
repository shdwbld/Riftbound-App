# A4 Implementation Plan: Transient Keyword Grants & Equipment Edge Cases

_Research agent — 2026-06-06. All line numbers verified against current files. Do NOT edit any source during this recon._

---

## Verified Card Data (from `src/data/cards.generated.json` + `src/data/extraCards.json`)

| ID | Name | Type | Energy | Text (verbatim, truncated) |
|----|------|------|--------|---------------------------|
| `unl-071-219` | Chakram Dancer | unit | 3 | `[Ambush] … When you play me, give your other units here [Shield] this turn. (+1 :rb_might: while they're defenders.)` |
| `unl-056-219` | Yuumi - Magical Cat | unit | 3 | `When I attack or defend, give one of your other units here +3 :rb_might: and [Tank] this turn. (It must be assigned combat damage first.)` |
| `ogn-057-298` | Block | spell | 2 | `[Hidden] … [Action] … Give a unit [Shield 3] and [Tank] this turn. (+3 … )` |
| `sfd-032-221` | Disarming Rake | unit | 3 | `When you play me, you may kill a gear.` |
| `sfd-074-221` | Pickpocket | unit | 3 | `When you play me, you may kill a gear with Energy cost no more than :rb_energy_1:. If you do, play a Gold gear token exhausted.` |
| `sfd-084-221` | Jayce - Man of Progress | unit | 4 | `When you play me, you may kill a friendly gear. If you do, you may play a gear with Energy cost no more than :rb_energy_7: from hand this turn, ignoring its Energy cost. (You must still pay its Power cost.)` |
| `sfd-160-221` | Zaun Punk | unit | 3 | `You may kill a friendly gear as an additional cost to play me. When you play me, if you paid the additional cost, kill a gear.` |
| `sfd-044-221` | Legion Quartermaster | unit | 3 | `As an additional cost to play me, return a friendly gear to its owner's hand.` |
| `sfd-005-221` | Detonate | spell | 1 | `Kill a gear. Its controller draws 2.` |
| `sfd-077-221` | Rocket Barrage | spell | 4 | `[Repeat] … Choose one — Deal 4 to a unit in a base. Kill a gear.` |
| `sfd-150-221` | Last Rites | gear | 3 | (TEXT_PATCHES) `[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash … When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)` |
| `sfd-059-221` | Svellsongur | gear | 3 | `[Equip] :rb_energy_1::rb_rune_calm: … As this is attached to a unit, copy that unit's text to this Equipment's effect text for as long as this is attached to it.` |

**Confirmed: none of the above (except Adaptatron for gear-kill) have any handler in `src/engine/engine.ts`** — all will parse as `manual=true` currently.

---

## A4-1: `grantShield` + `grantTank` (This-Turn Keyword Grants)

### Current grantAssault/grantGanking pattern — MIRROR EXACTLY

**`src/engine/types.ts` — EngineCard fields (current lines 84–89):**
```ts
84:   /** [Assault N] granted to this unit THIS TURN (Square Up, Vault Breaker, Lord
85:    *  Broadmane). Cleared at end of turn. Adds to combat Might while attacking. */
86:   grantAssault?: number
87:   /** [Ganking] granted to this unit THIS TURN (Vault Breaker). Lets it move
88:    *  battlefield-to-battlefield. Cleared at end of turn. */
89:   grantGanking?: boolean
```
ADD AFTER LINE 89:
```ts
  /** [Shield N] granted to this unit THIS TURN (Chakram Dancer, Block). Cleared at
   *  end of turn. Adds +N to combat Might while defending. */
  grantShield?: number
  /** [Tank] granted to this unit THIS TURN (Yuumi - Magical Cat, Block). Cleared at
   *  end of turn. Makes this unit take damage first in combat. */
  grantTank?: boolean
```

**`src/engine/effects.ts` — ParsedEffect interface (current lines 54–58):**
```ts
54:   /** [Assault N] granted to the chosen unit this turn ("give a unit [Assault 4]
55:    *  this turn" — Square Up, Vault Breaker). 0 = none. */
56:   grantAssault: number
57:   /** [Ganking] granted to the chosen unit this turn (Vault Breaker). */
58:   grantGanking: boolean
59:   /** [Assault N] granted to your OTHER units at the source's battlefield this
60:    *  turn ("give your other units here [Assault]" — Lord Broadmane). */
61:   grantAssaultHere: number
```
ADD AFTER LINE 61 (after `grantAssaultHere`):
```ts
  /** [Shield N] granted to the chosen unit this turn (Block, Yuumi). 0 = none. */
  grantShield: number
  /** [Tank] granted to the chosen unit this turn (Yuumi - Magical Cat, Block). */
  grantTank: boolean
  /** [Shield N] granted to all OTHER friendly units at the source's battlefield
   *  this turn (Chakram Dancer). 0 = none. */
  grantShieldHere: number
```

**`src/engine/effects.ts` — EMPTY_EFFECT() (current lines 246–248):**
```ts
246:   grantAssault: 0,
247:   grantGanking: false,
248:   grantAssaultHere: 0,
```
ADD AFTER LINE 248:
```ts
  grantShield: 0,
  grantTank: false,
  grantShieldHere: 0,
```

**`src/engine/effects.ts` — `hasTargetedPart` (current line 301):**
```ts
301: export function hasTargetedPart(e: ParsedEffect): boolean {
     return e.damage > 0 || e.kill > 0 || e.tempMight !== 0 || e.bounce !== null || e.moveToBase || e.moveUnit || e.stun > 0 || e.grantAssault > 0 || e.grantGanking || e.deathShield
```
ADD `|| e.grantShield > 0 || e.grantTank` BEFORE the closing parenthesis.

**`src/engine/effects.ts` — `hasUntargetedPart` (current line 305):**
ADD `|| e.grantShieldHere > 0` (mirrors `grantAssaultHere` which is already there).

**`src/engine/effects.ts` — Parse block (current lines 543–555):**
```ts
543:   // Temporary keyword grants "this turn". Targeted: "give a unit [Assault N] (and
544:   // [Ganking]) this turn" (Square Up, Vault Breaker). Area: "give your other
545:   // units here [Assault] this turn" (Lord Broadmane).
546:   if (/this turn/.test(t)) {
547:     const areaM = t.match(/give your (?:other )?units here \[assault(?:\s*(\d+))?\]/)
548:     if (areaM) { eff.grantAssaultHere = areaM[1] ? parseInt(areaM[1], 10) : 1; hit = true }
549:     else {
550:       const gaM = t.match(/give (?:a|an|target|another) (?:friendly |enemy )?unit[^.]*?\[assault(?:\s*(\d+))?\]/)
551:       if (gaM) { eff.grantAssault = gaM[1] ? parseInt(gaM[1], 10) : 1; hit = true }
552:       const ggM = t.match(/give (?:a|an|target|another) (?:friendly |enemy )?unit[^.]*?\[ganking\]/)
553:       if (ggM) { eff.grantGanking = true; hit = true }
554:     }
555:   }
```

REPLACE WITH:
```ts
  if (/this turn/.test(t)) {
    // Area grants — "give your other units here [Assault/Shield] this turn"
    const areaAssaultM = t.match(/give your (?:other )?units here \[assault(?:\s*(\d+))?\]/)
    if (areaAssaultM) { eff.grantAssaultHere = areaAssaultM[1] ? parseInt(areaAssaultM[1], 10) : 1; hit = true }
    const areaShieldM = t.match(/give your (?:other )?units here \[shield(?:\s*(\d+))?\]/)
    if (areaShieldM) { eff.grantShieldHere = areaShieldM[1] ? parseInt(areaShieldM[1], 10) : 1; hit = true }
    // Targeted grants — "give a/an/target/another/one of your other unit(s) [Keyword] this turn"
    if (!areaAssaultM) {
      const gaM = t.match(/give (?:a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?units?[^.]*?\[assault(?:\s*(\d+))?\]/)
      if (gaM) { eff.grantAssault = gaM[1] ? parseInt(gaM[1], 10) : 1; hit = true }
    }
    const ggM = t.match(/give (?:a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?units?[^.]*?\[ganking\]/)
    if (ggM) { eff.grantGanking = true; hit = true }
    const gsM = t.match(/give (?:a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?units?[^.]*?\[shield(?:\s*(\d+))?\]/)
    if (gsM) { eff.grantShield = gsM[1] ? parseInt(gsM[1], 10) : 1; hit = true }
    const gtM = t.match(/give (?:a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?units?[^.]*?\[tank\]/)
    if (gtM) { eff.grantTank = true; hit = true }
  }
```

> **Parse notes:**
> - Block (`ogn-057-298`): "Give **a unit** [Shield 3] and [Tank] this turn" → `grantShield=3, grantTank=true` (targeted single unit; targetScope will be inferred as 'any' since "a unit" with no friendly/enemy qualifier — check if targetScope defaulting works or if it needs to be set explicitly like grantAssault does). Verify: the `grantAssault` parse path sets `targetScope` via the downstream targeted dispatch, not in the parse itself.
> - Chakram Dancer: "give your **other units here** [Shield] this turn" → `grantShieldHere=1` (area, untargeted).
> - Yuumi: "give **one of your other units here** +3 Might and [Tank] this turn" → `tempMight=3, grantTank=true` (targeted). The `+3 :rb_might:` part already parses via existing `tempMight` logic. Only `grantTank` is new.

### Dispatch Site 1 — Targeted Spell Loop (`src/engine/engine.ts` lines 4581–4589)

CURRENT CODE (mirror this exactly):
```ts
4581:       if (e.grantAssault || e.grantGanking) {
4582:         const u = findUnitAnywhere(s, t)
4583:         if (u) {
4584:           if (e.grantAssault) u.grantAssault = (u.grantAssault ?? 0) + e.grantAssault
4585:           if (e.grantGanking) u.grantGanking = true
4586:           emit({ kind: 'buff', iid: t, player: controller })
4587:           s = log(s, controller, `${card.name}: ${getCard(u.cardId)?.name} gains ${e.grantAssault ? `[Assault ${e.grantAssault}]` : ''}${e.grantAssault && e.grantGanking ? ' and ' : ''}${e.grantGanking ? '[Ganking]' : ''} this turn.`)
4588:         }
4589:       }
```

ADD AFTER LINE 4589:
```ts
      if (e.grantShield || e.grantTank) {
        const u = findUnitAnywhere(s, t)
        if (u) {
          if (e.grantShield) u.grantShield = (u.grantShield ?? 0) + e.grantShield
          if (e.grantTank) u.grantTank = true
          emit({ kind: 'buff', iid: t, player: controller })
          s = log(s, controller, `${card.name}: ${getCard(u.cardId)?.name} gains ${e.grantShield ? `[Shield ${e.grantShield}]` : ''}${e.grantShield && e.grantTank ? ' and ' : ''}${e.grantTank ? '[Tank]' : ''} this turn.`)
        }
      }
```

### Dispatch Site 2 — `applyParsed` Area Path (`src/engine/engine.ts` lines 933–941)

CURRENT CODE (mirror this):
```ts
933:   if (e.grantAssaultHere && sourceIid != null) {
934:     // "give your other units here [Assault] this turn" (Lord Broadmane).
935:     const bi = battlefieldOf(s, sourceIid)
936:     let n = 0
937:     if (bi >= 0)
938:       for (const u of s.battlefields[bi].units)
939:         if (u.owner === p.id && u.iid !== sourceIid) { u.grantAssault = (u.grantAssault ?? 0) + e.grantAssaultHere; n++ }
940:     if (n) lines.push(`Gave [Assault ${e.grantAssaultHere}] to ${n} other unit(s) here this turn.`)
941:   }
```

ADD AFTER LINE 941:
```ts
  if (e.grantShieldHere && sourceIid != null) {
    // "give your other units here [Shield] this turn" (Chakram Dancer).
    const bi = battlefieldOf(s, sourceIid)
    let n = 0
    if (bi >= 0)
      for (const u of s.battlefields[bi].units)
        if (u.owner === p.id && u.iid !== sourceIid) { u.grantShield = (u.grantShield ?? 0) + e.grantShieldHere; n++ }
    if (n) lines.push(`Gave [Shield ${e.grantShieldHere}] to ${n} other unit(s) here this turn.`)
  }
```

> **Chakram Dancer fires on play** (`when you play me`) — the `onPlayEffect` parser will produce `grantShieldHere=1`. The PLAY_UNIT handler calls `applyParsed` with `sourceIid=ci.iid` which is set when Chakram is on base. At this point Chakram is in base, not on a battlefield, so `battlefieldOf` returns -1 and no units are buffed. **IMPORTANT: Chakram uses `[Ambush]` so it may be played directly to a battlefield.** If played via Ambush (`ambushBf != null`), `sourceIid` is the unit just placed on the battlefield. Check that PLAY_UNIT passes the correct `bfIndex`/`sourceIid` to `applyParsed` — it already does for on-play effects (look at the PLAY_UNIT handler flow around line 5280–5310 where `applyParsed` is called with `ambushBf` and `ci.iid`). The area grant only works when played to a battlefield, which is correct per the card text ("give your other units **here**").

### Dispatch Site 3 — ACTIVATE_UNIT Targeted Loop (`src/engine/engine.ts` lines 6231–6233)

CURRENT CODE (mirror this):
```ts
6231:           if (ab.effect.grantAssault) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantAssault = (tu.grantAssault ?? 0) + ab.effect.grantAssault }
6232:           if (ab.effect.grantGanking) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantGanking = true }
```

ADD AFTER LINE 6232:
```ts
          if (ab.effect.grantShield) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantShield = (tu.grantShield ?? 0) + ab.effect.grantShield }
          if (ab.effect.grantTank) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantTank = true }
```

### ACTIVATE_UNIT Untargeted `grantAssaultHere` (line 6244)

CURRENT CODE:
```ts
6244:       if (ab.effect.grantAssaultHere) { const bi = battlefieldOf(s1, u.iid); if (bi >= 0) for (const unit of s1.battlefields[bi].units) if (unit.owner === action.player && unit.iid !== u.iid) unit.grantAssault = (unit.grantAssault ?? 0) + ab.effect.grantAssaultHere }
```

ADD AFTER LINE 6244:
```ts
      if (ab.effect.grantShieldHere) { const bi = battlefieldOf(s1, u.iid); if (bi >= 0) for (const unit of s1.battlefields[bi].units) if (unit.owner === action.player && unit.iid !== u.iid) unit.grantShield = (unit.grantShield ?? 0) + ab.effect.grantShieldHere }
```

### Combat Reads

**Shield — `mightOf` (`src/engine/engine.ts` line 3584):**
```ts
3584:   if (role === 'defender') m += k.shield
```
CHANGE TO:
```ts
  if (role === 'defender') m += k.shield + (ci.grantShield ?? 0)
```

> **Note on `bfCombatBonus`:** The existing `unitGrantedKeyword(s, u, 'shield')` check at line 4044 handles **aura-based** shield grants (e.g. "Your Cats have [Shield]"). The new `grantShield` is a **per-instance** transient field, not an aura, so it goes in `mightOf` alongside `k.shield` — NOT in `bfCombatBonus`. The `bfCombatBonus` shield check adds +1 for aura-granted keyword; `grantShield` adds an arbitrary N so it must go in `mightOf` for precise Might calculation.

**Tank — `hasTank` (`src/engine/engine.ts` lines 2373–2376):**
```ts
2373: function hasTank(s: MatchState, u: EngineCard): boolean {
2374:   if (parseKeywords(def(u)).tank) return true
2375:   return getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Lillia - Protector of Dreams')
2376: }
```
CHANGE TO:
```ts
function hasTank(s: MatchState, u: EngineCard): boolean {
  if (parseKeywords(def(u)).tank) return true
  if (u.grantTank) return true                                           // ← ADD
  return getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Lillia - Protector of Dreams')
}
```

### End-of-Turn Cleanup (`src/engine/engine.ts` lines 6676 + 6679)

CURRENT CODE (lines 6676 and 6679):
```ts
6676:           pl.zones[z] = pl.zones[z].map((c) => ({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, deathShield: false, banishShield: false }))
...
6679:         bf.units = bf.units.map((u) => ({ ...u, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, deathShield: false, banishShield: false }))
```

CHANGE BOTH LINES TO (add `grantShield: 0, grantTank: false,` after `grantGanking: false`):
```ts
          pl.zones[z] = pl.zones[z].map((c) => ({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, grantShield: 0, grantTank: false, deathShield: false, banishShield: false }))
...
        bf.units = bf.units.map((u) => ({ ...u, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, grantShield: 0, grantTank: false, deathShield: false, banishShield: false }))
```

### Per-Card Handler Approach

| Card | Handler Approach |
|------|-----------------|
| Chakram Dancer (`unl-071-219`) | Generic — `grantShieldHere` parsed from on-play text; `applyParsed` area block fires on PLAY_UNIT. |
| Yuumi - Magical Cat (`unl-056-219`) | Generic — attack/defend trigger already fires; `tempMight=3` already works; `grantTank=true` is the only new piece once primitive is added. |
| Block (`ogn-057-298`) | Generic — spell effect parses `grantShield=3, grantTank=true`; targeted spell loop handles both. |

### Engine Test Cases

```ts
// --- grantShield: Block (spell) grants Shield 3 + Tank this turn ---
it('Block: gives target unit [Shield 3] and [Tank] this turn', () => {
  const sid = injectCard('block-t', 'Give a unit [Shield 3] and [Tank] this turn.', { type: 'spell', energy: 0 })
  const target = mk('some-unit', 1)  // enemy unit
  const s = baseState()
  s.battlefields[0].units.push(target)
  const spell = mk(sid, 0)
  s.players[0].zones.hand.push(spell)
  let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: spell.iid, targets: [target.iid], payment: emptyPayment() })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
  const u = r.state.battlefields[0].units.find(x => x.iid === target.iid)!
  expect(u.grantShield).toBe(3)
  expect(u.grantTank).toBe(true)
})

// --- grantShieldHere: Chakram Dancer on-play ---
it('Chakram Dancer: gives other units here [Shield] this turn on play', () => {
  const cid = injectCard('chakram-t', 'When you play me, give your other units here [Shield] this turn.', { type: 'unit', energy: 0 })
  const ally = mk('some-unit', 0)
  const s = baseState()
  s.battlefields[0].units.push(ally)
  const chakram = mk(cid, 0)
  s.players[0].zones.hand.push(chakram)
  // Play with Ambush to battlefield 0
  const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: chakram.iid, payment: emptyPayment(), ambushBf: 0 })
  const u = r.state.battlefields[0].units.find(x => x.iid === ally.iid)!
  expect(u.grantShield).toBe(1)
})

// --- grantTank: hasTank reads grantTank ---
it('hasTank respects grantTank flag', () => {
  const { combatMightAt } = await import('./engine')
  const s = baseState()
  const u = mk('some-unit', 0, { grantTank: true })
  s.battlefields[0].units.push(u)
  // Test via damageOrder indirectly: a unit with grantTank must take damage first.
  // Direct check: grantShield adds to defender mightOf
  const shield = mk('some-unit-2', 0, { grantShield: 3 })
  s.battlefields[0].units.push(shield)
  expect(combatMightAt(s, 0, shield, 'defender')).toBeGreaterThan(combatMightAt(s, 0, shield, 'attacker'))
})

// --- END_TURN clears grantShield + grantTank ---
it('END_TURN clears grantShield and grantTank', () => {
  const s = baseState()
  const u = mk('some-unit', 0, { grantShield: 3, grantTank: true })
  s.players[0].zones.base.push(u)
  const r = reduce(s, { type: 'END_TURN', player: 0 })
  const c = r.state.players[0].zones.base.find(x => x.iid === u.iid)!
  expect(c.grantShield).toBe(0)
  expect(c.grantTank).toBe(false)
})
```

---

## A4-2: `killGear` / `bounceGear` (Gear-Scoped Effects)

### Architecture: Gear Storage

Gear lives in exactly two places:
1. **Unattached** — in `players[].zones.base` as normal `EngineCard` instances.
2. **Attached** — as `"cardId|iid"` string refs in `unit.attached[]`. The string ref is NOT an `EngineCard`; it's reconstructed via `ref.split('|')` to get `[cardId, iid]`. The full EngineCard must be synthesized (same pattern as `controlledPermanents` at line 1067–1071).

**`sendToTrash` (line 311–324)** — sends a card to its owner's trash (owner is `PlayerState p` passed as arg). Calls `detachGearToBase` first (but gear won't have attached gear, so that's a no-op). Tokens cease to exist. Gold gear tokens (`getCard(card.cardId)?.supertype === 'token'`) will be discarded silently.

**Adaptatron bespoke pattern (lines 1369–1382)** — the only existing gear-kill. It only kills unattached gear from `p.zones.base`. The new generic helpers must handle both unattached base gear AND attached gear.

### New ParsedEffect Fields

In `src/engine/effects.ts`, add to the `ParsedEffect` interface after `returnFromTrash` (line 145):
```ts
  /** Kill a chosen gear. `scope` = whose gear; `maxEnergy` = optional Energy cost
   *  cap (Pickpocket: cap 1; others: null = any cost). `friendly`/`enemy`/`any`.
   *  Covers: Disarming Rake, Pickpocket, Zaun Punk (on-play bonus), Detonate,
   *  Rocket Barrage. */
  killGear: { scope: 'friendly' | 'enemy' | 'any'; maxEnergy: number | null } | null
  /** Return a friendly gear to its owner's hand as an additional cost (Legion
   *  Quartermaster) or on-play effect. NOT an additional-cost flag — the
   *  `bounceGear` effect fires on play (the Quartermaster's text states the
   *  return happens "as an additional cost" but the engine models it as a
   *  mandatory pre-play auto-pick after payment is accepted). */
  bounceGear: boolean
```

Add to `EMPTY_EFFECT()`:
```ts
  killGear: null,
  bounceGear: false,
```

Add to `hasUntargetedPart` (line 305): `|| !!e.killGear || e.bounceGear`

> **Targeting note**: `killGear` is an untargeted auto-pick (lowest-cost matching gear), NOT a player-targeted choice via the existing `targetCount`/`targetScope` system. The existing targeted system only lists unit iids. Adding a player-choice UI for gear targeting requires a new `pendingChoice.kind` value. **For MVP: auto-pick lowest-cost matching gear** (mirrors Adaptatron). Mark as upgrade path.

### Parse Block

In `src/engine/effects.ts`, add BEFORE line 865 (`if (!hit && t.trim().length > 0) eff.manual = true`):
```ts
  // Kill a gear: "kill a gear" / "kill a friendly gear" / "kill a gear with Energy
  // cost no more than :rb_energy_N:" (Disarming Rake, Pickpocket, Zaun Punk bonus,
  // Detonate, Rocket Barrage).
  const kgM = t.match(/kill (?:a|an) (friendly |enemy )?gear(?:[^.]*?:rb_energy_(\d+):)?/)
  if (kgM) {
    const scope = kgM[1]?.trim() === 'friendly' ? 'friendly' : kgM[1]?.trim() === 'enemy' ? 'enemy' : 'any'
    const maxEnergy = kgM[2] ? parseInt(kgM[2], 10) : null
    eff.killGear = { scope, maxEnergy }
    hit = true
  }
  // Return a friendly gear to its owner's hand (Legion Quartermaster additional cost).
  if (/return a friendly gear to (?:its owner'?s?|your) hand/.test(t)) { eff.bounceGear = true; hit = true }
```

> **Zaun Punk parse note**: Zaun Punk's text is:
> `You may kill a friendly gear as an additional cost to play me. When you play me, if you paid the additional cost, kill a gear.`
> The `paidBonusEffect` function at line 917 extracts the `"if you paid the additional cost, kill a gear"` clause. This clause parses as `killGear: { scope: 'any', maxEnergy: null }`. The `onPlayEffect` strips the conditional clause (line 910 regex already strips `"if you paid the additional cost,…"`). So Zaun Punk's on-play effect (without paying) is empty, and the bonus effect is `killGear: { scope:'any' }`. **BUT** the additional cost itself is a gear-kill, NOT a rune/energy cost — `optionalPlayCost` (in `keywords.ts`) only handles energy/rune costs. Zaun Punk's additional cost cannot be modeled by `optionalPlayCost`.

### `allGearInPlay` Enumerator

Add near `unitsInPlay` (`src/engine/engine.ts` line 6883):
```ts
/** Every gear currently in play: unattached gear in all players' bases, plus
 *  attached gear (reconstructed from unit.attached refs). */
function allGearInPlay(s: MatchState): EngineCard[] {
  const out: EngineCard[] = []
  for (const pl of s.players) {
    // Unattached gear at base
    for (const c of pl.zones.base) {
      if (getCard(c.cardId)?.type === 'gear') out.push(c)
    }
    // Attached gear — iterate all units across all zones
    const allUnits = [
      ...pl.zones.base,
      ...s.battlefields.flatMap((b) => b.units),
    ].filter((u) => u.owner === pl.id && getCard(u.cardId)?.type === 'unit')
    for (const u of allUnits) {
      for (const ref of u.attached) {
        const [cid, iid] = ref.split('|')
        if (cid && getCard(cid)?.type === 'gear')
          out.push({ iid: iid || `${pl.id}:gear:${cid}`, cardId: cid, owner: pl.id, exhausted: false, damage: 0, attached: [] })
      }
    }
  }
  return out
}
```

### `killGearByIid` Helper

Add after Adaptatron handler (line 1382, inside `fireTriggers`... actually add as a standalone function near `allGearInPlay`):
```ts
/** Kill a gear by iid — removes from wherever it lives (unattached base or
 *  attached to a unit) and sends to the gear's OWNER's trash.
 *  Returns true if found and killed. Attached refs are strings ("cardId|iid");
 *  we reconstruct a minimal EngineCard to pass to sendToTrash.
 *  Gold gear tokens cease to exist (sendToTrash checks supertype=token). */
function killGearByIid(s: MatchState, gearIid: string): boolean {
  for (const pl of s.players) {
    // Check unattached base gear
    const bi = pl.zones.base.findIndex((c) => c.iid === gearIid)
    if (bi >= 0) {
      const [g] = pl.zones.base.splice(bi, 1)
      sendToTrash(pl, g)
      return true
    }
    // Check attached gear on any unit (battlefields + base)
    const allUnits = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id)
    for (const u of allUnits) {
      const ri = (u.attached ?? []).findIndex((ref) => ref.split('|')[1] === gearIid)
      if (ri >= 0) {
        const [ref] = u.attached.splice(ri, 1)
        const [cid, iid] = ref.split('|')
        // Gear's owner = the unit's owner (gear always owned by who played it)
        const ownerPl = s.players[u.owner]
        sendToTrash(ownerPl, { iid: iid || `${u.owner}:gear:${cid}`, cardId: cid, owner: u.owner, exhausted: false, damage: 0, attached: [] })
        return true
      }
    }
  }
  return false
}
```

### `bounceGearByIid` Helper

Add after `killGearByIid`:
```ts
/** Return a gear by iid to its owner's hand (Legion Quartermaster). Same logic
 *  as killGearByIid but pushes to hand instead of trash. */
function bounceGearByIid(s: MatchState, gearIid: string): EngineCard | null {
  for (const pl of s.players) {
    const bi = pl.zones.base.findIndex((c) => c.iid === gearIid)
    if (bi >= 0) {
      const [g] = pl.zones.base.splice(bi, 1)
      pl.zones.hand.push({ ...g, exhausted: false, damage: 0, attached: [] })
      return g
    }
    const allUnits = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id)
    for (const u of allUnits) {
      const ri = (u.attached ?? []).findIndex((ref) => ref.split('|')[1] === gearIid)
      if (ri >= 0) {
        const [ref] = u.attached.splice(ri, 1)
        const [cid, iid] = ref.split('|')
        const ownerPl = s.players[u.owner]
        const ec: EngineCard = { iid: iid || `${u.owner}:gear:${cid}`, cardId: cid, owner: u.owner, exhausted: false, damage: 0, attached: [] }
        ownerPl.zones.hand.push(ec)
        return ec
      }
    }
  }
  return null
}
```

### Resolution in `applyParsed` (`src/engine/engine.ts` after line 941, same block as grantShieldHere)

Add:
```ts
  if (e.killGear) {
    const gears = allGearInPlay(s).filter((g) => {
      if (e.killGear!.scope === 'friendly' && g.owner !== p.id) return false
      if (e.killGear!.scope === 'enemy' && g.owner === p.id) return false
      if (e.killGear!.maxEnergy != null && (getCard(g.cardId)?.energy ?? 0) > e.killGear!.maxEnergy) return false
      return true
    })
    if (gears.length) {
      // Auto-pick lowest-Energy gear (mirrors Adaptatron pattern at line 1371).
      const pick = gears.reduce((lo, g) => ((getCard(g.cardId)?.energy ?? 0) <= (getCard(lo.cardId)?.energy ?? 0) ? g : lo))
      const nm = getCard(pick.cardId)?.name ?? 'a gear'
      killGearByIid(s, pick.iid)
      lines.push(`Killed ${nm}.`)
    } else {
      lines.push(`No valid gear to kill.`)
    }
  }
  if (e.bounceGear) {
    const gears = allGearInPlay(s).filter((g) => g.owner === p.id)
    if (gears.length) {
      const pick = gears.reduce((lo, g) => ((getCard(g.cardId)?.energy ?? 0) <= (getCard(lo.cardId)?.energy ?? 0) ? g : lo))
      const nm = getCard(pick.cardId)?.name ?? 'a gear'
      bounceGearByIid(s, pick.iid)
      lines.push(`Returned ${nm} to hand.`)
    }
  }
```

### Per-Card Handler Approaches

| Card | Handler Approach |
|------|-----------------|
| Disarming Rake (`sfd-032-221`) | Generic — `onPlayEffect` parses `killGear:{scope:'any', maxEnergy:null}`; `applyParsed` auto-picks lowest-cost gear. |
| Pickpocket (`sfd-074-221`) | Mostly generic — parses `killGear:{scope:'any', maxEnergy:1}` + `goldTokens:1`. The gold token fires from `applyParsed` only if a gear was killed (current `goldTokens` block unconditionally creates tokens). Needs a **bespoke PLAY_UNIT check**: apply `goldTokens` only when `killGear` was resolved successfully. Set a local `killedGear: boolean` from the `killGear` block, then gate `goldTokens` on it. Alternatively: model as `paidBonusEffect` pattern (but the bonus is conditional on the kill, not on an additional rune cost). **Recommended: mini-bespoke** — handle Pickpocket in fireTriggers by name, OR add a `killGearGoldBonus: boolean` flag to ParsedEffect. The simpler fix: add a check `if (e.killGear && e.goldTokens)` in `applyParsed` — produce gold only when both are set and a gear was actually killed. |
| Zaun Punk (`sfd-160-221`) | **Bespoke additional cost** — `optionalPlayCost` (in keywords.ts) cannot express "kill a gear". Add a `gearKillAdditionalCost` boolean to the PLAY_UNIT action (mirroring `payAdditionalCost`) that auto-kills the lowest-cost friendly gear before payment is accepted. The `paidBonusEffect` (`killGear:{scope:'any'}`) fires on-play as the bonus. Without this, Zaun Punk plays with no additional cost. |
| Legion Quartermaster (`sfd-044-221`) | **Bespoke additional cost** — "As an additional cost to play me, return a friendly gear to its owner's hand." No `if you paid` conditional (it's mandatory). `optionalPlayCost` cannot express this. **Option A (MVP)**: treat as mandatory on-play effect: parse `bounceGear=true` from text and apply via `onPlayEffect`/`applyParsed`. The word "additional cost" is technically wrong but functionally equivalent in this engine (no other payoff depends on whether a rune/gear was the additional cost). **Option B (correct)**: add `gearBounceAdditionalCost` flag. For MVP: go with Option A — the only functional gap is that the game doesn't enforce the gear must be returned before the card resolves (i.e. if no gear, Quartermaster still plays). If needed, add a `canPlay` pre-check. |
| Jayce - Man of Progress (`sfd-084-221`) | **Bespoke** — the kill-gear part parses generically (`killGear:{scope:'friendly'}`), but the follow-up "play a gear from hand with Energy cost ≤ 7, ignoring Energy cost" is a new effect. Add `playGearFromHand: { maxEnergy: number | null; energyOnly: boolean } | null` to ParsedEffect. Parse: `t.match(/play a gear[^.]*?from hand[^.]*?:rb_energy_(\d+):[^.]*?ignoring its energy cost/)`. In `applyParsed`: auto-play the highest-cost gear from hand (ignoring Energy cost, still paying Power). Gate the gear-play on whether `killGear` resolved (Jayce's text: "If you do, you may play..."). Use same local `killedGear` flag approach as Pickpocket. |
| Detonate (`sfd-005-221`) | Generic — spell effect parses `killGear:{scope:'any', maxEnergy:null}` + `controllerDrawOnKill:2` (already exists). Note: `controllerDrawOnKill` draws for the killed gear's controller, not the caster — check that the existing `controllerDrawOnKill` block in `applyParsed` works for gear (it searches for a killed unit; gear kill doesn't produce a unit kill event). **Likely needs bespoke**: after `killGearByIid`, manually call `drawN(s.players[killedGearOwner], 2)`. This is cleaner than re-using `controllerDrawOnKill`. Add to Detonate's parse: `drawOnGearKill: number` field, or just handle Detonate bespoke in fireTriggers by name. Recommended: **mini-bespoke** in a PLAY_SPELL special case keyed on card id `sfd-005-221`. |
| Rocket Barrage (`sfd-077-221`) | **Bespoke** — "Choose one — Deal 4 to a unit in a base. Kill a gear." This is a modal spell. Modal choices require a `pendingChoice`. Currently there's no generic modal framework. Handle as bespoke PLAY_SPELL keyed on `sfd-077-221`: push a `pendingChoice` with two options (deal-4 vs kill-gear), resolve in RESOLVE_CHOICE. |

### Engine Test Cases

```ts
// --- killGear: Disarming Rake kills lowest-cost gear ---
it('Disarming Rake: kills lowest-cost gear on play', () => {
  const rid = injectCard('rake-t', 'When you play me, you may kill a gear.', { type: 'unit', energy: 0 })
  const gid = injectCard('gear-t', 'Equip.', { type: 'gear', energy: 2 })
  const s = baseState()
  const gear = mk(gid, 1)                   // opponent's gear at base
  s.players[1].zones.base.push(gear)
  const rake = mk(rid, 0)
  s.players[0].zones.hand.push(rake)
  const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: rake.iid, payment: emptyPayment() })
  // Gear should now be in player 1's trash
  expect(r.state.players[1].zones.base.some(x => x.iid === gear.iid)).toBe(false)
  expect(r.state.players[1].zones.trash.some(x => x.iid === gear.iid)).toBe(true)
})

// --- killGear: kills attached gear ---
it('killGear kills an attached gear (spliced from unit.attached)', () => {
  const rid = injectCard('rake-t2', 'When you play me, you may kill a gear.', { type: 'unit', energy: 0 })
  const gid = injectCard('gear-t2', 'Equip.', { type: 'gear', energy: 1 })
  const uid = injectCard('unit-t', '', { type: 'unit', energy: 2 })
  const s = baseState()
  const hostUnit = mk(uid, 1)
  const gearIid = 'g-iid-1'
  hostUnit.attached = [`${gid}|${gearIid}`]
  s.battlefields[0].units.push(hostUnit)
  const rake = mk(rid, 0)
  s.players[0].zones.hand.push(rake)
  const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: rake.iid, payment: emptyPayment() })
  expect(r.state.battlefields[0].units[0].attached).toHaveLength(0)
  expect(r.state.players[1].zones.trash.some(x => x.iid === gearIid)).toBe(true)
})

// --- bounceGear: Legion Quartermaster returns a gear to hand ---
it('Legion Quartermaster: returns a friendly gear to hand on play', () => {
  const qid = injectCard('qm-t', 'As an additional cost to play me, return a friendly gear to its owner\'s hand.', { type: 'unit', energy: 0 })
  const gid = injectCard('gear-t3', 'Equip.', { type: 'gear', energy: 2 })
  const s = baseState()
  const gear = mk(gid, 0)
  s.players[0].zones.base.push(gear)
  const qm = mk(qid, 0)
  s.players[0].zones.hand.push(qm)
  const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: qm.iid, payment: emptyPayment() })
  expect(r.state.players[0].zones.base.some(x => x.iid === gear.iid)).toBe(false)
  expect(r.state.players[0].zones.hand.some(x => x.iid === gear.iid)).toBe(true)
})
```

---

## A4-3: Gear-as-Trigger-Source — Last Rites (`sfd-150-221`)

### Card Text (via TEXT_PATCHES in `src/data/cards.ts`)

```
[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash (Pay the cost: Attach this to a unit you control.) When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)
```

### Two Bugs (confirmed)

**Bug 1: Hold trigger NOT fired.**

Testing against current PATTERNS in `src/engine/triggers.ts`:
- `{ event: 'conquer', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+conquers?/i }` at line 86 → matches "When I conquer or hold" ✓
- `{ event: 'hold', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+holds?/i }` at line 95 → does NOT match "When I conquer or hold" because after `I` is `conquer`, not `hold` ✗

The `"When I attack or defend"` pattern (line 100) already covers the `attack-or-defend` case by making the defend pattern optionally match `attacks? or`. Mirror this for `conquer-or-hold`.

**Fix — `src/engine/triggers.ts` line 95.** CHANGE:
```ts
95:   { event: 'hold', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+holds?/i },
```
TO:
```ts
  // "When I hold" fires hold trigger. "When I conquer or hold" also fires hold
  // (the conquer half is already matched by line 86 conquer self pattern).
  { event: 'hold', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+(?:conquers?\s+or\s+)?holds?/i },
```

**Bug 2: `playUnitFromTrash` not parsed — clause truncated.**

`clauseAfter` extracts from "When I conquer" match end to the next `.` or `;`. The match ends at "conquer" (char index ~124), then:
```
rest = " or hold, you may play a unit from your trash. (You still pay its costs.)"
```
First `.` is at position 45 (after "trash"), so `end=45`, clause = `"or hold, you may play a unit from your trash"`.

The fullCost branch (effects.ts line 641) requires BOTH `/play a unit from your trash\b/` AND `/(?:you )?still pay its costs?\b/` — the second is in the parenthetical AFTER the `.`, stripped by `clauseAfter`. **The clause is missing "still pay its costs".**

**Fix — `src/engine/triggers.ts` `clauseAfter` function (lines 139–151).**

CURRENT CODE:
```ts
139: function clauseAfter(text: string, m: RegExpMatchArray): string {
140:   const start = (m.index ?? 0) + m[0].length
141:   const rest = text.slice(start).replace(/^\s*[:,]?\s*/, '')
142:   let end = rest.search(/[.;]/)
143:   // Multi-sentence deck-dig effects ("look at the top N … . You may reveal a gear …
144:   // and draw it. Recycle the rest.") span sentence boundaries — extend through the
145:   // closing "recycle …" sentence so the whole effect reaches the parser.
146:   if (end >= 0 && /\b(?:look at|reveal) the top\b/i.test(rest.slice(0, end))) {
147:     const recM = rest.match(/recycle [^.;]*[.;]/i)
148:     if (recM) end = (recM.index ?? 0) + recM[0].length - 1
149:   }
150:   return (end >= 0 ? rest.slice(0, end) : rest).trim()
151: }
```

ADD an extension after line 149, before line 150's return:
```ts
  // Full-cost trash-play ("play a unit from your trash. (You still pay its costs.)")
  // — extend through the closing "still pay its costs" parenthetical (Last Rites).
  if (end >= 0 && /\bplay a unit from your trash\b/i.test(rest.slice(0, end))) {
    const stillM = rest.match(/(?:you )?still pay its costs?[.;)]/i)
    if (stillM) end = (stillM.index ?? 0) + stillM[0].length - 1
  }
```

With this fix, clause becomes `"or hold, you may play a unit from your trash. (You still pay its costs.)"`. Both regexes in effects.ts line 641 match → `playUnitFromTrash: { maxEnergy: null, maxPower: null, energyOnly: false, fullCost: true }`.

### Gear Trigger Delivery — No Change Needed

`collectSelf` (lines 1099–1135) already handles gear-as-trigger-source. When `iids` is set (the host units at the just-conquered/held battlefield), it iterates `u.attached` refs for each host unit and fires `triggersFor(gCard, event)` with `sourceIid=u.iid, sourceCardId=gCard.id` (lines 1110–1115). Last Rites' trigger fires correctly with the host unit's iid as source (so "me"/"here" resolve to the host), while `sourceCardId='sfd-150-221'` tells the resolver which card's text to use for the `playUnitFromTrash` effect.

### Engine Test Cases

```ts
// --- Last Rites: conquer fires playUnitFromTrash (full cost) ---
it('Last Rites: fires on conquer, plays unit from trash at full cost', () => {
  // Use TEXT_PATCHES text
  const lrText = 'When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)'
  const lrGearId = injectCard('lr-t', lrText, { type: 'gear', energy: 0 })
  const deadUnit = injectCard('dead-t', '', { type: 'unit', energy: 2, power: {} })
  const hostId = injectCard('host-t', '', { type: 'unit', energy: 0 })
  const s = baseState()
  s.players[0].zones.runePool.push(mk(furyRune.id, 0), mk(furyRune.id, 0)) // 2 runes to pay
  const dead = mk(deadUnit, 0)
  s.players[0].zones.trash.push(dead)
  const host = mk(hostId, 0, { attached: [`${lrGearId}|lr-iid-1`] })
  s.battlefields[0].units.push(host)
  s.battlefields[0].controller = 0
  // Simulate a conquer event (engine's hold/conquer scoring path)
  // ... test through a PASS action that triggers hold/conquer in a showdown resolution
  // (The standard test pattern: move a unit to a battlefield that has no enemy units,
  //  then PASS/PASS to resolve the uncontested conquer.)
  // At minimum, parse-level test:
  const { triggersFor } = await import('./triggers')
  const lrCard = CARD_INDEX[lrGearId]
  const trigs = triggersFor(lrCard, 'hold')
  expect(trigs.length).toBe(1)
  expect(trigs[0].effect.playUnitFromTrash?.fullCost).toBe(true)
  const trigs2 = triggersFor(lrCard, 'conquer')
  expect(trigs2.length).toBe(1)
})
```

---

## A4-4: Svellsongur (`sfd-059-221`) — Runtime Ability Copy

### Card Text
```
[Equip] :rb_energy_1::rb_rune_calm: (…: Attach this to a unit you control.)
As this is attached to a unit, copy that unit's text to this Equipment's effect text for as long as this is attached to it.
```

### Current State
No handler. Confirmed via grep. Svellsongur attaches and grants 0 flat Might (no `+N Might` in text). All triggers from the host unit fire from the host normally; Svellsongur currently contributes nothing.

### Design: Snapshot Approximation (Option A — cardId Swap)

In `controlledPermanents` (`src/engine/engine.ts` lines 1067–1071), when building the virtual EngineCard for an attached gear, if the gear is Svellsongur (`cid === 'sfd-059-221'`), use the host unit's `cardId` instead:

CURRENT CODE (lines 1067–1071):
```ts
1067:   for (const u of units) {
1068:     for (const ref of u.attached) {
1069:       const [cid, iid] = ref.split('|')
1070:       if (cid && getCard(cid)?.type === 'gear') out.push({ iid: iid || `${player}:gear:${cid}`, cardId: cid, owner: player, exhausted: false, damage: 0, attached: [] })
1071:     }
1072:   }
```

CHANGE LINE 1070 TO:
```ts
      if (cid && getCard(cid)?.type === 'gear') {
        // Svellsongur: "copy that unit's text" — use host's cardId so triggers and
        // keyword reads resolve against the host's card text.
        const effectiveCardId = cid === 'sfd-059-221' ? u.cardId : cid
        out.push({ iid: iid || `${player}:gear:${cid}`, cardId: effectiveCardId, owner: player, exhausted: false, damage: 0, attached: [] })
      }
```

### Guard in `gearMight`

After the cardId swap, `gearMight` (line 3756) would try to parse the HOST's flat "+N Might" from the virtual Svellsongur EC and double-count it. Guard:

In `gearMight` (line 3758 `for (const gid of unit.attached)`):
```ts
3758:   for (const gid of unit.attached) {
3759:     const g = getCard(gid.split('|')[0]) // attached stored as "cardId|iid"
```

Change line 3759 to:
```ts
    const rawCid = gid.split('|')[0]
    if (rawCid === 'sfd-059-221') continue  // Svellsongur: no flat Might; host Might comes from host itself
    const g = getCard(rawCid)
```

### Flag: Double-Fire Risk

With the cardId swap, `controlledPermanents` returns one virtual EC with the HOST's `cardId`. `collectSelf` / `fireTriggers` will fire all the host's self-triggers TWICE: once from the host unit's own EC, and once from Svellsongur's virtual EC. This matches a literal reading of "copy text" — the gear now has those triggers independently. If double-firing is confirmed undesirable, add a dedup in `fireTriggers` that skips a trigger whose `sourceCardId` equals a trigger that was already queued from the same `bfIndex`/`event` with a different `sourceIid` but same effective card text. This is architectural complexity; defer to Opus's judgment.

### FLAG: HIGH ARCHITECTURAL COMPLEXITY
Svellsongur's implementation (Option A) is a 3-line change but has cascading effects on trigger collection, keyword parsing, and `levelBonus`. The Opus engineer should review whether double-firing is acceptable before shipping. Alternative: mark as `manual=true` and leave for a later pass.

---

## Recommended Implementation Order

1. **`grantShield` / `grantTank` primitive** — smallest blast radius. Touches types.ts (2 fields), effects.ts (parse + hasTargetedPart + EMPTY_EFFECT), engine.ts (3 dispatch sites + mightOf + hasTank + END_TURN cleanup). Unblocks Block, Chakram Dancer, Yuumi automatically.

2. **Last Rites fixes** — triggers.ts (1 regex change) + clauseAfter extension (4 lines). Very low risk, high payoff (Last Rites is a real deck card).

3. **`killGear` generic** — add ParsedEffect fields + parse + `allGearInPlay` + `killGearByIid` + `applyParsed` block. Unblocks Disarming Rake, Detonate automatically. Pickpocket and Jayce need bespoke follow-up.

4. **`bounceGear` generic** — `bounceGearByIid` + `applyParsed` block. Unblocks Legion Quartermaster (MVP: on-play, not true additional cost).

5. **Bespoke: Pickpocket** — gate `goldTokens` on `killGear` success in `applyParsed`.

6. **Bespoke: Jayce - Man of Progress** — add `playGearFromHand` ParsedEffect field; implement in `applyParsed`; gate on kill success.

7. **Bespoke: Zaun Punk** — new `gearKillAdditionalCost` mechanism in PLAY_UNIT. Architecturally the hardest of the killGear cards.

8. **Bespoke: Rocket Barrage** — modal choice via `pendingChoice`. Requires UI support; defer if no modal infrastructure.

9. **Svellsongur** — 3-line cardId swap in `controlledPermanents` + gearMight guard. Low code cost, high architectural uncertainty (double-fire). Do last, after reviewing double-fire acceptability.

---

## Blockers / Architectural Flags

| Issue | Severity | Notes |
|-------|----------|-------|
| Gear targeting requires player choice (not auto-pick) | Medium | MVP: auto-pick lowest-cost; upgrade path adds `pendingChoice.kind='killGear'` + new `pendingChoice.kind` in types.ts union + RESOLVE_CHOICE branch |
| Zaun Punk / Legion Quartermaster: additional-cost gear mechanic | High | `optionalPlayCost` only handles rune/energy. Needs new mechanism in PLAY_UNIT action + canPlay check. |
| Rocket Barrage modal ("Choose one —") | Medium | No generic modal framework. Bespoke `pendingChoice` per card. |
| Svellsongur double-fire | Medium | Literal rule reading fires triggers twice. May be correct; confirm with Opus. |
| Detonate `controllerDrawOnKill` not applicable to gear kills | Low | `controllerDrawOnKill` tracks killed unit's controller; gear kill has no unit. Add `drawOnGearKill: number` field or bespoke name-check. |
| Last Rites `playUnitFromTrash` is a "you may" — needs optional prompt | Low | Existing optional trigger infrastructure already handles `optional=true` triggers via the trigger prompt UI. No extra work needed. |
| Pickpocket gold token conditional on kill | Low | Add `killedGear` local boolean in `applyParsed` killGear block, gate goldTokens on it. |

---

## Summary of New `ParsedEffect` Fields

| Field | Type | Description |
|-------|------|-------------|
| `grantShield` | `number` | [Shield N] granted to chosen unit this turn (targeted) |
| `grantTank` | `boolean` | [Tank] granted to chosen unit this turn (targeted) |
| `grantShieldHere` | `number` | [Shield N] granted to other friendly units at source's bf this turn (area) |
| `killGear` | `{ scope, maxEnergy } \| null` | Kill a chosen gear matching scope/cost filter |
| `bounceGear` | `boolean` | Return a chosen friendly gear to its owner's hand |

Optional (bespoke path):
| `playGearFromHand` | `{ maxEnergy, energyOnly } \| null` | Play a gear from hand ignoring Energy cost (Jayce follow-up) |
