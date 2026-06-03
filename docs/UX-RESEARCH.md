# Digital TCG UX Research — what makes an online card game feel good

Research that informed the **UX & Interaction Overhaul** (validity gating,
affordances, feedback). Surveyed: Hearthstone, MTG Arena, Legends of Runeterra
(LoR), Marvel Snap, and the Riftbound fan simulators (Rift Atlas, Pixelborn-style
clients). The goal is not to copy any one client but to extract the *invariants*
every polished digital TCG shares, then map them onto our engine.

## 1. The core loop a virtual TCG must facilitate

A physical card game leans on players to remember rules, track state, and narrate
what happens. A virtual one must do all three *for* the player:

1. **Show what's legal.** The interface answers "what can I do right now?" before
   the player clicks. Unplayable cards are visibly inert; legal actions invite.
2. **Guide the interaction.** Playing a card that needs a target enters an
   explicit targeting mode; illegal targets are unselectable; the player can
   always cancel.
3. **Confirm what happened.** Every state change produces feedback — motion,
   flash, a number, a sound — so the player never wonders "did that work?"
4. **Keep the turn moving.** Priority/turn ownership is always on-screen; when a
   player has nothing to do, the game offers (or auto-takes) the pass.

## 2. Affordances & constraint-based gating (the headline)

Every surveyed client greys out or dims cards you can't play this moment, and
highlights the ones you can:

- **Hearthstone**: unplayable cards sit dark in hand; playable ones get a green
  glow. Minions that can attack pulse; exhausted/summoning-sick ones don't.
- **MTG Arena**: cards you can't afford or can't legally cast are dimmed; when you
  hold priority with no legal play, the client offers a prominent "Pass" and an
  auto-pass setting (full control / stops only on your stuff).
- **LoR**: legal spell targets light up; everything else dims. Units that can
  attack/block glow. The "no legal target → can't cast" rule is enforced *before*
  you commit the card.
- **Marvel Snap**: the clearest minimal case — a card you can't afford simply
  won't lift to the board; the energy cost turns red.

**The rule we adopted:** *if clicking would do nothing, the control must look
disabled.* Concretely:

- A spell that deals damage **with no unit in play has no legal target**, so it
  is **un-playable** — the Play button is disabled and the card is dimmed. This
  is the exact scenario the user called out ("if you click a spell but no target
  exists, then you can't use that spell").
- Unaffordable cards, wrong-phase plays, and out-of-priority responses are all
  dimmed with a tooltip reason rather than failing after the click.

This is implemented engine-side as `canPlay()` / `getLegalTargets()` so the rule
is computed from the same guards the reducer enforces — the UI can never offer a
play the engine would reject.

## 3. Targeting interaction

Consensus pattern (click-based, which we chose over drag for reliability):

1. Click **Play** on a card that needs a target → enter **targeting mode** (a
   banner + a board-wide tint).
2. **Only legal targets are highlighted** (gold ring); everything else dims and
   is unclickable.
3. Click a legal target → the action resolves. **Esc / Cancel** always exits.
4. If there are zero legal targets, step 1 never starts (see §2).

Drag-to-target (MTGA, LoR) looks great but is fiddly on trackpads/touch and
needs precise hitboxes; click-target (Hearthstone's "play then click") is more
forgiving and is what we ship.

## 4. Feedback & "game juice"

Players need to *see* the rules happen. The cheap, high-impact signals every
client uses — all achievable CSS-only, no animation library:

| Event            | Feedback                                                        |
|------------------|----------------------------------------------------------------|
| Damage           | target flashes red + a short shake; a floating `-N`            |
| Defeat           | unit fades/shrinks out before it's removed                    |
| Card played      | the card scales/pops into its zone                            |
| Draw             | card slides from the deck into hand                           |
| Buff / Stun      | a quick scale "pop" + a status badge                          |
| Score / conquer  | a center toast (`+N point`) + a brief board screen-shake      |
| Spell countered  | the countered item flashes and is struck from the chain       |
| Chain item added | slides in from the side onto the chain stack                  |

Two design constraints we kept:

- **Card-anchored, coordinate-free.** Rather than computing flight paths between
  arbitrary screen positions (fragile, layout-dependent), animations live *on the
  card* (a flash/pop class) or as *center-screen toasts*. This stays robust to
  the responsive playmat layout.
- **Driven by structured events, not log-scraping.** The engine emits typed
  `GameEvent`s (`damage`, `defeat`, `score`, `draw`, `play`, `move`, `buff`,
  `stun`, `conquer`, `counter`) at its mutation sites. The view animates from
  those — no brittle parsing of human-readable log text.
- **Respects `prefers-reduced-motion`.** All feedback keyframes are disabled
  under the OS "reduce motion" setting.

## 5. Flow facilitation

- **Always show whose turn / priority it is.** A single prominent banner replaces
  scattered status chips: *Your turn* / *Opponent's turn* / *Your priority
  (chain)* / *Showdown — your priority* / *waiting for X*.
- **Auto-pass / one-click pass.** When you hold a priority window but have **no
  legal response** (no affordable Reaction/Counter), surface a big single "Pass
  (Space)" affordance so the game never feels stuck. (MTGA's auto-pass and LoR's
  automatic pass-when-nothing-to-do are the references.)
- **End-turn guard.** If you end your turn with a playable card or an un-moved
  ready unit, a cheap confirm ("End turn anyway?") prevents fat-finger whiffs —
  Hearthstone's "you still have mana / cards" warning is the model.
- **Hover-to-zoom.** Hovering any board/hand card shows a large preview (full art
  + rules text + keyword tooltips). Universal across all clients; essential when
  board cards are rendered small.
- **Keyword tooltips.** Hovering a keyword chip explains it in one line — newer
  players don't have to leave the board to learn `Tank`, `Deflect`, `Legion`,
  etc.

## 6. How this maps to our batches

This overhaul is delivered as cross-cutting "rework" passes plus a shared layer
future batches plug into:

- **Batch B rework** — legal-target highlighting + no-target gating (§2, §3).
- **Batch A rework** — chain/priority flow: unified banner, auto-pass, chain
  slide-in (§4, §5).
- **Batch G rework** — status visuals: stun/buff/damage/move feedback (§4).
- **Shared affordance + feedback layer** — `canPlay`/`getLegalTargets`, the
  `GameEvent` stream, the `FeedbackLayer`, and `CardPreview`/keyword tooltips —
  reused by Batches C/D/E/F as they land (trigger prompts, Hidden/Banish piles,
  rune-pool meter, attach badges).
