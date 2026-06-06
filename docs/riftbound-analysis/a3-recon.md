# A3 Recon: Movement / Ready / Placement Restrictions

_Generated: 2026-06-06. Read-only survey; no engine files were modified._

---

## A3-1 — movementRestriction: Units Can't Move to Base

### Current Implementation

**RETREAT reducer** — `engine.ts:5538–5559`

```ts
case 'RETREAT': {
  const guard = requireActiveAction(state, action.player)
  if (guard) return fail(state, guard)
  const s = clone(state)
  for (let i = 0; i < s.battlefields.length; i++) {
    const bf = s.battlefields[i]
    const idx = bf.units.findIndex(
      (u) => u.iid === action.iid && u.owner === action.player,
    )
    if (idx >= 0) {
      if (bfScriptAt(s, i)?.noMoveToBase)          // <-- battlefield-level guard
        return fail(state, `Units can't move from ${getCard(bf.cardId)?.name ?? 'here'} to base.`)
      if (bf.units[idx].cantMoveTurn === s.turn)
        return fail(state, `${def(bf.units[idx])?.name} can't move this turn.`)
```

**BattlefieldScript interface** — `battlefieldScripts.ts:53`
```ts
noMoveToBase?: boolean
```

**Only existing entry** — `battlefieldScripts.ts:90`
```ts
"Vilemaw's Lair": { noMoveToBase: true },
```

### Cards

| Card | ID | Verbatim Text |
|---|---|---|
| Minotaur Reckoner | `sfd-014-221` | `"Units can't move to base."` |
| Determined Sentry | `unl-111-219` | `"I can't move to base."` |

### What Is Missing

1. **Minotaur Reckoner (global aura)** — When this unit is in play, ALL units (both players) cannot retreat to base. No engine check exists for this; the RETREAT reducer only checks `bfScriptAt(...).noMoveToBase` (a battlefield script flag), not a unit-aura scan.

2. **Determined Sentry (self flag)** — A per-unit flag `cantMoveToBase?: true` does not exist on `EngineCard` (types.ts). The RETREAT reducer has no per-unit check for this flag. Only `cantMoveTurn` (a different restriction) exists.

### Implementation Plan

**Step 1 — Add `cantMoveToBase` flag to `EngineCard`** (`types.ts` after line 55)
```ts
/** This unit can never retreat to its owner's base (Determined Sentry). */
cantMoveToBase?: boolean
```

**Step 2 — Add global-aura check helper** (`engine.ts` near `unitGrantedKeyword`, ~line 3810)
```ts
/** Returns true if any unit in play owned by any player has a "units can't move to base" aura. */
function globalNoMoveToBaseActive(s: MatchState): boolean {
  return [...s.battlefields.flatMap((b) => b.units), ...s.players.flatMap((p) => p.zones.base)]
    .some((u) => /units? can'?t move to base/i.test(getCard(u.cardId)?.text ?? ''))
}
```

**Step 3 — Stamp `cantMoveToBase` on Determined Sentry at play time** (`engine.ts` inside PLAY_UNIT after `ci` is pushed, ~line 5106 area)
```ts
if (/^i can'?t move to base\.?$/i.test((card.text ?? '').trim())) {
  const placed = p.zones.base.find((u) => u.iid === ci.iid) ??
    (enterBf != null ? s.battlefields[enterBf].units.find((u) => u.iid === ci.iid) : undefined)
  if (placed) placed.cantMoveToBase = true
}
```
(Or set it at unit creation via a helper that runs for any unit with that text.)

**Step 4 — Add both checks to RETREAT** (`engine.ts:5547`, insert before the existing `bfScriptAt` check)
```ts
// Global aura: Minotaur Reckoner "Units can't move to base."
if (globalNoMoveToBaseActive(s))
  return fail(state, "Units can't move to base right now.")
// Per-unit flag: Determined Sentry "I can't move to base."
if (bf.units[idx].cantMoveToBase)
  return fail(state, `${def(bf.units[idx])?.name} can't move to base.`)
```

**Step 5 — Also check `cantMoveToBase` in `moveToBase` effect path** (`engine.ts:4448`)
When `e.moveToBase` is resolved (Fight or Flight, Isolate, Emperor's Divide), the target is moved via `sendUnitToBase`. Add a guard:
```ts
if (e.moveToBase) {
  const mu = findUnitAnywhere(s, t)
  if (mu?.cantMoveToBase) {
    s = log(s, controller, `${card.name}: ${getCard(mu.cardId)?.name} can't be moved to base.`)
  } else if (mu && sendUnitToBase(s, t)) {
    s = log(s, controller, `${card.name}: moved ${getCard(mu.cardId)?.name} to its base.`)
  }
}
```

---

## A3-2 — readyRestriction: "I Can't Be Readied" + Mageseeker Warden Aura

### Current Ready Paths (complete inventory)

| Path | File:Line | Description |
|---|---|---|
| Awaken sweep | `engine.ts:3010–3014` | Maps all cards exhausted=false for active player at turn start |
| `readyAllUnits` effect | `engine.ts:898–903` | Auto-readies all friendly units (Shurelya's Requiem) |
| `readyOrExhaustLegend` | `engine.ts:905–910` | Ready/exhaust a legend (Royal Entourage) |
| `readyUnits` → `readyChoice` | `engine.ts:912–923` | Prompt: choose N exhausted units |
| `readySelf` | `engine.ts:958–965` | Readies the source unit (Sivir, Wildclaw Shaman) |
| `READY_UNIT` reducer | `engine.ts:5580–5592` | Resolves a `readyChoice` selection |
| Activated `readyUnits` | `engine.ts:5994` | ACTIVATE_UNIT targeted ready |
| Activated `readyAllUnits` | `engine.ts:6002` | ACTIVATE_UNIT sweep ready |
| Activated `readySelf` | `engine.ts:6003` | ACTIVATE_UNIT self-ready |
| `readyRunes` | `engine.ts:925–931` | Ready rune cards (not units) |

### Cards

| Card | ID | Verbatim Text |
|---|---|---|
| Maduli the Gatekeeper | `unl-144-219` | `"I can't be readied. :rb_rune_chaos:: Move me to an occupied enemy battlefield if my Might is greater than the total Might of enemy units there."` |
| Mageseeker Warden | `ogn-070-298` | `"While I'm at a battlefield, opponents can only play units to their base. While I'm at a battlefield, spells and abilities can't ready enemy units and gear."` |

### What Is Missing

Neither card has any handler in `engine.ts`. No `cantBeReadied` flag, no Mageseeker aura check, nothing.

### Implementation Plan — Maduli the Gatekeeper

**Step 1 — Add `cantBeReadied` flag to `EngineCard`** (`types.ts`, after `cantMoveToBase`)
```ts
/** This unit can never be readied by any effect (Maduli the Gatekeeper). */
cantBeReadied?: boolean
```

**Step 2 — Stamp flag at play time** (same location as `cantMoveToBase` stamping above)
```ts
if (/^i can'?t be readied\.?/i.test(card.text ?? '')) {
  placed.cantBeReadied = true
}
```

**Step 3 — Guard Awaken sweep** (`engine.ts:3010–3014`, replace the map calls)
```ts
// Legend
if (p.legend && !p.legend.cantBeReadied) p.legend.exhausted = false
// Zones
for (const z of Object.keys(p.zones) as ZoneId[])
  p.zones[z] = p.zones[z].map((c) => (c.cantBeReadied ? c : { ...c, exhausted: false }))
// Battlefields
for (const bf of s.battlefields)
  bf.units = bf.units.map((u) => (u.owner === ap && !u.cantBeReadied ? { ...u, exhausted: false } : u))
```

**Step 4 — Guard `readyAllUnits`** (`engine.ts:898–903`)
```ts
if (e.readyAllUnits) {
  for (const u of [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)])
    if (u.owner === p.id && u.exhausted && !u.cantBeReadied && getCard(u.cardId)?.type === 'unit')
      { u.exhausted = false; n++ }
```

**Step 5 — Guard `readyUnits` filter** (`engine.ts:916–917`)
```ts
const exhausted = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
  (u) => u.owner === p.id && u.exhausted && !u.cantBeReadied && getCard(u.cardId)?.type === 'unit' && u.iid !== excludeIid,
)
```

**Step 6 — Guard `readySelf`** (`engine.ts:958–965`)
```ts
if (costPaid && e.readySelf && sourceIid) {
  const u = findUnitAnywhere(s, sourceIid) ?? ...
  if (u && u.owner === p.id && u.exhausted && !u.cantBeReadied) {
    u.exhausted = false
    ...
```

**Step 7 — Guard `READY_UNIT` reducer** (`engine.ts:5586–5588`)
```ts
const u = findUnitAnywhere(s, action.iid)
if (!u || u.owner !== action.player || !u.exhausted || u.cantBeReadied)
  return fail(state, 'Choose one of your exhausted units (or that unit cannot be readied).')
```

**Step 8 — Guard activated `readyUnits/readySelf`** (`engine.ts:5994`, `6002`, `6003`)
Add `&& !tu.cantBeReadied` to each ready call.

**Step 9 — Maduli's activated ability** (Chaos rune cost, move-to-occupied-enemy-bf-if-Might-greater)
This is a targeted movement ability. Wire it as an `ACTIVATE_UNIT` trigger:
- Parse the `:rb_rune_chaos:` cost and "move me to an occupied enemy battlefield" text.
- Check: `battlefieldOf(s, u.iid) < 0` (Maduli must be at base), find all enemy-controlled battlefields where sum of enemy Might < Maduli's Might, move Maduli there via `moveUnits`.
- Add to the bespoke handler block near line 5960+.

---

### Implementation Plan — Mageseeker Warden

The Warden has two distinct aura effects while it is at a battlefield:

**Aura 1: "Opponents can only play units to their base."**

This blocks opponents from playing ANY card except units-to-base. This requires:

**Step A — Add helper** (`engine.ts` near `unitGrantedKeyword`)
```ts
/** Returns true if any friendly (owner=`ap`) Mageseeker Warden is at a battlefield. */
function mageseekerWardenActive(s: MatchState, ap: PlayerId): boolean {
  return s.battlefields.some((b) =>
    b.units.some((u) => u.owner === ap && getCard(u.cardId)?.name === 'Mageseeker Warden'),
  )
}
```

**Step B — In `canPlay` validation** (`engine.ts` ~line 6640+, the `canPlay` export function):
```ts
// Mageseeker Warden: "opponents can only play units to their base"
const opWarden = s.players.some((_, i) => i !== player && mageseekerWardenActive(s, i))
if (opWarden) {
  if (type !== 'unit') return { valid: false, reason: 'Mageseeker Warden: you can only play units.' }
  // unit must go to base (action.toBattlefield must be null / no bf chosen)
  if ((action as { toBattlefield?: number | null }).toBattlefield != null)
    return { valid: false, reason: 'Mageseeker Warden: units must be played to your base.' }
}
```
Also add the guard inside the PLAY_UNIT/PLAY_SPELL/PLAY_GEAR reducer arms (mirror).

**Aura 2: "Spells and abilities can't ready enemy units and gear."**

This needs to block all ready effects when Warden is on the opposing side. Affects:
- `readyAllUnits` (engine.ts:898): skip if an opponent's Warden is at a bf
- `readyUnits` (engine.ts:912): same
- `readySelf` (engine.ts:958): same
- `READY_UNIT` reducer (engine.ts:5580): same
- Activated `readyAllUnits`/`readySelf` (engine.ts:6002, 6003): same

Add a helper:
```ts
function wardenBlocksReady(s: MatchState, beneficiary: PlayerId): boolean {
  // An enemy Mageseeker Warden at a battlefield blocks ready effects targeting `beneficiary`'s units
  return s.players.some((pl, i) => i !== beneficiary && mageseekerWardenActive(s, i))
}
```
Then in each ready path, add `&& !wardenBlocksReady(s, p.id)` (or `u.owner`) before the unexhaust.

Note: The Warden aura is conditional on it being AT a battlefield (not base), so the helper checks `s.battlefields` only.

---

## A3-3 — placementPredicate: Play-to-BF / Open / Occupied-Enemy / Conquered-This-Turn

### Current `canPlayToBf` regex — `engine.ts:5094`

```ts
const canPlayToBf = !kw.ambush && /play (?:me|this) to (?:a|an|any|its)?\s*battlefield/i.test(card.text ?? '')
const playToBf = canPlayToBf && action.toBattlefield != null ? action.toBattlefield : null
```

**This regex is a single undifferentiated check.** It does NOT validate:
- Sneaky Deckhand / Sai Scout: destination must be OPEN (no units from either player)
- Dauntless Vanguard / Deadbloom Predator: destination must be ENEMY-OCCUPIED
- Perched Grimwyrm: destination must be in `conqueredThisTurn[]`

The regex matches all three and lets any destination through.

### Cards

| Card | ID | Verbatim Text |
|---|---|---|
| Sneaky Deckhand | `ogn-176-298` | `"You may play me to an open battlefield."` |
| Sai Scout | `ogn-174-298` | `"[Vision] ... You may play me to an open battlefield."` |
| Dauntless Vanguard | `sfd-093-221` | `"You may play me to an occupied enemy battlefield."` |
| Deadbloom Predator | `ogn-161-298` | `"[Deflect] ... You may play me to an occupied enemy battlefield."` |
| Perched Grimwyrm | `sfd-015-221` | `"Play me only to a battlefield you conquered this turn. (You can't play me anywhere else.)"` |
| Miss Fortune - Buccaneer | `ogn-193-298` / `ogn-193a-298` / `opp-193-298` | `"You may play me to an open battlefield. Friendly units may be played to open battlefields."` |

### `conqueredThisTurn` Tracking — ALREADY EXISTS

`markConquered` is called at `engine.ts:2912`, `2944`, `4224`. `conqueredThisTurn` is cleared at turn start `engine.ts:3000` and in `clearTurnState` override `engine.ts:6228`. **The data is available; the validation just isn't wired.**

### Enters-Ready Logic for play-to-bf — `engine.ts:5099–5101`

```ts
const readyHere = ambushBf != null || entersReady || /if you play (?:me|this) to a battlefield, i enters? ready/i.test(card.text ?? '')
```
Sneaky Deckhand has no "enters ready" clause → enters exhausted. Dauntless Vanguard same. Perched Grimwyrm: no "enters ready" clause found in its text.

### Enters-Exhausted Decision for Perched Grimwyrm

Perched Grimwyrm text is only `"Play me only to a battlefield you conquered this turn."` — no enters-ready clause → enters exhausted (correct default).

### Implementation Plan — Open BF Predicate (Sneaky Deckhand, Sai Scout)

**Step 1 — Add open-bf regex** (`engine.ts` ~line 5094, alongside existing canPlayToBf)
```ts
const wantsOpenBf = canPlayToBf && /play (?:me|this) to (?:a|an|any|its)?\s*open\s*battlefield/i.test(card.text ?? '')
const wantsEnemyOccupiedBf = canPlayToBf && /play (?:me|this) to (?:a|an|any|its)?\s*occupied enemy\s*battlefield/i.test(card.text ?? '')
const wantsConqueredBf = /play me only to a battlefield you conquered this turn/i.test(card.text ?? '')
```

**Step 2 — Validate destination** (insert before `const enterBf = ...` line ~5096)
```ts
if (wantsOpenBf && action.toBattlefield != null) {
  const dest = s.battlefields[action.toBattlefield]
  if (dest && dest.units.length > 0)
    return fail(state, `${card.name} can only be played to an open (empty) battlefield.`)
}
if (wantsEnemyOccupiedBf && action.toBattlefield != null) {
  const dest = s.battlefields[action.toBattlefield]
  const hasEnemy = dest?.units.some((u) => u.owner !== action.player)
  if (!hasEnemy)
    return fail(state, `${card.name} must be played to a battlefield with enemy units.`)
}
if (wantsConqueredBf) {
  const ct = s.players[action.player].conqueredThisTurn ?? []
  if (action.toBattlefield == null || !ct.includes(action.toBattlefield))
    return fail(state, `${card.name} can only be played to a battlefield you conquered this turn.`)
  // Also prohibit playing to base at all (the card text says "you can't play me anywhere else")
  // action.toBattlefield being null would fall through to base placement — guard that too
}
// Perched Grimwyrm must go to a bf (null → base is not allowed)
if (wantsConqueredBf && action.toBattlefield == null)
  return fail(state, `${card.name} must be played to a conquered battlefield, not your base.`)
```

**Step 3 — Mirror the same checks in `canPlay`** (`engine.ts` ~line 6640, the export `canPlay` function) so the UI can grey-out the card or disable invalid destinations.

**Step 4 — Miss Fortune - Buccaneer legend aura** — Her second line grants ALL friendly units the open-bf play. Implement as a helper:
```ts
function friendlyUnitsCanPlayToOpenBf(s: MatchState, player: PlayerId): boolean {
  return s.players[player].legend && getCard(s.players[player].legend!.cardId)?.name?.includes('Miss Fortune - Buccaneer') ||
    [...s.battlefields.flatMap(b => b.units), ...s.players[player].zones.base]
      .some(u => u.owner === player && /friendly units may be played to open battlefields/i.test(getCard(u.cardId)?.text ?? ''))
}
```
Then in PLAY_UNIT, if a non-special unit chooses `action.toBattlefield`, allow it when `friendlyUnitsCanPlayToOpenBf` is true and the destination is empty.

---

## A3-4 — entersReady Aura (Magma Wurm) + Blitzcrank Pull

### Magma Wurm

**Card** `ogn-011-298` — `"Other friendly units enter ready."`

**Current state of entersReady** — the `entersReady` flag at `engine.ts:5068` is computed from:
```ts
const entersReady = accelChosen || levelReady || baseReady || legendReady || condReady
```
`baseReady` matches `\bi enters? ready\b` on the PLAYED card's own text. Magma Wurm does NOT have "I enter ready" — it grants that to OTHERS. There is **no aura scan here**.

`legendReady` matches the controller's legend text for `[Level N] your units enter ready` — Wuju Master only, also not Magma Wurm.

**Gap**: When Magma Wurm is in play, any subsequently-played friendly unit should enter ready. There is no such aura check.

**Implementation Plan**

**Step 1 — Add aura helper** (`engine.ts` near `tokensEnterReady`, ~line 2193)
```ts
/** Returns true if any friendly unit of `player` has "other friendly units enter ready" aura. */
function friendlyUnitsEnterReadyAura(s: MatchState, player: PlayerId): boolean {
  return [...s.battlefields.flatMap((b) => b.units), ...s.players[player].zones.base]
    .some((u) => u.owner === player && /other friendly units enter ready/i.test(getCard(u.cardId)?.text ?? ''))
}
```

**Step 2 — Wire into `entersReady`** (`engine.ts:5068`, add to the OR chain)
```ts
const magmaAura = friendlyUnitsEnterReadyAura(s, action.player)
const entersReady = accelChosen || levelReady || baseReady || legendReady || condReady || magmaAura
```
Note: `baseReady` covers the played card itself having "I enter ready". `magmaAura` covers OTHER units in play granting it. Magma Wurm itself (when played) does NOT enter ready because the aura only applies to "other" units — so `magmaAura` must NOT count the card being placed (ci.iid is not yet in play at line 5068, so scanning existing friendlies is already correct).

---

### Blitzcrank - Impassive

**Card** `ogn-067-298` / `opp-067-298` — Full text:
```
[Tank] (I must be assigned combat damage first.)
When you play me to a battlefield, you may move an enemy unit to here.
When I hold, return me to my owner's hand.
```

**Current state** — `engine.ts:1383–1389`:
```ts
// Blitzcrank - Impassive: "When I hold, return me to my owner's hand." (Its
// "play me to a battlefield → pull an enemy" half needs battlefield-play support
// the engine lacks for non-Ambush units, so only the self-recall is modeled.)
if (ability.event === 'hold' && srcName === 'Blitzcrank - Impassive' && sourceIid) {
  s = bounceUnitToHand(s, sourceIid, player, 'Blitzcrank - Impassive', 0)
  s = log(s, player, `${label}: Blitzcrank returned to hand (held).`)
  handled = true
}
```
The **pull-an-enemy-here on play** is explicitly flagged as unimplemented (`// … pull an enemy … the engine lacks for non-Ambush units`).

**What "dynamic-battlefield" mechanism from Baron Pit could help**:
Baron Pit has no special unit-pull mechanism — the "dynamic battlefield" reference in memory likely refers to Blitzcrank's destination being whichever bf he was played to, passed as context to the on-play trigger. The existing `moveToBf` choice mechanism (`kind: 'moveToBf'` pendingChoice at `engine.ts:4463`) already moves a unit to a player-chosen destination bf. For Blitzcrank, the destination is FIXED (the bf Blitzcrank was just played to), so we need a simpler "move to here" path.

**Implementation Plan**

**Step 1 — Fire a `playBf` trigger** when Blitzcrank is played to a battlefield. The trigger's `bfIndex` should be the bf where Blitzcrank landed. This is available at `engine.ts:5237` via `playToBf`. After `firePlayTriggers` at line 5220, the `bfIndex` is in scope.

**Step 2 — Add bespoke handler** in the `fireAbility` bespoke block (~`engine.ts:1383`):
```ts
// Blitzcrank - Impassive: "When you play me to a battlefield, you may move an enemy unit to here."
if (ability.event === 'play' && srcName === 'Blitzcrank - Impassive' && sourceIid && bfIndex != null && bfIndex >= 0) {
  const enemies = s.battlefields.flatMap((b, i) => i !== bfIndex
    ? b.units.filter((u) => u.owner !== player).map((u) => ({ ...u, srcBf: i }))
    : [])
  if (enemies.length > 0) {
    // Auto-pick: move the highest-Might enemy not already at Blitzcrank's battlefield.
    const target = enemies.reduce((hi, u) => mightOf(u) > mightOf(hi) ? u : hi)
    const pulled = pluckCardAnywhere(s, target.iid)
    if (pulled) {
      const priorCtrl = s.battlefields[bfIndex].controller
      s.battlefields[bfIndex].units.push(pulled)
      recomputeControllers(s)
      s = log(s, player, `Blitzcrank: pulled ${getCard(pulled.cardId)?.name} to ${bfBaseNameAt(s, bfIndex) || 'this battlefield'}.`)
      s = showdownOrConquerAfterEffectMove(s, bfIndex, pulled.iid, priorCtrl)
    }
  }
  handled = true
}
```
Note: This auto-pulls the strongest enemy. If an optional-choice variant is preferred, surface it via `offerChoice` with `kind: 'moveToBf'` (the existing mechanism) but pre-fixing the destination to `bfIndex`.

**Step 3 — Ensure `bfIndex` is threaded to the on-play trigger** — `firePlayTriggers` at `engine.ts:5220` is called with `effTotal` but not `bfIndex`. Check that the `bfIndex` parameter reaches `fireAbility`. If not, pass the played-to bf index through `collectSelf` or the trigger context.

---

## MISSED-CARDS Section

These cards are in the pool and belong to the A3 cluster but were not listed in the original task. They all need implementation work.

### Move-Enemy Cards (enemy relocation — distinct from RETREAT)

These all use the `moveUnit: true` effect or are un-handled bespoke triggers. The generic `moveUnit` spell path (`engine.ts:4453–4464`) already handles TARGETED move-enemy-to-chosen-bf via `offerChoice(kind:'moveToBf')`. Cards using that text route through the parser correctly. However, several have BESPOKE conditions not parsed:

| Card | ID | Verbatim Text | Status |
|---|---|---|---|
| Charm | `ogn-043-298` | `"Move an enemy unit."` | Handled via `moveUnit` parser |
| Dragon's Rage | `ogn-258-298` | `"Move an enemy unit. Then ... they deal damage to each other."` | `moveUnit` fires; the post-move collision is unhandled — needs bespoke |
| Temptation | `sfd-129-221` | `"[Repeat] :rb_energy_2: Move an enemy unit to a location where there's a unit with the same controller."` | `moveUnit` fires; destination constraint (same-controller unit) not enforced |
| Skyward Strike | `unl-038-219` | `"Move an enemy unit. [Level 6][>] Stun an enemy unit."` | `moveUnit` fires; Level-6 stun is handled by the parser if `[Level 6]` gate is wired |
| Isolate | `unl-124-219` | `"Move an enemy unit from a battlefield to its base. Then, if there's an enemy unit alone at that battlefield, draw 1."` | Uses `moveToBase` (sendUnitToBase path) not `moveUnit`; the "then draw 1 if alone" is unhandled |
| Iascylla | `unl-050-219` | `"When I hold, at the start of your next Main Phase, you may move an enemy unit to this battlefield."` | Bespoke hold trigger, deferred-move-to-here; not handled |
| Imposing Challenger | `unl-105-219` | `"When I move, you may move an enemy unit here with less Might than me to a different battlefield."` | Bespoke on-move trigger; not handled |
| Irresistible Faefolk | `unl-112-219` | `"When I move to a battlefield, you may move an enemy unit to that battlefield."` | Bespoke on-move trigger (pull-to-here); not handled — same shape as Blitzcrank |
| Blast Cone | `unl-133-219` | `"When you play this, you may move an enemy unit. When you move an enemy unit, you may exhaust this to [Stun] it."` | First clause: `moveUnit` works. Second clause (exhaust-to-stun on any enemy move) is a reactive trigger; not handled |
| Sinister Poro | `unl-137-219` | `"When I attack, you may pay :rb_energy_1: to move an enemy unit here to its base."` | On-attack costed trigger; not handled |
| Evelynn - Entrancing | `unl-141-219` | `"[Hidden]...[Backline] When you play me from face down on your turn, you may move an enemy unit at a different location to my battlefield."` | On-reveal-play trigger, pull-to-here; not handled |
| Void Assault | `unl-202-219` | `"Move a friendly unit, then move an enemy unit. (If they both move to a battlefield you don't control, you're the attacker.)"` | Friendly-move + enemy-move + conditional-attacker role; not handled |

### Open-Battlefield Play Aura — Miss Fortune - Buccaneer

| Card | ID | Verbatim Text |
|---|---|---|
| Miss Fortune - Buccaneer | `ogn-193-298`, `ogn-193a-298`, `opp-193-298` | `"You may play me to an open battlefield. Friendly units may be played to open battlefields."` |

The second sentence is a LEGEND/UNIT AURA granting all friendly units the open-bf placement ability. Currently the `canPlayToBf` regex matches MF's own play text correctly, but the aura on line 2 is entirely unimplemented. Implementation: see A3-3 Step 4 above.

### Occupied-Enemy Placement Cards

| Card | ID | Verbatim Text |
|---|---|---|
| Dauntless Vanguard | `sfd-093-221` | `"You may play me to an occupied enemy battlefield."` |
| Deadbloom Predator | `ogn-161-298` | `"[Deflect]... You may play me to an occupied enemy battlefield."` |

Both match the same generic `canPlayToBf` regex but with no destination enforcement. Implementation: see A3-3 Step 2 (wantsEnemyOccupiedBf).

---

## Summary of Engine Files / Line Anchors

| File | Key Lines | Topic |
|---|---|---|
| `engine.ts` | 5538–5559 | RETREAT reducer |
| `engine.ts` | 5548 | `bfScriptAt(...).noMoveToBase` check |
| `engine.ts` | 5550 | `cantMoveTurn` check |
| `engine.ts` | 3009–3014 | Awaken ready sweep |
| `engine.ts` | 898–923 | `readyAllUnits`, `readyOrExhaustLegend`, `readyUnits` |
| `engine.ts` | 958–965 | `readySelf` |
| `engine.ts` | 5580–5592 | `READY_UNIT` reducer |
| `engine.ts` | 5994, 6002, 6003 | Activated unit ready paths |
| `engine.ts` | 5040–5107 | PLAY_UNIT entersReady + canPlayToBf + placement |
| `engine.ts` | 5094–5095 | `canPlayToBf` regex (the single undifferentiated check) |
| `engine.ts` | 5237 | `showdownOrConquerAfterEffectMove` call post-play |
| `engine.ts` | 1383–1389 | Blitzcrank bespoke handler (hold only; pull flagged TODO) |
| `engine.ts` | 2052–2058 | `markConquered` / `conqueredThisTurn` |
| `engine.ts` | 4448–4464 | `moveToBase` + `moveUnit` resolution |
| `engine.ts` | 5641–5657 | `moveToBf` pendingChoice resolver |
| `engine.ts` | 3810–3831 | `unitGrantedKeyword` / `unitGrantedKeywordHere` |
| `battlefieldScripts.ts` | 53 | `noMoveToBase` in `BattlefieldScript` |
| `battlefieldScripts.ts` | 90 | Vilemaw's Lair: noMoveToBase = true |
| `types.ts` | 39–93 | `EngineCard` interface (no `cantMoveToBase`, no `cantBeReadied`) |
| `types.ts` | 103–167 | `PlayerState` (has `conqueredThisTurn?: number[]` line 142) |
