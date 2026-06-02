# Riftbound Rules Audit — 4-phase

A line-by-line audit of the Riftbound rules against this engine, then a plan to
close the gaps.

**Sources:** The Phase-1 structure was scaffolded from runesandrift.com (fan
site), then **verified against the official Core Rules v1.2** (Riot, 2025-12-01),
whose full text is saved in this repo at `docs/core-rules-v1.2.txt`. Where the
fan site and the official rules differ, **the official rules win** — see the
"Authoritative addendum (Core Rules v1.2)" at the bottom, which corrects the
keyword glossary, resolves the conflicts, and adds mechanics the fan summary
missed (Bonus Damage, token persistence, Attach system, buff removal).

Status key: ✅ implemented · ◑ partial · ❌ absent. Engine files in `src/engine`.

---

## PHASE 1 — Rule checklist

### §1 Turn structure & phases
| # | Rule | Status | Engine notes |
|---|---|---|---|
| 1.1 | Declare Legend → Legend Zone | ✅ | `setup.buildPlayer` |
| 1.2 | Declare Champion → Champion Zone | ✅ | Chosen Champion set aside |
| 1.3 | Choose 1 of 3 battlefields (Bo1 random / Bo3 choose) | ◑ | each player's 1st BF auto-placed; no random/choose step |
| 1.4 | Shuffle Main & Rune decks separately | ✅ | |
| 1.5 | Draw 4-card opening hand | ✅ | `RULES.openingHand=4` |
| 1.6 | Mulligan ≤2 to bottom, no reshuffle | ✅ | MULLIGAN toBottom |
| 1.7 | No channel during setup; channel at turn start | ✅ | |
| 1.8 | Awaken: ready all owned objects | ✅ | `beginTurn` |
| 1.9 | Awaken: no play/react/score | ✅ | transient |
| 1.10 | Beginning: score 1 per Held BF | ✅ | |
| 1.11 | Beginning: start-of-turn triggers | ◑ | only battlefield-hold + Temporary; no general triggers |
| 1.12 | Channel 2 Ready | ✅ | |
| 1.13 | 2nd player channels 3 on turn 1 | ✅ | |
| 1.14 | Obelisk battlefield +1 rune turn 1 | ❌ | that passive is logged-manual |
| 1.15 | Draw 1 | ✅ | |
| 1.16 | Rune Pool empties end of Draw | ❌ | no floating pool (on-demand resources) |
| 1.17 | Burn Out on empty-deck draw | ✅ | |
| 1.18 | Action: any # of discretionary actions | ✅ | |
| 1.19 | Action: play/activate/move/showdown/conquer | ✅ | |
| 1.20 | Open-only plays; ACTION/REACTION in showdown | ◑ | reaction spells allowed; no Open/Closed model |
| 1.21 | End: "this turn"/"while" effects expire together | ◑ | tempMight/Stun cleared; no general "while" |
| 1.22 | End: clear Marked Damage | ◑ | we clear after each combat instead of EOT |
| 1.23 | End: empty Rune Pool | ❌ | no pool |
| 1.24 | Pass turn | ✅ | |

### §2 Zones
| # | Rule | Status | Notes |
|---|---|---|---|
| 2.1 | Base | ✅ | |
| 2.2 | Battlefield(s) | ✅ | |
| 2.3 | Facedown Zone (1/BF, Hidden) | ❌ | no hidden placement |
| 2.4 | Hand (private) | ✅ | UI-hidden; data shared in netcode ◑ |
| 2.5 | Main Deck (40, bottom recycle) | ✅ | |
| 2.6 | Rune Deck (12, bottom recycle) | ✅ | |
| 2.7 | Legend Zone (permanent, non-interactive) | ✅ | |
| 2.8 | Champion Zone | ✅ | |
| 2.9 | Trash | ✅ | |
| 2.10 | Banishment | ❌ | |
| 2.11 | Token pile | ✅ | |
| 2.12 | Passive/triggered only from Board | ◑ | no general passive system |

