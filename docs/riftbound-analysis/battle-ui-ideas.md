# Riftbound Battle Page — Prioritized UI/UX Backlog

> Produced by a fan-out research workflow (7 game-UI inspiration passes — LoR, Hearthstone, MTG Arena,
> Marvel Snap, Gwent, Yu-Gi-Oh Master Duel, Slay the Spire/Balatro juice — + a battle-page audit +
> synthesis). Every idea is deduped against what we already have and grounded in the actual codebase.

A concrete, codebase-grounded improvement plan for the battle board. Every idea below was deduped against the current audit (e.g. we already have card-anchored flashes, ready/ganking/stun overlays, the FeedbackLayer toasts, CombatBanner, BattleSummary replay, MulliganHand, ScoreTrack, PoolMeter, the right-rail Log, ping/targeting/preview systems). Nothing here re-proposes those.

Stack reality the proposals lean on: React + Tailwind v4, board cards in `BoardCard.tsx` driven by `cardFx()`; structured `GameEvent[]` per `reduce()`; a real `Phase` model (`setup | mulligan | awaken | score | channel | draw | action | showdown | gameover`); `match.log: LogEntry[]` (each carries a `turn`); `match.chain` with `priority`; `match.showdown` with `priority` + `passed[]`; `prefers-reduced-motion` already disabling all `fx-*`/`anim-*`.

---

## Top 10 — do these first (ranked by impact ÷ effort)

1. **Persistent Might/damage readout chip on units (color-coded white/red/green)** — no engine work, lives entirely in `BoardCard`, removes the single biggest "I have to click to see HP" friction.
2. **Pass-state ledger on the chain & showdown rails** — data already exists (`chain.priority`, `showdown.passed`); pure render in MatchBoard's right-rail action panel.
3. **Phase ribbon (Awaken → Channel → Draw → Action → Showdown)** — `match.phase` already exists; a thin always-on flex bar kills "what step am I in" confusion.
4. **Reaction-spell affordance: tag chain/hand cards "Reaction" vs "Action"** — keyword data already parsed; clarifies the chain-window mental model at a glance.
5. **`revive` / `counter-successful` / `fizzle` GameEvent toasts** — extend `FeedbackLayer`'s switch; tiny once the events exist, big clarity win.
6. **Cause→effect connector arc on the last action** — reuse the existing SVG/ping overlay plumbing; makes spell targeting and combat legible to spectators and the acting player.
7. **Mulligan redraw preview strip (curve + count) in `MulliganHand`** — small additive panel, makes the opening-hand decision informed.
8. **End-of-match screen (champion splash + stat breakdown + Play Again)** — `gameover` phase + champion audio already exist; high emotional payoff, self-contained component.
9. **Pending-draw / mill queue indicator ("Mill 3 · 1 of 3")** — small badge near deck; resolves the "did anything happen?" gap during multi-draw resolution.
10. **Last-combat participant ring on units** — derive from the latest `GameEvent[]`; a 1-class affordance on `BoardCard` that adds combat context for free.

---

## Layout & readability

### L1 — Persistent Might/damage readout (always-on, color-coded)
- **Desc:** Keep the Might pill always visible and color it white = base, red = damaged (current < base), green = buffed (current > base), so board state reads without clicking. We already show Might + a ±mods pill; this is the *coloring discipline* + ensuring it never collapses behind hover.
- **Impact:** High · **Effort:** Small · **Needs engine:** No
- **Builds on:** `BoardCard.tsx` (`effectiveMight`, the bottom-right Might span + left ±pill), `auraMightFor`.

### L2 — Hand width clamp + auto-shrink for large hands
- **Desc:** Cap hand-zone width and scale cards down (never below ~60px) instead of letting a big hand overflow or stretch; fan/peek the overflow.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No
- **Builds on:** PlayerMat hand zone (grid-template-areas), `useFitToViewport.ts`, the `--card-w` token.

