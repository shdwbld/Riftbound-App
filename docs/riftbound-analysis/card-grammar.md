# Card Grammar & Phrase-Identification Framework

> **Purpose.** Decode what a Riftbound card *intends to do* from its English text,
> so the simulator can **compose behavior from tagged phrases** instead of
> hand-coding each card. This is the design hypothesis the engine's parser
> (`effects.ts` / `keywords.ts` / `triggers.ts`) already half-implements; this doc
> formalizes it, enumerates the **conditional vocabulary explicitly as IF/THEN**
> (the hardest part to model), and maps every element to an existing engine handler
> or marks it a gap.

Inputs: the engine catalog (effects/keywords/triggers/ACTIVATE_UNIT), the
phrase-family taxonomy (1,064 cards; ~73% fit known families, ~27% long tail), and
`mechanics-and-symbols.md`.

---

## 1. The core idea

A card's rules text is a small, **regular language**. Almost every ability is one or
more **ability blocks**, and each block is a fixed sequence of slots:

```
ABILITY BLOCK  ::=  [KIND] · [TRIGGER?] · [CONDITION?] · [COST?] · EFFECT+ · [TARGET?] · [DURATION?]
```

- A card = **identity** (cost/type/domain/Might) + an ordered list of ability blocks.
- A block's **behavior** is the composition of the **tags** filling its slots.
- We only need to recognize the *slot vocabularies*; the long tail (~27%) sets an
  explicit `manual` flag so the UI/Override can resolve it without blocking play.

This is the difference between "program 1,064 cards" and "recognize ~7 slot
vocabularies of ~15–40 tags each." A new card with familiar phrasing needs **zero**
new code.

---

## 2. Card anatomy (the identity layer)

Read straight from the card frame / data fields — no NLP needed (see
`mechanics-and-symbols.md` for glyph placement):

| Part | Source | Tag(s) |
|------|--------|--------|
| **Type** | unit / spell / gear / rune / legend / battlefield | `type:*` |
| **Domain identity** | top-left glyphs (legend) / card domains | `domain:fury…chaos`, `domain:wild` |
| **Cost** | Energy numeral (`:rb_energy_N:`) + Power glyphs (`:rb_rune_*:`, stacked = ×N, divider = OR) | `cost.energy:N`, `cost.power:{domain:N}`, `cost.alt:[…]` |
| **Might** | unit/gear stat (`:rb_might:`) | `might:N` |
| **Static keywords** | `[Tank] [Shield N] [Assault N] [Deflect N] [Ganking] [Backline] [Hidden] [Legion] [Accelerate] [Repeat] [Ambush] [Quick-Draw] [Reaction] [Action] [Weaponmaster] [Equip] [Temporary] [Level N]` | `kw:*` (already parsed by `keywords.ts`) |

Keywords gated behind `[Level N]` apply only at `xp ≥ N` (`keywordsAt`).

---

## 3. The clause grammar (the ability layer)

### Slot 1 — KIND (how the ability activates)

| Tag | English markers | Engine today |
|-----|-----------------|--------------|
| `static` | no trigger/cost; a continuous truth ("Other friendly units here have [Assault]") | partial — only some auras (`grantAssaultHere`, Soul Shepherd) |
| `triggered` | "When/Whenever/After/At the start …" | ✅ `triggers.ts` PATTERNS |
| `activated` | "`<cost glyphs>`: `<effect>`" (the `::`/`[>]` separator) | ✅ `unitActivatedAbility` + `ACTIVATE_UNIT` |
| `replacement` | "instead of …", "If … would …" | ❌ none |

### Slot 2 — TRIGGER (the event), only for `triggered`

| Tag | English | Scope | Engine |
|-----|---------|-------|--------|
| `on.play` | "When you play a `<type/name>`" / "When I'm played" | self/global | ✅ (`playTriggerMatches` filters by type/cost) |
| `on.death` | "When I'm killed/defeated/dies" / `[Deathknell]` | self | ✅ |
| `on.death.ally` | "When another unit you control dies" | global | ✅ |
| `on.conquer` | "When I conquer" / "When you conquer" | self/global | ✅ |
| `on.hold` | "When I/you hold" | self/global | ✅ |
| `on.attack` / `on.defend` | "When I attack/defend" | self | ✅ |
| `on.winCombat` | "When I win a combat" | self | ✅ |
| `on.move` | "When I move" | self | ✅ |
| `on.startPhase` | "At the start of your Beginning/Main/End Phase" | global | ✅ (start-of-turn) — phase granularity is **partial** |
| `on.stun` | "When you stun an enemy unit" | global | ⚠️ stun is an effect, no trigger event |
| `on.discard` | "When you discard me / a card" | self/global | ❌ none |
| `on.spend` | "When you spend / play your 2nd card this turn" | global | ❌ none |