### §3 Resources
| # | Rule | Status | Notes |
|---|---|---|---|
| 3.1 | Energy = exhaust any rune | ✅ | |
| 3.2 | Power = recycle domain rune → bottom | ✅ | |
| 3.3 | Rune card type / separate deck | ✅ | |
| 3.4 | Rune Pool empties EOT/Draw | ❌ | no pool |
| 3.5 | Exhaust = spent, no re-exhaust | ✅ | |
| 3.6 | Recycle to bottom (+power for runes) | ✅ | |
| 3.7 | Cost paid in full, no partial | ✅ | |
| 3.8 | Add (Energy/Power to pool), reactable | ❌ | |
| 3.9 | Base vs modified cost | ◑ | printed only; no modifiers |
| 3.10–15 | Six Domains | ✅ | modeled |

### §4 Playing / Chain / states / priority / targeting / counter
| # | Rule | Status | Notes |
|---|---|---|---|
| 4.1 | Declare targets/BF/costs at play | ◑ | no targeting |
| 4.2 | Calculate total cost | ✅ | |
| 4.3 | Pay from pool | ✅ | payment object |
| 4.4 | Verify legality, reverse if invalid | ◑ | |
| 4.5 | Resolve | ✅ | immediate |
| 4.6 | Card text overrides rulebook | ❌ | no scripting |
| 4.7 | Partial instructions resolve as able | ❌ | |
| 4.8 | Play = onto Chain, "played" even if countered | ❌ | no chain |
| 4.9–4.11 | Chain LIFO / Closed state | ❌ | |
| 4.12 | Open State | ◑ | implicit default |
| 4.13 | Closed State | ❌ | |
| 4.14 | Neutral State | ◑ | implicit |
| 4.15 | Showdown State | ✅ | `phase==='showdown'` |
| 4.16 | Priority | ◑ | showdown only |
| 4.17 | Focus (attacker gains first) | ◑ | defender passes first instead |
| 4.18 | Active Player rotation in windows | ◑ | showdown pass loop |
| 4.19–4.20 | Windows of Opportunity / Relevant Players | ◑ | showdown pass loop only |
| 4.21 | Chain Window | ❌ | |
| 4.22 | Showdown Window | ✅ | |
| 4.23 | Targets chosen at play | ❌ | |
| 4.24 | Untargetable ≠ valid choice | ❌ | |
| 4.25 | All-invalid → no execute, still played | ❌ | |
| 4.26 | Re-check targets at resolution | ❌ | |
| 4.27 | Counter (negate; costs spent) | ❌ | |

### §5 Combat / Showdown
| # | Rule | Status | Notes |
|---|---|---|---|
| 5.1 | Showdown trigger on entering contested/empty BF | ✅ | |
| 5.2 | Showdown window | ◑ | pass loop |
| 5.3 | Combat only if both sides present | ✅ | |
| 5.4 | Modifiers: Assault/Shield/Tank | ✅ | designations/triggers ❌ |
| 5.5 | Lethal (damage ≥ Might) → Trash | ✅ | |
| 5.6 | Damage clears end-of-combat & EOT only | ◑ | cleared after each combat (not cumulative) |
| 5.7 | Marked damage ≠ destroyed; killed in cleanup | ◑ | inline |
| 5.8 | Conquer vs Recall | ✅ | both |
| 5.9 | Cleanup after combat | ◑ | partial |

### §6 Scoring & victory
| # | Rule | Status | Notes |
|---|---|---|---|
| 6.1 | Victory Score 8, win immediately | ✅ | (11 multiplayer) |
| 6.2 | Conquer 1/turn/BF; uncontested auto | ✅ | |
| 6.3 | Hold at start of turn | ✅ | |
| 6.4 | Burn Out | ✅ | |
| 6.5 | Card effects grant points | ◑ | BF "gain 1 point" logged-manual |
| 6.6 | 8th-point restriction | ◑ | conquer needs all BFs; hold instant; card-effect n/a |
| 6.7 | Victory Score modifiers (BF → 9) | ✅ | `winDelta` |