### L3 — Vertical status-effect stack (mine left / opponent right)
- **Desc:** Pull global/persistent conditions (stun, temp-Might, protected, targeting-immune) into anchored vertical icon stacks instead of cramming every badge onto the card corner; keep card-local badges for combat keywords only.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `BoardCard.tsx` badge cluster, the status-effect flyout, `parseKeywords`/`keywordsAt`.

### L4 — Hero-corner resource pod (Energy + score + legend portrait clustered)
- **Desc:** Co-locate PoolMeter (Energy), ScoreTrack, and the legend portrait into one bottom corner "home base" pod (curved/clip-path) so resource glances are one eye-movement, separate from the play zone.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** PlayerMat zones, `PoolMeter`, `ScoreTrack`, `matGradient()`, `domainGlow()`.

### L5 — Battlefield power-totals header (mine vs theirs, winner highlighted)
- **Desc:** Above each shared battlefield, show committed-Might "12 vs 8" with the leading side glowing — real-time control clarity during a showdown without summing cards by eye.
- **Impact:** High · **Effort:** Med · **Needs engine:** No (read-only over `combatMight()`)
- **Builds on:** BattlefieldZone, `combatMight()`, the mine/opponent border indicators.

---

## Game feel / juice

### J1 — Sequential cascade resolution with running totals
- **Desc:** When a chain/combat resolves, animate effects one-at-a-time (damage pops, then HP ticks, then next link) instead of snapping to final state. BattleSummary already lists rows on a timer — extend that staggering onto the live board cards.
- **Impact:** High · **Effort:** Large · **Needs engine:** No (events arrive ordered LIFO already)
- **Builds on:** `BattleSummary.tsx` cadence, `cardFx()` (seq-keyed flashes), `GameEvent[]`.

### J2 — Magnitude-encoded screen/card shake
- **Desc:** Tie shake amplitude/duration to magnitude — a 1-damage hit barely twitches, a lethal 6+ shakes hard. Currently `fx-damage` is one fixed shake.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No (`GameEvent.amount` exists)
- **Builds on:** the `fx-damage` keyframe + `cardFx()`; pass an intensity tier via CSS var.

### J3 — Rolling-digit counters on Might / Energy / score
- **Desc:** Animate numeric changes with a short slot-machine roll + overshoot instead of instant swaps, so totals feel "computed."
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `BoardCard` Might span, `PoolMeter`, `ScoreTrack`.

### J4 — Event-colored particle bursts from source toward target
- **Desc:** Emit small particle bursts matching the effect (red damage, green heal, gold buff) from the source card toward the target, reinforcing cause→effect. Distinct from existing battlefield ambient particles.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `bfEffectClass()` particle infra, `PingLayer.tsx` overlay pattern, `cardFx()`.

### J5 — Exaggerated expiry animation for transient state
- **Desc:** When Temporary units die at turn start, or temp-Might / grants wear off, play a scale-down + fade-out exit so ephemeral state has visual consequence rather than vanishing.
- **Impact:** Low · **Effort:** Small · **Needs engine:** No
- **Builds on:** `BoardCard` (`tempMight`, `grantShield`, `grantTank`, `temporary` badge), `cardFx()`.

### J6 — Non-blocking action queue (never gate input on animation)
- **Desc:** Let the player keep acting while flashes/announcements play; run feedback in parallel rather than serializing on `PlayedCardAnnouncement` timing.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `PlayedCardAnnouncement.tsx`, MatchBoard's `pendingDraw`/`recapOpen` gating effects.

---

## Clarity of state & priority

### C1 — Phase ribbon (always-on step bar)
- **Desc:** Thin horizontal bar marking `Awaken → Channel → Draw → Action → Showdown`, current step bright, with a moving indicator — players always know which structural step they're in.
- **Impact:** High · **Effort:** Small · **Needs engine:** No
- **Builds on:** `match.phase`, MatchBoard right-rail action panel area.

