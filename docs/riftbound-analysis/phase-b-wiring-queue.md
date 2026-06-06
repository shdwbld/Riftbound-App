# Phase B Wiring Queue — Fresh Coverage Audit

_Generated 2026-06-06 against HEAD `87517cb` by direct inspection of engine.ts/effects.ts/triggers.ts/keywords.ts/autopay.ts. Supersedes the stale `handler-coverage.md`. A6/Cluster-1 (control) is ON HOLD — skip in Phase B._

## Coverage estimate (sampled, ~984-card pool)
- Fully auto-resolved: ~530 · Keyword-only: ~109 · Bespoke handler: ~140+ · Vanilla: ~24 · **Still manual/broken: ~180–200** (down from ~290). ~36 confirmed-broken below across 11 clusters.

## Already solved — DO NOT re-flag
oncePerTurnGate · conqueredThisTurn placement predicates · staticMightAura (Baron Nashor) · Baron Pit placement + targetingImmune · Elder Dragon lethality + on-play · grantShield/grantTank · killGear/bounceGear/playGearFromHand · forcedDiscardCascade · Carnivorous Snapvine/Caitlyn/Vex-Mocking · Ashe-Focused/Insightful Investigator/Arise!/The List · Sumpworks Map/Ripper's Bay/Vex-Apathetic/Bone Skewer · buff+targeted triggers (Simian Ancestor/Jae Medarda/Irelia) · Loyal Pup global-defend + moveSourceToBf · Wraith of Echoes/Lucian-Merciless oncePerTurn · energySpentOnSpellsThisTurn counter (TRACKED; consumers below missing) · Battering Ram/Rhasa/Monch cost shapes · Mageseeker Warden dual aura · Magma Wurm/Minotaur Reckoner/Determined Sentry/Maduli · Blitzcrank-Impassive · movement predicates · Draven-Showboat/Dr.Mundo dynamic Might · Volibear-Furious/Sivir-Ambitious · enterReadyConditionMet guards.

## Prioritized queue (Effort S≤2h / M 2–6h / L 6h+)

### Cluster 1 — Take Control → **A6 (ON HOLD, skip in B)**
Possession `ogn-203-298`, Hostile Takeover `sfd-202-221`, Akshan - Mischievous `sfd-109-221`. Full specs in `a6-card-handlers.md` + `a6-rules-verification.md`.

### Cluster 2 — energySpentOnSpells consumers (Sonnet, S)
- Prepared Neophyte `unl-004-219` — "spent 4+ Energy on spells → +4 Might" (conditionalMight branch).
- Jhin - Meticulous Killer `unl-089-219` — alt flat cost when threshold met (effectiveCostOf branch).

### Cluster 3 — Novel additional costs (Opus)
- Brazen Buccaneer `ogn-002-298` — optional discard → cost −2 Energy (M).
- Atakhan `unl-170-219` — kill-friendly scales discount; on attack defender also kills one (L).
- Crescent Guardian `unl-122-219` — conditional additional Chaos Power cost (M).
- Safety Inspector `unl-164-219` — spend 3 XP additional cost gating a cull (Sonnet S; extend Insightful XP-gate w/ configurable amount).

### Cluster 4 — "Second card" trigger (Sonnet, S)
- Darius - Trifarian `ogn-027-298` — when `cardsPlayedThisTurn===2`, +2 Might & ready Darius (bespoke PLAY path).

### Cluster 5 — MF Buccaneer global aura (Sonnet, S)
- Miss Fortune - Buccaneer `ogn-193-298` — friendly units may play to open battlefields while she's here (canPlayToBf aura flag).

### Cluster 6 — Combat-aura conditional Might (Sonnet S; Opus M for Lucian)
- Crimson Pigeons `unl-154-219` — +2 attacking-with-another (conditionalMight predicate).
- Trusty Ramhound `sfd-159-221` — +1 while another friendly unit here.
- Lucian - Purifier `sfd-183-221` — your Equipment each give [Assault] (Opus, Equipment-type aura grant).

