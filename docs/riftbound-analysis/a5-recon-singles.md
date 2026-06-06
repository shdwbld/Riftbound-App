# A5 Bespoke Singles — Recon Report

Generated: 2026-06-06. Read-only recon. No edits to engine.

---

## 1. Arise! (sfd-198-221)

**Verbatim text:**
> "Play a 2 :rb_might: Sand Soldier unit token for each Equipment you control. Then do this: Ready up to two of them."

**Card data:** type=spell, tags=[Azir]

### What's broken

1. **Token count ignores equipment.** The `namedToken` regex (`effects.ts:438`) captures `count:1` for `"play a 2 :rb_might: Sand Soldier unit token"`. The phrase `"for each Equipment you control"` is never read; the spell always plays exactly 1 Sand Soldier.

2. **"Ready up to two of them" is unresolved.** `"of them"` is a pronoun referring to the freshly-spawned tokens. No parser path handles this:
   - `readyUnits` regex (`effects.ts:487`) requires `"units?"` as the noun — `"of them"` fails.
   - `readySelf` / `readyAllUnits` patterns don't match either.
   - There is no `readyJustSpawnedTokens` field; the effect silently drops.

### Engine anchors

- `src/engine/effects.ts` — `namedToken` parse block (~line 438) and `readyUnits` parse block (~line 487).
- `src/engine/engine.ts` — `applyParsed` namedToken branch (~line 623) where count is resolved and tokens are placed.
- `src/engine/engine.ts` — `PLAY_SPELL` handler (~line 4942) that calls `applyParsed` for spell effects.

### Step-by-step fix plan

**Option A — Bespoke handler in PLAY_SPELL (recommended):**
1. In `PLAY_SPELL`'s `resolveCard` path, before the generic `applyParsed` call, check:
   ```ts
   if (card.id === 'sfd-198-221') {
     // Count Equipment the player controls
     const equipCount = p.zones.base.filter(x => getCard(x.cardId)?.type === 'gear').length
       + [...p.zones.base, ...s.battlefields.flatMap(b => b.units)]
           .reduce((n, x) => n + (x.attached?.length ?? 0), 0)
     // Spawn equipCount Sand Soldiers (base, exhausted)
     const made = spawnNamedToken(p, 'sand soldier', Math.max(1, equipCount), s.turn, true, false)
     s = log(s, controller, `Arise!: played ${made} Sand Soldier token(s).`)
     // Ready up to 2 of them — un-exhaust up to the last 2 spawned soldiers
     const soldiers = p.zones.base.filter(x => getCard(x.cardId)?.supertype === 'token'
       && (getCard(x.cardId)?.tags ?? []).some(t => t.toLowerCase() === 'sand soldier'))
     let readied = 0
     for (const tok of soldiers.slice(-2)) { if (tok.exhausted) { tok.exhausted = false; readied++ } }
     if (readied) s = log(s, controller, `Arise!: readied ${readied} Sand Soldier(s).`)
     return ok(s)
   }
   ```
2. Skip the generic `applyParsed` branch for this card (use `handled` flag).
3. **Primitive needed:** The equipment-count formula is also used by Ornn's `"I have +N Might for each gear"` aura (line 3751 of engine.ts) — factor it into a helper `countEquipmentOwned(s, player): number` used by both.

---

## 2. The List (unl-138-219)

**Verbatim text:**
> "As you play this, name a tag. (For example, Miss Fortune, Demacia, and Poro are tags.):rb_exhaust:: Give a unit with the named tag -2 :rb_might: this turn."

**Card data:** type=gear

### What's broken

1. **"Name a tag" at play-time is unimplemented.** There is no pendingChoice kind for free-form tag naming, no `PlayerState.namedTag` field, and no PLAY_GEAR handler that prompts for a name. The "as you play this, name a tag" on-play clause is silently ignored.

2. **Activated ability is mis-dispatched.** `unitActivatedAbility` will parse the ability correctly (exhaust cost, effectText = `"Give a unit with the named tag -2 :rb_might: this turn"`, parses `tempMight:-2`). However, `"with the named tag"` is a **filter** on the target, not a tag-literal. The ACTIVATE_UNIT handler at line 6003 (`applyTempMight`) applies -2 Might to any chosen target regardless of tag. There is no lookup of `player.namedTag` to gate the target.