### Slot 3 — CONDITION (the IF gate) — **enumerated explicitly**

The user's key concern: **conditional triggers must be stated as IF/THEN and modeled
explicitly.** Each condition is a canonical tag + a truth-condition over game state.
The engine has 5 today (`conditionMet`); the rest are gaps.

| Tag | English phrasings | Truth condition (IF …) | Engine |
|-----|-------------------|------------------------|--------|
| `if.handAtMost(N)` | "if you have N or fewer cards in hand" | `hand.length ≤ N` | ✅ |
| `if.handAtLeast(N)` | "if you have N or more cards in hand" | `hand.length ≥ N` | ✅ |
| `if.unitsHereAtLeast(N)` | "if you have N+ units at that battlefield" | `unitsAt(bf, you).length ≥ N` | ✅ |
| `if.excessAtLeast(N)` | "if you assigned N+ excess damage" | `excess ≥ N` (combat) | ✅ |
| `if.xpAtLeast(N)` | "`[Level N][>]` …" | `you.xp ≥ N` | ✅ |
| `if.playedCardThisTurn` | "if you've played another card this turn", `[Legion]` | `you.cardsPlayedThisTurn ≥ 1` (≥2 if "another"+self) | ⚠️ counter exists; not wired as a condition |
| `if.playedEquipThisTurn` | "only if you've played an Equipment this turn" | `you.playedEquipmentThisTurn` | ✅ (`abilityUsableNow`) |
| `if.spentAtLeast(cost)` | "if you've spent ≥ :rb_X: this turn" | track spend-this-turn ≥ cost | ❌ no spend tracker |
| `if.targetHasNoBuff` | "if it doesn't have a buff" | `target.buffs === 0` | ❌ (buff value exists; not gated) |
| `if.targetMightAtLeast(N)` | "if it has N+ Might" / `[Mighty]` (N=5) | `mightOf(target) ≥ N` | ⚠️ Mighty shown in UI; no condition tag |
| `if.selfHasNoBuff` | "if I don't have a buff" | `self.buffs === 0` | ❌ |
| `if.selfAtBattlefield` | "if I'm at a battlefield" | `battlefieldOf(self) ≥ 0` | ✅ (`requiresBattlefield` for abilities) |
| `if.diedAlone` / `if.notAlone` | "if I died alone", "while a unit defends alone" | count co-located friendlies at event | ❌ |
| `if.controlBattlefield` | "while you control this battlefield" | `bf.controller === you` | ⚠️ controller known; no static condition layer |
| `if.scoreWithin(N)` | "if an opponent's score is within N of Victory" | `pointsToWin − maxOppPoints ≤ N` | ❌ |
| `if.firstThisTurn` | "the first time each turn" | per-turn once-flag on the source | ❌ |
| `unless(cost)` | "unless its controller pays :rb_X:" | offer opponent a pay-to-prevent choice | ❌ |
| `forEach(X)` | "draw 1 **for each** of your [Mighty] units" | multiply effect by `count(X)` | ⚠️ `drawPerBattlefield` only |
| `while(state)` | "[Assault N] = +N while attacking", "while buffed/Mighty/alone" | continuous stat condition during combat | ⚠️ Assault/Shield + `conditionalMight` cover the common ones; generic `while` is a gap |

> **Rule for the parser:** a CONDITION tag always renders to a single boolean (or a
> count for `forEach`). Conditions compose with AND when multiple appear in a clause.

### Slot 4 — COST (for `activated`, and "additional cost" riders)

| Tag | English / glyph | Engine |
|-----|------------------|--------|
| `cost.exhaust` | `:rb_exhaust:` | ✅ |
| `cost.energy(N)` | `:rb_energy_N:` | ✅ |
| `cost.power({d:N})` | `:rb_rune_<d>:` | ✅ |
| `cost.recycleTrash(N)` | "recycle N from your trash" | ✅ |
| `cost.killThis` | "kill this" | ✅ |
| `cost.discard(N)` | "discard N (as an additional cost)" | ❌ |
| `cost.spendBuff` | "spend a buff" | ⚠️ parsed flag; partial |
| `cost.optionalAdditional` | "you may pay X as an additional cost" (`[Accelerate]`) | ✅ for Accelerate/Repeat; generic = ❌ |

### Slot 5 — EFFECT (the verb) — composable, one or more per block

