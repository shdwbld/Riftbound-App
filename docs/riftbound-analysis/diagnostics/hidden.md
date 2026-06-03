# Diagnostic: the [Hidden] card group

**Method:** Opus diagnosis (same pattern as the Master Yi / Viktor / Vi card audits) —
enumerate the group, state the intended rule, trace the engine, rank the gaps.

## The rule
`[Hidden]` (reminder text: *"Hide now for `:rb_rune_rainbow:` to react with later for
`:rb_energy_0:`"*) is a two-step mechanic:
1. **Hide:** pay **1 Wild Power** (recycle any rune) to place the card **facedown** at a
   battlefield you control — on your turn, at action speed. Its real identity is hidden
   from opponents.
2. **Reveal:** later, flip it faceup to **play it for `:rb_energy_0:`** (free), at the
   card's own speed (`[Action]` / `[Reaction]`). A revealed **spell** resolves then
   trashes; **gear** attaches/enters; a **unit** enters play faceup.

### Confirmed against official rules (Riot Core Rules / Origins FAQ / errata, 2026-06-04)
- **A facedown card is NOT a unit** (rule 421.3: its properties are only what Hidden
  grants). It sits in a per-battlefield **Facedown Zone** — it **can't fight, can't
  defend, has no Might, can't be assigned combat damage**. So `[Backline]`/`[Tank]`/its
  triggered abilities are **dormant while hidden** and only apply once revealed faceup.
- **Targeting:** opponents see *that* a facedown card is there (public) but not its face
  (private). "Kill/deal-to/target **a unit**" **cannot** hit it — only effects naming
  "**a facedown card**" / "a card at a battlefield" can (per the Pack of Wonders errata,
  which lists "facedown card" as a separate category from "unit").
- **Reveal triggers:** targeting alone does **not** reveal it. It's revealed only when it
  **changes zones** or the game ends (rule 421.4) — e.g. killed→Trash (public) or
  returned→Hand (revealed first).
- **Timing:** you **cannot reveal the turn you hid** it; starting your next turn it gains
  **[Reaction]** and you reveal = **play for `:rb_energy_0:`** at Reaction speed (incl.
  showdowns). Reveal **opens a chain and fires play-triggers** (Legion triggers on the
  reveal, NOT on the hide). A revealed unit/spell's **targets are locked to the
  battlefield where it was hidden**. **One facedown card per battlefield** max.

Support cards: *Teemo - Swift Scout* (hide for 1 Energy instead of Wild Power),
*Ava Achiever* (play a [Hidden] card from hand ignoring cost), *Ember Monk* ("when you
play a card from [Hidden]"), *Guerilla Warfare* (return [Hidden] cards from trash; hide
ignoring costs), *Edge of Night* (when played from facedown, attach it),
*Noxus Saboteur* (opponents' [Hidden] cards can't be revealed here).

## Scope
**53** cards reference Hidden; **40 actually *have* [Hidden]** (can be hidden):
**21 spells · 2 gear · 17 units**. Plus 6 Teemo legend variants and several payoff cards.

## What the engine does today (`engine.ts` `HIDE` / `REVEAL`)
- **`HIDE`**: only a **unit** already in your **Base** with the `hidden` keyword; pays by
  recycling a ready rune; pushes it `facedown:true, exhausted:true` into `bf.units`.
- **`REVEAL`**: flips a facedown **unit** faceup and emits a `play` event — **but does
  not resolve any effect or "play" the card**.
- Facedown units render as a CardBack to opponents; orphan-cleanup removes facedown
  units at battlefields their owner no longer controls.

## Gaps (ranked by how many cards they block)

| # | Gap | Cards blocked | Severity |
|---|-----|---------------|----------|
| 1 | **Spells & gear can't be Hidden at all.** `HIDE` requires the card to be in **Base** and to be a unit; spells/gear live in **hand**. | **23** (21 spells + 2 gear) | 🔴 critical |
| 2 | **Reveal doesn't play the card.** `REVEAL` only flips a unit faceup; it never resolves a hidden spell (cast for 0), attaches hidden gear, or fires on-play effects. | all 40 | 🔴 critical |
| 3 | **No "play from facedown / from [Hidden]" trigger.** Ember Monk (+2 Might) and Edge of Night (attach on reveal) never fire; reveal should run play-triggers. | ~4 + payoffs | 🟠 |
| 4 | **Hidden spell isn't a unit** — but the only facedown representation is an entry in `bf.units`. A hidden spell/gear must sit facedown **without** being a combat unit. | 23 | 🔴 modeling |
| 5 | **Teemo discount** ("pay 1 Energy to hide instead of `:rb_rune_rainbow:`") not implemented. | 6 Teemo legends | 🟡 |
| 6 | **Hide cost is "recycle a rune," not "1 Wild Power."** Close, but the rule is pay 1 Wild Power (any single rune as Power); current code recycles a rune to the rune **deck**. Mostly OK; revisit with the cost model. | all | 🟡 |
| 7 | **Payoffs unbuilt:** Ava Achiever (play [Hidden] from hand ignoring cost), Guerilla Warfare (return [Hidden] from trash + hide free), Noxus Saboteur (deny reveal here). | ~3 | 🟢 |
| 8 | **Reveal speed/timing** — reveal should be usable at the card's `[Action]`/`[Reaction]` speed (incl. during showdowns), not only on your action. | all | 🟠 |

## Recommended fix (phased, mirrors how we did legend/gear abilities)
1. **Represent a facedown card generically** as a per-battlefield **Facedown Zone**
   (`battlefield.facedown?: EngineCard | null`, max one) holding **any** card type —
   NOT in `bf.units`. Per the official rules a facedown card is not a unit and never
   fights/defends (correcting an earlier assumption that facedown *units* fight). It's
   targetable only by "facedown card" effects, and revealed only on zone-change.
2. **`HIDE` from hand** for any `[Hidden]` card (spell/gear/unit), paying 1 Wild Power
   (any ready rune as Power), at action speed, to a controlled battlefield. (Teemo →
   allow 1 Energy instead.)
3. **`REVEAL` = play for 0.** On reveal: spell → `resolveSpellEffects` then trash; gear →
   attach (Edge of Night) or to base; unit → flip faceup in place. Fire **play-triggers**
   (covers Ember Monk) and a new `on.playFromHidden` event.
4. **Timing:** allow reveal at the card's keyword speed, including during showdowns/chain.
5. **Payoffs:** Ava Achiever / Guerilla Warfare / Noxus Saboteur as follow-ups.

This is a multi-commit mechanic (engine model + HIDE/REVEAL rework + UI for hiding
spells/gear + tests), comparable in size to the activated-ability track — not a
one-line fix. The biggest single win is **#1 + #2** (unblocks 23 spells/gear and makes
reveal actually do something).

---
Inputs: `src/engine/engine.ts` (`HIDE`/`REVEAL`, facedown handling), `keywords.ts`
(`hidden`), `src/data/cards.generated.json`. See `../card-grammar.md` (`on.play`,
`replacement`, `kw:hidden`). Unofficial fan research.