3. **No `namedTag` state field on `PlayerState`** exists in `src/engine/types.ts`.

### Engine anchors

- `src/engine/types.ts` — `PlayerState` interface: add `namedTag?: string`.
- `src/engine/engine.ts` — PLAY_GEAR handler (~line 5270): add a pendingChoice/offerChoice call for tag naming.
- `src/engine/engine.ts` — RESOLVE_CHOICE handler: add a case (kind `'nameTag'`) that sets `p.namedTag = payload`.
- `src/engine/engine.ts` — ACTIVATE_UNIT handler (~line 5996): when `card.id === 'unl-138-219'`, filter targets to units whose tags include `p.namedTag`.
- `src/pages/MatchPage.tsx` and `src/pages/OnlinePage.tsx`: render a text-input modal for the `'nameTag'` choice kind.

### Step-by-step fix plan

1. **Add `namedTag?: string` to `PlayerState`** in `types.ts`. Clear it on game start (setup.ts).
2. **PLAY_GEAR: prompt for tag name.** After placing the gear and before firing play triggers, detect `card.id === 'unl-138-219'` and call:
   ```ts
   offerChoice(s, { player: action.player, kind: 'nameTag', bfIndex: -1,
     prompt: 'The List — name a tag (e.g. "Miss Fortune", "Demacia", "Poro"):',
     options: [], payload: '' })
   ```