### §7 Deckbuilding
| # | Rule | Status | Notes |
|---|---|---|---|
| 7.1 | Main 40 | ✅ | |
| 7.2 | Max 3 copies | ✅ | |
| 7.3 | Rune 12, match legend colors | ✅ | |
| 7.4 | Legend 1, not in deck | ✅ | |
| 7.5 | Champion tag-match, 1 in zone, ≤3 copies | ◑ | tag-match at setup; copy interplay not validated |
| 7.6 | Signature ≤3 per tag, tag-match, not champion-unit | ◑ | ≤3 total enforced; per-tag/tag-match not |
| 7.7 | Domain identity (multicolor both match) | ✅ | |
| 7.8 | Battlefields choose 3, 1 used | ◑ | 3 in deck, 1 placed |
| 7.9 | Token supertype | ✅ | |
| 7.10 | Legality violations flagged | ✅ | `deckValidation` |

### §8 Keywords
| # | Keyword | Status | Notes |
|---|---|---|---|
| 8.1 | Accelerate (enter ready, extra cost) | ◑ | enters ready; extra cost not enforced |
| 8.2 | Action (timing) | ◑ | allowed in showdown |
| 8.3 | Assault X | ✅ | |
| 8.4 | Deathknell | ✅ | recruit deaths auto; generic logged |
| 8.5 | Deflect X | ❌ | parsed not applied |
| 8.6 | Ganking | ✅ | |
| 8.7 | Hidden | ❌ | |
| 8.8 | Legion | ✅ | gating |
| 8.9 | Mighty (≥5) | ◑ | helper only |
| 8.10 | Reaction (timing) | ◑ | allowed in showdown |
| 8.11 | Shield X | ✅ | |
| 8.12 | Tank | ✅ | |
| 8.13 | Temporary | ✅ | |
| 8.14 | Vision | ◑ | logged |
| 8.15–8.24 | Spiritforged: Attach/Detach/Inactive/Top-most/Equip/Quick-Draw/Weaponmaster/Repeat/Gold/Equipment | ◑/❌ | gear attaches + grants Might (◑); the rest ❌ |

### §9 Actions
| # | Action | Status | Notes |
|---|---|---|---|
| 9.3 | Channel | ✅ | |
| 9.4 | Draw | ✅ | |
| 9.5 | Exhaust | ✅ | |
| 9.6 | Ready | ✅ | |
| 9.7 | Recycle | ✅ | |
| 9.8 | Add | ❌ | |
| 9.9 | Reveal | ✅ | REVEAL_TOP |
| 9.10 | Discard (as cost) | ◑ | TRASH_CARD from hand |
| 9.11 | Banish | ❌ | |
| 9.12 | Kill (→ Trash, Deathknell) | ✅ | |
| 9.13 | Recall | ✅ | |
| 9.14 | Stun | ◑ | status applied in combat; no action to apply |
| 9.15 | Buff (max 1) | ✅ | |
| 9.16 | Counter | ❌ | |
| 9.17 | Burn Out | ✅ | |
| 9.18 | Play (onto chain) | ◑ | immediate |
| 9.19 | Activate | ◑ | legend only |
| 9.20 | React | ◑ | showdown only |
| 9.21 | Move (exhausts, once/turn, ready only) | ✅ | once/turn not enforced ◑ |
| 9.22 | Hide | ❌ | |
| 9.23 | Triggered abilities (on chain) | ◑ | fixed set, not on a chain |

### §10 State-based / cleanup
| # | Rule | Status | Notes |
|---|---|---|---|
| 10.1 | Cleanup after chain/move/showdown/combat | ◑ | partial |
| 10.2 | Cleanup tasks (kill, designations, control, expire while, remove hidden, pending) | ◑ | control + kill only |
| 10.3 | Cleanup doesn't clear Marked Damage | ◑ | we clear post-combat |
| 10.4 | Control | ✅ | presence-based |
| 10.5 | Card text overrides rulebook | ❌ | |

**Tally:** ~55 ✅ · ~28 ◑ · ~22 ❌.

**Conflicts to resolve (from the gather):** (a) does a Countered card count as
"played"? (b) Showdown = phase vs state (we use state, correct); (c) first-turn
channel phrasing (we do P2-channels-3, correct).

---

## PHASE 2 — Implementation batches

Grouping the ◑/❌ rules into coherent, dependency-ordered batches.

- **Batch A — Chain / Priority / Focus engine.** 1.20, 3.8, 4.8–4.22, 4.27, 9.8,
  9.16, 9.18–9.20, 9.23, 10.1. *The keystone; most other batches need it.*
