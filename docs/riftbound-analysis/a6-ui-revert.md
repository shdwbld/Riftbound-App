# A6 Control/Steal — UI Design & Revert Plan

Research date: 2026-06-06  
Cards in scope: **Hostile Takeover** (until-end-of-turn steal of a battlefield unit),
**Akshan - Mischievous** (steal an enemy Gear while Akshan is in play).

---

## (a) Stolen-unit badge in BoardCard.tsx

### What needs a badge

A stolen unit has `u.owner !== u.controlledBy` (owner = the original player;
controlledBy = the current controller who stole it).  The unit **renders on the
controller's side** (i.e. inside the controller's zone or the shared
battlefield) but its card art still shows the enemy legend.  Without a badge,
neither player can tell at a glance who "really" owns it.

### Badge pattern — mirror existing

BoardCard already has four badge families:

| Badge | Position | Tailwind classes (pattern) |
|---|---|---|
| Might / damage | bottom-right | `absolute bottom-0 right-0 rounded-tl px-1 text-[9px] font-bold bg-black/75 text-rose-300` |
| ±Might counter | left-center | `absolute left-0 top-1/2 -translate-y-1/2 rounded-r px-1 text-[9px] font-bold` |
| Status (M/buff/stun/lvl) | top-left column | `absolute left-0 top-0 flex flex-col gap-px text-[8px]` |
| Keyword (T/S/A/…) | bottom-left row | `absolute bottom-0 left-0 flex flex-wrap gap-px p-px text-[7px]` |

The **stolen badge** should sit in the **top-right corner**, mirroring the
existing "H" (Hidden) badge already rendered in BattlefieldZone for facedown
cards (`absolute -right-1 -top-1 z-10 rounded-full … text-[8px] font-bold`).

### Proposed implementation

```tsx
// In BoardCard.tsx — add to the existing status-badge block (the ci cast
// already widens to include optional fields; add controlledBy here):
const cx = ci as CardInstance & {
  buffs?: number; stunned?: boolean; tempMight?: number;
  attached?: string[]; controlledBy?: PlayerId;
}

// After the existing stunned/marker checks, add:
{cx.controlledBy != null && cx.controlledBy !== ci.owner && !faceDown && (
  <span
    className="absolute right-0 top-0 z-10 rounded-bl bg-fuchsia-600/90 px-0.5 text-[8px] font-bold text-white shadow ring-1 ring-black/60"
    title={`Stolen — controlled by player ${cx.controlledBy + 1} (owner: player ${ci.owner + 1})`}
    aria-label="stolen"
  >
    ☠C
  </span>
)}
```

Use `bg-fuchsia-600/90` to distinguish it from every other badge color and
make it visually alarming — the card is under hostile control.  The label
`☠C` reads "Controlled" and echoes the Hostile Takeover name; a simpler `C`
is fine if the skull is too loud.

### Render-side placement

In **BattlefieldZone** (`MatchBoard.tsx`, line ~1431–1453), stolen units from
the enemy that are now fighting **for the local player** will have
`u.owner !== perspective` but `u.controlledBy === perspective`.  The existing
`opacity-90` dim applied to `u.owner !== perspective` should be suppressed for
stolen units — add a guard:

```tsx
// line ~1444 — existing:
className={`relative ${u.owner === perspective ? '' : 'opacity-90'} …`}

// new:
const isStolen = (u as { controlledBy?: PlayerId }).controlledBy != null
  && (u as { controlledBy?: PlayerId }).controlledBy !== u.owner
const dimEnemy = u.owner !== perspective && !isStolen
className={`relative ${dimEnemy ? 'opacity-90' : ''} …`}
```

When the stolen unit belongs to the **opponent** (Hostile Takeover: it fights
for the opponent at your battlefield), it still renders in `bf.units`; the
badge tells each player it is temporarily defecting.

---

## (b) End-of-turn revert for Hostile Takeover

### Where the cleanup runs

`case 'END_TURN'` in `engine.ts` (line ~6993–7028) is the canonical
"per-turn cleanup" block.  It currently maps over every unit in
`s.players[pl].zones[z]` and every `bf.units` to clear:
`tempMight`, `stunned`, `grantAssault`, `grantGanking`, `grantShield`,
`grantTank`, `deathShield`, `banishShield`.

