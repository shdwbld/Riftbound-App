# Non-standard UNIT cards needing bespoke handlers

> Diagnosis-only audit (Sonnet sweep, 2026-06). Identifies **unit** cards whose rules
> text the generic engine (effects.ts ParsedEffect / triggers.ts events / keywords.ts)
> cannot express, and which therefore need a hand-coded handler. Each ✅/❌ is the
> auditor's read of the code at audit time — **re-verify per card before implementing**,
> since the coverage snapshot predates recent fix campaigns. Example flagged by the
> user: **Elder Dragon** (`unl-118-219`) — confirmed unhandled.

**71 distinct unit card designs need bespoke handlers, across 14 categories.** (134
coverage entries include ~13 reprints/variants; after dedup + excluding cards now
confirmed handled post-snapshot, 71 unique designs remain.)

The handler-coverage.data.json snapshot (984 cards) predates the deferred-card
implementation run; cards it flags `manual-unhandled` that are now handled are marked
"Already handled" inline. "Already handled" = working bespoke branch in
`engine.ts`/`battlefieldScripts.ts`, or the generic parser now resolves the clause.

---

## A — Replacement / "would die" / protection auras (need a replacement-layer hook)
- `sfd-173-221` **Soraka - Wanderer** — "if another unit you control here would die … recall it" → ✅ handled in `tryRecallInsteadOfDeath`; BUT "I must be assigned combat damage last" ❌ (no combat-assignment ordering).
- `unl-147-219` **Baron Nashor** — "can't be chosen by enemy spells/abilities" + "+2 Might to other friendly" + entry adds Baron Pit battlefield → ❌ entirely bespoke.
- `sfd-105-221` **Ruin Runner** — "I can't be chosen by enemy spells and abilities" → ❌ no targeting-immunity field.
- `unl-163-219` **Mageseeker Investigator** — per-unit rainbow surcharge to move multiple units to my bf → ❌.
- `sfd-014-221` **Minotaur Reckoner** — "Units can't move to base" (global) → ❌.
- `unl-111-219` **Determined Sentry** — "I can't move to base" → ❌.
- `unl-056-219` **Yuumi - Magical Cat** — on attack/defend give another unit here +3 Might and **[Tank]** this turn → ❌ (`grantTank` missing).

## B — "while in combat" auras / dynamic combat-Might scaling
- ✅ Already handled (conditionalMight): `ogn-055-298` Wielder of Water, `ogn-065-298` Wizened Elder, `sfd-110-221` Fiora - Peerless, `ogs-004-024` Master Yi - Meditative, `unl-076-219` Petal Pixie, `sfd-085-221` Ornn - Forge God.
- `unl-154-219` **Crimson Pigeons** — "+2 Might while attacking WITH another unit" → ❌ (opposite of the alone pattern).
- `sfd-159-221` **Trusty Ramhound** — "while you have another unit here, +1 Might" → ❌ (boolean board-presence, not a count).
- `unl-004-219` **Prepared Neophyte** — "if you've spent 4+ Energy on a spell this turn, +4 Might" → ❌ (no spell-energy-spent tracker).
- `sfd-146-221` **Vex - Cheerless** — friendly spells cost less / enemy spells cost more while I'm in combat → ⚠️ friendly half via cost-shaping Tier 2; enemy-cost-up half ❌.
- `unl-118-219` **Elder Dragon** — "Any amount of your damage is enough to kill enemy units" + on-play deal 1 to one enemy per location → ❌ both (damage-lethality replacement + per-location targeting).

## C — Static auras granting keywords/abilities to other units
- ✅ Already handled: `ogn-015-298` Captain Farron, `ogs-013-024` Garen - Commander, `ogn-100-298` Gemcraft Seer (Vision), `ogn-236-298` Karthus - Eternal, `ogn-084-298` Eager Apprentice (cost), `ogn-140-298` Herald of Scales (cost), `ogn-079-298` Leona - Zealot.
- `ogn-011-298` **Magma Wurm** — "Other friendly units enter ready" → ❌ (no PLAY_UNIT-time aura check).
- `unl-147-219` **Baron Nashor** — "+2 Might to all friendly" generic aura → ❌.
- `ogn-070-298` **Mageseeker Warden** — "opponents can only play units to base" + "can't ready enemy units/gear" → ❌.