- **Batch B — Targeting.** 4.1, 4.23–4.26, 5.4 (designations). *Needs A.*
- **Batch C — General triggered-ability & effect scripting.** 1.11, 4.6, 4.7,
  5.4 triggers, 6.5, 8.9 Mighty-triggers, 10.2 "while" re-eval, 10.5. *Needs A+B.*
- **Batch D — Zones: Banish + Hidden/Facedown.** 2.3, 2.10, 8.7 Hidden, 9.11,
  9.22 Hide. *Needs A (Hidden reveal is a reaction).*
- **Batch E — Resource pool model.** 1.16, 1.23, 3.4, 3.8 Add, 3.9 base-vs-modified.
- **Batch F — Spiritforged attach system.** 8.15–8.24 (Attach/Detach/Equip/
  Quick-Draw/Weaponmaster/Repeat/Gold/Top-most/Inactive-text).
- **Batch G — Standalone fixes (cheap, no A).** 1.3 battlefield draft, 1.14
  Obelisk, 1.22 damage-clear-at-EOT, 5.6/10.3 cumulative damage, 9.10 discard
  cost, 9.14 Stun action, 9.21 move-once-per-turn, 7.5/7.6 deckbuilding refines.
- **Batch H — Conflict resolutions / verification.** Countered-as-played; verify
  rule numbers vs Riot rulebook; Accelerate extra-cost enforcement.

Recommended order: **G → A → B → C → D → E → F** (G is quick wins; A unblocks the rest).

---

## PHASE 3 — Mechanics & state impact (per batch)

### Batch A — Chain / Priority / Focus
- **New state:** `MatchState.chain: ChainItem[]` (LIFO); `chainState: 'open'|'closed'`;
  `priority: PlayerId`; `passes: number`; `windowKind: 'chain'|'showdown'|null`.
- **ChainItem:** `{ kind:'spell'|'ability'|'trigger', controller, cardId/iid, targets?, payment? }`.
- **Flow change:** PLAY_* no longer resolve immediately — they push a ChainItem,
  set `closed`, open a Chain Window, and pass priority round Relevant Players.
  When all pass, pop & resolve the top item (LIFO), run cleanup, repeat until empty
  → `open`. New actions: `PASS_PRIORITY`, `COUNTER(targetChainIid)`, `ADD`.
- **Numbers:** priority rotates `(p+1)%N`; window closes after N consecutive passes;
  Counter removes a ChainItem (costs already paid stay spent).
- **Focus:** attacker gains priority/focus first in a showdown (flip current
  defender-first behavior).

### Batch B — Targeting
- **New:** `ChainItem.targets: string[]`; a pending-target request the UI fills
  before the item goes on the chain. Re-validate targets at resolution; drop
  invalid (4.25/4.26). `Deflect` adds Power to the cost of opponent-target effects.
- **Affects:** spell damage, buffs, gear equip, stun, counter — all become
  target-driven instead of auto/first-unit.

### Batch C — Triggered abilities & effects
- **New:** a trigger registry keyed by event (Play/Conquer/Hold/Attack/Defend/
  Death/StartOfTurn); on event, matching triggers push ChainItems (turn-player
  orders simultaneous ones). A small effect-DSL beyond the current text parser
  (deal/draw/channel/recruit/buff/stun/kill/recall + conditions like Mighty,
  Legion, Level). `EngineCard` may gain `xp` (for Hunt/Level).
- **Affects:** Attack/Defend once-per-combat flags on `ShowdownState`; card-effect
  points (6.5); "while" continuous re-eval in cleanup.

### Batch D — Banish + Hidden
- **New zones:** `PlayerState.banished: EngineCard[]`; per-battlefield
  `facedown?: EngineCard` (or reuse `EngineCard.facedown`). Actions: `BANISH`,
  `HIDE` (recycle 1 power → place facedown), reveal-as-reaction (0 cost).
- **Affects:** Kill vs Banish distinction (Deathknell only on Kill); cleanup
  removes unsupported Hidden cards.

### Batch E — Resource pool
- **New:** `PlayerState.pool: { energy:number, power:Partial<Record<Domain,number>> }`;
  Add/Exhaust/Recycle feed it; emptied at end of Draw and end of turn. Cost
  payment draws from the pool instead of computing per-play. `baseCost` vs
  `modifiedCost` split for cost-check effects (4-step play).