The "steal until end of turn" revert belongs **immediately after this map**,
still inside `case 'END_TURN'`, before the resource pool is cleared and before
`beginTurn` is called.  Order matters: clearing `controlledBy` may change
where the unit logically belongs (the controller's battlefield vs. the
enemy's), and `recomputeControllers` must run after.

### Data model additions needed

```ts
// In EngineCard (types.ts):
/** Player who currently controls this unit (differs from owner when stolen).
 *  Undefined / equal to owner = normal. Set by Hostile Takeover + Akshan gear. */
controlledBy?: PlayerId

/** When true, this unit's steal expires at end of the CURRENT turn (Hostile
 *  Takeover). On revert, the unit is recalled to its owner's base. */
stolenUntilEot?: boolean
```

### Revert pass (engine.ts, inside `case 'END_TURN'`)

```ts
// --- A6 steal revert: "until end of turn" stolen units return to owner base.
// Collect before any mutation so we don't skip elements mid-loop.
const stolenUnits: EngineCard[] = []
for (const bf of s.battlefields)
  stolenUnits.push(...bf.units.filter((u) => u.stolenUntilEot))

for (const u of stolenUnits) {
  // Remove from its current battlefield.
  for (const bf of s.battlefields) {
    const idx = bf.units.findIndex((x) => x.iid === u.iid)
    if (idx >= 0) bf.units.splice(idx, 1)
  }
  // Return to owner's base, exhausted (card text: "recall it at end of turn").
  s.players[u.owner].zones.base.push({
    ...u,
    exhausted: true,
    controlledBy: undefined,
    stolenUntilEot: undefined,
    damage: 0,          // Hostile Takeover says "recall" which heals it
  })
  s = log(s, null, `Hostile Takeover expired — ${getCard(u.cardId)?.name ?? 'a unit'} recalled to its owner's base.`)
}
recomputeControllers(s)
// --- end A6 steal revert ---
```

Place this block right after the `bf.units.map(…)` cleanup (line ~7004) and
before `s.players[state.activePlayer].pool = { energy: 0, power: {} }`.

### clearTurnState sandbox op

The existing `'clearTurnState'` override op (used to unstick per-turn flags)
should also clear `stolenUntilEot` on any unit so sandbox can manually trigger
the revert without waiting for end-of-turn.

---

## (c) On-leave revert for Akshan's stolen gear

### The mechanic

Akshan's text: "You control it [the enemy gear] until **I leave the board**."
This is a persistent steal, not an end-of-turn one — the gear returns to the
enemy's base when Akshan dies, bounces, or recalls.

### Data model

```ts
// In EngineCard (types.ts):
/** The iid of the Akshan instance that stole this gear. When Akshan leaves
 *  play, any gear with a matching akshanStolenBy is returned to its original
 *  owner (u.owner) base. */
akshanStolenBy?: string
```

The gear's `owner` stays as the original owner.  `controlledBy` is set to
Akshan's player.  On attach, the gear is in Akshan's `attached` list but its
`owner` points to the enemy.

### Where Akshan leaves play is detected

Every path that removes a unit from the board calls one of:

| Exit path | Engine site |
|---|---|
| Killed at battlefield | `killUnit()` ~line 4976 → `bf.units.splice` |
| Recalled / bounced to hand | `returnUnitToHand()` ~line 2922 |
| Sent to base (sendUnitToBase) | ~line 2592 |
| Death-shield recall | `recallToBase()` ~line 3082 |
| RETREAT action | RETREAT handler ~line 2594 |
| Token ceases to exist | `trashOrBanish()` |
| Sandbox move (OVERRIDE 'move') | pluckCardAnywhere ~line 1084 |

The cleanest hook is a **shared helper called from all paths** immediately
after the unit is removed from the board.  The equipment-overhaul already
detaches gear in `returnUnitToHand` (line ~2965) — Akshan's revert should run
alongside:

```ts
function onUnitLeavesPlay(s: MatchState, u: EngineCard): void {
  // ... existing deathknell hooks ...

  // A6: return any gear this Akshan instance stole.
  if ((getCard(u.cardId)?.name ?? '').includes('Akshan')) {
    for (const bf of s.battlefields)
      for (const unit of bf.units)
        revertAkshanGear(s, u.iid, unit)
    for (const p of s.players)
      for (const baseUnit of p.zones.base)
        revertAkshanGear(s, u.iid, baseUnit)
  }
}