| Tag | English | Engine |
|-----|---------|--------|
| `deal(N)` | "deal N to a unit" | ✅ |
| `kill` / `kill.mightMax(N)` | "kill a unit (with N Might or less)" | ✅ |
| `buff(N)` | "Buff" / "gains +N Might" (permanent) | ✅ |
| `mightTurn(±N)` | "give … ±N Might **this turn**" (self/target/all) | ✅ |
| `draw(N)` / `drawPerBattlefield` | "draw N" | ✅ |
| `channel(N)` / `channelExhausted(N)` | "channel N (exhausted)" | ✅ |
| `recycle(N)` | "recycle N" (from trash/board) | ⚠️ as cost only |
| `returnToHand` | "return/put … to hand" | ✅ |
| `moveToBase` / `moveToBattlefield` | "move … to its base / to a battlefield" | ⚠️ to-base ✅; to-bf ❌ |
| `playToken(kind,N)` | "play N Recruit/Gold/Sprite/Sand Soldier/Bird/Mech token(s)" | ✅ |
| `gainXP(N)` | "gain N XP" | ✅ |
| `score(N)` | "score N point(s)" | ❌ (only conquer/hold scoring) |
| `predict(N)` | "[Predict N]" | ⚠️ peeks 1 (simplified) |
| `attachEquip` | "attach an Equipment to a unit" | ✅ |
| `stun(N)` | "[Stun] a unit" | ✅ |
| `discard(N)` | "discard N" | ❌ |
| `readyUnits(N)` / `readySelf` | "ready a unit / ready me" | ✅ |
| `grantKeyword(kw)` | "give … [Assault/Ganking] this turn" | ⚠️ Assault/Ganking only |
| `costMod(±N)` | "costs N less/more" | ⚠️ in `autopay`, not an effect |
| `cull` | "each player kills one of their units" | ✅ |
| `statScale(stat)` | "My Might is increased by `<dynamic count>`" | ❌ (long tail) |
| `copy` | "becomes a copy of …" (Reflection) | ⚠️ bespoke per card |

### Slot 6 — TARGET (the selector)

| Tag | English | Engine |
|-----|---------|--------|
| `tgt.self` | "me / this" | ✅ |
| `tgt.friendlyUnit` / `tgt.enemyUnit` / `tgt.anyUnit` | "a friendly/enemy/target unit" | ✅ |
| `tgt.unitHere` | "a unit here / at a battlefield" | ⚠️ partial |
| `tgt.allUnits` / `tgt.allHere` | "all units / all units here" | ⚠️ some board-wide |
| `tgt.upToN(N)` | "up to N units" | ✅ (`targetCount`) |
| `tgt.withKeyword(kw)` | "a [Mighty] unit", "a Teemo unit" | ⚠️ name/keyword filter not enforced |

### Slot 7 — DURATION

| Tag | English | Engine |
|-----|---------|--------|
| `dur.thisTurn` | "this turn" | ✅ (`tempMight*`) |
| `dur.permanent` | default for "Buff" / +Might with no duration | ✅ |
| `dur.untilEnd` | "until end of turn/phase" | ⚠️ collapses to thisTurn |
| `dur.static` | continuous (keywords/auras) | partial |

---

## 4. The phrase-tag scheme (how a card decomposes)

A card's machine behavior is the **list of its ability blocks**, each a tag-tuple:

```
block = { kind, trigger?, conditions:[…], cost?, effects:[…], target?, duration? }
```

**Composition rules**
1. Parse identity from data fields (no NLP).
2. Split text into blocks at sentence/`::`/`[>]` boundaries and at trigger leads
   ("When…", "At the start…").
3. For each block, fill slots by matching the slot vocabularies above (longest-match,
   condition clauses are AND-composed).
4. Any block whose EFFECT can't be tagged → set `manual:true` on that block only
   (the rest of the card still works).
5. Render to the reducer: `triggered`→register on the event; `activated`→offer via
   `ACTIVATE_UNIT`; `static`→continuous recompute; `replacement`→intercept.

**Coverage hypothesis** (from the taxonomy): ~73% of cards are fully tag-composable
today's vocabulary; the ~27% long tail needs either (a) a new tag (cheap — extend a
vocabulary) or (b) `manual:true` (free — Override resolves it). The long tail
clusters into: dynamic stat-scaling (`statScale`), branching player choices, cross-zone
moves, healing/prevention, and copy/transform.

---

## 5. Worked examples (hand-parsed, incl. long tail)

