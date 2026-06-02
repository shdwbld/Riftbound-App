# Timing & interaction audit — engine vs. reference

Tests each interaction in `TIMING-REFERENCE.md` against the actual engine
(`src/engine`). ✅ implemented · ◑ partial · ❌ absent.

## Headline
The engine implements the **structural game** (phases, resources, scoring,
conquering), **keyword combat** (Tank/Assault/Shield/Backline), Might modifiers,
token generation, and battlefield passives. It does **NOT** implement the
**Chain / Priority / Focus / Counter** timing engine — the core of this
reference. Showdowns are a simplified "move → opponents pass → resolve" with
REACTION-speed spells allowed, but no LIFO stack, no Counter, no Recall, no Stun.

## §3 Actions
| Action | Status | Notes |
|---|---|---|
| Play (card) | ◑ | Plays resolve immediately; no Chain, so not "on the stack". |
| Activate (ability) | ◑ | Only the Legend ability (`ACTIVATE_LEGEND`); generic `cost:` abilities ❌. |
| Standard Move | ✅ | Base→BF; BF→BF gated by **Ganking**. Multi-unit simultaneous moves ❌ (one at a time). |
| Hide | ❌ | No Hidden facedown placement. |
| Channel / Draw | ✅ | Channel phase + on-effect; Burn Out ✅. |
| Exhaust / Ready | ✅ | Awaken readies; playing/moving exhausts. |
| Recycle | ✅ | Power payment recycles a rune to deck bottom. |
| Add | ◑ | Modeled implicitly in payment; not a reactable game action. |
| Reveal | ❌ | — |
| Discard | ❌ | No discard action. |
| Banish | ❌ | No banishment zone. |
| Kill | ✅ | Lethal combat damage → Trash (Deathknell distinguishes board kills). |
| Recall | ❌ | Attackers are NOT recalled when no conquer (they stay). |
| Stun | ❌ | No Stun status. |
| Buff | ◑ | `buffs` counter exists + auto-applied by battlefields; no card-driven targeting. |
| Counter | ❌ | No Chain to counter. |
| Burn Out | ✅ | Empty-deck draw → next player +1. |

## §4 Reactions & triggers
| Mechanism | Status | Notes |
|---|---|---|
| ACTION timing | ◑ | ACTION/REACTION spells allowed in a showdown; no full state machine. |
| REACTION timing | ◑ | Priority holder may play a Reaction spell in a showdown; no Chain/Counter. |
| Triggered abilities | ◑ | A fixed set auto-fires (on-play draw/channel/recruit, Deathknell→recruit, battlefield hold/conquer); no general trigger system, no Chain placement. |
| Hidden / Ambush | ❌ | Not modeled. |

## §5 Ordering
| Rule | Status | Notes |
|---|---|---|
| LIFO chain | ❌ | No chain. |
| Simultaneous trigger ordering (1 / many players) | ❌ | Triggers resolve inline in iteration order. |
| Cleanup after each chain item | ◑ | Controllers recomputed after moves/combat; no per-item cleanup loop. |
| Cost checks use base cost | ◑ | We use printed cost for payment; no cost-reduction effects to test against. |
| Combat math live (Assault/Shield/Tank/buffs) | ✅ | Computed at resolution from current Might. |
| Mighty / Deflect / Stun / null | ❌ | Not modeled. |

## §6 Before combat (Neutral Open)
| Capability | Status |
|---|---|
| Play units (enter exhausted) | ✅ |
| Accelerate → enter ready | ✅ |
| Play spells/gear, activate legend | ◑ (gear attaches; spell common effects) |
| LEGION sequencing | ❌ (keyword parsed, effect not applied) |
| Vision on play | ◑ (logged, no actual peek/recycle UI) |
| Standard-move to start a showdown | ✅ |
| Hide cards | ❌ |

## §7 During a showdown
| Rule | Status |
|---|---|
| Move into contested/empty BF starts showdown / takes control | ✅ |
| Attacker acts first (Focus) | ◑ (priority passes to defender first to respond) |
| Only ACTION/REACTION legal in showdown | ✅ (plain plays blocked; reaction spells allowed) |
| **Can't reinforce an active showdown** (T5) | ✅ (MOVE_UNIT blocked while phase = showdown) |
| REACTION opens a chain / LIFO | ❌ |
| Designations + Attack/Defend triggers | ❌ |
| Modifiers live; Tank lethal-first | ✅ |
| Lethal → Kill → Deathknell | ✅ |
| Conquer scores / both survive → **Recall** | ◑ (conquer ✅; recall ❌ — survivors stay) |
| Damage clears end of combat | ✅ |

## §8 After combat
| Capability | Status |
|---|---|
| More standard moves with un-exhausted units | ✅ |
| Start another showdown elsewhere | ✅ |
| Surviving non-conquering attackers recalled | ❌ |
| Control may have flipped | ✅ (presence-based) |
| Marked damage persists until end of turn | ◑ (cleared after each combat instead) |

## Validation scenarios
| # | Scenario | Status | Why |
|---|---|---|---|
| T1 | Counter beats spell (LIFO) | ❌ | no Chain / Counter |
| T2 | Played-but-countered still fires globals | ❌ | no Counter |
| T3 | LEGION needs a prior real play | ❌ | LEGION not applied |
| T4 | Cost checks read base cost | ◑ | no reduction effects to test |
| T5 | Can't reinforce an active showdown | ✅ | enforced |
| T6 | Tank + Shield protects the backline | ✅ | Tank lethal-first + Shield |
| T7 | Stun wins a trade | ❌ | no Stun |
| T8 | No conquer → attackers recalled | ❌ | no Recall |
| T9 | Deathknell on Kill, not Banish | ◑ | Deathknell ✅; no Banish to contrast |
| T10 | Simultaneous triggers, turn-player order | ❌ | no Chain ordering |
| T11 | Attack trigger once per combat | ❌ | no attack triggers |
| T12 | "Nth time" fires once | ❌ | not modeled |
| T13 | Null target fizzles | ❌ | no targeting/null model |
| T14 | Add can't be reacted, helps pay | ◑ | payment is atomic; not reactable |
| T15 | Conquer now, Hold next turn | ✅ | both implemented |

## What it would take to close this
The big missing piece is a **Chain/Priority/Focus engine**: a stack of pending
items, a priority/focus holder, pass-tracking, Counter, and a general triggered-
ability system that places triggers on the stack. That's a substantial rework of
the showdown/turn loop (effectively MTG's stack adapted to Riftbound's two-axis
model) plus: Stun, Recall-on-no-conquer, Banish, Hidden/Ambush, a targeting
system, and LEGION/Mighty/Deflect conditionals. Combat math, scoring windows,
Tank/Shield, and the can't-reinforce rule already hold (T5/T6/T15 pass).
