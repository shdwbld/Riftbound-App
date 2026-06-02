# Card & battlefield interactions

The interaction types found in the card pool, whether they're **passive**
(always-on / conditional) or **active** (a thing you do), and whether the engine
currently handles them. ✅ works · ◑ partial · ⏳ not yet.

## Might interactions
| Interaction | Passive / Active | Status | Notes |
|---|---|---|---|
| **Assault X** (+X while attacking) | Passive (combat) | ✅ | keyword, applied in combat |
| **Shield X** (+X while defending) | Passive (combat) | ✅ | keyword, applied in combat |
| **Gear "+N Might"** | Passive (attached) | ✅ | parsed from attached gear text |
| **Backline** (no frontline Might) | Passive | ✅ | contributes 0 in combat |
| **Buff (+1 counter)** | Active → persistent | ◑ | `EngineCard.buffs` adds to Might; auto-applied by "buff a unit here" battlefields. Card effects that grant buffs need targeting UI. |
| **"+N this turn"** | Active, temporary | ◑ | `EngineCard.tempMight` adds to Might and clears at end of turn; applying it from a card needs targeting UI. |
| **"−N Might" debuff** | Active | ◑ | same `tempMight`/`buffs` (negative); needs targeting UI to apply. |
| **Mighty** (≥ threshold trigger) | Passive condition | ⏳ | not evaluated |
| **Level N / Legion** (conditional buff) | Passive condition | ⏳ | parsed as keywords, effect not applied |

**Engine model:** effective Might =
`printed − damage + gear + buffs + tempMight + (attacking? Assault) + (defending? Shield)`,
floored at 0; Backline → 0.

## Battlefield passives
Grouped by trigger. Auto = engine resolves it; Manual = logged for the player.
| Battlefield example | Trigger | Effect | Status |
|---|---|---|---|
| Aspirant's Climb | Static | +1 to points-needed-to-win | ✅ auto (at setup) |
| Grove of the God-Willow | On hold | draw 1 | ✅ auto |
| Altar to Unity | On hold | play a Recruit | ✅ auto |
| Startipped Peak | On hold | channel 1 | ✅ auto |
| Navori Fighting Pit | On hold | buff a unit here | ✅ auto (first friendly unit) |
| The Candlelit Sanctum | On conquer | look at / draw | ◑ draw approximated |
| Targon's Peak | On conquer | ready 2 runes | ⏳ manual (logged) |
| Sigil of the Storm | On conquer | recycle a rune | ⏳ manual (logged) |
| Fortified Position | On defend | a unit gains Shield 2 | ⏳ manual (logged) |
| Reaver's Row | On defend | move a unit to base | ⏳ manual (logged) |
| Back-Alley Bar | On move-from | +1 this turn | ⏳ manual (logged) |
| Hallowed Tomb | On hold | return Chosen Champion from trash | ⏳ manual (logged) |
| Obelisk of Power | First Beginning | channel 1 | ⏳ manual (logged) |

**What's auto now:** static win-delta, and on-hold / on-conquer clauses that
reduce to draw / channel / play-a-recruit / buff-a-unit. Targeted, movement, or
bespoke clauses are surfaced in the log ("resolve manually").

## How to extend
- Buff/tempMight already affect combat — wiring a **targeting picker** lets card
  effects apply them to a chosen unit (currently only battlefield-driven buffs
  auto-apply).
- More battlefield triggers (on-defend, on-move) can be added the same way once
  targeting and movement hooks exist.