| Card (id) | Text (abbrev.) | Parsed blocks |
|-----------|----------------|---------------|
| **Lee Sin - Blind Monk** (ogn-257-298) | "`:rb_energy_1:`,`:rb_exhaust:`: Buff a friendly unit. (If none, +1 Might buff.)" | `{kind:activated, cost:[energy(1),exhaust], effects:[buff(1)], target:friendlyUnit}` ✅ |
| **Lillia - Bashful Bloom** (unl-189-219) | "`:rb_energy_4:`,`:rb_exhaust:`: play a ready 3-Might Sprite with [Temporary]. Costs 1 less per friendly [Temporary] unit." | `{kind:activated, cost:[energy(4)−forEach(if temporary),exhaust], effects:[playToken(sprite,1){ready,temporary}]}` ✅ |
| **Pyke - Bloodharbor Ripper** (unl-185-219) | "`:rb_energy_1:`,`:rb_exhaust:`: Return a friendly unit to hand. Play a Gold gear token exhausted." | `{kind:activated, cost:[energy(1),exhaust], effects:[returnToHand, playToken(gold,1)], target:friendlyUnit}` ✅ |
| **Azir - Emperor of the Sands** (sfd-197-221) | "Sand Soldiers have [Weaponmaster]. `:rb_energy_1:`,`:rb_exhaust:`: play a 2-Might Sand Soldier to base. **Use only if you've played an Equipment this turn.**" | block A `{kind:static, effects:[grantKeyword(weaponmaster)], target:tgt.withKeyword(sand soldier)}` ⚠️; block B `{kind:activated, conditions:[if.playedEquipThisTurn], effects:[playToken(sand soldier,1)]}` ✅ |
| **Garen - Might of Demacia** (ogs-023-024) | "When you conquer, **if you have 4+ units there**, draw 2." | `{kind:triggered, trigger:on.conquer, conditions:[if.unitsHereAtLeast(4)], effects:[draw(2)]}` ✅ |
| **Tryndamere - Barbarian** | "When I conquer after an attack, **if you assigned ≥5 excess damage**, …" | `{kind:triggered, trigger:on.conquer, conditions:[if.excessAtLeast(5)], effects:[…]}` ✅ condition; effect varies |
| **Watchful Sentry** | "[Deathknell] — Draw 1." | `{kind:triggered, trigger:on.death(self), effects:[draw(1)]}` ✅ |
| **Flame Chompers** | "When you discard me, you may pay :rb_rune_fury: to play me." | `{kind:triggered, trigger:on.discard(self), cost:[power(fury)], effects:[playSelf]}` ❌ (no discard trigger, no playSelf) → `manual` |
| **Draven - Showboat** | "My Might is increased by your points." | `{kind:static, effects:[statScale(might ← you.points)]}` ❌ long tail → `manual` |
| **Heimerdinger - Inventor** | "I have all `:rb_exhaust:` abilities of all friendly legends, units, and gear." | `{kind:static, effects:[copyAbilities(scope)]}` ❌ long tail → `manual` |

The first 7 parse cleanly with **today's** vocabulary (some need the gap tags in §3/§5
wired). The last 3 are the genuine long tail → `manual`.

---

## 6. What this buys us (mapping to the engine)

- **`triggered`** blocks → `triggers.ts` already covers 9 events; gaps = `on.discard`,
  `on.spend`, `on.stun`, phase-granular `startPhase`.
- **`conditions`** → only 5 of ~19 are wired (`conditionMet`). The highest-value gaps
  (most cards): `if.playedCardThisTurn`, `if.targetHasNoBuff`, `if.targetMightAtLeast`,
  `if.spentAtLeast`, generic `while(state)`, `forEach`.
- **`effects`** → `ACTIVATE_UNIT`/`applyParsed` cover ~12 verbs; gaps = `discard`,
  `score`, `moveToBattlefield`, generic `costMod`/`grantKeyword`, `statScale`, `copy`.
- **`replacement`** kind and `unless` → entirely unbuilt; needed by prevention/heal
  and "unless controller pays" cards.

Phase 4 (`gap-matrix.md`) ranks these by **how many meta cards** hit each gap, so we
fix the conditions/effects that unblock the most real decks first.

## 7. Recommended next step (Phase 5, later)
A `src/engine/cardIntent.ts` that, given a card, returns `{ identity, blocks[] }` using
these vocabularies (reusing `effects.ts`/`keywords.ts`/`triggers.ts` regexes as the
matchers). The reducer consumes `blocks` generically. New cards with known phrasing →
no code. Unknown EFFECT → `manual:true` → Override mode resolves it. This converts
"hand-code 1,064 cards" into "maintain ~7 slot vocabularies."

---
Sources: `mechanics-and-symbols.md`, `src/engine/{effects,keywords,triggers,engine}.ts`,
and the card-text taxonomy (1,064 cards). Unofficial fan research; not affiliated with
Riot Games.