function revertAkshanGear(s: MatchState, akshanIid: string, host: EngineCard): void {
  const stolenRefs = host.attached.filter((ref) => {
    const [, giid] = ref.split('|')
    // Look up the gear instance to check akshanStolenBy.
    // (Store it on the gear's EngineCard via the attached entry's metadata.)
    // Simplest: store akshanStolenBy on the host as a map, or track stolen
    // gear refs in a top-level MatchState set.
  })
  // Detach stolen refs and return them to their original owner's base.
  for (const ref of stolenRefs) {
    const [gCardId, gIid] = ref.split('|')
    // Find original owner from the gear's owner field (stored when stolen).
    const originalOwner = ... // from stolenGearOwner lookup
    s.players[originalOwner].zones.base.push({
      iid: gIid, cardId: gCardId, owner: originalOwner,
      exhausted: false, damage: 0, attached: [],
    })
    host.attached = host.attached.filter((r) => r !== ref)
  }
}
```

**Simplest concrete approach**: add a `MatchState`-level registry
`stolenGear?: Record<string, { originalOwner: PlayerId; akshanIid: string }>`
keyed by gear iid.  When Akshan is played with `paidAdditional` and moves an
enemy gear (the `paidBonusEffect` path in `engine.ts`), register the entry.
The `onUnitLeavesPlay` hook iterates the registry, finds entries where
`akshanIid === u.iid`, detaches them from wherever they are, and returns them
to `players[originalOwner].zones.base`.  Clear the registry entry after.

---

## (d) Cross-player steal pickers — new pendingChoice kinds

### Proposed new kinds

```ts
// In types.ts — extend pendingChoice.kind union:
| 'stealUnit'   // Hostile Takeover: pick an enemy unit at a battlefield
| 'stealGear'   // Akshan paid bonus: pick one of an enemy's attached gear pieces
```

### Building the options array

For **stealUnit** (Hostile Takeover effect resolves):
```ts
// options = enemy units at the battlefield where the card was played
const bfi = battlefieldOf(s, sourceIid)  // the Hidden card's battlefield
const enemyUnits = s.battlefields[bfi].units.filter((u) => u.owner !== controller)
const options = enemyUnits.map((u) => ({
  iid: u.iid,
  label: getCard(u.cardId)?.name ?? u.iid,
}))
s.pendingChoice = {
  player: controller,
  kind: 'stealUnit',
  bfIndex: bfi,
  prompt: 'Take control of an enemy unit at this battlefield.',
  options,
}
```

For **stealGear** (Akshan paid-additional effect):
```ts
// options = each piece of gear on every enemy unit on the board
const enemyGear: { iid: string; label: string }[] = []
for (const bf of s.battlefields)
  for (const u of bf.units.filter((x) => x.owner !== controller))
    for (const ref of u.attached) {
      const [gCardId, gIid] = ref.split('|')
      enemyGear.push({ iid: gIid, label: `${getCard(gCardId)?.name ?? gCardId} (on ${getCard(u.cardId)?.name ?? u.iid})` })
    }
// payload carries the host unit iid so the resolver can detach
s.pendingChoice = {
  player: controller,
  kind: 'stealGear',
  bfIndex: -1,
  prompt: 'Move an enemy gear to your base (attach it to Akshan if it is Equipment).',
  options: enemyGear,
  payload: akshanIid,
}
```

### UI rendering

The existing `pendingChoice` flow in **MatchPage.tsx** (line ~779–786) renders
a `<ChoiceModal>` for `match.pendingChoice.player === controlling`.  The new
kinds need no separate component — they reuse the same ChoiceModal.  The
`RESOLVE_CHOICE` dispatcher already wires `iid → action`.

The resolver for `stealUnit` inside `RESOLVE_CHOICE` (the big switch on
`pc.kind` at ~line 6326) would:
1. Find the unit by iid.
2. Mark it `controlledBy: controller, stolenUntilEot: true`.
3. Ready it (card text: "Ready it.").
4. Call `recomputeControllers(s)`.
5. If other enemies are present at the battlefield, open a showdown
   (`showdownOrConquerAfterEffectMove`); otherwise conquer.

### CardSearchOverlay: can the `owner` prop be made dynamic?

`CardSearchOverlay` (line ~43–163) already accepts `owner: PlayerId` and reads
`match.players[owner].zones[zoneKey]`.  The prop is set by `searchOverlay`
state in MatchBoard: `{ owner: PlayerId; source: SearchSource }`.

For a steal-gear picker, we do **not** need CardSearchOverlay — `stealGear`
options are built from `attached[]` arrays (already enumerated in the engine,
surfaced as `pendingChoice.options`), not a full zone search.  CardSearchOverlay
is for sandbox tutor/search, not for engine-choice pickers.

If a future mechanic needed to search an **enemy's zone** (e.g. "look at your
opponent's hand"), the `owner` prop just needs to be passed the opponent's
`PlayerId` — no structural change to the component is required.  The caller
would set `searchOverlay = { owner: opponentId, source: 'hand' }` and add
`'hand'` to the `DESTS`/`TITLE` maps.  The overlay already reads
`match.players[owner]`, so this works automatically.

---

## (e) recomputeControllers and targetScope with controlledBy

### recomputeControllers

Current logic (line ~3260–3282) counts units by `u.owner`, not by controller:

```ts
for (const u of bf.units) counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1)
```

For Hostile Takeover the stolen unit physically fights for the thief and
**should count toward the thief's control total**.  The fix:

```ts
const effectiveOwner = (u as { controlledBy?: PlayerId }).controlledBy ?? u.owner
for (const u of bf.units) counts.set(effectiveOwner, (counts.get(effectiveOwner) ?? 0) + 1)
```

This makes the stolen unit count toward the thief's unit majority.  When the
steal expires and `recomputeControllers` runs again (inside the revert pass),
`controlledBy` is cleared, so the unit counts for the original owner again.

**Important note on Akshan's gear**: Gear (`EngineCard` in `attached[]`) never
participates in `recomputeControllers` — only `bf.units` are counted.  Akshan's
gear steal therefore has no impact on `recomputeControllers`, which is correct.

### getLegalTargets / targetScope

`getLegalTargets` (line ~7254–7262) filters by `u.owner`:

```ts
if (e.targetScope === 'enemy') units = units.filter((u) => u.owner !== player)
else if (e.targetScope === 'friendly') units = units.filter((u) => u.owner === player)
```

With control stealing, **controller identity** diverges from owner.
Riftbound's rules say effects that target "a unit you control" / "an enemy
unit" track the **current controller**, not the original owner.

Proposed helper:

```ts
function controllerOf(u: EngineCard): PlayerId {
  return (u as { controlledBy?: PlayerId }).controlledBy ?? u.owner
}
```

Replace the filter in `getLegalTargets`:

```ts
if (e.targetScope === 'enemy')    units = units.filter((u) => controllerOf(u) !== player)
else if (e.targetScope === 'friendly') units = units.filter((u) => controllerOf(u) === player)
```

Apply the same fix to `autoSpellTargets` (line ~4927–4930):

```ts
const want = e.targetScope === 'friendly' ? 'friendly' : 'enemy'
const pool = want === 'friendly'
  ? [...s.players[player].zones.base, ...all].filter((u) => controllerOf(u) === player && def(u)?.type === 'unit')
  : (here.some((u) => controllerOf(u) !== player) ? here : all).filter((u) => controllerOf(u) !== player && def(u)?.type === 'unit')
