# Riftbound Mechanics & Symbols — engine vocabulary + gaps

Last verified 2026-06-06.

---

## A. Symbols & Icons (`:rb_*:` glyphs)

| Symbol / icon | Glyph token | Meaning | Engine handling |
|---|---|---|---|
| Wild Power (rainbow swirl) | `:rb_rune_rainbow:` | Power pip of any domain — satisfies any single domain requirement | Recognized: parsed by `accelerateCost()` / `repeatCost()` into `KeywordCost.power` |
| Energy cost (numeral in circle) | `:rb_energy_0:` … `:rb_energy_7:` | Domain-neutral play cost | Recognized: stored in `Card.energy`; parsed in ability text |
| Might (sword/shield glyph) | `:rb_might:` | Unit combat stat | Recognized: `MIGHT` regex constant `(?::rb_might:\|might)` in effects.ts |
| Exhaust (sideways arrow) | `:rb_exhaust:` | Tap cost or trigger | Recognized: activation costs parsed in engine.ts |
| Domain Power — Fury | `:rb_rune_fury:` | One Fury Power pip | Recognized: `"fury"` key in `Card.power` and `KeywordCost.power` |
| Domain Power — Calm | `:rb_rune_calm:` | One Calm Power pip | Recognized: `"calm"` — same as Fury |
| Domain Power — Mind | `:rb_rune_mind:` | One Mind Power pip | Recognized: `"mind"` — same as Fury |
| Domain Power — Body | `:rb_rune_body:` | One Body Power pip | Recognized: `"body"` — same as Fury |
| Domain Power — Order | `:rb_rune_order:` | One Order Power pip | Recognized: `"order"` — same as Fury |
| Domain Power — Chaos | `:rb_rune_chaos:` | One Chaos Power pip | Recognized: `"chaos"` — same as Fury |
| Buff counter | (text only) | +1 Might permanent counter; max one per unit; spendable resource | Recognized: `ParsedEffect.buff`, `buffSelf`, `buffExcludesSelf`, `spendBuff` |
| Gold gear token | (text only) | Gear token worth 1 Power (any domain) when destroyed | Recognized: `ParsedEffect.goldTokens`; engine spawns token objects |
| Recruit unit token | (text only) | Vanilla unit token at a battlefield | Recognized: `ParsedEffect.recruits`; spawned automatically |
| Named unit tokens (Sprite, Sand Soldier, Bird, Mech) | (text only) | Specific unit tokens with defined Might | Recognized: `ParsedEffect.namedToken` with `name`, `count`, `exhausted`, `temporary`, `here` |
| `[>]` activated-ability marker | `[>]` | Separates cost from effect in activation lines | Recognized: `\[(?:&gt;\|>)\]` regex in effects.ts |

---

## B. Keywords (`parseKeywords` / `Keywords` interface)

