# Rules-Fidelity Campaign: kill auto-payments, fix broken steps & cards

**Status (2026-06-16): Phases A–E + G DONE — only Phase F remains.** Shipped: A `86eba83`, B `0616847`, C1 `7f7cded`, C2a `5458c58`, C2b `cb73a59`, C2c `83d2174`, D `8313755`, G1 `40053fc`, G2 `04bb150`, G3a `e28c122`, G3b `7495c3c`, G3c `b8989c7`, G4 `3cc7ef4`, **E Wave 1 `a6237df`, E Wave 2a `d406bdb`, E Wave 2b `510cd09`, E review-fixes `2fbe85e`** (854 tests green, new suite `phase-e.test.ts`). Key invariants: **RESOLVE_CHOICE is the single payment site — DeferredOps never re-pay** (C); **trigger chain items resolve through fireTriggers + smart auto-pass keeps reaction-free boards synchronous** (G); **genuine player picks (peekDraw/discards/Insightful/Predict-2) surface a ChoiceModal, deferred behind open choices via the pendingDecisions `kind:'choice'`+`raw` queue** (E). Engine.ts line anchors below predate the edits; **re-verify before editing**.

**NEXT: Phase F** (live bug reports). Phase E DONE — all 15 broken cards fixed (E9 Last Rites was already done by the equipment overhaul; "die in combat" = died while participating in a showdown per RiftJudge FAQ #8741). Note found during E12: the effect parser does NOT recognize "Kill … at a battlefield" as a kill (relevant to the Hidden Blade bug report). User checkpoints at phase boundaries — get a go-ahead before Phase F.

User decisions locked in: prompt for **every** non-free rune spend when manual pay is on (toggle still bypasses), and **full chain fidelity** (showdown spells AND death/end-of-turn triggers on the chain).

## Context

A 3-agent audit (payment flows, step flow vs Core Rules v1.2, card inventory) plus the live `bug_reports` table found three families of problems:

1. **Auto-payment shortcuts** — the engine picks WHICH runes to exhaust/recycle for the player at many sites, even though Rule 354.1.a makes that a player choice (recycling permanently consumes a rune — a real cost). The full rune-picker UI already exists (`src/components/PaymentModal.tsx`: tap-to-cycle exhaust/recycle/both, auto-fill seed, `reserved`, custom label) but many flows bypass it.
2. **Steps that don't match the rules** — showdown spells never enter the chain (can't be countered), triggers resolve inline with no reaction window, END_TURN wipes "this turn" state before end-of-turn triggers read it, [Reaction]-speed abilities are locked to the owner's turn.
3. **Cards that don't work as intended** — ~20 verified-broken cards/mechanics + 7 live bug reports.

The full-chain decision supersedes the old "auto-resolve abilities, no manual buttons" preference for trigger *timing windows* — update memory `auto-resolve-abilities.md` after implementation.

Key existing machinery to reuse (do not rebuild):
- `PaymentModal.tsx` — full rune picker returning `Payment {exhaust[], recycle[], poolEnergy?, poolPower?}`.
- `pendingDecisions` queue (`types.ts:373`, kinds `optionalPay | selectTarget | selectGear`) promoted one-at-a-time to `pendingChoice` via `surfaceNextDecision` (`engine.ts:2249`), resolved by `RESOLVE_CHOICE` (`engine.ts:8012`).
- P5 combat-pause pattern: decisions queued at move-declaration BEFORE showdown math (`engine.ts:7250–7267, 7459`).
- `ChainItem.kind: 'spell' | 'counter' | 'trigger'` (`types.ts:392`) — 'trigger' already exists (Elder Dragon).
- `autoPay` (`autopay.ts:271`) stays as seed/validator/fallback; `applyPayment` (`engine.ts:~151`) validates explicit payments.

Rulebook grounding (`src/data/rulebook.json`, Core Rules v1.2): 354.1.a (player adds resources during Pay Costs), 392.2.a (costed triggers declinable at pay time), 731–747 (Accelerate/Deflect/Hidden/Equip/Repeat costs), 404.1.c (recycle-as-cost), End Phase ordering (triggers before cleanup).

---

## Phase A — Payment foundation (engine + modal plumbing) — ✅ DONE (86eba83)

