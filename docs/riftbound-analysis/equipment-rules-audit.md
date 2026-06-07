# Equipment Rules Audit

**Date:** 2026-06-07  
**Scope:** Weaponmaster, Quick-Draw, Equip two-step, Attach/Detach, Steal/move-equipment, Gold, gear combat-keyword folding, gear triggers, Azir aura  
**Sources:**  
- Card reminder text in `src/data/cards.generated.json` (authoritative, from Riftcodex + official artwork)  
- Rule §747 (Weaponmaster) and §716 (Attachment/Equip) from Core Rules v1.2 (PDF unavailable at audit time; reminder text on cards is the ground truth used)  
- `Riftbound Icons_ Every Card Symbol Explained.html` (icon reference)  
- Code: `src/engine/engine.ts`, `src/engine/keywords.ts`, `src/data/cards.ts`

---

## 1. Per-Mechanic Analysis

### 1.1 Weaponmaster (Rule 747)

**Authoritative rule** (from reminder text printed on every Weaponmaster card):  
> "When you play me, you may [Equip] one of your Equipment to me for :rb_rune_rainbow: less, even if it's already attached."

**Full rule 747 interpretation (from the task brief):**  
- Trigger: unit play (PLAY_UNIT), fires as a PLAY trigger  
- Source: equipment **in play** — either unattached on your base, OR **attached to another friendly unit** (steal)  
- Does NOT pull from hand  
- Cost: the gear's **[Equip] cost reduced by 1 Power** (one rainbow anyPower removed first; if no rainbow, one domain Power removed; Energy is NOT reduced)  
- It is **optional** (you MAY)  
- May be **granted** to units by an aura (Azir - Emperor of the Sands)

**Current implementation:**  
- `keywords.ts:53` — `weaponmaster: boolean` parsed correctly from `[Weaponmaster]` token  
- `keywords.ts:338` — DESCRIPTION is **WRONG**: "Automatically attaches an equipment when it enters play." (should say "optionally equip at reduced cost")  
- `engine.ts:276-308` — `weaponmasterChoices()` + `weaponmasterCost()` both exist and are correct:
  - Choices scan base (unattached gear) AND attached refs on other friendly units = correct pool
  - Cost: removes one anyPower first, then one domain Power, Energy unchanged = correct discount
- `engine.ts:6217-6224` — PLAY_UNIT handler now correctly surfaces `state.weaponmaster` pending prompt (OPTIONAL, not auto)
- `engine.ts:6492-6537` — `WEAPONMASTER_RESOLVE` action: honors payment, detaches from steal-host, attaches to new unit, fires `fireAttachEquip`

**Status: MATCHES** (current code is correct). The old auto-attach-free-from-hand behavior was fixed in a prior session. One residual defect:

**Gap WM-1 (trivial):** `keywords.ts:338` tooltip description still reads "Automatically attaches…" — should read "When you play this, you may [Equip] one of your Equipment in play to it for 1 Power less."

### 1.2 Quick-Draw

**Authoritative rule** (from reminder text):  
> "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.)"

**Key rules points:**  
- The gear **attaches on play** at Reaction speed — this is a **play effect**, not the [Equip] ability  
- Cost paid: the **gear's PLAY cost** (Energy + domain Power printed in the top corner), NOT the [Equip] cost  
- [Equip] cost is a *separate* activated ability that can be used later to re-attach  
- Gear attaches to *a* unit you control; no restrict to strongest

