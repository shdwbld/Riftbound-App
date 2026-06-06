# A4 Recon: Transient Grants and Equipment Edge Cases

_Written by recon agent — 2026-06-06. Do NOT edit engine/UI/test files during recon._

---

## Overview

Four implementation clusters, each with exact file:line anchors, verbatim snippets, confirmed card ids/text, and a concrete plan.

---

## A4-1: grantShield + grantTank (This-Turn Keyword Grants)

### Cards Confirmed

| Card | ID | Type | Text (verbatim) |
|------|----|------|-----------------|
| Chakram Dancer | `unl-071-219` | unit (3 Might) | `[Ambush] (…) When you play me, give your other units here [Shield] this turn. (+1 :rb_might: while they're defenders.)` |
| Yuumi - Magical Cat | `unl-056-219` | unit (1 Might) | `When I attack or defend, give one of your other units here +3 :rb_might: and [Tank] this turn. (It must be assigned combat damage first.)` |

### Current State — What Exists

**grantAssault / grantGanking** are already fully wired as transient EngineCard fields:

- **`src/engine/types.ts` line 85–89**: `grantAssault?: number` and `grantGanking?: boolean` fields on `EngineCard`.
- **`src/engine/effects.ts` line 55–58**: `grantAssault: number` and `grantGanking: boolean` in `ParsedEffect`; line 56–59 in `EMPTY_EFFECT()` defaults both to 0/false.
- **`hasTargetedPart` — `src/engine/effects.ts` line 301**: `|| e.grantAssault > 0 || e.grantGanking` — both counted as targeted.
- **Parse site — `src/engine/effects.ts` lines 546–554**: the `if (/this turn/.test(t))` block parses `[Assault N]` and `[Ganking]` grant patterns.
- **Three dispatch sites in `src/engine/engine.ts`**:
  - Targeted spell loop (line 4431–4438): `if (e.grantAssault || e.grantGanking) { ... u.grantAssault = ...; u.grantGanking = true }`
  - Area applyParsed (`grantAssaultHere`) (line 933–940) and ACTIVATE_UNIT (line 6005).
  - ACTIVATE_UNIT targeted loop (lines 5992–5993).
- **End-of-turn cleanup — `src/engine/engine.ts` lines 6392–6395**: both fields reset to `0`/`false` in the END_TURN map.
- **Combat reads — `src/engine/engine.ts`**:
  - `mightOf` line 3438: `if (role === 'attacker') m += k.assault + (ci.grantAssault ?? 0)`
  - `hasTank` line 2239–2242: only checks `parseKeywords().tank` and the Lillia aura — **no `grantTank`**.
  - `bfCombatBonus` line 3896: `if (role === 'defender' && ... unitGrantedKeyword(s, u, 'shield') ...) b += 1` — checks aura grants but not a per-unit `grantShield`.

### What Is Missing

**`grantShield`**: No `grantShield` field on `EngineCard`. The `mightOf` function adds `k.shield` for the defender role (printed keyword) but has no path for a transient this-turn shield grant. Chakram Dancer's "give your other units here [Shield] this turn" will parse as `manual=true` because the parse block at effects.ts:546–554 only checks for `[Assault]` and `[Ganking]` inside the `if (/this turn/.test(t))` guard.

**`grantTank`**: No `grantTank` field on `EngineCard`. `hasTank()` (engine.ts:2239) drives damage ordering; it does not check any transient flag. Yuumi's Tank grant therefore has no engine path.

**Yuumi trigger**: Yuumi fires on `attack` or `defend` events (self-scope), grants `+3 :rb_might:` (tempMight) to a chosen other unit here AND `[Tank]` this turn. The `+3 tempMight` part parses; the `[Tank]` part does not.

### Implementation Plan

#### Step 1 — `EngineCard` fields (`src/engine/types.ts`)

After line 89 (`grantGanking?: boolean`), add:

```ts
// Snippet to add after line 89:
/** [Shield N] granted to this unit THIS TURN (Chakram Dancer). Cleared at end of turn. Adds to combat Might while defending. */
grantShield?: number
/** [Tank] granted to this unit THIS TURN (Yuumi - Magical Cat). Cleared at end of turn. */
grantTank?: boolean
```

#### Step 2 — `ParsedEffect` + `EMPTY_EFFECT` (`src/engine/effects.ts`)

After `grantGanking: boolean` (line 58), add to the interface:

