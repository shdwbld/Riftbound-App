# Phase B architectural-tail dossier (verified)

_Generated 2026-06-06 by the `b-tail-dossier` workflow (5 Sonnet research + 7 adversarial verifiers + synth, ~919k tokens). Grounded in `docs/core-rules-v1.2.txt` + `docs/core-rules-faq.txt`. Drives the final Phase-B serial implementation. Anchors are against HEAD at generation time — re-grep before editing._

## Status of the 14 tail cards
- ✅ **Immortal Phoenix** (`ogn-037-298`) — ALREADY wired (engine.ts:1745, `fireDeaths` via `killedBySpell` + `playFromTrashPayingCost`). Test passes (engine.test.ts:5723). Verifier corrections (low priority enhancements): multiple Phoenix copies in trash should EACH trigger (current `.find()` plays one); the played Phoenix may enter base OR a controlled battlefield (current = base only). Happy path is correct; leave unless cheap.
- ❌ 13 to build (below).

## Engine framework already present (reuse)
- Additional cost: `optionalPlayCost` (keywords.ts:301 — matches rune/energy only), `action.payAdditionalCost` → `paidAdditional` (engine.ts:5588), `paidBonusEffect` (effects.ts:1003). `onPlayEffect` ALREADY strips the "if you paid the additional cost,…" clause (effects.ts:993-996) so the bonus never double-fires. Required-kill template: `killCostVictim` (engine.ts:5648-5711). `entersReady` (5643) can reference `paidAdditional`.
- Gear: `allGearInPlay` (2343), `killGearByIid` (2362→owner's trash, Rule 107.1.d), `applyKillGear({scope,maxEnergy},draw)` (2400, picks lowest-energy).
- Predict-1 sets `s.vision = {player, cardId}` (5870) + VISION_DECIDE (6315) keep/recycle.
- Cost-shaping: `effectiveCostOf(state,player,card,opts)` (autopay.ts:22). `addCost` to fold; clamp ≥0.

## Per-card specs (incorporating verifier corrections)

### Additional-cost cluster (PLAY_UNIT region ~5584-5760)
1. **Zaun Punk** `sfd-160-221` — "you may kill a friendly gear as additional cost; if paid, kill a gear." Optional gear-kill cost (auto-pick lowest-energy friendly gear via `killGearByIid`); set a paid flag; bonus = kill a gear (auto-pick ENEMY first, else friendly). Bonus already in `paidBonusEffect` IF paid flag fires; gate with skipGenericApply-equivalent in PLAY_UNIT (it's `if (paidAdditional)` at 5750 — extend to the gear-cost flag).
2. **Brazen Buccaneer** `ogn-002-298` — "you may discard 1 as additional cost; reduce my cost by 2E." Bespoke: if `payAdditionalCost` & hand≥1, auto-discard lowest card (`sendToTrash`+`fireDiscard`), `effCost.energy = max(0, energy-2)` BEFORE `applyPayment`. If opted-in & hand=0 → fail.
3. **Crescent Guardian** `unl-122-219` — "if you've played a spell this turn, you may pay Chaos as additional cost; if you do, I enter ready." NEW `PlayerState.spellPlayedThisTurn` (set in PLAY_SPELL + counter path; reset beginTurn). Gate the optional Chaos cost on it; `entersReady |= paidAdditional`. Discount-to-0 still counts as paid (rules 1886-94). HELD.
4. **Safety Inspector** `unl-164-219` — "you may spend 3 XP as additional cost; each player must kill one of their units; if you paid, you don't." Bespoke after placement: if `payAdditionalCost` & xp≥3 → −3 XP, paidXp. Each non-out player kills lowest-Might unit; skip controller if paidXp. `fireDeaths` all at once. skipGenericApply (don't let generic parse "each player must kill").
5. **Atakhan** `unl-170-219` — "you may kill a friendly unit as additional cost; if you do, costs 1E less per its Energy and 1 Order less per its Power. [Ganking](done). When I attack, the defender must kill one of their units here." HELD. PLAY_UNIT: optional kill (auto-pick lowest-Might friendly), discount from victim's PRINTED base cost (`effCost.energy-=printedEnergy`, `effCost.power.order = max(0, order - totalPipCount)`), kill after placement. Attack trigger (fireTriggers, new bespoke, srcName 'Atakhan'): defender at Atakhan's bf auto-kills their lowest-Might unit there.

### Bespoke move/swap/grant + combat
6. **Kato the Arm** `sfd-112-221` — "[Deflect]. when I move to a battlefield, give another friendly unit my keywords + Might=my Might this turn." NEW `EngineCard.grantDeflect?:number` (clear in BOTH end-of-turn spreads ~7234/7237; add to `deflectSurcharge` ~4388). Bespoke `move` self-trigger (after Irresistible Faefolk ~1509): auto-pick strongest other friendly anywhere; grant Kato's keywords (deflect/ganking/assault/shield/tank via grant* fields) + `tempMight += mightOf(kato)`.
7. **Tideturner** `ogn-199-298` — "[Hidden]. when you play me, you may choose a unit you control at ANOTHER location; swap locations." HELD. Per auto-resolve preference → AUTO-PICK strongest friendly unit at another location (no modal). Swap via Azir pattern (pullFrom splice both, place each at other's old loc), `recomputeControllers`, `showdownOrConquerAfterEffectMove` for each affected bf (snapshot priorController BEFORE). Wire in PLAY_UNIT bespoke AND REVEAL_HIDDEN path. Swap does NOT change ready/exhausted and does NOT fire move triggers.
8. **Ava Achiever** `ogn-107-298` — "when I attack, you may pay Mind to play a [Hidden] card from hand, ignoring cost; if unit, play here." Bespoke attack trigger (after Yuumi ~1593): if a ready mind rune & a [Hidden] hand card → recycle the mind rune, auto-pick strongest [Hidden] unit (else any [Hidden] card), play it (unit→Ava's bf exhausted + onPlayEffect + firePlayTriggers; gear→base; spell→resolve+trash). skipGenericApply 'Ava Achiever'.

### Trigger plumbing / passives
9. **Mageseeker Investigator** `unl-163-219` — "opponents must pay rainbow per unit beyond the first to move multiple units to my bf at once." moveUnits (~3219, after clone): if `iids.length>1`, COUNT opponent Investigators at `toBattlefield` (they STACK — correction), `tax = (iids.length-1) * count`; `makeBfApi(s).payPowerAny(player, tax)` else `fail`. Standard move only (effect-moves untaxed).
10. **Void Hatchling** `sfd-018-221` — "if you would reveal cards from a deck, look at top first, may recycle, then reveal." NOT a replacement effect (correction). Passive: while controller has Hatchling, before THEIR OWN reveal-from-deck splice (the four applyParsed reveal paths ~822-926), peek top of the revealing deck + may recycle. Does NOT fire on opponent self-reveals (Blind Fury). Auto-resolve: recycle is a genuine info choice → but per auto-resolve keep it simple (auto-recycle nothing OR a single Vision-style decision). Implement minimal: peek + auto-keep (flagged), or reuse vision prompt. LOWER priority / most architecturally awkward (synchronous applyParsed).
11. **Last Rites** `sfd-150-221` — gear. TWO gaps (correction): (a) "[Equip] — Chaos, Recycle 2 from trash" — the Recycle-2 additional equip cost is NOT enforced (keywords.ts:141-142); add to ATTACH reducer (~6151): require trash≥2, move 2 trash→deck. (b) gear-as-trigger-source: the gear's own "When I conquer/hold" does NOT currently fire from an attached gear (known open bug). Play-from-trash auto-resolves (NOT a modal — project policy).

### Predict-2 + snapshot
12. **Dramatic Visionary** `unl-062-219` — "[Deathknell] Predict 2 (look top 2, recycle any, rest back in any order)." Bespoke death handler (~1645) + skipGenericApply. Simplify to one ChoiceModal: pick which top card to recycle (or none); kept order preserved (flagged simplification). Fire `recycleCard` global trigger if any recycled. Guard `if(!s.pendingChoice)` (Karthus double).
13. **Svellsongur** `sfd-059-221` — gear, FLAGGED snapshot approximation. NEW `MatchState.svellsongurSnapshot?: Record<gearIid,string>`; set host text on attach (`fireAttachEquip` ~2491), clear on detach/death; in gear-trigger collection sites substitute `{...gCard, text: snapshot}`. Activated-ability forwarding deferred. LOWEST priority.

## Verifier corrections applied
- Immortal Phoenix: multi-copy each triggers; entry base-or-bf (enhancement, deferred).
- Last Rites: pendingChoice claim WRONG → auto-resolve; gear-trigger-source is a real open bug.
- Void Hatchling: NOT a replacement effect; no Blind Fury interception.
- Mageseeker Investigator: multiple copies STACK additively.