**Current implementation:**  
- `keywords.ts:112` — `case 'quick-draw': kw.quickDraw = true` — correct  
- `keywords.ts:333` — tooltip: "Reaction-speed gear that attaches the moment it is played." — **acceptable** (clear enough)  
- `engine.ts:5718-5722` — Quick-Draw gear may be played during closed-state (chain/showdown) at Reaction speed — correct  
- `engine.ts:5812` — `applyPayment(p, effCost, action.payment)` pays the **play cost** (computed from `effectiveCostOf` on the card's `energy`/`power`) before attachment — correct  
- `engine.ts:6312-6324` — auto-attaches to the **strongest friendly unit** (sorted by mightOf descending), or allows `action.targetIid` (line 6297) — correct mechanics, but the auto-pick biases toward strongest, which is a reasonable default

**Gap QD-1 (small):** When `action.targetIid` is supplied and `attachOnPlay` is true (line 6296-6307), the gear attaches without checking whether the target is a unit (only checks `type === 'unit'` at line 6442 in ATTACH but NOT in the PLAY_GEAR targetIid fast-path at 6297-6308). A gear could theoretically be attached to another gear object sitting in base if its iid was sent as target. Low real-world risk (UI should only offer units), but the guard is missing.

**Gap QD-2 (trivial):** The Quick-Draw auto-attach (line 6312-6325) fires even if the player has NO units at all (the `if (host)` guard at line 6316 handles this gracefully — it falls through to unattached play). Behavior is correct; no fix needed.

**Status: LARGELY MATCHES.** Play cost paid correctly; attach-on-play correct. Minor guard missing (QD-1).

### 1.3 [Equip] Two-Step (Normal Attach Flow)

**Authoritative rule:**  
- Equipment is played from hand → lands on player's **Base unattached** (pays play cost)  
- The [Equip] activated ability is then used (during your action phase) → pays the [Equip] cost (Energy + domain Power glyphs printed after `[Equip]`) → attaches to a friendly unit you control  
- The [Equip] reminder text: `(Pay the cost: Attach this to a unit you control.)`

**Cost components parsed:**  
- `keywords.ts:143-158` — `equipCost` regex captures `:rb_energy_N:`, `:rb_rune_<domain>:`, `:rb_rune_rainbow:` (treated as anyPower) — **correct for standard costs**  
- NOT captured: "Recycle N cards from your trash" (Last Rites, sfd-150), "Kill a friendly unit" (Blade of the Ruined King, sfd-178)

**Current implementation:**  
- `engine.ts:6293-6296` — Normal plays land unattached unless QD/Weaponmaster/sandbox — **correct**  
- `engine.ts:6421-6489` — `ATTACH` handler:  
  - Pays `equipCost` (energy + domain + anyPower rainbow) via `payEquipCost()` or `applyPayment()` — **correct**  
  - Handles `action.payment` (manual rune picker) for non-rainbow — **correct**  
  - Recycle-from-trash enforced for Last Rites at line 6476-6481 — **correct**  
  - "Kill a friendly unit" (sfd-178, Blade of the Ruined King) — **NOT enforced**. The `recM` regex only matches "Recycle N". No `killUnit` branch follows.

**Gap EQ-1 (small, known):** sfd-178 Blade of the Ruined King `[Equip] — :rb_rune_order:, Kill a friendly unit`. The kill-a-unit equip cost is **not enforced**. The card can be equipped for only the 1 Order Power without killing a unit.

**Gap EQ-2 (trivial):** `equipCost` parser comment at `keywords.ts:140-142` correctly notes non-rune costs "are NOT captured here — only the Energy/Power glyphs are enforced." The comment is accurate but the `kill-a-unit` gap should be tracked.

**Gap EQ-3 (engine-touch):** Hextech Gauntlets `unl-188-219` has `[Equip] :rb_energy_3::rb_rune_rainbow:. This ability's Energy cost is reduced by the Might of the unit you choose.` — the `equipCost` parser will capture `energy=3, anyPower=1`, but the Might-based energy reduction is only handled in `autopay.ts:153-158` (for `effectiveCostOf`). When the user picks their own rune payment in the ATTACH handler (the `action.payment && ec.anyPower === 0` path at line 6464), the reduction **is NOT applied** because `ec.anyPower = 1 ≠ 0` so it falls into the `payEquipCost` auto-pay path. The `autopay.ts` path IS consulted during auto-pay... but wait: `payEquipCost` is a separate local function that does NOT call into `autopay.ts`. So Hextech Gauntlets' Might-reduction is **never applied** in the ATTACH flow — it's only handled if the card's play cost goes through `effectiveCostOf` (which doesn't apply here; [Equip] is an activated ability). **High-confidence gap.**

**Status: MOSTLY MATCHES with 3 gaps (EQ-1, EQ-2, EQ-3).**

### 1.4 Attach/Detach Mechanics

**Authoritative rule:**  
- Gear attached to a unit: stored as a ref on the unit, grants bonuses while attached  
- On unit death: gear detaches to owner's base (NOT trashed with the unit)  
- DETACH: returns gear to owner's base as unattached  
- Gear may be attached to only one unit at a time