### C2 — Pass-state ledger
- **Desc:** During a chain/showdown, show who has consecutively passed and who's still owed priority ("You ✓ · Riven —"), so "why is it stuck on me / why did it resolve" is obvious.
- **Impact:** High · **Effort:** Small · **Needs engine:** No (`showdown.passed[]`, `chain.priority` exist)
- **Builds on:** the chain/showdown panels in MatchBoard (lines ~1280–1333), `CombatBanner.tsx`.

### C3 — Reaction vs Action spell tagging
- **Desc:** Badge each chain item and each hand card as "Reaction" (can be played in a window) vs "Action," and dim hand cards that aren't legal to play right now in this window — currently the chaining distinction is invisible at a glance.
- **Impact:** High · **Effort:** Med · **Needs engine:** No (keyword/timing already parsed; `canPlay()` exists)
- **Builds on:** `parseKeywords`, `canPlay()`, the chain list render, the `dim` prop on `BoardCard`.

### C4 — "Who can play this" indicator on reaction windows
- **Desc:** When a chain window is open to others, make it explicit on each card whether *you* may respond vs only another player may — distinct affordance from the generic dim state.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No
- **Builds on:** `canPlay()`, `myChainPriority`/`canRespondNow` (already computed in MatchBoard), `BoardCard.glow`.

### C5 — Battlefield flip-preview during showdown
- **Desc:** While a showdown is being calculated, show "→ will flip to <player>" on the contested battlefield so the conquest outcome is previewed before it commits. ShowdownPreview shows Might totals; this adds the *controller delta*.
- **Impact:** Med · **Effort:** Med · **Needs engine:** Maybe (a derived "projected controller" helper; data is present in showdown state + `combatMight()`)
- **Builds on:** ShowdownPreview, BattlefieldZone controller indicator, `combatMight()`.

### C6 — Rune-exhausted / rune-readied state animation
- **Desc:** Animate runes flipping to exhausted on spend (and back on awaken) in the rune pool, matching the unit exhaustion language — currently runes change silently.
- **Impact:** Low · **Effort:** Small · **Needs engine:** No (`payment` events carry `exhaust`/`recycle`)
- **Builds on:** rune-pool render in PlayerMat, `GameEvent` `payment`, the exhaustion rotation convention.

### C7 — Resource-debt / illegal-cost warning
- **Desc:** If a play would overspend Energy/Power, surface a red pulse on PoolMeter + a "Not enough" inline reason instead of a silent rejection.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No (`canPlay()` already returns legality)
- **Builds on:** `canPlay()`, `PoolMeter`, the existing `dim` unplayable styling, `PaymentModal`.

---

## Targeting & interaction

### T1 — Cause→effect connector arc on the most recent action
- **Desc:** Draw a short Bezier arc from source card to target(s) for the last play/ability/attack (blue = targeting, red = damage), auto-fading — so both the actor and spectators see "X hit Y." Distinct from the live targeting-mode ring we already have.
- **Impact:** High · **Effort:** Med · **Needs engine:** No (`GameEvent.iid` + DOM `data-iid` already on cards)
- **Builds on:** `data-iid` on `BoardCard`, `PingLayer.tsx` SVG-overlay pattern, `getBoundingClientRect`.

### T2 — Forgiving target hit-boxes
- **Desc:** Expand legal-target click zones (padding beyond the card art) and `pointer-events:none` on decorative overlays so targeting isn't fiddly, especially on touch.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No
- **Builds on:** the legal-target amber-ring highlight, `BoardCard` button, targeting-mode handling in MatchBoard.

### T3 — Multi-target checkbox affordance on legal targets
- **Desc:** For "pick up to X" spells, render a per-target toggle/checkmark on each legal unit (not just a counter), letting the player see and adjust the selected set before confirming.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No (multi-target progress already tracked)
- **Builds on:** the existing multi-target counter + `Done`/`Cancel` panel, legal-target highlight set (`fx.legalSet`).