### Batch G — Standalone (no chain)
- Battlefield draft (pick 3 → place 1, random in Bo1): setup + a pick UI.
- Obelisk +1 rune: a first-Beginning battlefield hook (like existing on-hold).
- Damage cumulative across combats; clear only at end-of-combat **and** EOT:
  stop zeroing `damage` after each showdown; add EOT damage clear.
- Stun action `STUN_UNIT`; Discard-as-cost; Move once-per-turn (`movedThisTurn`
  flag on `EngineCard`); deckbuilding signature-per-tag + champion copy rules.

---

## PHASE 4 — UI changes (per batch)

### Batch A (Chain/Priority)
- **Chain stack panel** showing pending items top→bottom, whose priority it is,
  and pass/respond controls. Wire hotkeys **A (approve/pass), S (resolve top)**.
- **Counter** affordance on chain items (a "Counter" button on reaction spells).
- Replace the single showdown "Pass" with a general priority "Pass / hold
  priority" control usable in both Chain and Showdown windows.

### Batch B (Targeting)
- **Targeting mode:** after choosing a spell/ability that needs a target, the
  board highlights legal targets; click to assign (hotkey **T**). Cancel support.
- Show **Deflect** tax on hovered enemy targets.

### Batch C (Triggers/effects)
- **Trigger prompt** when a triggered ability needs an ordering choice or a yes/no
  ("you may…"). A small "stack of triggers — order them" UI for simultaneous ones.
- Show **XP / Level / Mighty** badges on units.

### Batch D (Banish/Hidden)
- A **facedown card** slot rendered at each battlefield (back art); a **Hide**
  action (drag/menu) and a **reveal** prompt on your turn. A **Banishment** pile
  shown beside the trash.

### Batch E (Resource pool)
- A visible **Rune Pool meter** (current Energy + colored Power) that fills as you
  exhaust/recycle and **empties** at end of Draw/turn — replacing the implicit
  auto-pay. Manual rune-tap UI (click runes to pay), with auto-pay as a toggle.

### Batch F (Attach)
- Render **attached equipment stacked** under/over its unit (top-most card
  highlighted); equip via drag or the **B/right-click** menu; a **Gold** token
  counter.

### Batch G (Standalone)
- **Battlefield draft** screen at match start (pick 3 → reveal 1). **Stun** and
  **Discard** in the right-click menu. A "moved" indicator on units that already
  moved this turn. Deckbuilder warnings for the refined signature/champion rules.

---

## Recommended sequencing
1. **Batch G** (quick correctness wins, no chain) — a day's work, flips several ◑.
2. **Batch A** (chain/priority) — the keystone; unblocks B–D and the A/S/T/C hotkeys.
3. **Batch B → C** (targeting → triggers/effects) — the bulk of card behavior.
4. **Batch D, E, F** (zones, pool, attach) — depth.
5. **Batch H** throughout — verify numbers against Riot's official rulebook.

---

# Authoritative addendum (Core Rules v1.2)

Read directly from the official PDF (`docs/core-rules-v1.2.txt`, 4,738 lines).
This supersedes the fan-site numbers above where they differ.

## Conflicts — resolved by the official rules
1. **"Counts as played" when Countered/impossible?** — Rule **100**: "do as much
   as you can, ignoring impossible instructions. If all of a card's instructions
   are impossible, it is still **played and resolved**, but nothing happens." A
   card placed on the Chain *is* played; Counter negates its **resolution**, but
   global "when you play a card" triggers still fire. → **Played = on the Chain.**
2. **Showdown — phase or state?** — Rules **339–342**: a Showdown is a **State /
   Window of Opportunity** inside the Action Phase, *not* a phase. ✅ engine uses
   `phase==='showdown'` as a state — correct.
3. **First-turn channel** — Mode-of-Play / First Turn Process (rule **461**): the
   player on the draw channels extra on turn 1. ✅ engine: P2 channels 3 on T1.