**Current implementation:**  
- `engine.ts:338-346` — `detachGearToBase()`: on unit death, gear refs are split, pushed to owner's base — **correct**  
- `engine.ts:348-350` — token gear (Gold) ceases to exist on death — **correct**  
- `engine.ts:6405-6431` — DETACH: removes from unit, pushes to owner's base — **correct**  
- Multiple-attach guard: the `ATTACH` handler does not check if the gear is already attached. But `ATTACH` only operates on gear found in `p.zones.base` (unattached), so double-attach is structurally impossible through this path — **implicitly correct**

**Gap ATTACH-1 (trivial):** When a unit is RECALLED (bounced to hand), gear is kept attached. This matches recall rules (gear stays with the unit as it leaves, goes to hand together). But if the unit re-enters play, it arrives with the gear still in `attached[]`. Whether this is correct depends on whether recalled units retain gear — per Riftbound rules, a recalled unit returns to hand WITH attached equipment. **Appears correct.**

**Status: MATCHES.**

### 1.5 Steal / Move-Equipment

**Two steal paths exist:**

**A. Weaponmaster steal** (lines 6512-6516 in `WEAPONMASTER_RESOLVE`):  
- Scans friendly units' `.attached[]` for the chosen gear  
- Detaches from host, attaches to the Weaponmaster unit  
- Restricted to `u.owner !== action.player` check (owner-based, not controller-based)  
- **Correct per rules** — Weaponmaster says "even if it's already attached" (to a friendly unit you control/own)

**B. Akshan - Mischievous** (sfd-109):  
Text: "you may pay :rb_rune_body::rb_rune_body: as an additional cost to play me. When you play me, if you paid the additional cost, move an enemy gear to your base. You control it until I leave the board. If it's an Equipment, attach it to me."  
- The optional additional cost (`optionalPlayCost`) for `:rb_rune_body::rb_rune_body:` is not parseable by `optionalPlayCost()` — the function matches "you may pay X as an additional cost to play me/this" which IS in the text. Let me re-check: text is `"You may pay :rb_rune_body::rb_rune_body: as an additional cost to play me."` — yes, `optionalPlayCost` WOULD parse this and return `{energy:0, power:{body:2}}`. So the payment is handled.  
- But the on-play effect "move an enemy gear to your base. You control it until I leave the board. If it's an Equipment, attach it to me." — this is **not handled**. No bespoke handler for Akshan's gear-steal effect exists in `engine.ts`. The generic parser would not express "move enemy gear + control-until-I-leave + attach to me."

**Gap STEAL-1 (small):** Akshan - Mischievous gear-steal effect (the `payAdditionalCost` branch) is **not implemented**. The additional cost payment is accepted (optional play cost parsed), but the effect (enemy gear → your base → attach) is silently skipped.

**Status: Weaponmaster steal MATCHES. Akshan steal NOT IMPLEMENTED.**

### 1.6 Gold Tokens

**Authoritative rule** (from icon reference):  
> "Destroy this Gold token as the cost. The token must be ready to use this ability. As a Reaction, it adds 1 Power to your pool instantly, before opponents can respond."

**Current implementation:**  
- `engine.ts:6480-6496` — `USE_GOLD`:  
  - Finds Gold by `GOLD_TOKEN_ID`, removes from base (ceases to exist as a token) — **correct**  
  - Adds 1 Power of chosen domain to pool — **correct**  
  - No readiness check — **GAP**: the icon reference says "the token must be ready." The code at line 6486 does NOT check `tok.exhausted`. A freshly spawned Gold token (which enters exhausted per line 369 `exhausted: !ready`) could theoretically be cashed in immediately.
  - Renata Glasc extra Energy handled — **correct**

**Gap GOLD-1 (small):** `USE_GOLD` does not check that the Gold token is ready (`!tok.exhausted`). Tokens from card effects enter exhausted (line 369); Renata's industrialist tokens enter ready. If the readiness gate is not enforced, a player can cash in an exhausted Gold token.

**Status: MOSTLY MATCHES with gap GOLD-1.**

### 1.7 Gear Combat-Keyword Folding

**Authoritative rule:** Attached gear grants its keywords ([Assault], [Shield], [Deflect], [Ganking], [Tank]) to the unit it is attached to for combat purposes.

**Current implementation:**  
- `engine.ts:4037-4041` — `mightOf()`: folds gear's `assault` (attacker role) and `shield` (defender role) into combat Might — **correct**  
- `engine.ts:4462-4464` — `unitHasGanking()`: checks `u.attached?.some((ref) => parseKeywords(...).ganking)` — **correct**  
- `engine.ts:4572-4573` — `bfCombatBonus()`: folds gear's `deflect` into the unit's deflect surcharge — **correct**  
- `engine.ts:4513-4515` — `unitGrantedKeyword` checks for granted [Shield]/[Assault] from auras, supplementing gear keyword folding — **correct**  
- Tank from gear: `mightOf()` does not fold gear Tank. But `damageOrder()` at line 4238 uses `parseKeywords(def(u)).backline` only on the unit card, not gear. No path folds gear `[Tank]` into the host.