### T4 — Magnetic snap-in on board placement
- **Desc:** Give cards a spring/overshoot settle when they land on a battlefield/bench (and a slight nudge to neighbors) rather than appearing instantly.
- **Impact:** Low · **Effort:** Med · **Needs engine:** No
- **Builds on:** `fx-play`/`fx-move` flashes, the sandbox DnD drop handlers, `cardFx()`.

---

## History & review

### H1 — Action-history thumbnail strip (last ~7, color-coded by player)
- **Desc:** A compact horizontal strip of recent actions as small card-art thumbnails with player-colored borders and hover tooltips — glanceable audit trail above/beside the text Log.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No (`match.log` exists; enrich entries with `cardId`/player)
- **Builds on:** `match.log: LogEntry[]`, the right-rail Log, `PlayedCardSpotlight.tsx`.

### H2 — Log scrubbing / snapshot peek (read-only)
- **Desc:** Click a Log entry to open a frozen board snapshot at that point (no live rewind), as a memory aid.
- **Impact:** Med · **Effort:** Large · **Needs engine:** Yes (needs per-entry state snapshots or a replayable history; the page keeps undo history but not indexed snapshots)
- **Builds on:** `match.log`, the page-level undo history, `BattleSummary`/`MatchBoard` render path.

### H3 — Toast-dismiss control + recent-toast recall
- **Desc:** Let the player click to dismiss a FeedbackLayer toast early and re-open the last few from a small tray (toasts currently auto-expire only).
- **Impact:** Low · **Effort:** Small · **Needs engine:** No
- **Builds on:** `FeedbackLayer.tsx` (toast list + timers).

### H4 — Combat-summary "expand to full chain" link
- **Desc:** From the BattleSummary modal, let the player expand into the full ordered list (it currently shows a curated subset of event kinds) for post-mortem review.
- **Impact:** Low · **Effort:** Small · **Needs engine:** No
- **Builds on:** `BattleSummary.tsx` (`toRows`, `worthSummarizing`).

---

## New-event toasts & indicators (FeedbackLayer extensions)

### F1 — `revive` / unit-restored toast + card flash
- **Desc:** Surface revive/return-to-play events (currently no feedback at all) with a toast and a green "restore" flash on the card.
- **Impact:** Med · **Effort:** Small · **Needs engine:** Yes (add a `revive` GameEventKind where the reducer restores a unit)
- **Builds on:** `FeedbackLayer.tsx` switch, `cardFx()` flash set (add a `restore` flash).

### F2 — Counter-successful / spell-fizzle toast
- **Desc:** Distinct toast for "spell countered → fizzles" beyond the chain entry banner, so the payoff of a Counter is unmistakable.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No (`counter` event already emitted; just differentiate fizzle text)
- **Builds on:** `FeedbackLayer.tsx` (already handles `counter`), `BattleSummary`.

### F3 — Pending draw / mill queue indicator
- **Desc:** During multi-card resolution ("Mill 3 / Draw 2"), show "1 of 3" progress near the deck so partial resolution is visible.
- **Impact:** Med · **Effort:** Small · **Needs engine:** Maybe (a count is inferable from `draw`/`mill` events; a true queue length would need an engine field)
- **Builds on:** `draw` events (`FeedbackLayer`), the deck `CardBack.tsx` count, OVERRIDE `mill`/`draw` plumbing.

### F4 — Last-combat participant ring
- **Desc:** Briefly ring units that fought in the most recent combat so post-combat board context is clear (who attacked/defended).
- **Impact:** Med · **Effort:** Small · **Needs engine:** No (derive from the latest `GameEvent[]` iids)
- **Builds on:** `cardFx()`, `BoardCard.glow`, `GameEvent.iid`.

### F5 — Hidden-card "you know this is X" hint
- **Desc:** On a facedown/Hidden card the local player legitimately knows, show a subtle name hint on hover (gated to the owner) — the H badge currently gives no identity.
- **Impact:** Low · **Effort:** Small · **Needs engine:** Maybe (needs a "revealed-to-player" flag if not already tracked)
- **Builds on:** the facedown `H` badge in `BoardCard`, `CardPreview.tsx`, the Hidden-card context-menu category.

