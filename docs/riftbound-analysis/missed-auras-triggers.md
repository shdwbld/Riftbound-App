# Missed Auras & Triggered Abilities — Engine Audit

**Date:** 2026-06-07  
**Scope:** Read-only engine audit of `src/engine/engine.ts`, `src/engine/triggers.ts`, `src/engine/keywords.ts`, `src/engine/effects.ts`, `src/engine/autopay.ts` vs `src/data/cards.generated.json`.

---

## 1. Priority Table — Fully Missed / Misfiring Cards

Legend for "Wired?" column: **yes** = fully wired, **partial** = fires but condition ignored, **over-fire** = fires too broadly (wrong cards/no cost gate), **no** = never fires.

| # | Card ID | Card Name | Ability Text (condensed) | Wired? | Root Cause | Where It Would Wire | Effort |
|---|---------|-----------|--------------------------|--------|------------|---------------------|--------|
| 1 | `ogn-249-298` | **Volibear - Relentless Storm** | "When you play a [Mighty] unit, you may exhaust me to channel 1 rune exhausted" | **no** | `firePlayTriggers` drops any global play-trigger whose _clause_ contains `exhaust me` (line ~2014). Clause here IS "you may exhaust me to channel…" → silently filtered. No bespoke handler exists (only `Volibear - Furious` is in `skipGenericApply`). | `firePlayTriggers` — add an exhaust-me **opt-in** offer (pendingChoice) for optional-cost triggers, bypassing the blanket filter; wire in `fireTriggers` bespoke under `srcName === 'Volibear - Relentless Storm'` | small |
| 2 | `ogn-158-298` | **Volibear - Imposing** | "When an opponent moves to a battlefield other than mine, draw 1" | **no** | No `TriggerEvent` for "opponent moves". `PATTERNS` list has no pattern matching this text. No bespoke handler anywhere. | Add `'opponentMove'` to `TriggerEvent`; fire it inside the MOVE action handler (engine.ts ~line 3490) for each opponent's unit move; add a PATTERN; wire `drawN` effect in `fireTriggers`. | small |
| 3 | `unl-023-219` | **Katarina - Reckless** (hide) | "When you hide a card, ready me" | **no** | `PATTERNS` has no pattern for "when you hide". The `[Hidden]` placement action fires no trigger hook. | Add `'hide'` to `TriggerEvent`; fire from `HIDE` action; add a PATTERN `when(?:ever)?\s+you\s+hide\b`; `readySelf` parsed by `parseEffectText`. | small |
| 4 | `unl-023-219` | **Katarina - Reckless** (face-down play) | "When you play a card from face down, deal 2 to an enemy unit" | **over-fire** | `firePlayTriggers` gates "from [Hidden]" triggers via `/\bfrom \[?hidden\]?/i`. "from face down" does **not** match this regex → the trigger fires on **every** card play, not only reveals. | Fix the from-hidden regex to also match `from face(-| )down` (or normalise card text to use `[Hidden]`). | trivial |
| 5 | `sfd-121-221` | **Black Market Broker** | "When you play a card from face down, play a Gold gear token exhausted" | **over-fire** | Same root cause as #4: "from face down" ≠ `from [Hidden]` regex → fires for all card plays. | Same fix as #4. | trivial |
| 6 | `sfd-060-221` | **Tianna Crownguard** | "While I'm at a battlefield, opponents can't gain points" | **no** | `"tianna"` does not appear in `engine.ts`. None of the three point-awarding sites (`awardPoints`, `BfApi.score()`, `p.points += e.score`) check for Tianna. No bespoke helper exists. | Add `tiannaCrownguardBlocksScore(s, scorer)` check (analogous to `mageseekerWardenAtBf`) at the top of `awardPoints` and `BfApi.score()`; return without awarding points (or log a block) when an opponent controls Tianna at a battlefield. | small |
| 7 | `unl-041-219` | **Allay, Eager Admirer** | "While I'm at a battlefield, your other units here have [Deflect]" | **no** | `deflectSurcharge` does not check positional `[Deflect]` grants from a co-located unit. `unitGrantedKeywordHere` matches "other **friendly** units here have [keyword]" but Allay's text reads "your other units here have [Deflect]" — the regex requires the word `friendly`. No bespoke check in `deflectSurcharge`. | In `deflectSurcharge`, add a positional check: for each battlefield, if a co-located friendly unit's text matches `/your other units here have \[deflect\]/i`, increment `d` for other friendly units at that battlefield. | trivial |
| 8 | `ogn-084-298` | **Eager Apprentice** | "While I'm at a battlefield, the Energy costs for spells you play is reduced by 1, min 1" | **no** | `effectiveCostOf` (in `autopay.ts`) handles per-tag energy auras and many card-specific reductions, but has **no** pattern for "unit at battlefield reduces spell energy cost". No bespoke check exists. | In `effectiveCostOf`, when `card.type === 'spell'`, scan controlled permanents at _any_ battlefield for `/while i'?m at a battlefield, the energy costs? for spells you play (?:is )?reduced by :rb_energy_(\d+):/i`; subtract the match and enforce minimum of 1. | trivial |
| 9 | `sfd-100-221` | **Yordle Explorer** | "When you play a card with Power cost ≥2 (rainbow/rainbow), draw 1" | **over-fire** | `playTriggerMatches` only parses `:rb_energy_N: or more` (Energy threshold). The `f` noun is `"card"` (stops before `"with"`) → typeOk=true for all cards. The Power-cost threshold is never checked → fires for **every** card played. | Extend `playTriggerMatches` to recognise `/with power cost (?::rb_rune_rainbow:){N} or more/` and count recycled Power pips against the threshold (`playedCost`/power field not currently threaded — needs `playedPower` to be passed). Alternative: add a bespoke name check in `firePlayTriggers`. | small |
| 10 | `unl-011-219` | **Fresh Beans** | "When you play a unit during a showdown, you may exhaust this to draw 1" | **over-fire** | `playTriggerMatches` has no gate for "during a showdown". The trigger fires for all unit plays (including outside showdowns). The "exhaust this" cost is also not deducted (see #11 family). | In `firePlayTriggers`, filter triggers whose text matches `/during a showdown/i` to only fire when `s.showdown != null`. Separately handle the exhaust-this cost if the optional is accepted. | trivial |
| 11 | `unl-109-219` | **Blood Rose** | "When you play a unit, you may pay 1 Energy to gain 1 XP" | **partial** | Trigger fires (global `play` → `unit`). `parseEffectText` extracts `gainXp=1`. `fireTriggers` auto-applies it without deducting the 1-Energy cost. The `optional: true` flag on `TriggeredAbility` is **never read** in `fireTriggers` — no prompt/cost-gate exists for optional-cost triggered abilities. | Mark this trigger as needing a `pendingChoice` offer (pay 1E / skip). General solution: when `ability.optional` is true **and** the clause contains a cost glyph, offer a PaymentModal choice rather than auto-resolving. Bespoke short-term: check for Blood Rose by name, offer the choice, deduct energy. | small |
| 12 | `unl-097-219` | **Kinkou Initiate** | "When you play me, draw 1 if your other units have total Might 5 or more" | **partial** | Self play-trigger fires. `parseEffectText` extracts `draw=1`. The "if your other units have total Might 5 or more" condition is not parsed (no `'totalMight'` condition kind in `EffectCondition`). `conditionMet` returns `true` → draws unconditionally. | Add `'totalMightAtLeast'` condition kind to `EffectCondition`; parse `if your other units have total might (\d+) or more` in `parseEffectText`; implement in `conditionMet` by summing `mightOf` for each other friendly unit. | small |
| 13 | `sfd-143-221` | **Sivir - Mercenary** | "If you've spent ≥2 Power (rainbow/rainbow) this turn, I have +2 Might and [Ganking]" | **no** | No per-turn Power-spent tracking exists in `PlayerState`. `conditionalMight` and `unitHasGanking` have no handler for "spent rainbow/rainbow". The Might bonus is silently 0; [Ganking] is never granted. | Add `powerSpentThisTurn: Partial<Record<Domain, number>>` (or a rainbow-pips tally) to `PlayerState`; update it in `applyPayment`; read it in `conditionalMight` and `unitHasGanking` via a new regex branch. | engine-touch |
| 14 | `unl-181-219` | **Jhin - Virtuoso** | "When you play a spell costing 4+ energy, you may banish it; if four spells banished with me, recycle them, channel 4, draw 1" | **no** | Trigger fires (global `play` → `spell`, cost condition NOT gated — see Revna #15). The effect "you may banish it" has no `ParsedEffect` field; `applyParsed` does nothing. No bespoke handler. The four-spell-counter state also doesn't exist. | Fully bespoke: in `fireTriggers`, check `srcName === 'Jhin - Virtuoso'`; offer a choice to banish the played spell (stored on the Jhin instance as a counter array); when four reach the threshold, recycle them, `channelN(4)`, `drawN(1)`. Needs a `jhinBanished: string[]` field on `EngineCard`. | engine-touch |
| 15 | `unl-005-219` | **Revna the Lorekeeper** | "When you play a spell, if you spent ≥4 Energy (cumulative this turn), ready me" | **over-fire** | Trigger fires for **all** spell plays (playTriggerMatches checks `'spell'` type OK). The "if you spent 4+ energy" clause is not parsed as a condition (no `energySpentAtLeast` condition kind). `readySelf` applies unconditionally → Revna readies on every spell, even cheap ones. | Add `'energySpentOnSpellsAtLeast'` condition kind; parse `/if you spent :rb_energy_(\d+): or more/`; implement in `conditionMet` via `p.energySpentOnSpellsThisTurn` (already tracked). | trivial |

---

## 2. "Deal N Damage Split Among Any Number" — Blast Radius for Free-Counter Change

The following cards contain the phrase "damage split among any number of enemy units here". The main agent is fixing Volibear - Furious's split-damage to use free damage counters (bypassing the lethal-first combat assignment rule). Every card in this list is potentially affected by that primitive change.

| Card ID | Card Name | Full Damage Clause |
|---------|-----------|---------------------|
| `ogn-041-298` | **Volibear - Furious** | "When I attack, deal 5 damage split among any number of enemy units here" |
| `ogn-041a-298` | **Volibear - Furious (Alternate Art)** | Same |

**Audit result:** Only two cards (same card, two printings) carry this exact phrase in the current pool. No other cards use "split among any number" phrasing. The blast radius of the free-counter change is limited to the Volibear - Furious handler.

---

## 3. "When an Enemy Unit Attacks a Battlefield You Control" — Hook Coverage

Cards with this trigger phrase and whether the hook exists:

| Card ID | Card Name | Trigger Text | Hook Exists? | Notes |
|---------|-----------|--------------|-------------|-------|
| `ogn-255-298` | **Ahri - Nine-Tailed Fox** | "When an enemy unit attacks a battlefield you control, give it −1 Might this turn (min 1)" | **yes** | Wired bespokely in `fireCombatTriggers` (~line 4763): reads `playerHasLegend(s, controller, 'Ahri - Nine-Tailed Fox')` and applies `applyTempMight(s, u.iid, -1, 1)` to each attacker. Fires for every attacker, not just one. |
| `ogn-303-298` | **Ahri - Nine-Tailed Fox (Overnumbered)** | Same | **yes** | Same handler (name-matched, art suffix stripped). |
| `opp-255-298` | **Ahri - Nine-Tailed Fox** | Same | **yes** | Same handler. |

**Conclusion:** The "enemy attacks a battlefield you control" hook exists only as a bespoke Ahri legend check inside `fireCombatTriggers`. There is **no generic TriggerEvent** for this pattern. Any future card with this trigger phrase would need its own bespoke handler — or a new `'enemyAttacks'` event added to `TriggerEvent` + `PATTERNS`.

---

## 4. Verified-Wired Auras (Reference — Not Broken)

The following auras/triggers were audited and confirmed correctly wired:

| Card | Mechanism | Engine Location |
|------|-----------|----------------|
| Soul Shepherd — "Your token units have +1 Might" | `auraMightBonus` regex | engine.ts ~4873 |
| Baron Nashor — "Other friendly units have +2 Might" | `auraMightBonus` | engine.ts ~4877 |
| Rumble - Scrapper — "Your Mechs have +1 Might" | `auraMightBonus` | engine.ts ~4875 |
| Lee Sin - Centered — "Other buffed friendly units at my battlefield have +2 Might" | `auraMightHere` | engine.ts ~4565 |
| Garen - Commander — "Other friendly units have +1 Might here" | `auraMightHere` | engine.ts ~4568 |
| Captain Farron — "Other friendly units here have [Assault]" | `unitGrantedKeywordHere` | engine.ts ~4530 |
| Taric - Protector — "Other friendly units here have [Shield]" | `unitGrantedKeywordHere` | engine.ts ~4530 |
| Lillia - Protector of Dreams — "Your token units have [Tank]" | `hasTank` | engine.ts ~4865 |
| Ornn - Forge God — "I have +1 Might for each friendly gear" | `conditionalMight` (feM) | engine.ts ~4436 |
| Petal Pixie — "I have +1 Might for each [Temporary] unit" | `conditionalMight` (feM) | engine.ts ~4438 |
| Crimson Pigeons — "+2 Might while attacking with another unit" | `conditionalMight` | engine.ts ~4477 |
| Trusty Ramhound — "While you have another unit here, I have +1 Might" | `conditionalMight` | engine.ts ~4486 |
| Wielder of Water — "While I'm attacking or defending alone, +2 Might" | `conditionalMight` | engine.ts ~4455 |
| Wizened Elder — "While I'm buffed, additional +1 Might" | `conditionalMight` | engine.ts ~4446 |
| Bilgewater Bully — "While I'm buffed, I have [Ganking]" | `unitHasGanking` | engine.ts ~4542 |
| Fiora - Victorious — "While [Mighty]: [Deflect], [Ganking], [Shield]" | `unitHasGanking`, `deflectSurcharge`, `bfCombatBonus` | engine.ts |
| Master Yi - Meditative — "While you have 8+ runes, +4 Might" | `conditionalMight` | engine.ts ~4420 |
| Magma Wurm — "Other friendly units enter ready" | `friendlyUnitsEnterReadyAura` | engine.ts ~2510 |
| Master Yi - Wuju Master L11 — "Your units enter ready" | `legReadyM` check in PLAY_CARD | engine.ts ~5956 |
| Renata Glasc - Industrialist — "Your tokens enter ready" | `tokensEnterReady` | engine.ts ~2830 |
| Mageseeker Warden — unit-play/ready restrictions | `mageseekerWardenAtBf` / `enemyWardenAtBf` | engine.ts ~2499 |
| Syndra - Transcendent — "While in showdown, your spells have [Repeat]" | `repeatCostFor` | engine.ts ~2896 |
| Ahri - Nine-Tailed Fox — "Enemy attacks your battlefield: −1 Might" | bespoke in `fireCombatTriggers` | engine.ts ~4763 |
| Volibear - Relentless Storm trigger parse | PARTIALLY: `parseTriggers` DOES match it; filtered downstream | see #1 above |
| Forecaster — "Your Mechs have [Vision]" | `unitGrantedKeyword` + Vision check at play | engine.ts ~6262 |
| Azir - Emperor — "Your Sand Soldiers have [Weaponmaster]" | `unitGrantedKeyword` | engine.ts ~4514 |
| Forgotten Library — "When you play a spell, if spent 4+, [Predict]" | `bfScriptAt` `onSpellPlayed` | battlefieldScripts.ts ~123 |
| Prize of Progress — "When you use a gear activated ability, +1 Might" | `fireGearAbilityUse` | engine.ts ~2177 |
| Darius - Trifarian — "When you play your 2nd card, +2 Might, ready me" | `fireSecondCardPlayed` | engine.ts ~2074 |
| Aphelios - Exalted / Jax - Unrelenting — "When you attach an Equipment" | `fireAttachEquip` | engine.ts ~2747 |

---

## 5. Prioritized Fix Queue

**P0 — Fully silenced champion/legend mechanics (high game-play impact):**
1. `#1` Volibear - Relentless Storm (exhaust-me filter kills the whole trigger)
2. `#6` Tianna Crownguard (opponents freely score through her)
3. `#14` Jhin - Virtuoso (entire banish loop never fires)
4. `#13` Sivir - Mercenary (both Might bonus and [Ganking] dead)

**P1 — Over-fires causing wrong game state:**
5. `#4`/`#5` from-face-down filter (Katarina + Black Market Broker fire on all plays)
6. `#11` Blood Rose (free XP every unit play)
7. `#10` Fresh Beans (draws outside showdowns)
8. `#15` Revna the Lorekeeper (readies on cheap spells)
9. `#12` Kinkou Initiate (unconditional draw)

**P2 — Wired but condition or cost never checked:**
10. `#7` Allay, Eager Admirer (Deflect aura invisible to spell targeting)
11. `#8` Eager Apprentice (spell cost reduction never applied)
12. `#2` Volibear - Imposing (opponent-move draw)

**P3 — New event / tracking required:**
13. `#13` Sivir - Mercenary (needs `powerSpentThisTurn` tracking — engine-touch)
14. `#9` Yordle Explorer (needs Power-cost threshold in `playTriggerMatches`)
15. `#3` Katarina hide trigger (needs `'hide'` TriggerEvent)