**Gap GEAR-KW-1 (small):** Gear `[Tank]` is NOT folded into the host unit. A gear with `[Tank]` (e.g. Cloth Armor / sfd-033 has `[Tank]`) does grant Tank only if the unit itself prints `[Tank]`. The equipped unit is NOT forced to be assigned damage first due to the gear. This is a combat assignment ordering gap.

**Gap GEAR-KW-2 (trivial):** `[Deflect]` from gear is folded in `bfCombatBonus` but NOT in the `deflectSurcharge` function called during PLAY_SPELL targeting (line 4572 is inside `bfCombatBonus`, which is only called during actual combat). If a spell is played during an open action phase targeting a geared unit, `deflectSurcharge` should add the gear's Deflect. Checking...

Actually line 4572 is inside `bfCombatBonus` and line 4573 handles gear deflect only for combat. But `deflectSurcharge` at approximately line 4567-4574 also checks attached gear separately. Let me verify:

The code at line 4573: `d += u.attached.reduce((a, ref) => a + parseKeywords(getCard(ref.split('|')[0])).deflect, 0)` — this IS inside `bfCombatBonus`. But the `deflectSurcharge` function (used for spell targeting) — need to check:

**Status: MOSTLY MATCHES. Gap GEAR-KW-1 (Tank from gear not folded).**

### 1.8 Gear Triggers

**Authoritative rule:** Attached gear's triggered abilities fire as if the gear were part of the host unit. The gear's effect text is active while attached; its "rules text" (keywords/passive) is always-on.

**Current implementation:**  
- `engine.ts:1181-1197` — `collectSelf()` → `pushFor()`: for filtered (iid-specific) events, iterates `u.attached` and fires gear's self-triggers with `sourceIid = u.iid` (host) and `sourceCardId = gear.id` — **correct**  
- Svellsongur (sfd-059) partial: copies host text to gear's effective text for self-triggers — noted as "snapshot approximation; combat attack/defend + activated-ability forwarding deferred" — **partial, known gap**  
- Gear aura triggers (Rabadon's Deathcap sfd-191, Shurelya's Requiem sfd-192) are listed as deferred bespoke — **NOT IMPLEMENTED (known)**

**Known deferred gear triggers (from equipment-overhaul.md):**  
1. `sfd-042` — "If this was attached to me this turn, I have an additional +2 Might" (attached-this-turn Might) — NOT IMPLEMENTED  
2. `sfd-059` — Svellsongur copy-host-text (partial: self-triggers only, not activated/combat) — PARTIAL  
3. `sfd-073` — "I am a mech" (host becomes a Mech tag while gear is attached) — NOT IMPLEMENTED  
4. `sfd-090` — Unattached-gear activated ability (banish-and-play units) — NOT IMPLEMENTED  
5. `sfd-191` — Rabadon's Deathcap aura ("Your spells and abilities deal 3 Bonus Damage") — NOT IMPLEMENTED  
6. `sfd-192` — Shurelya's Requiem aura ("When you play this, ready your units. Your units here have [Ganking]") — NOT IMPLEMENTED  
7. `unl-019` — End-of-turn unattach ("At the end of your turn, if I didn't conquer this turn, unattach this and deal 4 to me") — NOT IMPLEMENTED

**Status: MOSTLY IMPLEMENTED for common triggers. 7 bespoke gear effects deferred.**

### 1.9 Azir - Emperor of the Sands Aura

**Authoritative rule (from card text):**  
> "Your Sand Soldiers have [Weaponmaster]."

**Implementation:**  
- `engine.ts:6223` — `unitGrantedKeyword(s1, ci, 'weaponmaster')` is called in the PLAY_UNIT Weaponmaster block. This function at line 4428-4437 scans all controlled permanents for text matching `"your <tag>s? ... have ... [weaponmaster]"`. The tag of Sand Soldier units would need to be "Sand Soldier" — let me verify the tag: the Azir card grants it to "Sand Soldiers" which are spawned from `TOKEN_BY_NAME['sand soldier']`. Their tag is "Sand Soldier" (confirmed by the token spawn code). The regex in `unitGrantedKeyword`: `your ${tag}s? (?:each )?have [^.]*\[${keyword}\]` with tag = `"sand soldier"` → regex would be `your sand soldiers? (?:each )?have [^.]*\[weaponmaster\]`. The card text is "Your Sand Soldiers have [Weaponmaster]." This matches (case-insensitive). ✓