```

**Aura/passive effects** that reference "friendly units at this battlefield"
(e.g. `auraMightFor`, `battlefieldPassive`, `Azir Weaponmaster` aura) should
also be audited to use `controllerOf` rather than `u.owner` — this is a
separate audit pass not in scope here.

---

## Summary: key decisions and risks

### Badge approach
Add a `controlledBy?: PlayerId` field to `EngineCard`.  In `BoardCard.tsx`,
mirror the Hidden "H" badge pattern (top-right, `absolute -right-0 top-0`,
`bg-fuchsia-600/90`, label `☠C`).  In `BattlefieldZone`, suppress the
`opacity-90` dim for units where `controlledBy !== u.owner` so stolen units
render at full brightness regardless of which seat's zone they occupy.

### Revert hook
End-of-turn revert (Hostile Takeover) runs at the **top of `case 'END_TURN'`**,
immediately after the existing `bf.units.map(…)` per-flag cleanup but before
the resource-pool flush.  Akshan on-leave revert is injected into every unit-
exit path via a shared `onUnitLeavesPlay` helper (or inline in
`returnUnitToHand` / `killUnit` / `recallToBase`), keyed by a
`MatchState.stolenGear` registry.

### Picker approach
Two new `pendingChoice.kind` values: `stealUnit` (options = enemy units at
that battlefield) and `stealGear` (options = enemy attached gear enumerated
from all units).  Both reuse the existing `ChoiceModal` in MatchPage.tsx —
no new component needed.  CardSearchOverlay's `owner` prop is already dynamic;
it can point to any player's zones without structural change.

### Biggest UI risk
**The stolen unit's "home" in the render tree**: `BattlefieldZone` renders all
`bf.units` together.  A stolen unit `u.owner = 1, u.controlledBy = 0` lives in
`bf.units` shared by both players, so it appears in the neutral battlefield
panel correctly.  The risk is in **PlayerMat / base zones**: if a steal
mechanic is added that places an enemy unit in the local player's base (e.g. a
"take a unit to your base" variant), the base render loop currently dims all
cards where `u.owner !== perspective`.  Without the `controlledBy` guard, a
base-steal would render dimmed, which is wrong.  The `isStolen` check in
BattlefieldZone (see section a) needs to be propagated to every `u.owner !==
perspective` opacity guard across PlayerMat and OpponentMat too.  Additionally,
`recomputeControllers` counting by `controlledBy` is a one-line change but
affects every scoring/conquer path — regression test coverage for the normal
(non-stolen) unit-majority case must be verified.