3. **RESOLVE_CHOICE case `'nameTag'`:** Set `s.players[action.player].namedTag = action.payload` and log it.
4. **ACTIVATE_UNIT (The List):** Detect `card.id === 'unl-138-219'` before the generic `applyTempMight` call. Replace with:
   ```ts
   const tag = p.namedTag ?? ''
   const tgtUnit = findUnitAnywhere(s1, action.targets?.[0] ?? '')
   if (tgtUnit && (getCard(tgtUnit.cardId)?.tags ?? []).includes(tag)) {
     s1 = fireDeaths(s1, applyTempMight(s1, tgtUnit.iid, -2, 1))
     s1 = log(s1, action.player, `The List: gave ${getCard(tgtUnit.cardId)?.name} -2 Might (tag: ${tag}).`)
   } else {
     s1 = log(s1, action.player, `The List: target doesn't have tag "${tag}" — fizzled.`)
   }
   handled = true
   ```
5. **UI:** Add a text-input branch in the pendingChoice modal renderer (MatchPage + OnlinePage) for kind `'nameTag'` — a free-form string input, confirm button.

---

## 3. Vex - Mocking (unl-055-219)

**Verbatim text:**
> "[Shield] (+1 :rb_might: while I'm a defender.)[Tank] (I must be assigned combat damage first.)When you [Stun] an enemy unit at a battlefield, you may move me to that battlefield."

**Card data:** type=unit, might=5, tags=[Yordle, Vex, Shadow Isles]

### What's broken

1. **`bfIndex` not forwarded to `moveSourceToBf`.** `fireStun(s, player)` (engine.ts:1679) calls `fireTriggers(s, collectGlobal(s, player, 'stun'))` **without a `bfIndex`**. Inside `applyParsed` (line 967), `moveSourceToBf` only relocates the source when `bfIndex != null && bfIndex >= 0`. Because no `bfIndex` is passed, the move silently no-ops. Vex stays wherever she is.

2. **Trigger parsing is correct.** Triggers.ts line 110 matches `"when you stun an enemy unit"` as event=`'stun'`, scope=`'global'`. Effects parser correctly sets `moveSourceToBf=true` for `"you may move me to that battlefield"` (the `"move me"` branch at effects.ts:579). The failure is purely in the plumbing between the stun action and the trigger resolution.

3. **"At a battlefield" scoping.** The stun could happen via STUN_UNIT action (line 5367) or as part of a trigger (line 1192–1199). In both paths, the stunned unit's battlefield is recoverable:
   - In STUN_UNIT: `battlefieldOf(s, action.iid)` gives the index.
   - In trigger stun (line 1192–1199): `battlefieldOf(s, sourceIid)` gives the source's battlefield.

### Engine anchors

- `src/engine/engine.ts` — `fireStun` function (~line 1679): must accept and forward a `bfIndex`.
- `src/engine/engine.ts` — STUN_UNIT case (~line 5367): compute `battlefieldOf(s, target.iid)` and pass to `fireStun`.
- `src/engine/engine.ts` — trigger stun block (~line 1192–1199): pass `battlefieldOf(s, sourceIid)` to `fireStun`.
- `src/engine/engine.ts` — trigger stun block (~line 6026): pass `battlefieldOf(s1, action.targets?.[0])` to `fireStun`.

### Step-by-step fix plan

1. Change `fireStun` signature:
   ```ts
   function fireStun(s: MatchState, player: PlayerId, bfIndex?: number): MatchState {
     return fireTriggers(s, collectGlobal(s, player, 'stun'), bfIndex)
   }
   ```
2. **STUN_UNIT (line ~5379):**
   ```ts
   const stunBf = s.battlefields.findIndex(b => b.units.some(u => u.iid === target.iid))
   if (target.owner !== action.player) sStun = fireStun(sStun, action.player, stunBf >= 0 ? stunBf : undefined)
   ```
3. **Trigger auto-stun block (line ~1196–1199):**
   ```ts
   const stunBf = battlefieldOf(s, sourceIid ?? '')
   s = fireStun(s, player, stunBf >= 0 ? stunBf : undefined)
   ```
4. **Activated ability stun (line ~6026):**
   ```ts
   const tgt = action.targets?.[0]
   const stunBf2 = tgt ? s.battlefields.findIndex(b => b.units.some(u => u.iid === tgt)) : -1
   if (ab.effect.stun) s1 = fireStun(s1, action.player, stunBf2 >= 0 ? stunBf2 : undefined)
   ```
5. No new primitive needed — the fix is purely plumbing.
6. **Note:** Vex - Mocking also has `[Tank]`, which `hasTank` already handles. `[Shield]` is handled by the generic keywords parser. Only the stun-move is broken.

---

## 4. Carnivorous Snapvine (ogn-149-298)

**Verbatim text:**
> "When you play me, choose an enemy unit at a battlefield. We deal damage equal to our Mights to each other."

**Card data:** type=unit, might=6, tags=[Shadow Isles]

### What's broken

1. **`applyParsed` skips `dealMight.dealer=self` entirely.** The `onPlayEffect` parser correctly returns `dealMight={dealer:'self', target:'mutual', useStat:'might', side:null}`. However, the `applyParsed` function has no branch for `dealMight` at all — `dealMight` is only handled in the spell resolver (`resolveCard`, line 4291, guarded `dealer !== 'self'`) and in `fireTriggers` for attack/defend events (line 1237). Neither path fires for an on-play unit effect.

2. **`resolveCard` skips self-dealer.** Even if `applyParsed` were patched, the guard `if (e.dealMight && e.dealMight.dealer !== 'self')` at line 4291 explicitly skips `dealer='self'` in spell resolution. Snapvine is a unit and goes through PLAY_UNIT → `applyParsed`, not through `resolveCard`.

3. **No target-choice prompt.** The unit has `"choose an enemy unit"` which requires a pendingChoice, but the generic applyParsed path offers no target selection for `dealMight` on-play effects.

### Engine anchors

- `src/engine/engine.ts` — PLAY_UNIT case (~line 5123), right after `const e = onPlayEffect(card)` and the `applyParsed` call.
- `src/engine/engine.ts` — `applyParsed` function (~line 567) — or bypass entirely with a bespoke handler.

### Step-by-step fix plan

**Bespoke handler in PLAY_UNIT (recommended — avoids polluting applyParsed with a complex targeting case):**

1. After `const e = onPlayEffect(card)` (line ~5123), add:
   ```ts
   if (card.id === 'ogn-149-298' && !legionGated) {
     // "choose an enemy unit" — auto-pick the highest-Might enemy at any battlefield
     const enemies = s1.battlefields.flatMap(b => b.units).filter(u => u.owner !== action.player && getCard(u.cardId)?.type === 'unit')
     const foe = enemies.sort((a, b) => mightOf(b) - mightOf(a))[0]
     if (foe) {
       const self = findUnitAnywhere(s1, ci.iid)
       const selfMight = self ? mightOf(self) : (card.might ?? 0)
       const foeMight = mightOf(foe)
       const deadCells: EngineCard[] = [
         ...applyTargetDamage(s1, foe.iid, selfMight, true, action.player),
         ...(self ? applyTargetDamage(s1, self.iid, foeMight, true, action.player) : [])
       ]
       s1 = log(s1, action.player, `Carnivorous Snapvine: clashed with ${getCard(foe.cardId)?.name} (${selfMight} vs ${foeMight}).`)
       s1 = fireDeaths(s1, deadCells)
     } else {
       s1 = log(s1, action.player, `Carnivorous Snapvine: no enemy unit to clash with.`)
     }
     // Skip generic applyParsed for this card (set handled flag or guard the existing applyParsed call)
   }
   ```
2. Guard the existing `applyParsed(s1, p, e, ...)` call so it's skipped for this card's `dealMight` (or let it pass — `applyParsed` has no `dealMight` branch so it will silently do nothing, which is fine if the bespoke handler already fires).
3. **Shared primitive needed:** `applyTargetDamage` is already the correct helper. No new primitives required.
4. **Future improvement:** Add a target-selection prompt (pendingChoice kind `'snapvineTarget'`) so the player can manually pick the enemy rather than auto-highest. This is optional for now since auto-pick is functionally correct.

---

## 5. Caitlyn - Patrolling (ogn-068-298)

**Verbatim text:**
> "I must be assigned combat damage last.:rb_exhaust:: Deal damage equal to my Might to a unit at a battlefield. Use this ability only while I'm at a battlefield."

**Card data:** type=unit, might=3, tags=[Caitlyn, Piltover]

### What's broken

1. **"Assigned combat damage last" is unimplemented.** `damageOrder` (engine.ts:3638) supports ranks 0 (Tank), 1 (normal), 2 (backline). There is no rank=3 "assigned last" for a unit that is neither Tank nor Backline. Caitlyn enters the normal rank=1 bucket.

2. **Activated `dealMight.dealer=self` is not dispatched.** `unitActivatedAbility` parses the ability correctly (`exhaust:true`, `requiresBattlefield:true`, `effect.dealMight={dealer:'self', target:'singleEnemy', useStat:'might', side:null}`). In ACTIVATE_UNIT (line ~5988–6026), the handler dispatches `ab.effect.damage` (flat number) and `ab.doubleMight`, but **there is no branch for `ab.effect.dealMight`**. The ability resolves as a no-op beyond exhausting the unit.

3. **`requiresBattlefield` gate is honoured.** `unitActivatedAbility` sets `requiresBattlefield:true` which is checked in `canActivateUnit` (line ~2486). This part is correct.

### Engine anchors

- `src/engine/engine.ts` — `damageOrder` function (line 3638): add rank=3 for "assigned last".
- `src/engine/engine.ts` — `hasTank` / damage step builder: detect `"must be assigned combat damage last"` from card text.
- `src/engine/engine.ts` — ACTIVATE_UNIT handler (line ~5987): add a `dealMight.dealer=self` branch.

### Step-by-step fix plan

**Part A — Combat assignment ordering:**
1. In `damageOrder` (line 3638), change rank function to:
   ```ts
   const rank = (u: EngineCard) =>
     isTank(u) ? 0
     : /must be assigned combat damage last/i.test(getCard(u.cardId)?.text ?? '') ? 3
     : parseKeywords(def(u)).backline ? 2 : 1
   ```
2. Update `validateManualAllocation` and `autoDistribute` to respect rank=3 (last, after backline). A rank=3 unit should receive damage only after all rank≤2 units are lethal. Specifically, in `validateManualAllocation` (~line 3907), add a mirror of the Tank-first guard for "last":
   ```ts
   const lastUnit = step.targets.find(iid => /must be assigned combat damage last/i.test(getCard(findUnitAnywhere(s, iid)?.cardId ?? '')?.text ?? ''))
   if (lastUnit && (alloc[lastUnit] ?? 0) > 0) {
     const others = step.targets.filter(iid => iid !== lastUnit && !step.tanks.includes(iid))
     if (others.some(iid => (alloc[iid] ?? 0) < step.hp[iid]))
       return 'Other units must be assigned lethal damage before the "assigned last" unit.'
   }
   ```

**Part B — Activated dealMight:**
3. In ACTIVATE_UNIT, after `ab.doubleMight` / `ab.effect.tempMightSelf` branches (~line 5991), add:
   ```ts
   if (ab.effect.dealMight?.dealer === 'self') {
     const bi = battlefieldOf(s1, u.iid)
     if (bi >= 0) {
       const amt = combatMightAt(s1, bi, u, 'attacker')
       const tgt = action.targets?.[0]
       const foe = tgt ? findUnitAnywhere(s1, tgt) : pickEnemyToDamage(s1.battlefields[bi].units, action.player, amt)
       if (foe && amt > 0) {
         s1 = fireDeaths(s1, applyTargetDamage(s1, foe.iid, amt, true, action.player))
         s1 = log(s1, action.player, `${name}: dealt ${amt} to ${getCard(foe.cardId)?.name}.`)
       }
     }
     handled = true
   }
   ```
4. Add `needsTgt` detection in MatchPage / OnlinePage for `ab.effect.dealMight?.dealer === 'self'` (already partially present via the `ab.effect.damage > 0` branch, but `dealMight` is not checked — add `|| ab.effect.dealMight?.dealer === 'self'`).

---

## 6. Draven - Showboat (ogn-028-298)

**Verbatim text:**
> "My Might is increased by your points."

**Card data:** type=unit, might=3, tags=[Draven, Noxus], supertype=champion

### Current state — partial bespoke exists

The `auraMightBonus` function (engine.ts:2259) correctly adds `s.players[u.owner]?.points ?? 0` to Draven's Might. This is state-aware and live (consulted in `combatMightAt` / `mightBreakdownAt`). Test coverage exists at engine.test.ts:4899 and 5024.

### Remaining gaps

1. **No UI Might tooltip.** `mightBreakdownAt` aggregates the bonus correctly, but the board display of Draven's Might in the hand/bench card view may show the static printed Might (3) rather than the live value. Verify `BoardCard.tsx` uses `mightBreakdownAt` or the live computed value, not the raw `card.might`.

2. **Point changes are not reactive.** When points change (score, mid-combat), `auraMightBonus` is re-called on the next Might query, but no `emit({kind:'buff',...})` is fired. The board card may not re-render to reflect the change. Consider emitting a buff event after every `points +=` mutation where Draven is in play.

3. **No known logic errors.** The core bonus is correct.

### Step-by-step fix plan

1. Confirm `BoardCard.tsx` reads the live computed Might (via `mightBreakdown` prop from MatchPage) rather than `card.might` directly.
2. After every `p.points += N` mutation in engine.ts (direct scoring, deathknell scoring, conquer scoring), check if the player controls a Draven - Showboat and emit `{kind:'buff', iid: draven.iid}` to trigger a re-render.
3. No engine logic changes required — the bonus calculation is correct.

---

## 7. Dr. Mundo - Expert (ogn-109-298)

**Verbatim text:**
> "My Might is increased by the number of cards in your trash.At the start of your Beginning Phase, recycle 3 from your trash."

**Card data:** type=unit, might=6, tags=[Dr. Mundo, Zaun], supertype=champion

### Current state — partial bespoke exists

`auraMightBonus` (engine.ts:2260) correctly adds `s.players[u.owner]?.zones.trash.length ?? 0` to Mundo's Might. This is live and state-aware.

### Remaining gaps

1. **"Recycle 3 from your trash" is unresolved.** The startOfTurn trigger pattern (triggers.ts:96) will collect Mundo's trigger (`"At the start of your Beginning Phase"` matches the regex). The trigger fires `fireTriggers` → `applyParsed`, but `applyParsed` has **no effect primitive for "recycle N cards from your trash to your deck"** as a triggered effect. The phrase `"recycle 3 from your trash"` only appears as a **cost** field (`recycleTrash`) in `unitActivatedAbility`, not as a free-standing effect field. Result: the trigger fires but silently does nothing.

2. **No `recycleFromTrash` effect field in `ParsedEffect`.**

### Engine anchors

- `src/engine/effects.ts` — `ParsedEffect` interface and `EMPTY_EFFECT`: add a `recycleFromTrash?: number` field.
- `src/engine/effects.ts` — `parse` function: detect `"recycle N from your trash"` as an **effect** (not cost) and set `eff.recycleFromTrash = N`.
- `src/engine/engine.ts` — `applyParsed` function: add a handler for `recycleFromTrash` that shuffles N cards from trash to deck.
- `src/engine/engine.ts` — `fireTriggers`: no changes needed (generic applyParsed path will handle it once the field exists).

### Step-by-step fix plan

**Option A — generic `recycleFromTrash` effect primitive (recommended, reusable for future cards):**
1. Add to `ParsedEffect` in `effects.ts`:
   ```ts
   recycleFromTrash: number // "recycle N from your trash" as a triggered/on-play effect
   ```
   Default: `0` in `EMPTY_EFFECT()`.
2. In `parse` in `effects.ts`, add detection (after the cost-parsing block to avoid conflict):
   ```ts
   const rftM = t.match(/\brecycle (\d+|a|an|one|two|three) (?:cards? )?from your trash\b/)
   if (rftM && !/unitActivatedAbility context/.test(t)) { // only fire for effect context
     eff.recycleFromTrash = num(rftM[1])
     hit = true
   }
   ```
   Note: Disambiguate from the cost context. Since `parse` in `effects.ts` is called for effect clauses (not cost strings), this should be safe without extra guards.
3. In `applyParsed` (engine.ts, after the `recycleRune` / channel blocks):
   ```ts
   if (e.recycleFromTrash) {
     const n = Math.min(e.recycleFromTrash, p.zones.trash.length)
     for (let i = 0; i < n; i++) p.zones.mainDeck.push(p.zones.trash.shift()!)
     if (n > 0) lines.push(`Recycled ${n} card(s) from trash to deck.`)
   }
   ```
4. Mundo's `startOfTurn` trigger will now auto-resolve through `fireTriggers` → `applyParsed` without bespoke code. The Might bonus already works.

**Option B — bespoke startOfTurn handler (narrower, lower risk):**
- In `fireTriggers`, detect `srcName === 'Dr. Mundo - Expert'` and `ability.event === 'startOfTurn'`, then inline the recycle-3 logic. Simpler but not reusable.

---

## Shared Primitives Summary

| Primitive | Cards that need it | Where to add |
|---|---|---|
| `countEquipmentOwned(s, player)` | Arise! (token count), already used by Ornn (line 3751) | Extract from engine.ts:3751 into a named helper |
| `recycleFromTrash: number` in `ParsedEffect` | Dr. Mundo beginning-phase recycle | `effects.ts` + `applyParsed` |
| `fireStun(s, player, bfIndex?)` signature | Vex - Mocking move | `engine.ts` fireStun signature + 3 call sites |
| `dealMight.dealer=self` in ACTIVATE_UNIT | Caitlyn activated ability | ACTIVATE_UNIT handler block |
| `PlayerState.namedTag?: string` + `'nameTag'` pendingChoice | The List | `types.ts` + PLAY_GEAR + RESOLVE_CHOICE + UI |
| damage-order rank=3 "assigned last" | Caitlyn combat ordering | `damageOrder` + `validateManualAllocation` |

---

## Priority Order

1. **Vex - Mocking** — 3-line fix (forward bfIndex), high impact, zero new types.
2. **Dr. Mundo recycle** — small new effect field, reusable, unblocks the startOfTurn trigger.
3. **Caitlyn activated dealMight** — add dealMight branch to ACTIVATE_UNIT (shared by any future self-dealer activated ability).
4. **Carnivorous Snapvine** — bespoke on-play handler, self-contained.
5. **Arise!** — bespoke PLAY_SPELL handler, extract equipment-count helper.
6. **Caitlyn combat ordering** — rank=3 in damageOrder, update validation; moderate complexity.
7. **The List** — most complex (free-form UI input + new PlayerState field + tag-filtered activation).
8. **Draven / Mundo Might aura** — already correct; only UI re-render polish needed.