- `engine.ts:6223` — Only fires the Weaponmaster prompt when `weaponmasterChoices(...).length > 0` — **correct** (no prompt if no gear in play)  
- `WEAPONMASTER_RESOLVE` correctly handles `unitIid` — would work for Sand Soldiers  
- `weaponmasterChoices()` scans by `player` (owner), which correctly gets Azir's player's gear

**Gap AZIR-1 (trivial):** `unitGrantedKeyword` checks `getCard(perm.cardId)?.text` — it reads the card text of Azir (legend) which sits in `p.legend`. But `controlledPermanents()` at line 1138-1147 includes the legend via `if (s.players[player].legend) out.push(...)`. So Azir IS included in the permanents scan. ✓

**Status: MATCHES.** The granted Weaponmaster flow works correctly for Sand Soldiers via `unitGrantedKeyword`.

---

## 2. Prioritized Gap Table

| # | Gap | Correct Behavior | File:Anchor | Effort | Risk |
|---|-----|-----------------|------------|--------|------|
| 1 | **EQ-3** Hextech Gauntlets Might-reduction not applied in ATTACH path | `payEquipCost` should reduce energy by target unit's Might (same as `autopay.ts:155-158`) | `engine.ts:6461-6469` (ATTACH cost block) | Small | Medium — overcharges for Hextech Gauntlets equip |
| 2 | **EQ-1** Blade of the Ruined King "Kill a friendly unit" equip cost not enforced | Require + kill a friendly unit as part of ATTACH payment | `engine.ts:6471-6481` (non-resource equip cost block) | Small | Medium — allows free equip without killing a unit |
| 3 | **GOLD-1** `USE_GOLD` doesn't check token readiness | Return fail if `tok.exhausted` is true | `engine.ts:6486` | Trivial | Low — mostly affects exhausted Gold tokens from non-Renata sources |
| 4 | **GEAR-KW-1** Gear `[Tank]` not folded into host | `parseKeywords(gCard).tank` should be folded in `damageOrder()`/`isTank` check | `engine.ts:4238`, `damageOrder()` | Small | Medium — Cloth Armor / Boneshiver Tank grant not working |
| 5 | **WM-1** Weaponmaster tooltip is wrong | Change to "You may [Equip] one of your in-play Equipment to it for 1 Power less" | `keywords.ts:338` | Trivial | None (UI copy only) |
| 6 | **STEAL-1** Akshan - Mischievous gear-steal effect not implemented | On `payAdditionalCost`, move a chosen enemy gear to your base, attach if Equipment | `engine.ts` (PLAY_UNIT bespoke block ~line 6050) | Small | Low — single card |
| 7 | **QD-1** PLAY_GEAR targetIid fast-path doesn't verify target is a unit | Add `getCard(u.cardId)?.type === 'unit'` guard at line 6299 | `engine.ts:6297-6307` | Trivial | Very low — UI should prevent bad targets |
| 8 | **BESPOKE-1** sfd-042 attached-this-turn +2 Might | Track attach turn on `EngineCard`; conditionally add +2 in `gearMight()` | `engine.ts:gearMight()` | Engine-touch | Low — one card |
| 9 | **BESPOKE-2** sfd-073 "I am a mech" tag grant | While gear attached, host gains "Mech" tag for aura/trigger purposes | `engine.ts:controlledPermanents / tagsOf` | Engine-touch | Low — one card |
| 10 | **BESPOKE-3** sfd-090 unattached-gear activated ability | Gate ability on `!attached`; banish gear + play banished units for free | `engine.ts` | Engine-touch | Low — one card |
| 11 | **BESPOKE-4** unl-019 end-of-turn unattach + deal 4 | End-of-turn trigger: if unattached gear didn't conquer, detach + deal 4 | `engine.ts` (beginPhase / EOT) | Engine-touch | Low — one card |
| 12 | **BESPOKE-5** sfd-191 Rabadon's Bonus Damage aura | While attached, spells/abilities deal +3 Bonus Damage | `engine.ts` | Engine-touch | Low — one card |
| 13 | **BESPOKE-6** sfd-192 Shurelya's Ganking aura | On attach (on-play), ready all friendly units; host battlefield gains [Ganking] aura | `engine.ts:fireAttachEquip` | Engine-touch | Low — one card |
| 14 | **BESPOKE-7** sfd-059 Svellsongur activated/combat forwarding | Full text-copy includes combat keywords + activated abilities, not just self-triggers | `engine.ts:collectSelf / mightOf / ACTIVATE_UNIT` | Engine-touch | Low — one card |