1. **Types** (`src/engine/types.ts`): add `'payCost'` to `PendingDecision`/`pendingChoice` kinds; add `resolvedCost?: ResolvedCost & {powerAny?: number}` alongside the legacy `cost` field; add `payment?: Payment` to `RESOLVE_CHOICE`; add `payment?: Payment` to `ACTIVATE_UNIT` and `HIDE` actions.
2. **PaymentModal powerAny** (`PaymentModal.tsx`): accept `cost: ResolvedCost & {powerAny?}`; recycle-assigned runes that match no remaining specific-domain need fill `powerAny` slots; update tally/validation and auto-fill seed. (Needed for any-domain costs: equip rainbow, hide, optionalPay `powerAny`.)
3. **`applyPayment` powerAny validation** (`engine.ts:~151`): leftover `payment.recycle` entries after domain matching must cover `powerAny`; fix the strict recycle-count check; keep `powerSpentThisTurn` tracking right.
4. **`queuePayCost()`** (next to `queueOptionalPay`, `engine.ts:2222`): mandatory-cost decision (no yes/no) carrying `resolvedCost` + `DeferredOp`; `surfaceNextDecision` promotes it.
5. **RESOLVE_CHOICE** (`engine.ts:8012–8022`): for `optionalPay`/`payCost`, if `action.payment` present → validate via `applyPayment` (invalid ⇒ choice stays open); absent → fall back to current `payPowerAny`/`payEnergyAuto` auto-pick (back-compat for manual-pay-off and stale online clients).
6. **UI rendering** (`MatchPage.tsx` ~898, `OnlinePage.tsx` equivalent): `optionalPay` becomes two-step (PromptModal yes/no → PaymentModal with `resolvedCost`); `payCost` opens PaymentModal directly. `useEffect` auto-resolves instantly (no payment payload) when `manualPay` is off (`MatchPage.tsx:142`); OnlinePage is always manual. Show "waiting for [player] to pay…" when `pendingChoice.player !== seat`. Net layer needs no changes — `RESOLVE_CHOICE.payment` is plain JSON over the existing action message.

Gate: new `manual-payment.test.ts` (explicit payment valid/invalid/declined, powerAny matching, fallback path) + full `npx vitest run`.

## Phase B — Route pre-dispatch payment sites through the modal — ✅ DONE (0616847)

| Site | Today | Fix |
|---|---|---|
| ACTIVATE_UNIT (engine.ts:~8407; UI `activateUnit` in MatchPage ~517 / OnlinePage ~861) | always `autoPay`, no modal | UI computes ability cost, opens PaymentModal ("Pay & activate ▶"), dispatches with `payment`; engine validates, falls back to autoPay |
| Equip rainbow power (MatchPage.tsx:819 gate `anyPower === 0`; engine `payEquipCost` 7631) | bypasses modal | drop the gate; pass `powerAny` into the modal cost; ATTACH validates payment incl. powerAny |
| Weaponmaster rainbow (engine.ts:7694; OnlinePage `wmPay` ~1149) | bypasses modal | same as equip |
| HIDE (MatchBoard.tsx:667 picks first ready rune) | auto-picks the sacrificed rune | new `onHide` prop → PaymentModal with `{powerAny: 1}` (Teemo - Swift Scout exhaust variant: `{energy: 1}` — check engine HIDE handler); extract rune iid from payment |

## Phase C — Trigger-time payments ("prompt everywhere") — ✅ DONE (C1 7f7cded, C2a 5458c58, C2b cb73a59, C2c 83d2174; C3 → G3)

