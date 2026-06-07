# A6 Engine Refactor Map — controllerOf() vs owner

> **Scope:** `src/engine/engine.ts` (7028 lines), `src/engine/autopay.ts` (267 lines), `src/engine/invariants.ts` (56 lines).
>
> **Rule:** Add `EngineCard.controlledBy?: PlayerId` and a helper `controllerOf(u) = u.controlledBy ?? u.owner`. Owner stays immutable. Every **friendly/enemy determination** that currently reads `u.owner` must switch to `controllerOf(u)` so stolen units fight on the thief's side. Zone-routing (trash/hand/banish) must **keep `u.owner`** per Rule 107.1.d (a card going to a zone goes to its real owner's zone).

---

## Legend

| Symbol | Meaning |
|--------|---------|
| **YES** | Change to `controllerOf(u)` (friendly/enemy logic) |
| **NO** | Keep `u.owner` (zone routing / immutable identity) |

---

## Comprehensive Table

| file:line | current code | controllerOf? | note |
|-----------|-------------|---------------|------|
| **engine.ts — Combat sides (showdownSteps / fireCombatTriggers / finalizeShowdown)** | | | |
| engine.ts:4350 | `bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer` | YES | Determines moverOwner — a stolen unit's controller is the attacker |
| engine.ts:4351 | `s.players[u.owner]?.xp ?? 0` | NO | XP lookup by the unit's real owner (identity stat, not control side) |
| engine.ts:4352 | `bf.units.filter((u) => u.owner === moverOwner)` | YES | attacker side split — must use controllerOf |
| engine.ts:4353 | `bf.units.filter((u) => u.owner !== moverOwner)` | YES | defender side split — must use controllerOf |
| engine.ts:4365 | `defenders.map((u) => u.owner)` | YES | defOwners array — used to elect defense assigner by controller |
| engine.ts:4342 | `defenders.filter((u) => u.owner === owner).length` (inside `count()` lambda) | YES | counts defenders per controller for assigner election |
| engine.ts:4388 | `bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer` | YES | fireCombatTriggers: same moverOwner derivation |
| engine.ts:4389 | `bf.units.filter((u) => u.owner === moverOwner)` | YES | fireCombatTriggers attackers |
| engine.ts:4390 | `bf.units.filter((u) => u.owner !== moverOwner)` | YES | fireCombatTriggers defenders |
| engine.ts:4450 | `bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer` | YES | finalizeShowdown moverOwner derivation |
| engine.ts:4457 | `s.players[u.owner]?.xp ?? 0` | NO | xpOf lambda — XP belongs to real owner |
| engine.ts:4458 | `bf.units.filter((u) => u.owner === moverOwner)` | YES | finalizeShowdown attackers |
| engine.ts:4459 | `bf.units.filter((u) => u.owner !== moverOwner)` | YES | finalizeShowdown defenders |
| engine.ts:4479 | `defenders.map((u) => u.owner)` (inside `onDefend` loop) | YES | per-controller onDefend callback; controller is what matters |
| engine.ts:4485 | `bf.units.filter((u) => u.owner === owner).map(...)` (Reaver's Row opts) | YES | find the controlling player's units here |
| engine.ts:4499 | `u.owner !== moverOwner && defendersDefeated.has(u.iid)` | YES | which side a dead unit was on |
| engine.ts:4500 | `u.owner === moverOwner && attackersDefeated.has(u.iid)` | YES | which side a dead unit was on |
| engine.ts:4535 | `bf.units.some((u) => u.owner !== moverOwner)` | YES | defendersRemain check |
| engine.ts:4536 | `bf.units.filter((u) => u.owner === moverOwner)` | YES | moverRemain |
| engine.ts:4538 | `bf.units.filter((u) => u.owner !== moverOwner)` | YES | strip attacker units after no-conquer recall |
| engine.ts:4551 | `bf.units.filter((u) => u.owner === moverOwner).map(...)` | YES | moverHere (win-combat trigger sources) |
| engine.ts:4552 | `bf.units.some((u) => u.owner !== moverOwner)` | YES | enemyHere (win-combat guard) |
| **engine.ts — recomputeControllers** | | | |
| engine.ts:3267 | `counts.set(u.owner, ...)` | YES | Controller election is based on who controls each unit (controlledBy), not who owns them |
| **engine.ts — Awaken / ready sweep (beginTurn)** | | | |
| engine.ts:3314 | `u.owner === ap && !unitCantBeReadied(u)` | YES | Awaken should ready units the AP controls, not merely owns — a stolen unit on AP's behalf stays exhausted |
| engine.ts:3341 | `u.owner === ap && (parseKeywords(def(u)).temporary ...)` | YES | Temporary expiry fires for units the AP controls (the controller's clean-up, not the owner's) |
| **engine.ts — trigger collection (controlledPermanents / collectGlobal / collectSelf)** | | | |
| engine.ts:1127 | `b.units.filter((u) => u.owner === player)` | YES | controlledPermanents — a stolen unit's triggers fire under the thief's control |
| engine.ts:1117 | `u.owner === player && has(u)` (countFriendlyUnitsWithKeyword) | YES | counts units a player controls |
| engine.ts:1118 | `u.owner === player && has(u)` (countFriendlyUnitsWithKeyword base) | YES | same, base zone |
| engine.ts:1803 | `b.units.filter((u) => u.owner === pid)` (fireOpponentUnitPlay) | YES | opponent's units at bf — responder's controlled units |
| engine.ts:1909 | `if (u.owner !== player) continue` (fireGearAbilityUse) | YES | skip units not controlled by player |
| **engine.ts — aura (auraMightBonus / bfCombatBonus scope)** | | | |
| engine.ts:4114 | `controlledPermanents(s, u.owner)` (Mask of Foresight gear scan) | YES | gear aura scans the controller's permanents; controllerOf should replace u.owner here |
| engine.ts:3929 | `bf.units.filter((x) => x.owner === u.owner).length === 1` (combatMightAt alone) | YES | "alone" = only unit on your side; side = controller |
| engine.ts:3813 | `s.battlefields[bi].units.filter((x) => x.owner === u.owner).length === 1` (STATES alone) | YES | same alone check in state engine |
| engine.ts:3811 | `s.players[u.owner]?.xp ?? 0` (STATES mighty) | NO | XP belongs to the real owner (identity stat) — do not change |
| engine.ts:3931 | `s.players[u.owner]?.xp ?? 0` (combatMightAt mightOf call) | NO | same |
| engine.ts:4109 | `mightOf(u, role, owner.xp ?? 0)` (Fiora 1v1 double) | NO | owner = PlayerState of the card's owner for XP purposes |
| **engine.ts — Hunt / awardPoints / grantHunt** | | | |
| engine.ts:3008 | `u.owner === player` (grantHunt) | YES | Hunt XP goes to the player controlling the units here |
| engine.ts:3216 | `u.owner === player` (MOVE_UNIT conquer — `here` iids for collectSelf) | YES | fire self-triggers for units the conquering player controls |
| engine.ts:3247 | `u.owner === movedOwner` (showdownOrConquerAfterEffectMove `here` iids) | YES | same pattern |
| engine.ts:3482 | `u.owner === ap` (resumeBeginning hold `heldUnitIids`) | YES | self-triggers for held units the AP controls |
| engine.ts:3507 | `u.owner === ap` (Grand Plaza winOnUnitsHere) | YES | count units AP controls at this BF |
| engine.ts:3517 | `u.owner === ap` (Amateur Recital opts) | YES | AP picks from units they control |
| **engine.ts — Mighty / alone counts** | | | |
| engine.ts:596 | `u.owner === p.id && stateActive(s, u, 'mighty')` (drawPerMighty) | YES | count AP's controlled [Mighty] units |
| engine.ts:1660–1662 | `s.players[u.owner]?.xp` (mightyAtDeath) | NO | Deathknell snapshot: XP is the owner's stat |
| engine.ts:1664–1668 | `x.owner === u.owner` (aloneAtDeath) | YES | "alone" at death time = same controller side |
| engine.ts:1666 | `x.owner === u.owner && x.iid !== u.iid` | YES | survivors on the same side |
| engine.ts:1667 | `x.owner === u.owner && x.diedAtBf === u.diedAtBf` | YES | co-casualties on the same side |
| **engine.ts — getLegalTargets / untargetableByEnemy** | | | |
| engine.ts:7257 | `units.filter((u) => u.owner !== player)` (enemy scope) | YES | getLegalTargets: enemy filter = "not controlled by player" |
| engine.ts:7258 | `units.filter((u) => u.owner === player)` (friendly scope) | YES | getLegalTargets: friendly filter |
| engine.ts:7260 | `u.owner === player \|\| !untargetableByEnemy(state, u)` | YES | protect stolen-but-owner-immune units correctly |
| engine.ts:7244 | `state.players[u.owner]?.xp ?? 0` (untargetableByEnemy Level gate) | NO | XP belongs to the real owner |
| **engine.ts — misc friendly/enemy helpers and bespoke handlers** | | | |
| engine.ts:424 | `u.owner !== player` (tribeTagCount) | YES | tribe tags from units the player controls |
| engine.ts:432 | `u.owner === player` (controlsTribeTag) | YES | |
| engine.ts:444 | `u.owner === p.id` (conditionMet unitsHereAtLeast) | YES | counts units AP controls at the BF |
| engine.ts:484 | `u.owner !== p.id` (applyBuff give) | YES | buff only own-controlled units |
| engine.ts:499 | `u.owner === p.id` (buffAll sweep) | YES | |
| engine.ts:503 | `u.owner === p.id` (buffAll unbuffed sweep) | YES | |
| engine.ts:556 | `u.owner !== chooser` (applyRecruit) | YES | own-side check for recruit targets |
| engine.ts:2215 | `u.owner === owner` (mageseekerWardenAtBf) | YES | Warden presence is a control-side aura |
| engine.ts:2227 | `u.owner === player` (friendlyUnitsEnterReadyAura) | YES | aura from units the player controls |
| engine.ts:2238 | `u.owner !== player` (pullEnemyToBf filter) | YES | "enemy" = not controlled by player |
| engine.ts:2257 | `enemy.owner === mover` (blastConeOnEnemyMove guard) | YES | skip if mover somehow controls the "enemy" |
| engine.ts:2280 | `u.owner === pl.id` (allGearInPlay — unit scan) | YES | find units the player controls to surface attached gear |
| engine.ts:2299 | `u.owner === pl.id` (killGearByIid unit scan) | YES | same |
| engine.ts:2319 | `u.owner === pl.id` (bounceGearByIid unit scan) | YES | same |
| engine.ts:2337 | `g.owner !== player` (applyKillGear friendly scope) | YES | friendly gear = controlled by player |
| engine.ts:2338 | `g.owner === player` (applyKillGear enemy scope) | YES | enemy gear = not controlled |
| engine.ts:2388 | `u.owner === player` (Reaver's Row opts in finalizeShowdown) | YES | controller picks from their own units |
| engine.ts:2417 | `u.owner === player` (findUnitByBaseName) | YES | find a unit the player controls |
| engine.ts:2425 | `target.owner !== player` (applyRecruit guard) | YES | ensure target is player's controlled unit |
| engine.ts:2456 | `u.owner === player` (applyParsed buffUnbuffed sweep) | YES | |
| engine.ts:2478 | `u.owner === p.id` (controlsTribeTag variant in applyParsed) | YES | |
| engine.ts:2505 | `u.owner === player` (Zilean aura check) | YES | aura from a unit the player controls |
| engine.ts:2520 | `u.owner !== player` (pickStrongestEnemy) | YES | enemy = not controlled by player |
| engine.ts:2529 | `u.owner !== player` (pickEnemyToDamage) | YES | same |
| engine.ts:2575 | `u.owner === player` (Vex in-combat spell aura — inner check in applyParsed) | YES | |
| engine.ts:2627 | `u.owner !== player` (controlledEquipOptions unit scan) | YES | skip units not controlled by player |
| engine.ts:2639 | `u.owner === player` (unitsControlledBy) | YES | core helper — entire point of this function |
| engine.ts:2654 | `u.iid === iid && u.owner === player` (controlledInstance) | YES | find an instance the player controls |
| engine.ts:2871 | `x.iid === iid && x.owner === player && !x.exhausted` | YES | check if player controls the unit at a BF |
| engine.ts:2914 | `u.owner === player && u.iid !== iid` (opts for activate choice) | YES | other units the AP controls |
| engine.ts:3105 | `u.owner !== caster` (Elder lethal — applyTargetDamage) | YES | Elder Dragon: lethal to enemy units (not controlled by caster) |
| engine.ts:3127 | `u.owner !== caster` (Elder lethal — base zone sweep) | YES | same |
| engine.ts:3163 | `u.iid === iid && u.owner === player` (bfIndexOfUnit-style find) | YES | ownership-as-identity here — find the specific instance; this is a locate, not friendly/enemy, leave as-is (both are fine; owner as unique-id is acceptable) |
| engine.ts:3193 | `u.owner !== player` (contested check in MOVE_UNIT) | YES | contested = enemy-controlled unit present |
| engine.ts:3234 | `u.owner !== movedOwner` (showdownOrConquerAfterEffectMove contested) | YES | |
| engine.ts:3396 | `u.owner === pl.id` (Shard opponents with units filter) | YES | opponents with units they control |
| engine.ts:3416 | `u.owner === pid` (resumeBeginning hold check) | YES | |
| engine.ts:3434 | `u.owner === ap` (opts for beginMove) | YES | AP selects from units they control |
| engine.ts:3482 | `u.owner === ap` (heldUnitIids) | YES | (duplicate of hold row above) |
| engine.ts:4290 | `u.owner !== caster` (bespoke handler guard) | YES | enemy unit check |
| engine.ts:4485 | `u.owner === owner` (Reaver's Row opts build) | YES | pick units owner controls |
| engine.ts:4607 | `u.owner === controller` (strikeDown dealer filter) | YES | equipped friendly |
| engine.ts:4609 | `u.owner !== controller` (strikeDown enemy filter) | YES | enemy |
| engine.ts:4635 | `u.owner === controller` (Void Assault friendly filter) | YES | |
| engine.ts:4635 | `u.owner !== controller` (Void Assault enemy filter) | YES | |
| engine.ts:4636 | `u.owner === controller` (Void Assault chosen friendly) | YES | |
| engine.ts:4637 | `u.owner !== controller` (Void Assault chosen enemy) | YES | |
| engine.ts:4691 | `u.owner === controller` (dealMight friendlies) | YES | |
| engine.ts:4692 | `u.owner !== controller` (dealMight enemiesAll) | YES | |
| engine.ts:4696 | `u.owner === controller` / `u.owner !== controller` (chosen lambda) | YES | |
| engine.ts:4709 | `u.owner !== controller` (allEnemiesAtBf foes filter) | YES | |
| engine.ts:4750 | `u.owner === pl.id` (cullEachPlayer own-units filter) | YES | each player kills their own controlled unit |
| engine.ts:4766 | `tu.owner !== controller` (hasTargetedPart untargetable guard) | YES | |
| engine.ts:4779 | `dtu.owner === controller` (Dreaming Tree friendly-choose check) | YES | |
| engine.ts:4826 | `u.owner !== controller` (stun tracking stunnedEnemy) | YES | |
| engine.ts:4885 | `u.owner === mu.owner` (Temptation same-controller filter) | YES | move to a BF where the moved unit's controller has another unit |
| engine.ts:4929 | `u.owner === player` (autoSpellTargets friendly pool) | YES | |
| engine.ts:4930 | `u.owner !== player` / `u.owner !== player` (autoSpellTargets enemy pool) | YES | |
| engine.ts:5404 | `bf.units.some((u) => u.owner === action.player)` (MOVE_UNIT Ambush guard) | YES | player has units at the BF they control |
| engine.ts:5494 | `u.owner !== action.player && u.stunned` (wantsEnemyOccupied check) | YES | |
| engine.ts:5534 | `u.owner !== action.player` (wantsEnemyOccupiedBf guard) | YES | |
| engine.ts:5615 | `u.owner !== action.player` (foe in bespoke handler) | YES | |
| engine.ts:5743 | `u.owner !== action.player` (enemy filter in handler) | YES | |
| engine.ts:5773 | `u.owner !== action.player` (enemy sort pick) | YES | |
| engine.ts:5792 | `u.iid === action.targetIid && u.owner === action.player` | YES | find own controlled unit |
| engine.ts:5806 | `u.owner === action.player` (filter friendlies) | YES | |
| engine.ts:6031 | `u.owner !== action.player` (Hidden-reveal blocker) | YES | check enemy unit has a blocking aura |
| engine.ts:6052 | `u.owner === action.player` (host for facedown reveal) | YES | find the AP's unit as host |
| engine.ts:6079 | `u.iid === action.iid && u.owner === action.player` | YES | own-controlled unit locate |
| engine.ts:6126 | `u.owner !== action.player \|\| !u.exhausted ...` (READY guard) | YES | can only ready units you control |
| engine.ts:6163 | `u.owner === pid` (own-units filter in trigger handler) | YES | |
| engine.ts:6196 | `u.owner === card.owner` (Dragon's Rage same-side filter) | YES | same controller as moved unit |
| engine.ts:6603 | `tu.owner !== action.player && tu.stunned` (RESOLVE_CHOICE enemy-stunned find) | YES | |
| engine.ts:7011 | `u.owner === ender` (end-of-turn unit scan) | YES | ender's controlled units |
| engine.ts:7071 | `u.iid === action.iid && u.owner === action.player` (facedown locate) | YES | |
| engine.ts:7106 | `u.iid === action.iid && u.owner === action.player` (REVEAL_FACEDOWN index) | YES | |
| engine.ts:7256 | `u.owner !== player` (fireTriggers enemy targetScope) | YES | |
| engine.ts:7257 | `u.owner === player` (fireTriggers friendly targetScope) | YES | |
| engine.ts:7259 | `u.owner === player \|\| !untargetableByEnemy(...)` | YES | |
| engine.ts:7315 | `bf.units.some((u) => u.owner === player)` (canPlay Ambush check) | YES | player controls a unit at that BF |
| **engine.ts — MUST KEEP owner (zone routing, Rule 107.1.d)** | | | |
| engine.ts:312–316 | `sendToTrash(s.players[u.owner], u)` | NO | Stolen unit dying → goes to REAL owner's trash |
| engine.ts:330–333 | `banishCard(s.players[u.owner], u)` | NO | Same principle |
| engine.ts:2298 | `sendToTrash(pl, g)` (killGearByIid — iterates by owner's player) | NO | Gear goes to its owner's trash |
| engine.ts:2305 | `sendToTrash(s.players[u.owner], { ... owner: u.owner ... })` | NO | Attached gear → owner's trash |
| engine.ts:2318 | `pl.zones.hand.push(...)` (bounceGearByIid) | NO | Gear goes to its owner's hand |
| engine.ts:2325 | `s.players[u.owner].zones.hand.push(...)` | NO | same |
| engine.ts:2934 | `s.players[u.owner].zones.hand.push(...)` (returnUnitToHand) | NO | Bounced unit → owner's hand |
| engine.ts:2981 | `s.players[owner].zones.hand.push(...)` (bounceUnitToHand, owner = u.owner) | NO | Bounce always goes to owner's zone |
| engine.ts:2987 | `s.players[owner].zones.hand.push(...)` (bounceUnitToHand base unit) | NO | same |
| engine.ts:3039 | `s.players[u.owner].zones.trash.push(...)` (Zhonya's self-sacrifice gear) | NO | Consumed gear → owner's trash |
| engine.ts:3074–3075 | `banishCard(s.players[u.owner], u)` / `sendToTrash(s.players[u.owner], u)` (trashOrBanish) | NO | Death routing — always to real owner |
| engine.ts:3347 | `sendToTrash(p, u)` (temporary expiry, p = players[ap], u.owner checked above) | NO | Sends to owner's trash (ap is the owner in this loop) |
| engine.ts:3359 | `sendToTrash(p, u)` (base temporary expiry) | NO | same |
| engine.ts:3367 | `sendToTrash(s.players[bf.facedown.owner], bf.facedown)` | NO | Facedown revealed/removed → owner's trash |
| engine.ts:3697–3699 | `leaving = bf.units.filter((u) => u.owner === player)` / `sendToTrash(p, u)` (eliminate) | YES/NO | The filter by owner is OK (eliminate removes only the DEPARTED player's units); trash route uses p = players[player] = owner. Filter is identity (owner), trash is zone-routing (owner). Both intentional. |
| engine.ts:5017 | `sendToTrash(s.players[u.owner], u)` (applyTempMight lethal) | NO | Real owner's trash |
| engine.ts:5027 | `sendToTrash(p, u)` (applyTempMight base) | NO | p is the base-zone's own player |
| engine.ts:5064 | `sendToTrash(s.players[target.controller], target.instance)` (resolveTopOfChain counter) | NO | Spell chain uses `.controller` (already a chain-item field, not unit.owner) — correct |
| engine.ts:5070 | `sendToTrash(p, item.instance)` | NO | Spell goes to its controller's trash — chain instance; no unit.owner involved |
| engine.ts:6705–6712 | `s.players[x.owner].banished` / `s.players[x.owner].zones.trash` (sandbox trash/banish) | NO | Sandbox override routes to real owner's zone |
| engine.ts:6864–6866 | `s.players[fd.owner].zones.hand` / `banishCard(s.players[fd.owner], fd)` / `sendToTrash(s.players[fd.owner], fd)` | NO | Facedown reveal — owner's hand/trash |
| **autopay.ts — aura / cost** | | | |
| autopay.ts:32 | `u.owner === player` (controlsTag inner) | YES | tag aura from units the player controls |
| autopay.ts:57 | `b.units.filter((u) => u.owner === player)` (Herald of Scales aura perms) | YES | scan permanents the player controls |
| autopay.ts:80 | `u.owner !== player` (perTagM tribe scan) | YES | skip enemy-controlled units |
| autopay.ts:93 | `u.owner !== player && u.stunned` (monchM opponent stunned check) | YES | enemy = not controlled by player |
| autopay.ts:112 | `u.owner === player && d?.type === 'unit'` (Jaull-Fish mighty count) | YES | count [Mighty] units the player controls |
| autopay.ts:134 | `b.units.filter((u) => u.owner === player)` (Irelia aura perms2) | YES | same, Irelia spell-discount aura |
| autopay.ts:159 | `vex.owner === player` (Vex cost modifier) | YES | Vex on your side = you get the discount |
| **invariants.ts** | | | |
| invariants.ts:50 | `!b.units.some((u) => u.owner === b.controller)` | YES | Sanity: the declared controller must have a unit they control there — after A6 this should check controllerOf(u) === b.controller |

---

## Summary of Counts

| Category | Count |
|----------|-------|
| **YES** — change to `controllerOf(u)` | **~110** |
| **NO** — must keep `u.owner` (zone routing) | **~22** |

---

## Four-Line Summary

1. **110 YES sites** span all seven categories: combat-side splits (showdownSteps/fireCombatTriggers/finalizeShowdown), recomputeControllers, Awaken/ready sweep, trigger collection (controlledPermanents/collectGlobal/collectSelf), aura & cost checks in autopay.ts, Hunt/grantHunt/hold scoring, and every getLegalTargets/untargetableByEnemy filter.

2. **~22 MUST-KEEP-owner sites** are zone-routing calls — every `sendToTrash(s.players[u.owner], u)`, `banishCard(s.players[u.owner], u)`, and `zones.hand.push(... owner: u.owner ...)` path must continue using `u.owner` so that a stolen unit's death/bounce/banish correctly deposits it in its real owner's zone (Rule 107.1.d).

3. **Biggest implementation risk:** `recomputeControllers` (line 3267) uses `u.owner` to bucket units into the majority-count map — switching to `controllerOf(u)` here is mandatory; missing it means the BF controller won't update when a stolen unit tips the majority, breaking conquer/hold detection for every subsequent action. The `mightOf(u, role, s.players[u.owner]?.xp)` XP lookups scattered across combat (lines 4351, 4457, 3811, 3931, 4109, 1660) should intentionally stay on `u.owner` because XP (Champion Level) is a player-identity stat, not a control-side stat — do not inadvertently change those.

4. **Rollout order:** (a) add `controlledBy?: PlayerId` to `EngineCard` type and the `controllerOf` helper; (b) update `recomputeControllers` first (foundational); (c) update `controlledPermanents` (all trigger collection cascades from it); (d) update combat sides in `showdownSteps`/`fireCombatTriggers`/`finalizeShowdown`; (e) update `getLegalTargets`; (f) update `autopay.ts` cost auras; (g) update the remaining bespoke-handler sites; (h) update `invariants.ts`; (i) add a unit-test: steal a unit mid-combat, verify it fights on the thief's side and dies to the thief's trash not the victim's.