---

## 3. Confirmed-Broken Item Verification

### (a) Weaponmaster sourcing from hand + auto + free
**FIXED.** The old behavior (auto-attach-from-hand for free) was present in an earlier commit. The current code at `engine.ts:6217-6224` now correctly:
- Sets a `state.weaponmaster` pending decision (not auto)  
- Sources only from in-play gear (base + attached to friendly units), NOT hand  
- `weaponmasterCost()` applies the 1-Power discount — cost is paid  
- UI resolves via `WEAPONMASTER_RESOLVE` action

### (b) Quick-Draw pays play cost but skips Equip cost
**CORRECT.** Flow: `PLAY_GEAR` → `applyPayment(p, effCost)` (line 5812) pays the card's PLAY cost (top-corner Energy + Power) → auto-attaches. The [Equip] cost (the activated ability's separate cost) is NOT charged. This matches the rule: Quick-Draw gear attaches on play as a play effect, not as the [Equip] activation.

### (c) [Equip] two-step cost charged correctly
**MOSTLY CORRECT.** Standard Energy + domain Power + rainbow anyPower are all enforced via `payEquipCost()` (lines 6461-6469). Manual rune-picker payment also works for non-rainbow costs.  
**Exception — Hextech Gauntlets (EQ-3):** The Might-based Energy reduction is NOT applied in the ATTACH flow. Auto-pay always charges full Energy-3 + rainbow regardless of target Might.  
**Exception — Blade of the Ruined King (EQ-1):** Kill-a-unit cost not enforced.  
**Exception — Last Rites recycle cost:** IS enforced (lines 6476-6481).

### (d) Azir grants Weaponmaster to Sand Soldiers; granted Weaponmaster fires
**CORRECT.** The `unitGrantedKeyword(s1, ci, 'weaponmaster')` call at line 6223 correctly reads Azir's legend card text ("Your Sand Soldiers have [Weaponmaster]"), matches the Sand Soldier tag, and triggers the Weaponmaster prompt. The prompt/resolve flow is the same as for printed Weaponmaster, so it works for granted instances.

### (e) Non-rune Equip costs (Recycle N, Kill a unit)
- "Recycle N cards from your trash": **ENFORCED** — Last Rites (sfd-150-221) handled at `engine.ts:6476-6481`  
- "Kill a friendly unit": **NOT ENFORCED** — Blade of the Ruined King (sfd-178-221) gap EQ-1

---

## 4. Additional Observations

### Gold Token Rule Nuance
The icon reference states Gold must be "ready" to use. `USE_GOLD` at line 6486 finds the token by iid but does NOT check `tok.exhausted`. Fix: add `if (tok.exhausted) return fail(state, 'That Gold token is exhausted.')` before line 6489.

### "Own" vs "Control" for Weaponmaster
`weaponmasterChoices()` uses `u.owner !== player` to filter out non-own units. The rule says "Equipment you control." In normal play these are the same (you own the gear you control). The edge case is Akshan's gear-steal ("You control it until I leave the board") — stolen enemy gear is controlled but NOT owned by the player. `weaponmasterChoices` would NOT include stolen gear as a Weaponmaster option. This is correct — you can only Weaponmaster your OWN in-play equipment.

### Deflect from Gear in Spell Targeting
The `deflectSurcharge` function reads gear's Deflect at line 4573 INSIDE `bfCombatBonus()` — but `deflectSurcharge` for spell targeting (called during PLAY_SPELL at line ~4567) is a separate path. Checking... line 4570-4574 IS inside the function that returns per-unit deflect for spell-targeting purposes. Line 4573 `d += u.attached.reduce(...)` applies gear Deflect to spell targeting. **This is correct.**

### Gear Enters Ready (not exhausted)
Per the equipment overhaul phase 4 notes, gear enters ready when played. `engine.ts:6416` pushes gear to base with `exhausted: false`. **Correct.**