```ts
// After line 58 in ParsedEffect interface:
/** [Shield N] granted to the chosen unit this turn. 0 = none. */
grantShield: number
/** [Tank] granted to the chosen unit this turn. */
grantTank: boolean
```

In `EMPTY_EFFECT()` (after line 259 `grantGanking: false`):

```ts
grantShield: 0,
grantTank: false,
```

#### Step 3 — Parse (`src/engine/effects.ts` lines 546–555)

Inside the existing `if (/this turn/.test(t))` block, after the `ggM` (grantGanking) match:

```ts
// After line 554 (ggM block), still inside if(/this turn/) {
const gsM = t.match(/give (?:a|an|target|another) (?:friendly |enemy )?unit[^.]*?\[shield(?:\s*(\d+))?\]/)
if (gsM) { eff.grantShield = gsM[1] ? parseInt(gsM[1], 10) : 1; hit = true }
const gtM = t.match(/give (?:a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?units?[^.]*?\[tank\]/)
if (gtM) { eff.grantTank = true; hit = true }
// Area [Shield] — "give your other units here [Shield] this turn" (Chakram Dancer)
// Area grants go into a new grantShieldHere field (or handle in applyParsed via the area branch).
```

For Chakram Dancer's area form ("give your other units here [Shield]"), add a parallel `grantShieldHere: number` field (like `grantAssaultHere`), or reuse the existing `areaM` branch to also capture `[Shield]`.

#### Step 4 — `hasTargetedPart` (`src/engine/effects.ts` line 301)

```ts
// Old:
export function hasTargetedPart(e: ParsedEffect): boolean {
  return e.damage > 0 || e.kill > 0 || ... || e.deathShield
}
// Add at end:
  || e.grantShield > 0 || e.grantTank
```

#### Step 5 — Three Dispatch Sites (`src/engine/engine.ts`)

**Targeted spell loop (near line 4431)**:

```ts
// After the grantGanking block (lines 4431–4438), add:
if (e.grantShield || e.grantTank) {
  const u = findUnitAnywhere(s, t)
  if (u) {
    if (e.grantShield) u.grantShield = (u.grantShield ?? 0) + e.grantShield
    if (e.grantTank) u.grantTank = true
    emit({ kind: 'buff', iid: t, player: controller })
    s = log(s, controller, `${card.name}: ${getCard(u.cardId)?.name} gains ${e.grantShield ? `[Shield ${e.grantShield}]` : ''}${e.grantTank ? '[Tank]' : ''} this turn.`)
  }
}
```

**Area applyParsed (near line 933)**: Add `grantShieldHere` parallel to `grantAssaultHere`.

**ACTIVATE_UNIT loop (near line 5992)**: Add the same `grantShield`/`grantTank` blocks alongside the existing grantAssault/grantGanking blocks.

#### Step 6 — Combat Reads

**Shield (defender Might) — `mightOf` at `src/engine/engine.ts` line 3439**:

```ts
// Old:
if (role === 'defender') m += k.shield
// New:
if (role === 'defender') m += k.shield + (ci.grantShield ?? 0)
```

**Tank (damage-assignment order) — `hasTank` at `src/engine/engine.ts` line 2239–2242**:

```ts
// Old:
function hasTank(s: MatchState, u: EngineCard): boolean {
  if (parseKeywords(def(u)).tank) return true
  return getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Lillia - Protector of Dreams')
}
// New — add before return:
  if (u.grantTank) return true
```

#### Step 7 — End-of-Turn Cleanup (`src/engine/engine.ts` lines 6392–6395)

```ts
// Old spread (lines 6392 and 6394–6395):
({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, deathShield: false, banishShield: false })
// New:
({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, grantShield: 0, grantTank: false, deathShield: false, banishShield: false })
```

#### Chakram Dancer's Area Grant

Chakram Dancer fires on play (`when you play me`), area scope (`give your OTHER units HERE [Shield] this turn`). Add `grantShieldHere: number` to `ParsedEffect`/`EMPTY_EFFECT` and handle in `applyParsed` (the `grantAssaultHere` block near line 933) and ACTIVATE_UNIT (line 6005).

Yuumi's grant fires on attack/defend trigger (self-scope, "give one of your other units here +3 Might and [Tank] this turn"). The `+3 tempMight` already works via `tempMight`; `grantTank` is the only missing piece once the field and targeted dispatch are added.