## D — Cost modification (dynamic/conditional play costs)
- `ogn-002-298` **Brazen Buccaneer** — optional discard → reduce my cost 2 Energy → ❌.
- `ogn-195-298` **Rhasa the Sunderer** — −1 Energy per card in trash → ❌.
- `sfd-010-221` **Void Drone** — −2 Energy when played from non-hand zone → ❌.
- `sfd-012-221` **Battering Ram** — −1 Energy per card played this turn → ❌.
- `unl-035-219` **Monch** — conditional −2 Energy + enter ready → enter-ready ✅, cost half ❌.
- `unl-089-219` **Jhin - Meticulous Killer** — alt flat cost if spell-energy threshold met → ❌.
- `unl-122-219` **Crescent Guardian** — conditional additional Chaos cost → enter ready → ❌.
- `unl-170-219` **Atakhan** — kill-friendly additional cost scales discount by its cost; on attack defender must kill one → ❌.
- `ogn-208-298` **Cruel Patron** — kill a friendly unit as additional cost → ✅ handled.
- `sfd-044-221` **Legion Quartermaster** — return a friendly gear as additional cost → ❌.
- `sfd-160-221` **Zaun Punk** — optional kill-gear cost + kill-a-gear effect → ❌ (kill-gear scope).
- `unl-164-219` **Safety Inspector** — spend-3-XP additional cost gating cull → ⚠️ XP gate ❌.

## E — Placement / "play me to" rules
- `ogn-176-298` **Sneaky Deckhand** — "play me to an open battlefield" → ⚠️ engine allows any bf, not just open.
- `ogn-193-298` **Miss Fortune - Buccaneer** — same + global "friendly units may be played to open battlefields" → ❌ aura.
- `sfd-093-221` **Dauntless Vanguard** — play to an occupied ENEMY battlefield → ❌.
- `sfd-015-221` **Perched Grimwyrm** — only to a battlefield you conquered this turn → ❌.

## F — Rare/novel trigger events
- `ogn-091-298` **Pit Crew** — "when you play a gear, ready me" → ⚠️ may work via readySelf; verify.
- `sfd-047-221` **Simian Ancestor** — "when you buff me, ready me" → ❌ (no `buff` event).
- `ogn-006-298` **Flame Chompers** — "when you discard ME, pay Fury to play me" → ❌ (self-discard trigger).
- `sfd-142-221` **Jae Medarda** — "when you choose me with a spell, draw 1" → ❌ (no chosen-as-target event).
- `sfd-126-221` **Loyal Pup** — "when you defend at a battlefield, move me there" → ❌ (no global defend event).
- `unl-055-219` **Vex - Mocking** — stun event fires but "move me to that battlefield" self-reposition ❌.
- `ogn-027-298` **Darius - Trifarian** — "when you play your second card this turn, +2 & ready" → ❌ (count gate).
- `ogn-118-298` **Wraith of Echoes** — "first time a friendly unit dies each turn, draw 1" → ❌ (once-per-turn gate).
- `sfd-075-221` **Prize of Progress** — gear-ability-use trigger → ✅ handled. `unl-179-219` **Rift Herald** move→peekDraw → ✅.

## G — Multi-step bespoke on-play effects
- `unl-118-219` **Elder Dragon** — (see A/B).
- `ogn-149-298` **Carnivorous Snapvine** — on-play mutual dealMight (self as dealer) → ❌ (deferred).
- `ogn-026-298` **Brynhir Thundersong** — "opponents can't play cards this turn" → ❌.
- `sfd-132-221` **Beast Below** — bounce one friendly + one enemy simultaneously → ❌.
- `unl-132-219` **Angler Beast** — bounce ALL units ≤2 Might (both sides) → ❌ (no bounceAll).
- `ogn-199-298` **Tideturner** — bilateral location swap of two friendly units → ❌.
- `sfd-112-221` **Kato the Arm** — on move, copy my keywords + Might to another unit → ❌ (no grantKeywords).
- `sfd-177-221` **Azir - Sovereign** — on attack move any number of token units here → ❌.
- `ogn-230-298` **Albus Ferros** — spend any number of buffs → channel that many → ❌.
- `sfd-084-221` **Jayce - Man of Progress** — kill gear → free-play a gear from hand → ❌.
- `sfd-032-221` **Disarming Rake** — kill a gear → ❌ (gear scope). `sfd-074-221` **Pickpocket** — kill gear→Gold ❌.

## H — Copy / text-copy
- `jdg-111-298` **Heimerdinger - Inventor** — "I have all [Exhaust] abilities of all friendly legends/units/gear" → ❌.

## I — Novel keywords / unique rule-words
- `unl-062-219` **Dramatic Visionary** — `[Deathknell][>] [Predict 2]` (choose-any-subset of top 2) → ❌.
- ✅ keyword-only cards (Laurent Bladekeeper, Vanguard Attendant, Direwing enter-ready, Shadow Watcher, etc.) handled.