| Keyword | Rule summary | Engine field |
|---|---|---|
| `[Tank]` | Must receive lethal before non-Tank defenders | `Keywords.tank: boolean` |
| `[Shield N]` | +N Might while defending | `Keywords.shield: number` |
| `[Assault N]` | +N Might while attacking | `Keywords.assault: number`; `grantAssault` / `grantAssaultHere` for temporary grants |
| `[Deflect N]` | Opponents pay +N to target this unit | `Keywords.deflect: number` |
| `[Accelerate]` | Optional cost — enters ready if paid | `Keywords.accelerate: boolean`; cost parsed by `accelerateCost()` |
| `[Repeat]` | Optional cost — resolve spell effect again | `Keywords.repeat: boolean`; cost parsed by `repeatCost()` |
| `[Ambush]` | Play at Reaction speed to a contested battlefield | `Keywords.ambush: boolean` |
| `[Ganking]` | Move directly between battlefields | `Keywords.ganking: boolean`; `grantGanking` for temporary grants |
| `[Hidden]` | Play facedown; reveal = play for 0 | `Keywords.hidden: boolean`; facedown/flip state tracked |
| `[Hunt N]` | Gain N XP when conquering or holding | `Keywords.hunt: number` |
| `[Legion]` | Bonus if another card already played this turn | `Keywords.legion: boolean`; gates on `cardsPlayedThisTurn` |
| `[Level N]` | Buff/keyword active when controller has ≥ N XP | `Keywords.level: number`; `keywordsAt()` gates post-level keywords |
| `[Quick-Draw]` | Gear attaches at Reaction speed | `Keywords.quickDraw: boolean` |
| `[Reaction]` | Play during a Closed State | `Keywords.reaction: boolean` |
| `[Action]` | Play during an Open State / showdown | `Keywords.action: boolean` |
| `[Vision]` | Look at top card(s) of deck on play | `Keywords.vision: boolean` |
| `[Predict]` | Look at top card; may recycle | `Keywords.predict: boolean` |
| `[Weaponmaster]` | Auto-attaches gear on enter-play | `Keywords.weaponmaster: boolean` |
| `[Backline]` | Excluded from frontline combat damage | `Keywords.backline: boolean` |
| `[Temporary]` | Defeated at start of controller's next turn | `Keywords.temporary: boolean` |
| `[Equip]` | Gear — attaches to a unit; lower text activates | `Keywords.equip: boolean` |
| `[Deathknell]` | Trigger on this unit's defeat | `Keywords.deathknell: boolean` |
| `[Stun]` | Exhaust target; skip next ready | `ParsedEffect.stun: number`; engine skip-ready in beginning-phase |

---

## C. Trigger Events (`TriggerEvent` union)

`play`, `conquer`, `hold`, `death`, `startOfTurn`, `attack`, `defend`, `move`, `winCombat`, `stun`, `enemyDeath`, `discard`, `recycleRune`, `recycleCard`, `spendBuff`, `becomesState`

---

## D. Condition Kinds

`handAtMost`, `handAtLeast`, `unitsHereAtLeast`, `xpAtLeast`, `excessAtLeast`, `controlsTribe`, `allTribeTags`, `wasMighty`, `diedAlone`, `diedNotAlone`, `oppScoreWithin`

---

## E. Parsed Effect Verbs (auto-resolvable)

`draw`, `discard`, `channel`, `addEnergy`, `addPower`, `stun`, `score`, `gainXp`, `ifTargetStunned`, `killMightMax`, `drawPerBattlefield`, `drawPerMighty`, `grantAssault`, `grantGanking`, `grantAssaultHere`, `damage`, `recruits`, `recruitsHere`, `goldTokens`, `namedToken`, `readyUnits`, `readyAllUnits`, `readyOrExhaustLegend`, `readySelf`, `readyExcludesSelf`, `strikeDown`, `dealMight`, `readyRunes`, `buff`, `buffSelf`, `buffExcludesSelf`, `buffAll`, `spendBuff`, `kill`, `tempMight`, `tempMightSelf`, `tempMightAll`, `tempMightAllEnemy`, `tempMightTag`, `tribeTagCount`, `bounce`, `moveToBase`, `moveUnit`, `deathShield`, `banishOnDeath`, `returnFromTrash`, `opponentHandStrip`, `opponentDiscards`, `playUnitFromTrash`, `playUnitFromHand`, `playSpellFromTrash`, `revealPlayFromDeck`, `peekDraw`, `peekToHand`, `peekBanishPlay`, `channelExhausted`, `drawOnKill`, `cullEachPlayer`, `controllerDrawOnKill`, `tempMightFloor`

---

## F. Completed Mechanics (post gap-fix and deferred-cards campaigns)