---

## A4-2: Gear-Scoped killGear / bounceGear

### Cards Confirmed

| Card | ID | Type | Text (verbatim) |
|------|----|------|-----------------|
| Disarming Rake | `sfd-032-221` | unit | `When you play me, you may kill a gear.` |
| Pickpocket | `sfd-074-221` | unit | `When you play me, you may kill a gear with Energy cost no more than :rb_energy_1:. If you do, play a Gold gear token exhausted.` |
| Jayce - Man of Progress | `sfd-084-221` | unit | `When you play me, you may kill a friendly gear. If you do, you may play a gear with Energy cost no more than :rb_energy_7: from hand this turn, ignoring its Energy cost. (You must still pay its Power cost.)` |
| Zaun Punk | `sfd-160-221` | unit | `You may kill a friendly gear as an additional cost to play me. When you play me, if you paid the additional cost, kill a gear.` |
| Legion Quartermaster | `sfd-044-221` | unit | `As an additional cost to play me, return a friendly gear to its owner's hand.` |

### Current State

- **No `killGear` or `bounceGear` field** in `ParsedEffect`. None of the five cards have a bespoke handler in engine.ts (confirmed: `grep -n "Disarming\|Pickpocket\|Jayce.*Man\|Zaun Punk\|Legion Quart" src/engine/engine.ts` → no output).
- All five cards will parse as `manual=true` currently.
- **Adaptatron** (`src/engine/engine.ts` line 1336–1380) has the only bespoke `kill a gear` resolution — as a conquer trigger auto-picking the lowest-cost gear in base. This is the pattern to generalize.
- **Gear in play lives in two places** (documented in `detachGearToBase`, `controlledPermanents`):
  1. Unattached: `players[].zones.base` (where gear goes after a unit dies or detaches).
  2. Attached: `unit.attached` as `"cardId|iid"` strings, surfaced as virtual EngineCards by `controlledPermanents`.
- **Trash destination**: When a gear is killed intentionally (rule 107.1.d analogue), it goes to the **OWNER's trash** — unlike unit death where `detachGearToBase` returns gear to base first. The `sendToTrash` function at engine.ts:311 is the right call, but the target must be constructed from the `"cardId|iid"` ref.
- **No `allGearInPlay` enumerator** exists. `getLegalTargets` (engine.ts:6642) only handles unit iids; there is no gear-targeting branch.

### Implementation Plan

#### Step 1 — `ParsedEffect` fields (`src/engine/effects.ts`)

Add after `returnFromTrash` (around line 145):

```ts
/** Kill a chosen gear (Disarming Rake, Pickpocket, Zaun Punk). `scope` whose:
 *  'friendly' / 'enemy' / 'any'. `maxEnergy` = Energy cost cap (null = uncapped). */
killGear: { scope: 'friendly' | 'enemy' | 'any'; maxEnergy: number | null } | null
/** Return a chosen friendly gear to its owner's hand (Legion Quartermaster). */
bounceGear: boolean
```

Add to `EMPTY_EFFECT()`:
```ts
killGear: null,
bounceGear: false,
```

#### Step 2 — Parse (`src/engine/effects.ts`)

In the `parse()` function, add (before the final `if (!hit ...) eff.manual = true`):

```ts
// Kill a gear: "you may kill a gear [with Energy cost no more than N]"
const kgM = t.match(/kill (?:a|an) (friendly |enemy )?gear(?:[^.]*?energy cost no more than :rb_energy_(\d+):)?/)
if (kgM) {
  const scope = kgM[1]?.trim() === 'friendly' ? 'friendly' : kgM[1]?.trim() === 'enemy' ? 'enemy' : 'any'
  const maxEnergy = kgM[2] ? parseInt(kgM[2], 10) : null
  eff.killGear = { scope, maxEnergy }
  hit = true
}
// Return a friendly gear to hand: "return a friendly gear to its owner's hand"
if (/return a friendly gear to (?:its owner'?s?|your) hand/.test(t)) { eff.bounceGear = true; hit = true }
```

#### Step 3 — `allGearInPlay` Enumerator (`src/engine/engine.ts`)

Add near `unitsInPlay` (engine.ts line 6612):