### Cluster 7 — Trigger/placement edge singles
- Stealthy Pursuer `ogn-177-298` — move-with friendly leaving my location → **new `moveFrom` event (Opus M)**.
- Void Hatchling `sfd-018-221` — reveal-replacement (look-top-first) → reveal-replacement layer (Opus M).
- Windsinger `sfd-138-221` — bounce a unit ≤3 Might → `bounceMightMax` field (Sonnet S).
- Dropboarder `sfd-072-221` — enter ready if control 2+ gear (enterReadyConditionMet gear-count branch, Sonnet S).
- Mageseeker Investigator `unl-163-219` — per-unit rainbow surcharge multi-move (Opus M, looping cost-per-unit).

### Cluster 8 — Zaun Punk kill-gear additional-cost gate (Sonnet S)
- Zaun Punk `sfd-160-221` — optional "kill a friendly gear as additional cost"; bonus currently fires unconditionally; mirror `killCostVictim` for gear.

### Cluster 9 — Gear-as-trigger-source (Opus M)
- Last Rites `sfd-150-221` — gear's own "When I conquer/hold" must fire from the gear's `iid` (route via controlledPermanents gear entries).

### Cluster 10 — Svellsongur (Opus / DEFER, L)
- `sfd-059-221` — runtime ability-copy host→gear; flagged snapshot approximation or defer.

### Cluster 11 — Bespoke singles
- Immortal Phoenix `ogn-037-298` — **`killWithSpell` event** + kill-source metadata (Opus M).
- Kato the Arm `sfd-112-221` — on move, copy keywords+Might to another unit; `grantKeywords` (Opus M).
- Tideturner `ogn-199-298` — bilateral swap of two friendly units; `swapUnits` (Opus M).
- Ava Achiever `ogn-107-298` — on attack pay Mind → play a Hidden card free (Opus M).
- Brynhir Thundersong `ogn-026-298` — "opponents can't play cards this turn" play-lock (Opus M).
- Dramatic Visionary `unl-062-219` — true Predict-2 subset choose (Opus M).
- Ezreal - Prodigy (OGN variant) — Tier-4 optional-cost friendly aura (Opus M).
- Albus Ferros `ogn-230-298` — spend N buffs → channel N (Sonnet S).
- Beast Below `sfd-132-221` — bounce one friendly + one enemy (Sonnet S).
- Angler Beast `unl-132-219` — bounce ALL units ≤2 Might; `bounceAllMightMax` (Sonnet S).
- Azir - Sovereign `sfd-177-221` — on attack move any number of token units here (Sonnet S).
- Vayne - Hunter `ogn-035-298` — cost-gated self-bounce on conquer (Sonnet S).
- Draven - Vanquisher `sfd-020-221` — optional rune-pay gate on +2 Might winCombat (Sonnet S).
- Jax - Unrelenting `sfd-119-221` — Energy-gate in fireAttachEquip (Sonnet S).

## Batch formation (execution; B1=A6 SKIPPED)
- **B2** Sonnet-style: Prepared Neophyte, Jhin, Darius "second card", MF-Buccaneer aura, Dropboarder, Safety Inspector.
- **B3** Sonnet-style: Crimson Pigeons, Trusty Ramhound, Windsinger, Zaun Punk gate, Vayne, Draven Vanquisher, Jax Unrelenting.
- **B4** Opus: Stealthy Pursuer (moveFrom), Void Hatchling, Immortal Phoenix (killWithSpell).
- **B5** Opus: Last Rites gear-trigger, Lucian Purifier.
- **B6** Opus: Kato, Tideturner, Ava Achiever, Brynhir, Dramatic Visionary, Ezreal Prodigy.
- **B7** Sonnet-style: Beast Below, Angler Beast, Azir Sovereign, Albus Ferros.
- **B8** Opus/defer: Svellsongur, Atakhan, Mageseeker Investigator, Crescent Guardian, Brazen Buccaneer.

> NOTE: many "Sonnet-style" cards still touch engine.ts (conditionalMight/effectiveCostOf branches) and so must be done by Opus serially; the Workflow fan-out is reserved for genuinely cards.ts-only (TEXT_PATCH) + test work.
