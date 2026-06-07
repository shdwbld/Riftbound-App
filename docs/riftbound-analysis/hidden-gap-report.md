# [Hidden] — Engine/UI Gap Report

_Synthesis of (a) the official rules spec (Core Rules v1.2 + retired FAQ) and (b) a read-only audit of our engine + UI. Date: 2026-06-07._

## How it's modeled today (summary)
- `BattlefieldState.facedown?: EngineCard | null` — a **single slot per battlefield** (matches rule 106.4.b's max-1). Stored OUTSIDE `bf.units` (correctly not a unit). `EngineCard.facedown` + `hiddenTurn` flags.
- **HIDE** (engine.ts ~7048): action-phase only (`requireActiveAction`), must control the bf, bf slot empty, card in hand with `[Hidden]`, pay 1 ready rune (recycled; Teemo-Swift-Scout exhausts-for-Energy variant), stores `{facedown:true, hiddenTurn:turn}`, fires the `hide` trigger. **No chain opened** (correct).
- **REVEAL** (engine.ts ~7081): same-turn block via `hiddenTurn`, Noxus-Saboteur block, plays the card for **0** at the hidden bf, `firePlayTriggers(fromHidden=true)`, bespoke Evelynn/Tideturner/Edge-of-Night. Unit→bf, gear→attach-or-base, spell→`resolveSpellEffects([])`.
- **Cleanup**: `beginTurn` trashes any facedown card whose owner ≠ bf.controller (matches 106.4.d / 322.7), to the owner's trash.
- **UI**: card-back + amber **"H"** badge (owner sees real name in tooltip; opponent sees only "a Hidden card"). Hide & Reveal are right-click context-menu items. Sandbox: revealFacedown/removeFacedown + a `grant facedown` toggle.

## Gaps vs. the rules (prioritized)

### P0 — rules-incorrect behavior
1. **Reveal has NO timing/speed model.** Rules: a hidden card gains **Reaction** and can be played in **Closed States on any player's turn**, and **playing from hidden OPENS A CHAIN** (737.1.c.3) so opponents can counter. Engine: REVEAL has *no* `requireActiveAction`/phase/priority check (so it's loosely "any time"), but it **resolves instantly and pushes NO ChainItem** → opponents can never react to or counter a revealed spell/unit. This is the biggest correctness gap.
2. **Hidden-reveal targeting restrictions absent (737.1.d).** A revealed unit *must* enter the hidden bf (engine does this), but a revealed **spell always resolves with `[]` targets** — it ignores the rule that its targets must be chosen from that battlefield, and the "can't reveal a spell with no legal targets there" guard is missing. Spells needing a target silently fizzle/misfire.
3. **Cleanup only runs at `beginTurn`, not on mid-turn control loss/conquer.** Rule 322.7 fires Cleanup after any showdown/combat that changes control. Engine leaves a facedown card on an enemy-controlled bf until the next beginning phase.

### P1 — missing capability
4. **Cost model is hardcoded to "1 rune of any domain."** Rules say hide cost = `[A]` (1 Power any color) — engine matches by recycling 1 rune, but with **no rune-choice** (auto-picks first ready) and only the one bespoke Teemo variant. No general cost-substitution parsing.
5. **No reveal during opponents' turns / showdowns in practice.** Because reveal isn't wired into the priority/closed-state windows, the headline Hidden play pattern (ambush-react on the opponent's turn) isn't really reachable through normal flow — there's no "reveal" affordance offered during a showdown/chain, and no chain interaction.
6. **`pluckCardAnywhere` ignores `bf.facedown`.** Sandbox `move` and any effect routing through it can't see/relocate a hidden card.

### P2 — polish / UX
7. **No "can't reveal this turn" UI feedback** — the Reveal menu item always shows; the same-turn block only surfaces as a rejected-action error string.
8. **No rune picker / confirmation for Hide** (auto-first-ready rune; no PaymentModal), and no pre-action hint that Teemo changes the cost to Energy.
9. **Sandbox `grant facedown` creates a hybrid** — sets `u.facedown=true` while the unit stays in `bf.units` (so it would still fight and can't be revealed via normal REVEAL, which looks in `bf.facedown`). Two inconsistent "hidden" representations.
10. **Stale log copy**: cleanup logs "Unsupported Hidden card revealed and trashed" (the word "Unsupported" is a dev note).
11. **Hidden privacy edge (408.4):** returning a facedown card to a private zone (hand) should reveal it to all players first — not modeled.

## Confirmed-correct (no action needed)
- One facedown card per battlefield; must control the bf to hide; hide is action-phase + open-state only and opens no chain; same-turn reveal ban; play-from-hidden cost = 0; unit enters the hidden bf; cleanup routes to **owner's** trash; facedown identity is private to its controller; `from face down`/`from [Hidden]` play-triggers fire only on reveal (fixed in the recent auras pass).

## Suggested build order (if we pursue Hidden next)
1. Make REVEAL push a ChainItem (reaction-speed) so reveals can be countered and respected in closed states (P0 #1) — the largest change.
2. Honor 737.1.d spell-targeting on reveal + the "no legal target → can't reveal" guard (P0 #2).
3. Mid-turn cleanup on control change (P0 #3).
4. UI: offer Reveal during opponents' turns/showdowns; "can't reveal yet" disabled state; Hide rune picker (P1/P2).