## J — Conditional Might / state with no pattern
- `ogn-041-298` **Volibear - Furious** — deal 5 split among enemies (flat, not Might-equal) → ❌.
- `sfd-120-221` **Sivir - Ambitious** — deal excess-damage-amount on conquer → ❌.
- `sfd-113-221` **Lucian - Merciless** — "first time I conquer each turn, ready me" → ❌ (once-per-turn gate).

## K — Activated abilities with novel cost/effect shapes
- `ogn-068-298` **Caitlyn - Patrolling** — "assigned last" ordering + activated dealMight → ❌.
- `sfd-082-221` **Ezreal - Dashing** — "I don't deal combat damage" flag + activated self-move → ❌ (trigger half ✅).
- `unl-144-219` **Maduli the Gatekeeper** — "can't be readied" + conditional-Might self-move activation → ❌.
- `ogn-107-298` **Ava Achiever** — on attack, pay Mind → play a [Hidden] card from hand ignoring cost → ❌.

## L — Opponent-directed / multi-player
- `unl-130-219` **Walking Roost** — opponent plays a Bird token → ✅ likely (namedToken.opponent).
- `unl-135-219` **Insightful Investigator** — XP-spend gate on hand-strip → ⚠️ XP gate ❌.
- `unl-121-219` **Bewitching Spirit** — choose a player, they discard 1 → ✅.
- `unl-169-219` **Ashe - Focused** — banish a card from opp hand; "when they hold, return it" (persists after Ashe leaves) → ❌ return-on-hold half.

## M — Movement / positioning
- `ogn-177-298` **Stealthy Pursuer** — "when a friendly unit moves from my location, move with it" → ❌ (no such event).
- `sfd-138-221` **Windsinger** — bounce a unit ≤3 Might → ❌ (no killMightMax for bounce).
- `unl-021-219` **Grim Apothecary** — bounce a friendly unit → ✅. `ogn-188-298` **Zaunite Bouncer** — bounce any at a bf → ✅ likely.
- `sfd-018-221` **Void Hatchling** — "if you would reveal, look at top first, may recycle" → ❌ (reveal replacement).

## N — Unique one-offs
- `ogn-035-298` **Vayne - Hunter** — cost-gated self-bounce on conquer → ❌ (enter-ready ✅).
- `sfd-020-221` **Draven - Vanquisher** — optional rune-pay gate on +2 Might → ⚠️ gate ❌ (winCombat→Gold ✅).
- `sfd-119-221` **Jax - Unrelenting** — "when you attach Equipment to me, pay 1 Energy → draw 1" → ❌ (no `attachEquip` trigger with cost gate).
- `sfd-109-221` **Akshan - Mischievous** — capture enemy gear to base, control it, attach if Equipment → ❌.
- `sfd-072-221` **Dropboarder** — "if you control 2+ gear, ready me" → ❌ (condition).
- `unl-071-219` **Chakram Dancer** — give other units here **[Shield]** this turn → ❌ (`grantShield` missing).
- ✅ many `paidBonusEffect` optional-cost units (Clockwork Keeper, Blast Corps Cadet, Frostcoat Cub, Sea Monkey, Pyke - Dockside Butcher), plus Raging Firebrand, Harnessed Dragon, Sandshifter, Solari Chief, Mindsplitter, Karma - Channeler, Fiora - Worthy, Kha'Zix - Evolving Hunter — handled.

---

## Cross-cutting missing primitives (each unblocks several cards)
1. **Targeting immunity** flag ("can't be chosen by enemy spells/abilities") — Baron Nashor, Ruin Runner.
2. **Generic static Might aura** ("+N Might to (all) other friendly units [here/everywhere]") — Baron Nashor, etc.
3. **`grantShield` / `grantTank` (this turn)** — Chakram Dancer, Yuumi.
4. **Once-per-turn trigger gate** ("first time … each turn") — Wraith of Echoes, Lucian - Merciless.
5. **Cards-played / Energy-spent-on-spells this-turn counters** — Darius, Battering Ram, Prepared Neophyte, Jhin.
6. **Movement restrictions** ("can't move to base", "can't be readied") — Minotaur Reckoner, Determined Sentry, Maduli.
7. **kill / bounce with a Might cap, and gear-scoped kill/bounce** — Windsinger, Disarming Rake, Zaun Punk, Legion Quartermaster.
8. **"Play to open / enemy / just-conquered battlefield"** placement predicates — Sneaky Deckhand, Dauntless Vanguard, Perched Grimwyrm.
9. **`buff` and `attachEquip` (cost-gated) trigger events** — Simian Ancestor, Jax - Unrelenting.
10. **Damage-lethality replacement layer** — Elder Dragon.

> Verify each card against current `engine.ts` before building — several "❌" may have
> been closed by fix campaigns after the coverage snapshot.