---

## Onboarding / mulligan

### O1 — Mulligan redraw preview (count + Energy curve)
- **Desc:** In `MulliganHand`, add a live "keeping 3 · replacing 1" status plus a tiny Energy-cost curve of the kept hand so the redraw decision is informed.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No (cost data on cards)
- **Builds on:** `MulliganHand.tsx` (`aside` set already owned by caller), `getCard`.

### O2 — Mulligan focus overlay (darken board behind the panel)
- **Desc:** Dim everything except the mulligan panel and enlarge the cards, putting full focus on the decision (Hearthstone/MTGA pattern).
- **Impact:** Low · **Effort:** Small · **Needs engine:** No
- **Builds on:** `MulliganHand.tsx`, the modal/overlay backdrop pattern used in `BattleSummary`.

### O3 — Pinned quick-rules reference (conquer / showdown / chain)
- **Desc:** A collapsible cheat-sheet panel summarizing conquer, showdown, and chain timing for newer players — distinct from the per-keyword tooltips we already have.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `MechanicTooltip.tsx` content, `HotkeyHelp.tsx` panel pattern.

### O4 — "Your turn / their turn" transition banner + interactivity dimming
- **Desc:** A 1–2s "Your Turn" banner on turn handoff plus dimming all my interactive elements during the opponent's turn, reinforcing whose window it is. Distinct from the persistent priority banner.
- **Impact:** Med · **Effort:** Small · **Needs engine:** No
- **Builds on:** `CombatBanner.tsx` (reuse the banner shell), the priority banner derivation in MatchBoard, `canAct`.

---

## End-of-match

### E1 — End-of-match screen (champion splash + stats + Play Again)
- **Desc:** On `gameover`, full-screen victory/defeat with the winner's champion splash, a champion voice line, a stat breakdown (points, units defeated, turns), and Play Again / Lobby buttons. We currently only fire a one-shot announcer.
- **Impact:** High · **Effort:** Med · **Needs engine:** No (`gameover` phase + `setWinner` + champion audio + `match.log` for stats all exist)
- **Builds on:** the victory/defeat announcer, champion audio (`toChampionKey`, `audio.ts`), `matSplashUrl`, `match.log`.

### E2 — Victory burst (particles + flash + camera shake)
- **Desc:** Dramatic lethal/win moment — opponent legend portrait bursts, screen flash + shake, synced victory sting — so the win feels earned. Layered on top of E1.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** E1, `PingLayer`/particle infra, `audio.ts` music/SFX buses, `fx-*` keyframes.

### E3 — Per-match stat capture for the end screen
- **Desc:** Tally damage dealt, units defeated, points scored, cards drawn across the match to feed E1's breakdown.
- **Impact:** Low · **Effort:** Med · **Needs engine:** Maybe (accumulate from `GameEvent[]` across the match; light aggregation, no rules change)
- **Builds on:** `GameEvent[]` stream, the page-level match state, `BattleSummary` event-mapping logic.

---

## Accessibility (cross-cutting)

### A1 — ARIA labels + keyboard focus indicators on interactive board elements
- **Desc:** Add `aria-label`s to cards/zones/buttons and visible focus rings (beyond tab order) so the board is operable and screen-reader-legible. We already respect `prefers-reduced-motion`.
- **Impact:** Med · **Effort:** Med · **Needs engine:** No
- **Builds on:** `BoardCard` button (`title` exists, add `aria-label`), zone buttons in MatchBoard, the existing reduced-motion discipline.

---

### Notes on engine dependencies
Most ideas are pure render over data the engine already exposes. The few that need engine work are: **F1 revive event**, **H2 log snapshots**, **C5/F3** (optional derived helpers/fields), **F5** (a revealed-to-player flag if not tracked), and **E3** (cross-match event aggregation). None require rules changes — they're additive event kinds or read-only derivations.
