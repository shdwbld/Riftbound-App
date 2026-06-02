# Riftbound — Actions, Reactions & Interactions (timing reference)

Authoritative timing/interaction reference (from Riot Core Rules, rule numbers
cited as `CR x`). This is the spec; `TIMING-AUDIT.md` maps it to what the engine
actually implements. Treat CR numbers as a guide; the official Core Rules /
Patch Notes are final.

## 1. Timing engine
Two independent state axes + one resolution stack.
- **Combat axis:** Neutral ↔ Showdown (`CR 508`).
- **Chain axis:** Open ↔ Closed (`CR 509`). Closed whenever a Chain exists.
- Four composite states: Neutral Open (default, full freedom), Neutral Closed
  (Chain up — only REACTION may be added), Showdown Open (combat, only
  ACTION/REACTION), Showdown Closed (combat + Chain — only REACTION).
- **Priority** = permission in Neutral (`CR 512`). **Focus** = combat permission
  in Showdown, ACTION/REACTION only; attacker gains Focus first (`CR 513`).
- **Chain** = LIFO stack (`CR 509`). Playing/activating adds to it → Closed.
  Triggered abilities still go on the Chain automatically even while Closed.
  Chain empties → Open → a Cleanup runs.
- **Ordering rules:** (1) LIFO on the chain. (2) Your simultaneous triggers —
  you order them (`CR 583.3.b`). (3) Multiple players' simultaneous triggers —
  Turn Player first, then in turn order (APNAP, `CR 583.3.b.1`). (4) Cost checks
  use **base/printed cost** (`CR 130.4`).

## 2. Turn structure (A-B-C-D, Action, End; `CR 514-517`)
1. **Awaken** — ready all. No plays.
2. **Beginning** — start-of-turn triggers; **Hold** scoring (1/battlefield held);
   Temporary units die here (before scoring).
3. **Channel** — 2 runes ready (2nd player 3 on turn 1). No plays.
4. **Draw** — draw 1; Rune Pool empties end of phase; empty deck → **Burn Out**.
5. **Action** — all plays/moves/abilities/combat; **Conquer** scoring here.
6. **End** — "this turn" effects expire simultaneously; Marked Damage clears;
   Rune Pool empties; pass.
Combat is **not** its own phase — it happens inside Action.

