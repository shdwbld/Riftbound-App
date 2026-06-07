# A6 Control Refactor — Rules Verification & Cross-Check

_Research date: 2026-06-06_

---

## Part 1 — Official Rules Confirmed (with citations)

### 1.1 Ownership vs. Controller — the fundamental split

| Rule | Verbatim text | Source |
|------|--------------|--------|
| **Rule 126.1 / 127.1** | "For gameplay purposes, a card's Owner is the player who brought it into the game, either as their Champion Legend, one of their Battlefields, or part of their Main Deck or Rune Deck." | [riftrules.com](https://riftrules.com/?r=rule&slug=core-rules) / [jeff425 hyperlinked CR](https://jeff425.github.io/hyperlinked-rb-cr/) |
| **Rule 056 / 107.1.d** | "Cards a player owns may never be placed into a non-Board zone belonging to another player. If it would be, it goes to its owner's corresponding zone instead." Applies to Trash, Hand, and Banishment identically. | [rules.flexslot.gg — 107.1.d](https://rules.flexslot.gg/rules/107-1-the-trash) / [riftrules.com](https://riftrules.com/?r=rule&slug=core-rules) |
| **Rule 182.1 / 188.1** | "When a player Plays a Card, they are established as that Game Object's Controller." | [riftrules.com](https://riftrules.com/?r=rule&slug=core-rules) / [jeff425](https://jeff425.github.io/hyperlinked-rb-cr/) |
| **Rule 182.3 / 188.3** | "For Permanents and Runes, when they Enter the Board, that player is assigned as that Game Object's Controller." | [riftrules.com](https://riftrules.com/?r=rule&slug=core-rules) |

**Summary:** Owner is permanent and immutable (who brought the card). Controller can change. Non-board zones (trash, hand, banish) always route to the OWNER, never the controller.

---

### 1.2 "Gain control" / "Take control until end of turn" semantics

No comprehensive rule explicitly defines a generic "gain control of a permanent" verb akin to Magic: The Gathering; Riftbound instead expresses it entirely through card text. From card text and rulings:

- **Possession** (card text): "Choose an enemy unit at a battlefield. Take control of it and recall it." — The effect is the capture: the unit becomes yours **permanently** (no end-of-turn revert). The "recall" that follows sends it to your base.
- **Hostile Takeover** (card text): "Take control of an enemy unit at a battlefield. Ready it. … Lose control of that unit and recall it at end of turn." — Temporary. The card explicitly says to recall it at end of turn. No broader rule mandates this; the revert is card-text driven.

**Confirmed from SFD FAQ:** "You'll start a noncombat showdown. (Hostile Takeover's reminder text is a little misleading in this regard — you have to have some kind of showdown before you can conquer.)" [riftbound.leagueoflegends.com Spiritforged FAQ](https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/riftbound-spiritforged-faq/)

---

### 1.3 What happens when a stolen/controlled permanent leaves play

**Deaths / trash routing:** Rule 056 / 107.1.d is absolute — a stolen unit that dies goes to its **owner's** trash, not the controller's trash. This is engine.ts's existing behavior (`sendToTrash(s.players[u.owner], u)`). It is **correct** and must not change.

**Recall routing — CRITICAL DISCREPANCY:** Rule 428 / 149.3 states:
> "To Recall a card means to return it from a Location on the board to a designated Zone — most often from a Battlefield to its **controller's** Base — without it being treated as a Move."
> "If an unattached Gear is at a Battlefield for any reason during a cleanup, then it is recalled to its **controller's** Base as a corrective action." [rules.flexslot.gg](https://rules.flexslot.gg/rulebook) / [riftrules.com](https://riftrules.com/?r=rule&slug=core-rules)

**Recall goes to the CONTROLLER's base, not the owner's base.** This is the opposite of the trash rule and directly contradicts the dossier model (see Section 2 for full implications).

**Bounce / return-to-hand:** Rule 107.6.f says a card cannot enter another player's hand; it goes to the owner's hand. So bouncing a stolen unit returns it to its **owner's** hand.

---

### 1.4 What happens when the controlling source leaves play (Akshan gear)

**Rule 718.5.f (confirmed):** "Changes in control of the top-most card do not affect control of attached cards, and vice versa." [riftboundfaq.com](https://www.riftboundfaq.com/mechanics/equipment) / [search confirmation](https://rules.flexslot.gg/rulebook)

This means:
- When Possession or Hostile Takeover steals a unit that has gear attached, the **gear's controller does not change** — it stays with the original gear-controller.
- The original gear-controller retains Weaponmaster access to their gear even while it rides on a stolen unit.
- When Akshan steals a gear, his player becomes the gear's controller. When Akshan **leaves the board**, control of the stolen gear reverts to the original owner. Confirmed by community rulings: "Once Akshan leaves play, control of the equipment returns to its original owner." [RiftboundReport on X](https://x.com/RiftboundReport/status/2027337877307166829) / [Facebook rulings group](https://www.facebook.com/groups/riftboundrulesandfaqs/posts/2075617529953096/)

**Where does Akshan's gear go on his exit?** The gear, once Akshan is gone, is unattached gear whose controller is now back to the original owner. Rule 149.3 / 428 would then direct it to that player's base on the next cleanup. Akshan's card text says it goes to "your base" (Akshan player's base) — but on departure the control reverts first, then cleanup routes it to the re-owner's base.

---

### 1.5 Verbatim card text (confirmed from cards.generated.json)

**Possession** (`ogn-203-298`):
> [Action] (Play on your turn or in showdowns.) Choose an enemy unit at a battlefield. Take control of it and recall it. (Send it to your base. This isn't a move.)

**Hostile Takeover** (`sfd-202-221`):
> [Hidden] (Hide now for :rb_rune_rainbow: to react with later for :rb_energy_0:.) Take control of an enemy unit at a battlefield. Ready it. (Start a combat if other enemies are there. Otherwise, conquer.) Lose control of that unit and recall it at end of turn. (Send it to base. This isn't a move.)

**Akshan - Mischievous** (`sfd-109-221`):
> [Weaponmaster] You may pay :rb_rune_body::rb_rune_body: as an additional cost to play me. When you play me, if you paid the additional cost, move an enemy gear to your base. You control it until I leave the board. If it's an Equipment, attach it to me.

---

## Part 2 — Cross-Check of Dossier vs. Real Rules

### 2.1 Engine Refactor Map (a6-engine-refactor-map.md)

| Claim in dossier | Verification result |
|---|---|
| `u.owner` must be kept for all zone-routing (trash, hand, banish) | **CONFIRMED** — Rule 107.1.d / 056 makes this absolute. |
| Zone-routing calls at lines 312, 330, 2305, 2934, 2981, 3074-3075, etc. must stay on `u.owner` | **CONFIRMED** for trash and hand. |
| `recallToBase(s, u)` sends to `s.players[u.owner].zones.base` (all lines citing owner for recall) | **WRONG — CRITICAL.** Rule 428 says recall goes to the **controller's** base, not the owner's base. If a stolen unit is recalled, it must go to the **controller's** base. The `MUST-KEEP-owner` classification for recall sites is incorrect. |
| ~110 YES sites switching to `controllerOf(u)` for friendly/enemy logic | **CONFIRMED** — the logic split is sound. |
| XP lookups (`s.players[u.owner]?.xp`) must stay on owner | **CONFIRMED** — XP is player-identity. |
| `recomputeControllers` must switch to `controlledBy ?? u.owner` | **CONFIRMED** — needed for correct majority counting. |

**Recall site discrepancy detail:** The dossier lists engine.ts:2934, 2981, 2987 (returnUnitToHand/bounceUnitToHand) and engine.ts:3082 (recallToBase) as `MUST-KEEP-owner` in the NO column. However:
- `returnUnitToHand` / `bounceUnitToHand` → **owner** is correct (Rule 107.6.f: hand goes to owner).
- `recallToBase` (`s.players[u.owner].zones.base.push(...)`) → **WRONG.** For a unit that is under stolen control and recalled, rule 428 routes to the controller's base. The engine's `recallToBase` at line 3082 must use `controllerOf(u)`, not `u.owner`.

This is specifically relevant to Possession's "Take control of it and recall it" — the card text says "Send it to **your** base" (the caster's base). Since the caster is now the controller, using `controllerOf(u)` after mutating `u.controlledBy` would be correct. The dossier's workaround of permanently mutating `u.owner` achieves the same end result for Possession, but the base routing rule is controller-based not owner-based — implementers must not assume recall = owner's base.

---

### 2.2 Card Handler Dossier (a6-card-handlers.md)

#### Possession — Errors & Corrections

| Claim | Verdict |
|---|---|
| Permanently mutate `u.owner` to caster, then `recallToBase` routes it to caster's base | **FUNCTIONALLY CORRECT** for Possession's permanent steal — the mutation makes caster = controller = owner all at once, so recall lands correctly. However, see attached-gear issue below. |
| No revert needed — ownership is permanent | **CONFIRMED.** Possession has no end-of-turn revert. |
| Target: "enemy unit at ANY battlefield" | **WRONG.** Card text says "at **a** battlefield" — it does not say "at any battlefield." Riftbound spell targeting typically refers to the battlefield where the action takes place or a specific named one. However, as a chain action (not a non-combat ability), it may target at any battlefield; this needs local adjudication. The dossier's auto-pick across all battlefields is probably fine but should be noted. |
| Stealing a unit also steals its attached gear control | **WRONG — CRITICAL.** Rule 718.5.f: "Changes in control of the top-most card do not affect control of attached cards." Possession steals the **unit** only. Gear attached to the stolen unit remains under the **original opponent's** control. On recall, the gear detaches and goes to the original gear-controller's base (Rule 149.3 / cleanup). The dossier does not handle this and must be corrected. |

**Correct Possession behavior:**
1. Choose an enemy unit at a battlefield.
2. Change `controlledBy` of the unit to caster (or mutate `u.owner` permanently — both achieve same permanent result for Possession's one-shot steal).
3. Detach any attached gear **and return it to the original owner's base** (do NOT steal the gear — Rule 718.5.f).
4. Recall the unit to the **new controller's** (caster's) base (Rule 428).
5. Call `recomputeControllers(s)`.
6. No revert entry needed.

---

#### Hostile Takeover — Errors & Corrections

| Claim | Verdict |
|---|---|
| Temporarily mutate `u.owner` to caster; store original in `hostileTakeoverRevert[]`; restore at END_TURN | **FUNCTIONALLY CORRECT** — matches card text semantics exactly. |
| On revert: reset `u.owner` to originalOwner, then `recallToBase` routes to originalOwner's base | **WRONG — same recall routing issue.** Rule 428 says recall goes to the **controller's** base. After resetting `u.owner = originalOwner`, the controller = originalOwner, so routing works correctly by accident with the dossier's owner-mutation model. But implementers must understand: the correct principle is controller's base, not owner's base. The implementation happens to be correct because owner and controller are unified via mutation. |
| "Start a combat if other enemies are there. Otherwise, conquer." | **CONFIRMED but partially wrong per FAQ.** The SFD FAQ states: "You'll start a noncombat showdown" even when no other enemies are present at that battlefield (because you must have a showdown before conquering). The dossier calls `showdownOrConquerAfterEffectMove` which should handle this correctly IF it starts a noncombat showdown when no enemies remain — verify this path. |
| Attached gear on the stolen unit: not addressed in dossier | **MISSING.** Rule 718.5.f means the stolen unit's gear does NOT change control. The dossier does not handle this case. During the steal, the gear stays under original opponent control (they can still Weaponmaster their gear even though it's physically on your unit). On end-of-turn revert recall, the gear detaches and cleanup routes it to its controller's (original owner's) base. |
| `stolenUntilEot` flag approach (from a6-ui-revert.md) vs `hostileTakeoverRevert[]` registry (from a6-card-handlers.md) | **INCONSISTENCY between dossiers.** The engine dossier uses a `MatchState.hostileTakeoverRevert[]` array; the UI dossier uses a per-card `stolenUntilEot?: boolean` flag on `EngineCard`. These must be reconciled to a single approach. The per-card flag approach is simpler and avoids a separate registry; the MatchState array approach avoids polluting EngineCard. Either works but implementer must pick one consistently. |
| `controlledBy` field on `EngineCard` (from a6-ui-revert.md) vs direct `u.owner` mutation (from a6-card-handlers.md) | **FUNDAMENTAL INCONSISTENCY between dossiers.** The engine dossier says "there is no `controlledBy` field" and uses direct `u.owner` mutation. The UI dossier proposes adding `controlledBy?: PlayerId` to `EngineCard` and using `controllerOf(u) = controlledBy ?? owner`. The engine refactor map dossier also adds `controlledBy`. The card-handlers dossier is the outlier — it contradicts the other two. **The `controlledBy` field approach is the correct one** because it keeps `u.owner` immutable (per 107.1.d principle) and separates control from ownership. The card-handlers dossier's `u.owner` mutation model causes the wrong player's trash to be used when a stolen unit dies mid-steal under Hostile Takeover if owner is mutated (the unit would die to the thief's trash, violating 107.1.d). |

**Correct Hostile Takeover behavior:**
1. Set `u.controlledBy = controller` (do NOT mutate `u.owner`).
2. Set `u.stolenUntilEot = true` (or register in `hostileTakeoverRevert[]`).
3. Gear attached to the unit: leave as-is, no control change (Rule 718.5.f).
4. Ready the unit.
5. Call `recomputeControllers(s)` (counting by `controlledBy ?? owner`).
6. `showdownOrConquerAfterEffectMove(s, bfIndex, u.iid, priorCtrl)` — ensure this path starts a noncombat showdown even when no other enemies present (per SFD FAQ).
7. At END_TURN: clear `u.controlledBy`, clear `u.stolenUntilEot`; recall the unit to `s.players[u.owner].zones.base` (owner's base — because once `controlledBy` is cleared, controller = owner, so recall correctly routes to owner's base).
8. If the stolen unit **dies during the steal period** (before revert): because `u.owner` was never mutated, death routing `sendToTrash(s.players[u.owner], u)` correctly sends it to the real owner's trash. Remove its `hostileTakeoverRevert` entry so end-of-turn revert skips it.

---

#### Akshan - Mischievous — Errors & Corrections

| Claim | Verdict |
|---|---|
| Card id `sfd-109-221`, no alternates | **CONFIRMED.** |
| Steal an enemy gear; attach if Equipment; place in base if not Equipment | **CONFIRMED** — matches card text "move an enemy gear to your base. … If it's an Equipment, attach it to me." |
| Gear `owner` field: safe to leave at original owner since gear doesn't affect recomputeControllers | **CORRECT.** Gear never participates in `recomputeControllers` (only `bf.units` are counted). |
| On-leave revert: revert to original owner's base | **CONFIRMED** by community rulings: "Once Akshan leaves play, control of the equipment returns to its original owner." Gear goes to the original owner's base (per Rule 149.3: recalled unattached gear → controller's base; after control reverts, controller = original owner). |
| Four leave-play paths must all call `revertAkshanStolenGears` | **CONFIRMED and CRITICAL.** The dossier correctly identifies fireDeaths, bounceUnitToHand, recallToBase, sendUnitToBase as all requiring the hook. A fifth path is also possible: sandbox OVERRIDE 'move' via `pluckCardAnywhere` — the UI dossier flags this. |
| `gearCardId` must be stored in the registry entry | **CONFIRMED** — the dossier catches its own bug correctly. |
| Akshan steal target: "move an enemy gear to your base" | **TARGET SCOPE.** Card text says "an enemy gear" — this targets ONE gear. Target can be attached to a unit OR unattached in enemy base (confirmed by community ruling: "Akshan can take control of an equipment that is already attached to an enemy unit"). |
| If Akshan is recalled (not died): does control revert? | **YES — confirmed** by community ruling: "Does Akshan return stolen gear when recalled?" = yes, "until I leave the board" applies to all exit paths including recall. The dossier confirms this. |
| The dossier's `revertAkshanStolenGears` helper has a placeholder for `gearCardId` in the EngineCard reconstruction | **BUG** — the code stub at line 388-396 has `cardId: ''` placeholder. Implementer must ensure the registry entry stores `gearCardId` (the dossier notes this, but the stub still has the bug). |

**Correct Akshan behavior:**
1. On play with `paidAdditional`: pick one enemy gear (attached or unattached).
2. Remove from original location (detach from host's `attached[]` or remove from enemy base).
3. Register `{ gearIid, gearCardId, originalOwner, akshanIid }` in `MatchState.akshanStolenGears[]`.
4. If Equipment: add to Akshan's `attached[]` and fire equip triggers.
5. If non-Equipment: push to Akshan-player's base as unattached gear.
6. Gear `owner` field: leave as original owner (or set to Akshan's player — either is fine since gear doesn't affect recomputeControllers, but tracking original owner separately in the registry is the dossier's approach and is cleaner).
7. On Akshan leaving play (any path): call `revertAkshanStolenGears(s, akshanIid)` — detach gear from wherever it is, push to `s.players[originalOwner].zones.base`.

---

### 2.3 UI Revert Dossier (a6-ui-revert.md)

| Claim | Verdict |
|---|---|
| Add `controlledBy?: PlayerId` to `EngineCard` | **CONFIRMED as the correct approach** — consistent with engine refactor map dossier; resolves the contradiction with card-handlers dossier's owner-mutation model. |
| `recomputeControllers` must count `controlledBy ?? u.owner` | **CONFIRMED.** |
| Badge `☠C` top-right, `bg-fuchsia-600/90`, suppresses `opacity-90` dim | **Reasonable UI design** — no rules-level concern. |
| Hostile Takeover revert: at END_TURN, splice stolen units from bf, push to `players[u.owner].zones.base` exhausted | **CONFIRMED** for the routing (after `controlledBy` is cleared, owner's base is correct). But: the code snippet calls `recallToBase` in the engine dossier vs. a direct push in the UI dossier — the two must be reconciled to one approach. |
| `stolenUntilEot` flag on `EngineCard` vs `hostileTakeoverRevert[]` registry | **Same inconsistency flagged above** — pick one. |
| `pendingChoice.kind = 'stealUnit'` options built from enemy units at that battlefield | **CONFIRMED** — Hostile Takeover targets an enemy unit at A battlefield (the battlefield where the spell resolves or the Hidden card was revealed from). |
| `pendingChoice.kind = 'stealGear'` options include attached AND unattached enemy gear | **CONFIRMED** — Akshan can target gear attached to a unit (confirmed by ruling) OR unattached gear in enemy base. |

---

## Part 3 — Final Corrected Behavior Specs

### Possession (`ogn-203-298`)

**Trigger:** `resolveSpellEffects` bespoke block, `card.id === 'ogn-203-298'`.

**Correct behavior:**
1. Validate target: an enemy unit at a battlefield (requires `pendingChoice.kind = 'stealUnit'` picker, or auto-pick).
2. Detach all gear from the stolen unit — each detached gear card remains under the **original opponent's control** (Rule 718.5.f); push each detached gear to `s.players[gear.owner].zones.base` (gear owner = original opponent; rule 149.3 says recalled to controller's base, and after detach the controller is still the original owner).
3. **Permanently** set `u.owner = controller` (or equivalently, set `u.controlledBy = controller` and never revert — for a permanent steal, owner-mutation is equivalent and simpler, and avoids needing to track a forever-permanent `controlledBy`).
4. Remove unit from battlefield.
5. Push to `s.players[controller].zones.base` exhausted (recall to new controller's/owner's base — Rule 428; after mutation these are the same player).
6. Call `recomputeControllers(s)`.
7. Log.

**No end-of-turn revert. No gear transfer. Attached gear stays with original opponent.**

---

### Hostile Takeover (`sfd-202-221`)

**Trigger:** `resolveSpellEffects` bespoke block, `card.id === 'sfd-202-221'`. Also: END_TURN revert pass.

**Correct behavior (on cast):**
1. Validate target: an enemy unit at a battlefield (that battlefield specifically — Hostile Takeover is Hidden and resolves at the battlefield where it was revealed). Use `pendingChoice.kind = 'stealUnit'` if not auto-resolved.
2. Set `u.controlledBy = controller` (do NOT mutate `u.owner`).
3. Set `u.stolenUntilEot = true`.
4. Gear on stolen unit: **no change to gear control** (Rule 718.5.f). Original gear-controller keeps control. Do not touch gear.
5. `u.exhausted = false` (card text: "Ready it").
6. Call `recomputeControllers(s)` (counting by `controlledBy ?? owner`).
7. `showdownOrConquerAfterEffectMove(s, bfIndex, u.iid, priorCtrl)` — must open a noncombat showdown if no other enemies remain (per SFD FAQ: "you have to have some kind of showdown before you can conquer").

**Correct behavior (END_TURN revert):**
1. Collect all units where `u.stolenUntilEot === true`.
2. Clear `u.controlledBy = undefined`, `u.stolenUntilEot = undefined`.
3. Remove from current battlefield (the unit may have moved or been at a different BF post-combat).
4. Push to `s.players[u.owner].zones.base` with `exhausted: true, damage: 0` (card text: "recall it at end of turn"; after clearing `controlledBy`, controller = owner, so Rule 428 routes to owner's base correctly).
5. Call `recomputeControllers(s)`.
6. Gear that rode on the stolen unit: already remained under original owner control throughout; when unit returns to base, any gear that detached at BF was already handled by cleanup (Rule 149.3).

**If stolen unit dies before end of turn:**
- `sendToTrash(s.players[u.owner], u)` — correct (owner's trash, Rule 107.1.d).
- Remove from `hostileTakeoverRevert[]` / clear `stolenUntilEot` so end-of-turn pass skips it.

---

### Akshan - Mischievous (`sfd-109-221`)

**Trigger:** `if (paidAdditional)` block inside PLAY_UNIT, bespoke check for `card.id === 'sfd-109-221'`.

**Correct behavior (on play with paid additional cost):**
1. Build options: all enemy gear across all players — both attached to units and unattached in enemy base. Use `pendingChoice.kind = 'stealGear'` picker (or auto-pick first/only gear).
2. Remove gear from its current location (detach from `host.attached[]` or splice from enemy `zones.base`).
3. Register `{ gearIid, gearCardId, originalOwner, akshanIid: ci.iid }` in `MatchState.akshanStolenGears[]`.
4. Change `gear.owner = action.player` (for consistency — gear owner now = Akshan's player who controls it).
5. If Equipment: add `${gearCardId}|${gearIid}` to Akshan's `attached[]`, fire equip triggers.
6. If non-Equipment: push to `s.players[action.player].zones.base` unattached.
7. No effect on `recomputeControllers` (gear doesn't participate).

**Correct behavior (Akshan leaves play — all four paths):**
Call `revertAkshanStolenGears(s, akshanIid)` immediately after the unit is removed from its location:

```
for each entry in akshanStolenGears where akshanIid matches:
  - find gear wherever it is (Akshan's attached[], Akshan-player's base, or wherever it was moved)
  - remove from current location
  - push to s.players[entry.originalOwner].zones.base (unattached, not exhausted)
  - remove entry from akshanStolenGears[]
```

Required call sites: `fireDeaths`, `bounceUnitToHand`, `recallToBase`, `sendUnitToBase` (and sandbox `pluckCardAnywhere` path).

**`akshanStolenGears` entry type (final):**
```typescript
{ gearIid: string; gearCardId: string; originalOwner: PlayerId; akshanIid: string }
```
`gearCardId` is mandatory — needed to reconstruct the EngineCard on return.

---

## Part 4 — Prioritized Discrepancy List for Implementer

### CRITICAL (rules-breaking if wrong)

1. **Recall routing is controller's base, not owner's base (Rule 428).** The card-handlers dossier's `recallToBase(s, u)` function (line 3082) routes to `s.players[u.owner].zones.base`. This is correct only because the dossier also mutates `u.owner` before calling it. If the implementation switches to the `controlledBy` model (keeping `u.owner` immutable), `recallToBase` must be updated to use `controllerOf(u)` (i.e., `u.controlledBy ?? u.owner`), not bare `u.owner`. All callers of `recallToBase` must be verified.

2. **Attached gear does NOT change control when a unit is stolen (Rule 718.5.f).** Neither the Possession handler nor the Hostile Takeover handler in the card-handlers dossier mentions this. Both must: (a) leave attached gear's controller/owner unchanged, and (b) during Possession's recall, detach the gear and route it back to the original opponent's base separately from the unit. The UI dossier is also silent on this.

3. **`u.owner` mutation model (card-handlers) conflicts with `controlledBy` field model (engine refactor + UI dossiers).** For Hostile Takeover specifically: mutating `u.owner` means that if the stolen unit dies mid-steal, `sendToTrash(s.players[u.owner], u)` would route to the thief's trash — a 107.1.d violation. The `controlledBy` field model (keeping `u.owner` immutable) is the correct approach. Possession's permanent steal is exempt from this concern because after permanent capture the unit truly belongs to the caster; owner mutation is acceptable there.

### SIGNIFICANT (incorrect game behavior)

4. **Hostile Takeover — noncombat showdown when no enemies remain.** The SFD FAQ explicitly states a noncombat showdown must occur even if no other enemies are present. `showdownOrConquerAfterEffectMove` must handle the case where the stolen unit is now the only unit at the battlefield (conquer should only happen AFTER that noncombat showdown concludes, not immediately).

5. **Hostile Takeover stolen unit dying: must clean up revert registry.** If the stolen unit dies before end of turn, its `stolenUntilEot` / `hostileTakeoverRevert[]` entry must be cleared so the revert pass doesn't try to recall a dead unit.

6. **Akshan's gear steal: can target gear attached to a unit (confirmed by ruling).** The gear search in the dossier correctly includes attached gear — this is confirmed correct. But the dossier's `revertAkshanStolenGears` stub has `cardId: ''` placeholder (unfinished). This will crash on return if not completed.

### MINOR (inconsistency / design debt)

7. **Two dossiers disagree on revert data model** (per-card `stolenUntilEot` flag vs. `MatchState.hostileTakeoverRevert[]` registry). Pick one and document the choice.

8. **Possession target scope ("at a battlefield" — which one?).** The card text says "at a battlefield" (singular) but doesn't name one. Verify whether this means: (a) any battlefield on the board (the dossier's auto-pick-across-all approach), or (b) a specific battlefield contextual to where the Action was played. Most Action spells in Riftbound can target any battlefield; this is likely fine.

9. **`revertAkshanStolenGears` must be called from the sandbox `pluckCardAnywhere` override path.** The UI dossier mentions this; the engine dossier does not list it as a required call site.

---

## Sources

- [Riftbound Rules Hub](https://riftbound.leagueoflegends.com/en-us/rules-hub/) — official PDF listing (last updated 3/30/26)
- [Riftbound Comprehensive Rules — rules.flexslot.gg](https://rules.flexslot.gg/rulebook) — Rule 107.1.d, Rule 428
- [riftrules.com core rules reference](https://riftrules.com/?r=rule&slug=core-rules) — Rules 126.1, 182.1/3, 107.1.d, 107.5.d, 107.6.f, 144.3
- [jeff425 hyperlinked CR](https://jeff425.github.io/hyperlinked-rb-cr/) — Rules 056, 056.1, 056.2, 127.1, 149.3, 188.1/3
- [riftboundfaq.com — Equipment](https://www.riftboundfaq.com/mechanics/equipment) — Rule 718.5.f, gear control on unit-control change
- [Riftbound Spiritforged FAQ](https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/riftbound-spiritforged-faq/) — Hostile Takeover noncombat showdown ruling
- [Unleashed Rules FAQ and Clarifications](https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/unleashed-rules-faq-and-clarifications/) — control of battlefields, chain rules
- [RiftboundReport on X](https://x.com/RiftboundReport/status/2027337877307166829) — Akshan gear revert on leave ruling
- [Riftbound Rules & FAQs Facebook group — Akshan recall](https://www.facebook.com/groups/riftboundrulesandfaqs/posts/2075617529953096/) — "Does Akshan return stolen gear when recalled?" ruling
- [Riftbound Spiritforged Errata](https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/riftbound-spiritforged-errata/) — set errata reference

---

## 4-Line Summary

1. **Top confirmations:** Rule 107.1.d (owner's trash/hand/banish is absolute and the engine's ~22 MUST-KEEP-owner sites for those zones are correct); Rule 718.5.f (gear control does not change when a unit changes control — confirmed by riftboundfaq.com); Hostile Takeover noncombat-showdown-even-with-no-enemies (Spiritforged FAQ); Akshan gear revert on all exit paths including recall (community ruling confirmed).

2. **Most important discrepancy #1 — Recall routing:** Rule 428 says recall goes to the **controller's base**, not the owner's base. The card-handlers dossier's `recallToBase` at line 3082 routes to `u.owner`'s base. This is correct only incidentally (because the dossier also mutates `u.owner`). If the implementation uses the `controlledBy` field (keeping `u.owner` immutable — the correct approach per 107.1.d logic), `recallToBase` must be patched to use `controllerOf(u)`.

3. **Most important discrepancy #2 — Gear control during steal:** Neither the Possession nor Hostile Takeover handler in the card-handlers dossier accounts for Rule 718.5.f. Stealing a unit does NOT steal its attached gear. During Possession, gear must be detached and returned to the original owner's base separately. The Hostile Takeover handler must leave gear control untouched for the steal's duration. This is a complete omission in both the card-handlers and UI-revert dossiers.

4. **Most important discrepancy #3 — `u.owner` mutation vs `controlledBy` field:** The card-handlers dossier mutates `u.owner` directly for Hostile Takeover's temporary steal. This causes a 107.1.d violation if the stolen unit dies mid-steal (it goes to the thief's trash instead of the real owner's trash). The correct implementation is the `controlledBy?: PlayerId` field approach used in the engine refactor map and UI dossiers — keep `u.owner` immutable, add `controlledBy`, use `controllerOf(u) = controlledBy ?? owner` everywhere. The card-handlers dossier must be revised to match.