## Keyword glossary — official functional text + engine status
| Keyword | Official functional text (default X=1) | Engine |
|---|---|---|
| **Accelerate** (731.6) | "As you play me, pay [1] + 1 Power; if you do, I enter ready." | ◑ enters ready; extra cost not enforced |
| **Action** (732) | "Can be played/activated during showdowns on any player's turn." | ◑ |
| **Assault X** (734?) | "While I'm an attacker, +X Might." Sums. | ✅ |
| **Deathknell** (734) | "When I die [Killed→Trash], [Effect]." NOT on recall-replacement; each instance on the Chain before moving to trash. | ✅ (no Chain ◑) |
| **Deflect X** (735.3) | "Opponent spells/abilities that **choose** me cost X more Power (any domain)." | ❌ |
| **Ganking** (736.1) | "I may move to a battlefield from another battlefield." No cost; redundant. | ✅ |
| **Hidden** (737.1d) | Pay [A] to hide facedown at a controlled BF; next turn gains Reaction, play ignoring base cost; targets restricted to that BF. | ❌ |
| **Legion** (738) | On-play: "if you played another Main Deck card **before this** this turn"; other abilities: "if you played a Main Deck card this turn." | ✅ on-play variant |
| **Reaction** (739) | Action + "can be played during Closed States on any player's turn." | ◑ |
| **Shield X** (740) | "While I'm a defender, +X Might." Sums. | ✅ |
| **Tank** (741) | "Must be assigned lethal before any same-controller non-Tank unit." Order only; redundant. | ✅ |
| **Temporary** (742) | "At start of my controller's Beginning Phase, **before scoring**, kill me." | ✅ |
| **Vision** (743) | "When played, look at top of Main Deck; you may recycle it." Each instance separate. | ◑ logged |
| **Equip** (744) | Activated: "[Cost]: Attach this gear to a unit you control." | ◑ gear attaches |
| **Quick-Draw** (744.1) | Reaction + "when you play this, attach it to a unit you control." | ❌ |
| **Repeat** (746) | "Pay [Cost] extra to execute this spell's instructions one additional time." Spell still played once. | ❌ |
| **Weaponmaster** (747) | "When you play me, choose an Equipment you control; pay its Equip cost reduced by [A] to attach it to me." | ❌ |

## Mechanics the fan summary missed (now captured)
| Rule | Mechanic | Engine |
|---|---|---|
| 701–712 | **Buffs**: max **1** per unit; +1 Might each; removed when the unit leaves play; champions don't retain buffs in the Champion Zone. | ◑ (max-1 + Might ✅; removal-on-leave/champion-zone ❌) |
| 713–715 | **Mighty**: Might ≥5; board uses **current** Might, non-board uses **printed**. | ◑ (`isMighty` uses current; not wired to triggers) |
| 715.1–718 | **Bonus Damage**: intrinsic, additive across sources, positive-only, applied per-target. | ❌ |
| 716–722 | **Attach / Detach / Top-Most / Inactive text**: attached card's Effect Text appends to top-most, Might Bonus modulates it, rules text Inactive; detach on zone change. | ◑ (gear +Might only) |
| 161–164 | **Rune Pool**: conceptual Energy/Power; **empties end of Draw and end of turn**; unspent lost. | ❌ |
| 177–183 | **Tokens cease to exist** the moment they enter any Non-Board Zone. | ❌ (our tokens persist in trash) |
| 300–345 | **Chain / Open-Closed / Neutral-Showdown / Priority / Focus / Windows** — the full timing model. | ❌ (Batch A) |
| 437–451 | **Combat**: Attacker/Defender designations, damage assignment, lethal, conquer vs Recall, Cleanup; **Marked Damage clears only end-of-combat and end-of-turn** (cumulative otherwise). | ◑ (we clear after each combat; no designations/triggers) |

## Number corrections to apply (Batch H)
- Default keyword value **X = 1** when omitted (Assault/Shield/Deflect) — ✅ matches engine.
- **Buffs cap = 1** ✅. **Mighty = 5** ✅. **Victory Score = 8** ✅ (some battlefields raise it; ✅ winDelta).
- Token-in-non-board → cease to exist: **engine gap** (tokens currently sit in trash; should be removed).
- Buff removal on leave-play: **engine gap**.

These corrections are folded into the batches: token-cease + buff-removal → **Batch G**;
Bonus Damage + Attach → **Batch C/F**; Rune Pool → **Batch E**; everything else as mapped.