- Conditional `enterReady` evaluator (`enterReadyConditionMet`, engine.ts:2070)
- Tribe/tag counting and tag conditions (`controlsTribe`, `allTribeTags`, `tribeTagCount`)
- `playSpellFromTrash` path (Fizz - Trickster, Kai'Sa - Evolutionary)
- `recruitsHere` token placement
- Positional keyword auras: Captain Farron, Jax - Unmatched (Equipment everywhere `[Quick-Draw]`)
- Conditional/dynamic keywords: `discardedThisTurn` gate (Raging Soul), Ancient Warmonger dynamic Assault count
- Gear `onPlayEffect` dispatch (Forge of the Future, Shurelya's Requiem, Edge of Night, Gutter Palace)
- Opponent-directed spawns and opponent-turn gate (Walking Roost, Viktor - Innovator, Noxus Saboteur)
- `recycleRune`, `recycleCard`, `spendBuff`, `becomesState` trigger events
- `xpGainedThisTurn` flag + Wily Newtfish
- `fromHidden` play-flag filter + Ember Monk
- Weaponmaster gear re-seat (can re-attach already-attached gear)
- `STATES` registry + `stateActive()` + `becomesState` transition trigger + `[Mighty]` gaps (Fiora Victorious/Worthy/Grand Duelist, Volibear, Kadregrin)
- Gear keyword/trigger propagation to host unit (equipment overhaul Phases 1–3)
- Generic `attachEquip` event generalized beyond Aphelios name-check
- Vex - Cheerless in-combat enemy-spell cost-up aura (confirmed in `autopay.ts`)
- Cost-shaping Tiers 1–3 + counter-unless-pay (Hard Bargain) + score-proximity discount
- `cardsPlayedThisTurn` counter (Legion gating)
- `dealMight` effect; Spirit's Refuge; Kha'Zix enemy-alone fix
- Full deferred-cards plan Phases 1–4d: Yone, Twisted Fate - Gambler, Teemo - Strategist, Adaptatron, Blitzcrank hold-recall, Rell - Magnetic, Jax - Unmatched, Teemo - Swift Scout, Gearhead, Rek'Sai - Breacher, Royal Entourage, Strike Down, Azir - Ascendant, Bard - Mercurial, Jax - Grandmaster At Arms, Heimerdinger - Inventor, Ivern - Green Father

---

## G. STILL MISSING / NOT YET IMPLEMENTED

**27 distinct gaps** across 12 themes. Priorities: **High** = cross-cutting primitive; **Med** = named champion or multi-card; **Low** = single bespoke card.

---

### G1. Damage and Lethality

#### `damageLethality` replacement aura
- **Real rules**: While Elder Dragon's controller has any damage marked on an enemy unit (even 1), that damage is lethal. Also on play: deal 1 to one enemy per location.
- **Cards**: Elder Dragon (`unl-118-219`)
- **Current support**: None. Death-check has no lethality-replacement hook; multi-location on-play targeting unimplemented.
- **Priority**: Low (1 card)
- **Source**: https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/unleashed-rules-faq-and-clarifications/

#### `killWithSpell` trigger event
- **Real rules**: Alt-cost to play Immortal Phoenix from trash fires when a unit is killed by a spell; requires kill-source metadata on the kill event.
- **Cards**: Immortal Phoenix (`ogn-037-298`)
- **Current support**: `playFromTrashPayingCost` helper exists; no `killWithSpell` TriggerEvent.
- **Priority**: Low (1 card)

#### Volibear - Furious flat-5 split damage
- **Real rules**: Deal 5 damage split among enemies — flat count, not Might-equal; differs from `dealMight`.
- **Cards**: Volibear - Furious (`ogn-041-298`)
- **Current support**: None for flat-split damage distinct from `dealMight`.
- **Priority**: Low (1 card)

#### Sivir - Ambitious excess-damage redirect
- **Real rules**: On conquer, deal the excess damage amount to the strongest enemy in a base.
- **Cards**: Sivir - Ambitious (`sfd-120-221`)
- **Current support**: None.
- **Priority**: Low (1 card)

---

### G2. Targeting and Protection

#### `targetingImmune` flag
- **Real rules**: Unit cannot be chosen as the target of opponent-controlled spells or activated abilities. Board-wides still apply; combat damage still applies. Distinct from `[Deflect N]` which merely adds a surcharge.
- **Cards**: Baron Nashor (`unl-147-219`), Ruin Runner (`sfd-105-221`)
- **Current support**: None.
- **Priority**: Med (2 cards; Baron Nashor is a major landmark)
- **Source**: https://www.facebook.com/groups/riftboundrulesandfaqs/posts/2110208349827347/

#### `chosenAsTarget` / `on.targeted` trigger event
- **Real rules**: "When you choose me with a spell, draw 1" (Jae Medarda); "when chosen by your own spell/ability, gain a buff" (Irelia - Fervent, The Dreaming Tree).
- **Cards**: Jae Medarda (`sfd-142-221`), Irelia - Fervent, The Dreaming Tree
- **Current support**: None. No `targeted` TriggerEvent exists.
- **Priority**: Med (several cards)

---

### G3. Auras and Static Buffs

#### Generic global-friendly `staticMightAura`
- **Real rules**: While named unit is in play, all friendly units everywhere gain +N permanent Might (continuous aura, not a triggered buff). Distinct from `conditionalMight` (positional/role-scoped) and `auraMightBonus` (tag-scoped).
- **Cards**: Baron Nashor (+2 Might to all friendly units)
- **Current support**: `auraMightBonus` exists for Mech-tag scope; no global-friendly path.
- **Priority**: Med (Baron Nashor is a top-played legend)

#### Lucian - Purifier Equipment-type keyword aura
- **Real rules**: "Your Equipment each give [Assault]" — Equipment-type-scoped aura using "give" verb.
- **Cards**: Lucian - Purifier (`sfd-183-221`)
- **Current support**: Captain Farron positional aura and Jax - Unmatched equipment-everywhere aura done; Lucian's Equipment-give variant remains open.
- **Priority**: Med (1 card; clean Equipment-verb gap)

#### Magma Wurm "other friendly units enter ready" aura
- **Real rules**: While Magma Wurm is on the battlefield, other friendly units enter play ready (not exhausted).
- **Cards**: Magma Wurm (`ogn-011-298`)
- **Current support**: None. `PLAY_UNIT` `entersReady` logic does not scan controlled permanents for this aura.
- **Priority**: Med (affects every subsequent unit played while it is alive)

#### Mageseeker Warden dual-restriction aura
- **Real rules**: While at a battlefield — (1) opponents can only play units to their base; (2) spells and abilities cannot ready enemy units or gear.
- **Cards**: Mageseeker Warden (`ogn-070-298`)
- **Current support**: None. `PLAY_UNIT` has no "opponents must play to base" check; ready logic has no "can't be readied" aura check.
- **Priority**: Med (strong competitive card; complete mis-implementation)
- **Source**: https://riftbound.wiki.fextralife.com/OGN-070_Mageseeker_Warden

#### Ezreal - Prodigy optional-cost aura (Tier 4 cost-shaping)
- **Real rules**: Aura that reduces costs for friendly units when the player pays an optional cost at play-time.
- **Cards**: Ezreal - Prodigy
- **Current support**: Tiers 1–3 cost-shaping complete; Tier 4 explicitly deferred.
- **Priority**: Low (1 card)

---

### G4. Movement Restrictions

#### `movementRestriction` — "Units can't move to base" (global)
- **Real rules**: While Minotaur Reckoner is in play, no unit from either player can move to base.
- **Cards**: Minotaur Reckoner (`sfd-014-221`)
- **Current support**: None. `moveUnitToBase` has no restriction-flag check.
- **Priority**: Med (board-locking; completely changes game flow)
- **Source**: https://riftbound.gg/cards/sfd-014-minotaur-reckoner/

#### `movementRestriction` — "I can't move to base" (self)
- **Real rules**: Determined Sentry cannot move to its own base.
- **Cards**: Determined Sentry (`unl-111-219`)
- **Current support**: None.
- **Priority**: Low (1 card, self-scoped)

#### `readyRestriction` — "I can't be readied"
- **Real rules**: Maduli the Gatekeeper's own readying via any effect or the beginning phase is blocked. Also has an activated conditional-Might self-move ability.
- **Cards**: Maduli the Gatekeeper (`unl-144-219`)
- **Current support**: None. `beginTurn` ready-sweep does not check restriction flags.
- **Priority**: Low (1 card)

---

### G5. Once-Per-Turn Gates

#### Generic `oncePerTurnGate`
- **Real rules**: A trigger fires at most once per turn (either player's turn), regardless of how many times the condition is met. Resets at each turn start.
- **Cards**: Wraith of Echoes (`ogn-118-298`) — "first time a friendly unit dies each turn, draw 1"; Lucian - Merciless (`sfd-113-221`) — "first time I conquer each turn, ready me"
- **Current support**: Zilean-specific per-turn flag and Azir - Ascendant bespoke once-per-turn check exist; no general-purpose per-trigger-key gate.
- **Priority**: **High** — cross-cutting primitive; unblocks multiple cards with a single mechanism

---

### G6. Turn-Counter Gaps

#### `energySpentOnSpellsThisTurn` counter
- **Real rules**: Running total of Energy spent on spells this turn; used as a condition gate and as an alt-cost trigger.
- **Cards**: Prepared Neophyte (`unl-004-219`) — "if you've spent 4+ Energy on a spell this turn"; Jhin - Meticulous Killer (`unl-089-219`) — alt flat cost if threshold met
- **Current support**: `cardsPlayedThisTurn` exists; no spell-energy tracker.
- **Priority**: Med (2+ cards; counter is simple to add)

#### "Second card played this turn" trigger
- **Real rules**: Fires on exactly the 2nd card played this turn (`cardsPlayedThisTurn === 1` before increment).
- **Cards**: Darius - Trifarian (`ogn-027-298`)
- **Current support**: Counter exists but no trigger wired to "second card" crossing.
- **Priority**: Med (1 card; leverages existing counter)

#### Battering Ram `cardsPlayedThisTurn` discount scalar
- **Real rules**: "−1 Energy per card played this turn" — counter used as a cost scalar.
- **Cards**: Battering Ram (`sfd-012-221`)
- **Current support**: Counter exists; scalar discount path in `effectiveCostOf` not wired for this card.
- **Priority**: Low (1 card)

---

### G7. Non-Standard On-Play and Placement

#### `placementPredicate` — play to open/empty battlefield
- **Real rules**: "You may play me to an open battlefield" — an unoccupied battlefield (no units from either side).
- **Cards**: Sneaky Deckhand (`ogn-176-298`), Miss Fortune - Buccaneer (`ogn-193-298`)
- **Current support**: Engine allows play to any battlefield; empty-slot constraint unenforced. Miss Fortune's all-friendly aura also unimplemented.
- **Priority**: Med (2 cards; Miss Fortune is a named champion)

#### `placementPredicate` — play to occupied enemy battlefield (Ambush-style trigger)
- **Real rules**: Dauntless Vanguard must be placed directly at a battlefield the opponent controls, immediately initiating showdown.
- **Cards**: Dauntless Vanguard (`sfd-093-221`)
- **Current support**: None. Non-Ambush units have no engine path to play directly to a battlefield and initiate combat.
- **Priority**: Med (1 card; combat-initiating edge case)
- **Source**: https://riftbound.gg/cards/sfd-093-dauntless-vanguard/

#### `placementPredicate` — play only to battlefield conquered this turn
- **Real rules**: Perched Grimwyrm can only be played to a battlefield conquered this turn; requires a `conqueredThisTurn` set on `PlayerState`.
- **Cards**: Perched Grimwyrm (`sfd-015-221`)
- **Current support**: None.
- **Priority**: Low (1 card)

#### Blitzcrank - Impassive battlefield pull (on-play)
- **Real rules**: When played directly to a battlefield, move an enemy unit at that battlefield here.
- **Cards**: Blitzcrank - Impassive (`ogn-067-298`)
- **Current support**: `canPlayToBf` check exists (hold-recall done); engine comment at engine.ts:4886–4889 explicitly flags the pull trigger as missing.
- **Priority**: Low (1 card; intentional deferred gap)

---

### G8. Transient Keyword Grants

#### `grantShield` this-turn keyword grant
- **Real rules**: Give a chosen unit `[Shield]` for this turn only.
- **Cards**: Chakram Dancer (`unl-071-219`)
- **Current support**: `grantAssault`, `grantGanking`, `grantAssaultHere` exist; no `grantShield` in `ParsedEffect` or transient-grant tracking.
- **Priority**: Med (1 card; `[Shield]` is a defense-phase keyword with meaningful impact)

#### `grantTank` this-turn keyword grant
- **Real rules**: Give a chosen unit `[Tank]` for this turn only (must receive lethal before non-Tank defenders).
- **Cards**: Yuumi - Magical Cat (`unl-056-219`) — on attack/defend give another unit +3 Might and `[Tank]` this turn
- **Current support**: None. `UnitState` tracks `grantGanking` but has no transient Tank grant.
- **Priority**: Med (Yuumi is a named champion; `[Tank]` changes combat assignment order)

---

### G9. Equipment Edge Cases

#### Gear-scoped kill/bounce targets (`killGear`, `bounceGear`)
- **Real rules**: Kill or bounce a gear (attached or unattached) as a distinct targeting category from killing units.
- **Cards**: Disarming Rake (`sfd-032-221`), Zaun Punk (`sfd-160-221`), Legion Quartermaster (`sfd-044-221`), Jayce - Man of Progress (`sfd-084-221`), Pickpocket (`sfd-074-221`)
- **Current support**: `kill` targets units only; no gear-scoped kill/bounce in `ParsedEffect`; `RESOLVE_CHOICE` has no gear-kill path.
- **Priority**: **High** — 5 cards across multiple sets; anti-equipment archetype cannot function

#### Gear-as-trigger-source (`gearTriggerSource`)
- **Real rules**: A gear attached to a unit should fire its own conquer/hold triggers using the gear's `iid`, not the host unit's.
- **Cards**: Last Rites (gear with `playUnitFromTrash` conquer/hold trigger)
- **Current support**: `controlledPermanents` surfaces gear with its own `iid`; conquer/hold event collection uses the host unit's iid.
- **Priority**: Med (1 card; fix unlocks correct gear-trigger semantics broadly)

#### Svellsongur runtime ability copy
- **Real rules**: While attached, the gear exposes the host unit's printed abilities as its own (runtime text-copy from host to gear).
- **Cards**: Svellsongur (`sfd-059-221`)
- **Current support**: Card text in dataset; no engine handler exists. Intentional architectural deferral.
- **Priority**: Low (1 card; architecturally complex)

---

### G10. Trigger Event Gaps

#### `buffEvent` — "when you buff me" trigger
- **Real rules**: Fires when any buff is applied to the named unit.
- **Cards**: Simian Ancestor (`sfd-047-221`) — "when you buff me, ready me"
- **Current support**: No `buff` entry in `TriggerEvent` union.
- **Priority**: Med (1 card; buff events are common flavor)

#### `globalDefendEvent` — other units reacting to any friendly defend
- **Real rules**: Fires when any friendly unit defends at any battlefield, allowing other units to react.
- **Cards**: Loyal Pup (`sfd-126-221`) — "when you defend at a battlefield, move me there"
- **Current support**: `defend:self` exists; no global defend trigger for other units.
- **Priority**: Low (1 card)

---

### G11. Persistent and Cascading Effects

#### `banishAndReturnOnHold` (Ashe - Focused)
- **Real rules**: On play, strip a card from opponent's hand and banish it. When that opponent holds, return the banished card to their hand — even if Ashe is no longer in play.
- **Cards**: Ashe - Focused
- **Current support**: `opponentHandStrip` half handled; no per-card persistent "return-on-hold" state.
- **Priority**: Med (Ashe is a named champion; half-implemented is worse than not)

#### `forcedDiscardCascade`
- **Real rules**: When an opponent is forced to discard (Mindsplitter, Sabotage, Bewitching Spirit, etc.), the victim's discard-triggered abilities should fire.
- **Cards**: Mindsplitter, Sabotage, Bewitching Spirit, and any future forced-discard sources
- **Current support**: `opponentHandStrip` and `opponentDiscards` execute the discard without firing victim's `discard` triggers.
- **Priority**: Med (cross-cutting; affects every forced-discard card vs. discard-trigger decks)

#### Insightful Investigator XP-as-resolution-cost gate
- **Real rules**: "You may pay 2 XP" mid-resolution (costs within instructions, per FAQ).
- **Cards**: Insightful Investigator (`unl-135-219`)
- **Current support**: No XP-cost-within-resolution mechanism.
- **Priority**: Low (1 card; unusual pattern)
- **Source**: https://riftbound.gg/cards/unl-135-insightful-investigator/

---

### G12. Single-Card Bespoke Gaps

| Card | Gap | Priority |
|---|---|---|
| Arise! (`sfd-198-221`) | Sand Soldier count scales by Equipment count; "ready them" pronoun unmatched | Low |
| The List (`unl-138-219`) | Free-form tag-naming at play + per-tag filtered −Might activation | Low |
| Vex - Mocking (`unl-055-219`) | Post-stun self-move to that battlefield | Low |
| Carnivorous Snapvine (`ogn-149-298`) | On-play mutual `dealMight` where self is the dealer | Low |
| Caitlyn - Patrolling (`ogn-068-298`) | Activated `dealMight` + "assigned combat damage last" ordering flag | Low |
| Draven - Showboat | Dynamic Might scaling per point scored (partial bespoke only) | Low |
| Dr. Mundo | Dynamic Might scaling per card in trash (partial bespoke only) | Low |

---

## H. Deferred-Cards Plan Status

`docs/riftbound-analysis/deferred-cards-plan.md` is **largely obsolete as an active work queue**.

Code-level verification confirms **23 of 25** originally tracked items are fully implemented, including Heimerdinger - Inventor (via `heimerBorrow` pendingChoice flow in engine.ts:5560–5592, three passing tests) — which the plan's "Final deferrals" section still erroneously lists as deferred.

**Two items remain genuinely unimplemented from the plan:**

1. **Blitzcrank - Impassive — battlefield pull** (`ogn-067-298`): the on-play "move an enemy unit to here" when Blitzcrank is placed directly at a battlefield. Explicitly flagged by an engine comment at engine.ts:4886–4889. `canPlayToBf` check exists; pull trigger never fires.

2. **Svellsongur** (`sfd-059-221`): runtime ability-copy gear; card text in dataset, zero engine handling. Architecturally complex intentional deferral.

Both are single-card, low-impact gaps. The plan should be updated to mark Heimerdinger as done and reclassify these two as tracked-but-intentionally-deferred. After that update the document can be retired as an active task list and kept only as reference documentation.

---

## Sources

1. Unleashed FAQ — https://riftbound.leagueoflegends.com/en-us/news/rules-and-releases/unleashed-rules-faq-and-clarifications/
2. Baron Nashor FAQ — https://www.facebook.com/groups/riftboundrulesandfaqs/posts/2110208349827347/
3. Mageseeker Warden wiki — https://riftbound.wiki.fextralife.com/OGN-070_Mageseeker_Warden
4. Minotaur Reckoner card — https://riftbound.gg/cards/sfd-014-minotaur-reckoner/
5. Dauntless Vanguard card — https://riftbound.gg/cards/sfd-093-dauntless-vanguard/
6. Insightful Investigator card — https://riftbound.gg/cards/unl-135-insightful-investigator/
7. Keyword parser — `src/engine/keywords.ts`
8. Effect parser — `src/engine/effects.ts`
9. Card data — `src/data/cards.generated.json`
10. HTML symbol reference — `Riftbound Icons_ Every Card Symbol Explained.html` (captured 2026-04-10)

See also: [[handler-coverage-report]], [[nonstandard-unit-cards-audit]], [[tag-engine-audit]], [[deferred-cards-plan]]