```ts
/** Every gear currently in play: unattached gear in all players' bases, plus
 *  gear attached to units (surfaced as virtual EngineCards). */
function allGearInPlay(s: MatchState): EngineCard[] {
  const out: EngineCard[] = []
  for (const pl of s.players) {
    for (const c of pl.zones.base) {
      if (getCard(c.cardId)?.type === 'gear') out.push(c)
    }
    const units = [...pl.zones.base, ...s.battlefields.flatMap(b => b.units)].filter(u => getCard(u.cardId)?.type === 'unit')
    for (const u of units) {
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

#### Step 4 — `killGearByIid` Helper (`src/engine/engine.ts`)

Add near the existing Adaptatron gear-kill logic (after line 1380):

```ts
/** Kill a gear (send it to its owner's trash) given its iid. Handles both
 *  unattached base gear and gear attached to a unit. Returns true if found. */
function killGearByIid(s: MatchState, gearIid: string): boolean {
  for (const pl of s.players) {
    const idx = pl.zones.base.findIndex(c => c.iid === gearIid)
    if (idx >= 0) {
      const [g] = pl.zones.base.splice(idx, 1)
      sendToTrash(pl, g)
      return true
    }
    for (const u of [...pl.zones.base, ...s.battlefields.flatMap(b => b.units)]) {
      const ri = (u.attached ?? []).findIndex(ref => ref.split('|')[1] === gearIid)
      if (ri >= 0) {
        const [ref] = u.attached.splice(ri, 1)
        const [cid, iid] = ref.split('|')
        sendToTrash(pl, { iid: iid || `${pl.id}:gear:${cid}`, cardId: cid, owner: pl.id, exhausted: false, damage: 0, attached: [] })
        return true
      }
    }
  }
  return false
}
```

#### Step 5 — Resolution in `applyParsed` / targeted spell loop

Since `killGear` requires player to choose a target gear (not a unit), it cannot go through the existing unit-targeted path. Implement as a **pendingChoice** or auto-resolution (similar to Adaptatron's auto-pick-lowest approach):

- **Auto-resolution approach** (conservative): auto-pick the lowest-Energy gear matching the scope/maxEnergy filter. Log it. This avoids building a new choice UI branch.
- **Manual prompt approach** (correct UX): push a `pendingChoice` with `kind: 'killGear'` and options from `allGearInPlay()` filtered by scope and maxEnergy. A new RESOLVE_CHOICE branch detaches + sends to trash.

In `applyParsed` (`src/engine/engine.ts` around line 567), add:

```ts
if (e.killGear) {
  const gears = allGearInPlay(s).filter(g => {
    if (e.killGear!.scope === 'friendly' && g.owner !== p.id) return false
    if (e.killGear!.scope === 'enemy' && g.owner === p.id) return false
    if (e.killGear!.maxEnergy != null && (getCard(g.cardId)?.energy ?? 0) > e.killGear!.maxEnergy!) return false
    return true
  })
  if (gears.length) {
    // Auto: lowest-cost matching gear (mirrors Adaptatron pattern)
    const pick = gears.reduce((lo, g) => ((getCard(g.cardId)?.energy ?? 0) < (getCard(lo.cardId)?.energy ?? 0) ? g : lo))
    killGearByIid(s, pick.iid)
    lines.push(`Killed ${getCard(pick.cardId)?.name ?? 'a gear'}.`)
  }
}
if (e.bounceGear) {
  // Return lowest-cost friendly gear to its owner's hand
  const friendly = allGearInPlay(s).filter(g => g.owner === p.id)
  if (friendly.length) {
    const pick = friendly.reduce((lo, g) => ((getCard(g.cardId)?.energy ?? 0) < (getCard(lo.cardId)?.energy ?? 0) ? g : lo))
    // Remove from wherever it lives; push to owner's hand
    killGearByIid(s, pick.iid) // reuse removal logic; then push to hand instead
    // NOTE: killGearByIid trashes it — bounceGear needs a bounceGearByIid variant that pushes to hand
    lines.push(`Returned ${getCard(pick.cardId)?.name ?? 'a gear'} to hand.`)
  }
}
```

Implement a `bounceGearByIid` variant of `killGearByIid` that removes from wherever the gear lives and pushes to `pl.zones.hand` instead of `sendToTrash`.

#### Step 6 — Bespoke Card Follow-Ups

- **Pickpocket**: after killGear resolves, if a gear was killed, apply `goldTokens: 1` (already parseable). Wire: check `e.killGear && e.goldTokens` together in applyParsed — produce the gold token only when a gear was actually killed.
- **Jayce - Man of Progress**: after killing a friendly gear, "you may play a gear from hand ignoring its Energy cost" — this is a new `playGearFromHand: { maxEnergy: number | null }` effect flag, or handle as bespoke post-kill logic. The gear-from-hand play with ignoring-energy needs a new `ParsedEffect` field.
- **Zaun Punk**: additional-cost path ("you may kill a friendly gear as an additional cost"). The optional-cost infrastructure (optionalPlayCost in keywords.ts) only handles rune/energy costs. Zaun Punk's gear-kill cost needs a new bespoke additional-cost flag or hand-coded check at PLAY_UNIT time.
- **Legion Quartermaster**: "return a friendly gear to its owner's hand as an additional cost" — same additional-cost complexity as Zaun Punk.

---

## A4-3: Gear-as-Trigger-Source (Last Rites)

### Card Confirmed

| Card | ID | Type | Text (verbatim after TEXT_PATCHES) |
|------|----|------|-------------------------------------|
| Last Rites | `sfd-150-221` | gear | `[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash (Pay the cost: Attach this to a unit you control.) When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)` |

Note: the **raw** ingested text (cards.generated.json) is truncated to just the `[Equip]` cost line. The `TEXT_PATCHES` in `src/data/cards.ts` (line 23) restores the full text.

### Current State — Two Distinct Bugs

#### Bug 1: Hold trigger NOT fired

The trigger regex for `conquer` self-scope (`/when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+conquers?/i`) **matches** "When I conquer or hold". The trigger regex for `hold` self-scope (`/when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+holds?/i`) does **NOT** match "When I conquer or hold" — because after `I` comes `conquer`, not `holds?`.

Result: Last Rites fires its trigger on conquer but NOT on hold.

Confirmed by test (`node -e` above):
- `conquer self match: true`
- `hold self match: false`

#### Bug 2: Trigger clause truncated; effect parses as `manual=true`

`clauseAfter()` (`src/engine/triggers.ts` line 139–151) extracts the text after the trigger phrase up to the next `.` or `;`. For "When I conquer or hold, **you may play a unit from your trash**. (You still pay its costs.)", the clause is:

```
or hold, you may play a unit from your trash
```

The `fullCost` branch in `effects.ts` (around line 641) requires BOTH `/play a unit from your trash\b/` AND `/(?:you )?still pay its costs?\b/` to be present. The clause contains the former but NOT the latter (which is in the next sentence, stripped by `clauseAfter`). Result: `playUnitFromTrash` is `null`, `manual = true`.

#### Bug 3: Gear trigger fires with host unit as sourceIid — OK as designed

`collectSelf` (engine.ts line 1107–1116): when `iids` is set (the units at the just-conquered/held battlefield), the gear trigger is correctly fired via `pushFor(u, event)` for the host unit `u` (whose iid IS in `only`). The `sourceCardId` is the gear's id. This part works correctly — the gear's trigger IS fired when its host unit conquers.

### Implementation Plan

#### Fix 1 — Add "conquer or hold" self-trigger pattern (`src/engine/triggers.ts`)

In `PATTERNS` array (around line 69), add before or after the existing `hold self` pattern (line 95):

```ts
// "When I conquer or hold" — fires BOTH conquer and hold (single pattern, double-fires).
// Alternatively, add a new pattern:
{ event: 'hold', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+conquers?\s+or\s+holds?/i },
```

This makes "When I conquer or hold" also produce a hold-scope trigger. The existing `{ event: 'conquer', scope: 'self', re: /...conquers?/i }` already fires the conquer half; the new pattern adds the hold half.

#### Fix 2 — Extend `clauseAfter` or `triggersFor` to span cross-sentence full-cost trash patterns

In `clauseAfter()` (`src/engine/triggers.ts` lines 139–151), add a cross-sentence extension for "still pay its costs" analogous to the existing "recycle the rest" extension:

```ts
// Existing extension for deck-dig (lines 146–149):
if (end >= 0 && /\b(?:look at|reveal) the top\b/i.test(rest.slice(0, end))) {
  const recM = rest.match(/recycle [^.;]*[.;]/i)
  if (recM) end = (recM.index ?? 0) + recM[0].length - 1
}
// Add: extend through "You still pay its costs." for full-cost trash plays (Last Rites):
if (end >= 0 && /\bplay a unit from your trash\b/i.test(rest.slice(0, end))) {
  const stillM = rest.match(/(?:you )?still pay its costs?[.;]/i)
  if (stillM) end = (stillM.index ?? 0) + stillM[0].length - 1
}
```

With this fix the clause becomes: `or hold, you may play a unit from your trash. (You still pay its costs.)`

After the parenthetical is trimmed, the effect parser will see `play a unit from your trash` + `still pay its costs` → `playUnitFromTrash: { fullCost: true, ... }` → auto-resolved.

#### Verify Gear Trigger Delivery (no change needed)

The gear-as-source path in `collectSelf` (engine.ts lines 1110–1116) correctly delivers the trigger with `sourceIid = hostUnit.iid` and `sourceCardId = 'sfd-150-221'`. `fireTriggers` then dispatches the `playUnitFromTrash` effect from `applyParsed`. No structural change needed here.

---

## A4-4: Svellsongur (Runtime Ability Copy from Host)

### Card Confirmed

| Card | ID | Type | Text (verbatim) |
|------|----|------|-----------------|
| Svellsongur | `sfd-059-221` | gear (Epic, Calm, 3E+1 Calm) | `[Equip] :rb_energy_1::rb_rune_calm: (:rb_energy_1::rb_rune_calm:: Attach this to a unit you control.) As this is attached to a unit, copy that unit's text to this Equipment's effect text for as long as this is attached to it.` |

### Current State

**No handler exists** for Svellsongur. Confirmed:
- `grep -n "Svellsongur\|sfd-059\|copy.*text\|as this is attached" src/engine/engine.ts src/engine/triggers.ts src/engine/effects.ts` → no engine results.
- The card will be treated as an Equipment that grants 0 flat Might (no `+N :rb_might:` in its text), no `[Assault]`/`[Shield]`, no triggers — effectively a no-op except for the attach flow.

### Design: Snapshot-Approximation Approach

Svellsongur's rule is: while attached, this gear's "effect text" is the host unit's text. In Riftbound, "effect text" = the non-keyword ability text. The practical implication: the gear grants the host's triggered abilities as if they were also printed on the gear. Since `controlledPermanents` already surfaces attached gear as virtual EngineCards (with their own `cardId`), the simplest approximation is a **runtime snapshot**: when collecting triggers or passive keywords for Svellsongur's virtual EngineCard, substitute the host unit's card id.

Key constraint: the host unit already fires its own triggers. Adding Svellsongur's copy would double-fire every self-trigger the host has. The correct rule interpretation is that Svellsongur acquires the HOST's text for ITS OWN abilities (i.e. the gear gains new triggers it wouldn't normally have — the host's triggers resolve once from the host and once from the gear? Or just once total?). In most TCG copier rules, copying a card's text means the copier has that text, so triggers fire once from each source. However in practice Svellsongur is most likely intended for keyword/passive transfer (e.g. equip a unit with [Hunt 2] and Svellsongur would also grant Hunt 2's XP gain). A conservative snapshot approach:

#### Implementation Plan

**Option A: cardId Swap in `controlledPermanents`** (smallest footprint)

In `controlledPermanents` (engine.ts line 1063–1074), when constructing the virtual EngineCard for Svellsongur (id `sfd-059-221`), use the host unit's `cardId` instead:

```ts
// Inside the for (const ref of u.attached) loop (lines 1067–1071):
if (cid && getCard(cid)?.type === 'gear') {
  // Svellsongur: runtime ability copy from host.
  const effectiveCardId = cid === 'sfd-059-221' ? u.cardId : cid
  out.push({ iid: iid || `${player}:gear:${cid}`, cardId: effectiveCardId, owner: player, exhausted: false, damage: 0, attached: [] })
}
```

This makes the virtual Svellsongur EC appear to have the host unit's card id for trigger collection and keyword parsing. Triggers will fire twice (once from host, once from Svellsongur's virtual EC). This matches the "copy text" rule literally.

**Option B: Snapshot at Attach Time** (snapshot stored on the EngineCard)

When Svellsongur is attached (in `fireAttachEquip` or `PLAY_GEAR`/`ATTACH`), stamp the host's cardId onto the gear's virtual EC via a new `snapshotCardId?: string` field. Update `controlledPermanents` to use `snapshotCardId` when present.

Downside: the snapshot becomes stale if the host's effective text changes (Level gates, state grants). Upside: avoids re-computing host cardId every collection pass.

**Recommended approach**: Option A (cardId swap in controlledPermanents). It is dynamic (always current), trivially reversible, and the double-firing matches the rule text literally. If double-firing is confirmed wrong, add a dedup pass in `fireTriggers` to skip triggers whose `sourceCardId` === the host unit's `cardId` when the same trigger was already fired by the host directly.

**Flat-Might note**: Svellsongur's text has no `+N :rb_might:` line, so `gearMight()` returns 0 for it. After the cardId swap, `gearMight()` would try to parse the host's text for `+N Might` lines — which would double-count the host's own printed Might. Guard this: in `gearMight()`, skip the Might parse when the gear instance is Svellsongur (`c.split('|')[0] === 'sfd-059-221'`).

---

## Summary of File:Line Anchors

| Item | File | Lines |
|------|------|-------|
| `EngineCard` fields (add grantShield, grantTank) | `src/engine/types.ts` | after line 89 |
| `ParsedEffect` (add grantShield, grantTank, killGear, bounceGear) | `src/engine/effects.ts` | after line 58 (interface), after line 259 (EMPTY_EFFECT) |
| Parse grantShield / grantTank | `src/engine/effects.ts` | lines 546–555 (inside `if (/this turn/)` block) |
| Parse killGear / bounceGear | `src/engine/effects.ts` | before line 866 (`if (!hit ...) eff.manual`) |
| `hasTargetedPart` add grantShield, grantTank | `src/engine/effects.ts` | line 301 |
| Targeted spell loop dispatch (grantShield, grantTank) | `src/engine/engine.ts` | after line 4438 |
| Area applyParsed dispatch (grantShieldHere) | `src/engine/engine.ts` | near line 933 |
| ACTIVATE_UNIT dispatch (grantShield, grantTank) | `src/engine/engine.ts` | near lines 5992–5993 |
| `mightOf` add grantShield for defenders | `src/engine/engine.ts` | line 3439 |
| `hasTank` add grantTank check | `src/engine/engine.ts` | lines 2239–2242 |
| END_TURN cleanup add grantShield, grantTank | `src/engine/engine.ts` | lines 6392, 6394–6395 |
| `allGearInPlay` enumerator (new) | `src/engine/engine.ts` | near line 6612 |
| `killGearByIid` helper (new) | `src/engine/engine.ts` | after line 1380 |
| `bounceGearByIid` helper (new) | `src/engine/engine.ts` | after killGearByIid |
| killGear / bounceGear in `applyParsed` | `src/engine/engine.ts` | in `applyParsed` function (line 567) |
| Last Rites "conquer or hold" pattern | `src/engine/triggers.ts` | after line 95 (hold self pattern) |
| Last Rites `clauseAfter` extension | `src/engine/triggers.ts` | lines 139–151 |
| Svellsongur cardId swap | `src/engine/engine.ts` | lines 1067–1071 (controlledPermanents) |
| Svellsongur gearMight guard | `src/engine/engine.ts` | gearMight function (near line 3614) |

---

## Cross-Cutting Notes

- `grantShield`/`grantTank` cleared in the same END_TURN spread as `grantAssault`/`grantGanking` (lines 6392, 6394–6395). Both zones and battlefields need the spread updated.
- The `allGearInPlay` enumerator must surface virtual ECs for attached gear using the same `"cardId|iid"` ref format as `controlledPermanents` — ownership comes from the host unit's owner.
- Gear killed by killGear effects goes to the **gear owner's trash** (same owner as the unit it was attached to). `sendToTrash` handles the token check (Gold gear tokens cease to exist).
- Zaun Punk and Legion Quartermaster have **additional-cost** gear mechanics, not on-play effects. The existing `optionalPlayCost` infrastructure in `keywords.ts` only handles Energy/Power rune costs. These cards require either bespoke PLAY_UNIT pre-checks or a new `gearCostKind: 'killGear' | 'bounceGear'` optional-cost flag.
- Svellsongur's cardId swap in `controlledPermanents` will also affect `keywordsOf`, `levelBonus`, and `parseKeywords` for the virtual EC — the host's keywords become the gear's keywords. This is the correct rule outcome but may interact with existing keyword-grant dedup logic (shield/assault from granted-in-aura stripping in `parseKeywords`).