## 3. Actions
**Discretionary** (you initiate, need Priority/Focus): Play (→Chain), Activate
(→Chain), Standard Move (Base→BF or BF→BF with Ganking; may start a Showdown;
not a Chain), Hide (recycle a rune to place a Hidden card facedown; not a play,
no LEGION).
**Limited** (only when instructed): Channel, Draw, Exhaust, Ready, Recycle, Add
(can't be reacted to; instant), Reveal, Discard, Banish (≠ Kill/Discard), Kill
(only "Killed" from board → Deathknell), Recall (→Base; not a Move; no triggers,
no Chain), Stun (no combat damage this turn), Buff (counter, max 1), Counter
(stop a Chain item; not "played"; costs not refunded), Burn Out (empty deck →
opponent scores 1).

## 4. Reactions & triggers
- **ACTION** (`CR 718`): may be played during Showdowns, any turn. Adds timing;
  can't interrupt a Chain.
- **REACTION** (`CR 725`): play during Closed states, any turn; inherits ACTION.
  Counterspell/combat-trick layer. Hidden gains REACTION next turn, reveal for 0.
- **Triggered abilities** (`CR 582`): fire automatically; go on the Chain even
  while Closed. Shapes: Play, Conquer, Hold, Attack, Defend. Attack/Defend fire
  once per combat. "Nth time" fires once even on a simultaneous spike.
- **Rule of thumb:** *you* choose when → REACTION; the *game* decides → Triggered.

## 5. What goes first / applies first
- **Resolution:** LIFO chain; simultaneous triggers ordered (one controller
  picks; multiple → turn player first); Cleanup after each item.
- **Application:** cost checks read base cost; combat math live at resolution —
  Assault [X] (+X attacking, stacks), Shield [X] (+X defending, stacks), Stunned
  = 0 damage (still has Might to survive), Mighty = Might≥5 state, Tank
  redirects lethal (no extra Might), Buff = counter (max 1), Deflect [X] = +X
  Power for opponents' choose/target effects. Null (not 0) on undeterminable
  numbers → dependent effect fizzles cleanly.

## 6. Before combat (Neutral Open)
Play units to base (enter Exhausted unless Accelerate → Ready), play spells/gear,
activate abilities, trigger LEGION (2nd+ Main Deck card this turn; Hidden doesn't
count), Vision on play, Standard-move units (this starts a Showdown), Hide cards,
hold REACTIONs up.

## 7. Starting & during a Showdown (`CR 508/513`)
- Starts when a unit **moves into a contested/uncontrolled battlefield**;
  attacker gains Focus. Empty BF → no combat, take control. Contested → combat.
- Showdown window: only ACTION/REACTION legal; Focus holder acts first; players
  alternate until all pass; **movement into this battlefield is locked** (no
  reinforcements). REACTION opens a Chain → Showdown Closed → LIFO → Cleanup.
- Combat resolution: (1) designations + Attack/Defend triggers (once/combat);
  (2) modifiers apply live (Assault/Shield/Stun); (3) damage by modified Might,
  Tank takes lethal first; (4) lethal check → Kill → Deathknell; (5)
  conquer (clear defenders & still present → score 1) or **both survive → no
  conquer → attackers Recalled**; (6) damage clears end of combat; (7) Cleanup.

## 8. After combat
Return to Neutral Open. Legal: more Standard Moves with un-exhausted units
(can start another Showdown at a different BF; Ganking repositions), more plays/
abilities; surviving non-conquering attackers are already Recalled (damage
cleared); control may have flipped. You can't clear your own Marked Damage on
surviving non-attackers until end of turn.
Cleanup (after every chain/move/showdown): kill lethal-damaged units, clear
designations, remove unsupported Hidden cards, re-evaluate "while" effects, start
Pending combat. Cleanup does NOT clear Marked Damage.

## 9. Keyword cheat-sheet
Accelerate (enter ready), Action/Reaction (timing), Assault/Shield (combat ±,
stack), Tank (redirect lethal), Deflect (target tax), Ganking (BF→BF move),
Hidden (facedown→0 reaction), Ambush (flash a unit into a held BF, dependent),
Legion (conditional on prior play), Mighty (Might≥5), Deathknell (on Kill),
Temporary (dies start of your turn), Vision (peek/recycle on play), Stun (0
damage this turn).

## 10. Validation scenarios (T1–T15)
T1 Counter beats spell (LIFO), no refund. T2 played-but-countered still fires
global "when you play a card". T3 LEGION needs a prior real play (Hidden ≠ play).
T4 cost checks read base cost. T5 can't reinforce an active Showdown. T6
Tank+Shield protects the backline. T7 Stun wins a trade. T8 no conquer →
attackers recalled, damage cleared. T9 Deathknell on Kill, not Banish. T10
simultaneous triggers — turn player orders first. T11 Attack trigger once/combat.
T12 "Nth time" fires once on a simultaneous spike. T13 null target → fizzle. T14
Add can't be reacted to, helps pay mid-Chain. T15 Conquer scores now; Hold scores
next Beginning.

## 11. Legal play types by state
| State | plain unit/spell/gear | ACTION | REACTION | Triggered |
|---|---|---|---|---|
| Neutral Open | ✅ | ✅ | ✅ | auto |
| Neutral Closed | ❌ | ❌ | ✅ | auto |
| Showdown Open | ❌ | ✅ | ✅ | auto |
| Showdown Closed | ❌ | ❌ | ✅ | auto |
| Opponent's turn | ❌ | (showdown only) | ✅ | auto |