Implementation notes for the record: new DeferredOps `playFromZone`/`drawN`/`replaySpellFromTrash`/`readyUnit`/`rumbleConquer(+Play)`; play-from-zone sites now bill the card's PRINTED per-domain Power (not the payPowerAny wildcard); `discardReplay`/`becomesStateReady` pendingChoice kinds retired in favor of queueOptionalPay; MOVE_UNITS gained `payment?` for the Mageseeker toll (pre-dispatch modal in both pages); Rumble - Hotheaded = selectTarget spare → payCost Energy remainder (reduced by the spare's Might), recycle waits for payment. Affordability gates use autoPay (exhausted runes are recyclable — fixed Mistfall's too-strict ready-rune gate).

Convert mid-effect auto-pay sites to `queuePayCost`/upgraded `queueOptionalPay` with `resolvedCost`. Waves, each vitest-gated:

- **C1 – existing optionalPay sites** (Vayne 1632, Immortal Phoenix 2030, Blood Rose 2187, Ripper's Bay 3774): populate `resolvedCost` so the modal gets real costs.
- **C2 – play/effect-time sites**: generic activated-gear power pips (756), playUnitFromTrash/FromHand power-due (892, 912), `payFixedCost`/`playFromTrashPayingCost` (2543, 2577, 8197 Phoenix from-trash payment itself), spell power-due (6360), Mageseeker multi-move surcharge (4215), Jax - Unrelenting attach cost (~3101), Mistfall (~615 — also stop auto-firing the "you may", it's an optionalPay), Rumble - Hotheaded (also let player pick WHICH card to recycle via `selectTarget`).
- **C3 – death-adjacent sites**: Altar of Blood (5810), Sett - The Boss death-save (3902). These run inside death/cleanup loops — **verify re-entrancy first**; if a mid-death pause is unsafe today, defer them to Phase G3 (the chain rework gives deaths a safe pause point) rather than hacking it.
  - **VERIFIED UNSAFE (2026-06-11) → deferred to G3.** Both pay inside the combat-finalization death loop / `tryRecallInsteadOfDeath`; a queued decision can't retroactively pull the unit out of `defeated` after Deathknells fire and the conquer math runs (and a late "save" would restore from trash with double-fire risk). They keep their inline auto-pay until G3 gives deaths a chain pause point.

## Phase D — Combat-time payments & forced picks (reuse P5 pre-math pattern) — ✅ DONE (`8313755`)

Queue decisions at move-declaration/showdown-open like engine.ts:7250–7267:
- Draven - Vanquisher (1529–1535), Sinister Poro (1773–1783), Ava Achiever (1804–1823): `optionalPay` with `resolvedCost` before combat math; effect applied via DeferredOp.
- Atakhan defender-must-kill (1785–1800): `selectTarget` decision for the **defending** player (currently auto-kills their weakest).

**Implementation notes (D):** `resolveShowdown` gained a Phase D pause — `queueNextCombatDecision(s, bfIndex)` runs FIRST (before the split-damage and P5 target-pick pauses, since these effects remove units from the battlefield). It scans `collectCombatFired` and queues ONE decision at a time through `pendingDecisions`: Draven = `optionalPay` billing the printed fury Power (was `payPowerAny` wildcard); Poro = `selectTarget` the enemy (was auto-weakest) → `payCost` ⚡1 (Rumble's pick-then-pay pattern; the move now also fires Blast Cone "move an enemy" triggers); Ava = `selectGear` list of [Hidden] hand cards (was auto-strongest) → `payCost` 1 mind (old code wrongly demanded a READY mind rune; recycling may use exhausted runes) → `avaPlayHidden`; Atakhan = mandatory `selectTarget` per defending player (decline falls back to their weakest = old auto-pick). New DeferredOps `combatDraven`/`combatPoroPick`/`combatPoroMove`/`combatAvaPick`/`combatAvaPlay`/`combatAtakhanKill` each mark `showdown.combatDone` (key = sourceIid, or `sourceIid:player` for Atakhan) and re-enter `resolveShowdown`; declines route through `combatOpDeclined` in RESOLVE_CHOICE so the showdown ALWAYS resumes; an already-pending combat op dedupes re-entries (PASS spam can't double-queue). Unaffordable/no-target triggers are marked done silently (matches the old silent skip). Fire-time handlers in `fireTriggers` are now no-ops for these four (attack/defend triggers only fire via `collectCombatFired`, verified). No UI changes needed — all four decision kinds render generically since Phase A–C.

## Phase E — Broken-card fixes (verified inventory)

Small (S):
1. "I don't deal combat damage" never enforced — Ezreal - Dashing, Galio - Indefatigable, Vilemaw (conditional Might compare): add predicate in `damageOutput()` (engine.ts:4943) + the `dealt()` lambda (5568).
2. Immortal Phoenix: `.find()` → all copies trigger (engine.ts:2028); allow base-or-battlefield placement.
3. `peekToHand` silently auto-takes when another `pendingChoice` is active (engine.ts:984) → queue through `pendingDecisions` instead. (This is the live "Stacked Deck" bug report.)
4. Hidden cleanup on mid-turn control loss (currently only at `beginTurn`) — call facedown cleanup when battlefield control changes.

Medium (M):
5. `peekDraw` auto-takes highest-cost match (~19 cards: Ornn, Ivern, Rift Herald…) (engine.ts:940–975) → `peekToHand`-style picker filtered to qualifying cards.
6. `opponentDiscards` auto-picks lowest-cost (engine.ts:856) → `selectTarget`-style hand pick **by the discarding player** (pattern exists: insightfulInvestigator).
7. Insightful Investigator auto-picks highest-cost card (engine.ts:8151) → chooser picks from revealed hand (reuse RevealHandModal flow).
8. Dramatic Visionary Predict-2 auto-resolves (engine.ts:1927–1941) → interactive look-2 / recycle-any / reorder via pendingDecisions.
9. Last Rites gear conquer/hold trigger never fires — gear iids missing from the `iids` filter in `collectSelf` (engine.ts:1337–1358) at conquer/hold collection sites. Fix delivery generically (also fixes the **Eye of the Herald** bug report — gear move-trigger on host move).
10. Ezreal - Prodigy "optional additional costs cost 1 less": apply in optional-cost resolution (autopay.ts has no Tier-4).
11. Draven - Audacious "when I die in combat, choose an opponent; they score 1": add `diedInCombat` flag set during showdown finalization + opponent-directed score + opponent pick.
12. Hidden reveal: bf-scoped spell targeting + "can't reveal spell with no legal target there" guard (`resolveRevealedCard`, engine.ts:6442 passes `[]` targets).
13. [Reaction]-speed `[Add]` activations (Seals, Energy Conduit) blocked by `requireActiveAction` in ACTIVATE_UNIT → allow off-turn/mid-chain when the ability is [Reaction]; Add still resolves instantly (rule: no chain item).
14. 2v2 cross-player triggers: teammate's hold/death global triggers never collected (engine.ts:4583–4585 only `ap`; `fireDeaths` only unit owner) → also collect for teammate.

Large (L, last): 15. Svellsongur — forward host's attack/defend triggers + activated abilities through the gear (engine.ts:1352 snapshot approximation).

## Phase F — Live bug reports (Supabase `bug_reports`)

- Sun Disk: "doesn't play next unit as ready" — find handler, honor the enter-ready grant.
- Hidden Blade: can't target own units/battlefield — fix targeting scope.
- "Negative values overflow" (high) — investigate stored fixture (`pre_state`/`action` jsonb), likely Might/cost clamping.
- Sand Soldier token numbering (high, UX) — render a per-token index badge so targets are distinguishable.
- "teemo" (vague) — reproduce from the stored fixture; fix what it shows.

## Phase G — Full chain fidelity — ✅ DONE (G1 `40053fc`, G2 `04bb150`, G3a `e28c122`, G3b `7495c3c`, G3c `b8989c7`, G4 `3cc7ef4`)

Design: triggers/deaths become `ChainItem{kind:'trigger'}` entries resolved through the existing PASS_PRIORITY loop instead of inline `fireTriggers`. To keep play fast, add **smart auto-pass**: a seat's priority auto-passes when it has no legal reaction (no ready/recyclable runes for any reaction-speed card in hand, no hidden card, no [Reaction] ability) — outcome-equivalent to the rules without click spam.

- ✅ **G1 – infra**: `ChainItem.trigger` gained `{kind:'fired', fired: FiredTrigger, excess?, wasUncontrolled?}` — resolves through the existing `fireTriggers`, so every bespoke handler is reused untouched. `pushFiredTriggers` pushes in reverse `orderTriggers` order (first-fired resolves first). `autoPassTriggers` (central post-action hook + beginTurn tail) auto-passes seats with no affordable Reaction/Action spell / Quick Draw gear / Ambush unit / revealable Hidden card (`seatHasLegalReaction` mirrors canPlay minus the priority check) — when all seats auto-pass, the trigger resolves synchronously in the same reduce() call, which kept the synchronous test idiom green (NO passUntilQuiet sweep was needed!). Spells/counters on top keep the manual flow. COUNTER rejects trigger items (rule 352). Pilot family: start-of-turn.
- ✅ **G2 – showdown spells on the chain**: legacy instant-resolve path deleted; spells fall through to the normal chain push (rule 344.3) → **counters work in showdowns**. PASS is blocked while the chain exists (Showdown Closed); `onChainEmptied` passes focus from its frozen holder + resets showdown passes (the legacy path also let the caster pass straight into combat without the opponent re-passing — fixed). Hooked at PASS_PRIORITY resolve, the auto-pass loop, and the Hard Bargain splice.
- ✅ **G3 – trigger families onto the chain**: conquer/hold/winCombat (5 sites; each global+self pair combined into ONE push to preserve order), deaths/Deathknell (single change in fireDeaths' tail converts all ~18 call sites; snapshots per rule 415/735 were already on the FiredTrigger), play-triggers (firePlayTriggers generic batch + fireTokenPlay; play-trigger items land ABOVE a pending spell and resolve first while the spell stays counterable — rule 351). **C3's Sett/Altar combat rescues became real choices**: a pre-death scan in finalizeShowdown queues optionalPay per would-die unit (steps stashed in `showdown.pendingSteps`, verdicts in `showdown.rescues`, decided-keys in `combatDone`; accept/decline re-enters finalizeShowdown with the SAME steps). Free rescues (shield/Zhonya/Soraka) stay inline and suppress the prompt.
- ✅ **G4 – END_TURN restructure** (rule 317): Ending Step FIRST — end-of-turn effects are synthesized into `endOfTurn` FiredTriggers and chained while "this turn" state is live; `maybeFinishEndTurn` (runs when the chain empties + no decisions) does the End of Turn Cleanup incl. **heal all units (rule 317.3 2c — marked damage no longer leaks across turns)**, the Expiration sweep, pool drain, extraTurns consumption, and beginTurn. `state.endingTurn` flags the in-flight hand-off.
- Test churn was minimal (smart auto-pass preserved synchronicity): ~6 tests updated, 13 added (`chain-fidelity.test.ts`); 840 green.

**Phase G known gaps (deliberate):**
- Long-tail trigger families still fire inline: stun, recycleRune/recycleCard, buff, targeted, hide, discard, move, opponentMove, becomesState, spendBuff (low interaction value; convert opportunistically).
- Sett's SPELL-kill death-save still auto-pays inline (`tryRecallInsteadOfDeath` default path) — a mid-spell pause is unsafe; only COMBAT deaths prompt.
- Combat attack/defend triggers stay on the Phase D pre-math decision machinery rather than a literal rule-344.3 "Initial Chain".
- A paused start-of-turn window doesn't halt the rest of beginTurn (channel/draw proceed; the window resolves at the start of the Action Phase).
- `autoPassTriggers` gotcha for future editors: when trigger items above a spell resolve, it opens a FRESH response window on the spell (passes=0, priority = opponent of its controller) — without this, counters bounce off 'Not your priority'.

## Skipped/deferred (with reasons, so they aren't re-audited)

- Stealthy Pursuer "should exhaust on follow" — audit-agent claim is **wrong**: effect moves aren't Standard Moves; only the Standard Move costs exhaust (rule 408). No change.
- Score-before-hold-trigger ordering — "when you hold" fires after scoring; current order is defensible. No change.
- Player-chosen discount ordering (rule 354) — only matters with min-cost floors; rare. Deferred.
- Beginning-phase sub-step reaction windows (Awaken/Channel/Draw) — no cards in pool currently need it. Deferred.
- ADD action phase-gating (engine.ts:9110) — harmless; pool clears each turn. Deferred.
- Sett/Altar mid-death pauses if C3 verification shows re-entrancy risk → land with G3.

## Verification

- `npx vitest run` green after every phase (790+ tests currently); new suites: `manual-payment.test.ts`, chain-fidelity additions to `timing.test.ts`/`chain-counter.test.ts`.
- Manual run (`npm run dev`): play a unit / activate an ability / equip rainbow gear / hide a card with manual pay on → every spend opens the rune picker; toggle off → zero modals.
- Online smoke test: two browser tabs; mid-effect payment shows "waiting for payment" on the other seat; counter a spell played during a showdown (G2).
- Re-export the five bug-report fixtures via /bugs and confirm each repro is fixed.
- Engine edits are sequential in `engine.ts` (no parallel agents on that file — established project rule). Commit surgically per phase (parallel committers on main).

## After implementation

Memory updates: revise `auto-resolve-abilities.md` (triggers now chain with smart auto-pass), update payment-flow pointers in other memories if touched, add a campaign-status memory.
