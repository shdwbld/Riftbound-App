# A5 Card Facts — Verified Card Data

Copy-paste-ready reference for all 11 cards in scope. All fields verified directly from `src/data/cards.generated.json`. Ids corrected where the guess was wrong.

---

## Card Data Table

| # | Name | Actual id | Guessed id | Match? | type | supertype | might | energy | power | tags |
|---|------|-----------|------------|--------|------|-----------|-------|--------|-------|------|
| 1 | Caitlyn - Patrolling | `ogn-068-298` | ogn-068-298 | ✓ | unit | champion | 3 | 3 | `{calm:1}` | Caitlyn, Piltover |
| 2 | Carnivorous Snapvine | `ogn-149-298` | ogn-149-298 | ✓ | unit | — | 6 | 5 | `{body:2}` | Shadow Isles |
| 3 | Dr. Mundo - Expert | `ogn-109-298` | ogn-109-298 | ✓ | unit | champion | 6 | 8 | `{mind:2}` | Dr. Mundo, Zaun |
| 4 | Arise! | `sfd-198-221` | sfd-198-221 | ✓ | spell | signature | — | 6 | `{calm:1}` | Azir |
| 5 | The List | `unl-138-219` | unl-138-219 | ✓ | gear | — | — | 1 | `{}` | — |
| 6 | Ashe - Focused | `unl-169-219` | unl-169-219 | ✓ | unit | champion | 4 | 5 | `{order:1}` | Freljord, Ashe |
| 7 | Insightful Investigator | `unl-135-219` | unl-135-219 | ✓ | unit | — | 3 | 3 | `{}` | Piltover |
| 8 | Bone Skewer | `unl-139-219` | unl-139-219 | ✓ | spell | — | — | 2 | `{chaos:1}` | — |
| 9 | Vex - Apathetic | `unl-150-219` | unl-150-219 | ✓ | unit | champion | 4 | 4 | `{}` | Yordle, Vex, Shadow Isles |
| 10 | Sumpworks Map | `unl-085-219` | unl-085-219 | ✓ | gear | — | — | 2 | `{}` | — |
| 11 | Ripper's Bay | `unl-214-219` | unl-214-219 | ✓ | battlefield | — | — | — | — | — |

All 11 guessed ids are exact matches.

---

## Alternate-Art / Promo Variants

| Base id | Variant id | Variant rarity | Notes |
|---------|------------|----------------|-------|
| `ogn-068-298` | `pr-068a-298` | promo | Different flavor text only; same card text. Base = `ogn-068-298`. |
| `unl-150-219` | `unl-150a-219` | showcase | Named "Vex - Apathetic (Alternate Art)". **WARNING: truncated text** — showcase variant omits the parenthetical Deflect reminder and the stun parenthetical. Base = `unl-150-219`. |

Cards 2–8, 10–11 have no alternate printings.

---

## Full Card Text (Verbatim)

### 1. Caitlyn - Patrolling (`ogn-068-298`)
```
I must be assigned combat damage last.:rb_exhaust:: Deal damage equal to my Might to a unit at a battlefield. Use this ability only while I'm at a battlefield.
```

### 2. Carnivorous Snapvine (`ogn-149-298`)
```
When you play me, choose an enemy unit at a battlefield. We deal damage equal to our Mights to each other.
```

### 3. Dr. Mundo - Expert (`ogn-109-298`)
```
My Might is increased by the number of cards in your trash.At the start of your Beginning Phase, recycle 3 from your trash.
```
Note: missing space between the two sentences in the raw JSON (`.At` with no space).

### 4. Arise! (`sfd-198-221`)
```
Play a 2 :rb_might: Sand Soldier unit token for each Equipment you control. Then do this: Ready up to two of them.
```

### 5. The List (`unl-138-219`)
```
As you play this, name a tag. (For example, Miss Fortune, Demacia, and Poro are tags.):rb_exhaust:: Give a unit with the named tag -2 :rb_might: this turn.
```

### 6. Ashe - Focused (`unl-169-219`)
```
When you play me, choose an opponent. They reveal their hand. Choose a card revealed this way and banish it. When they hold, return it to their hand (even if I'm no longer on the board).
```

### 7. Insightful Investigator (`unl-135-219`)
```
When you play me, choose an opponent. They reveal their hand. You may pay 2 XP to choose a card from their hand. If you do, they discard that card and draw 1.
```

### 8. Bone Skewer (`unl-139-219`)
```
[Hidden] (Hide now for :rb_rune_rainbow: to react with later for :rb_energy_0:.)Choose a battlefield. An opponent reveals their hand. You may choose a unit from it. They play that unit to that battlefield, ignoring any and all costs. When they do, [Stun] it. (It doesn't deal combat damage this turn.)
```

### 9. Vex - Apathetic (`unl-150-219`) — BASE
```
[Deflect] (Opponents must pay :rb_rune_rainbow: to choose me with a spell or ability.)When an opponent plays a unit while I'm at a battlefield, [Stun] it. They can't move it this turn. (It doesn't deal combat damage this turn.)
```

### 9a. Vex - Apathetic (Alternate Art) (`unl-150a-219`) — DO NOT USE FOR TESTS
```
[Deflect]When an opponent plays a unit while I'm at a battlefield, [Stun] it. They can't move it this turn.
```
(Missing reminder text; also missing the `(It doesn't deal combat damage this turn.)` clause.)

### 10. Sumpworks Map (`unl-085-219`)
```
[Reaction] (Play any time, even before spells and abilities resolve.)[Temporary] (Kill this at the start of its controller's Beginning Phase, before scoring.)When an opponent scores, draw 1.
```

### 11. Ripper's Bay (`unl-214-219`)
```
When a unit here is returned to a player's hand, that player may pay :rb_energy_1: to channel 1 rune exhausted.
```

---

## Parse-Path Analysis

### Cards 1–3 (unit cards with on-play or triggered abilities)

#### 1. Caitlyn - Patrolling

- **Activated ability detection (`unitActivatedAbility`):** The `"::" ` pattern (`::\s`) matches at position 49 (after `:rb_exhaust:`). Cost string = `:rb_exhaust:`. Effect text = `"Deal damage equal to my Might to a unit at a battlefield"`.
- **`dealMight` parse:** The regex `deals? damage equal to (?:its|my|their|our) (mights?)` matches `"deal damage equal to my might"`. Because `"equal to my might"` triggers the `self` branch, result is:
  ```
  dealMight: { dealer: 'self', target: 'singleEnemy', useStat: 'might', side: null }
  ```
- **Exhaust cost:** `exhaust: true`. No energy or power cost.
- **`requiresBattlefield`:** `true` — text contains `"only while I'm at a battlefield"`.
- **"must be assigned combat damage last":** YES, confirmed verbatim in text. This static ability is NOT parsed by `effects.ts`/`unitActivatedAbility` — it must be handled by the engine's combat-assignment logic (bespoke; search engine.ts for `damage last` or a Tank-adjacent handler).

#### 2. Carnivorous Snapvine

- **Trigger path (`parseTriggers`):** The pattern `play self` (`when(?:ever)?\s+(?:i'm|i am|you\s+play\s+(?:me|this))`) matches `"When you play me"`. This fires a `play` / `scope:'self'` trigger.
- **Clause after trigger:** `"choose an enemy unit at a battlefield. We deal damage equal to our Mights to each other."` — `clauseAfter` returns the first sentence only: `"choose an enemy unit at a battlefield"`, BUT the `dealMight` regex also fires because `"We deal damage equal to our Mights to each other"` is present in the full parse call (the trigger's `effect` is `parseEffectText(clause || text)` — when the clause itself has no parseable effect, it falls back to the full text).
- **`dealMight` result:**
  - `"we deal"` → `dealer: 'self'` (the `\bwe deal\b` branch)
  - `"to each other"` → `target: 'mutual'`
  - `useStat: 'might'`, `side: null`
  ```
  dealMight: { dealer: 'self', target: 'mutual', useStat: 'might', side: null }
  ```
- **Note:** `targetScope` resolves to `'enemy'` (mutual needs a chosen enemy partner). The trigger also fires `onPlayEffect()` which gates on `ON_PLAY` regex; `"When you play me"` matches `when you play (?:me|this)`, so `onPlayEffect` also returns this `dealMight` effect.

#### 3. Dr. Mundo - Expert

- **Might-scaling (bespoke):** `"My Might is increased by the number of cards in your trash"` is handled by a dedicated bespoke branch in `engine.ts` (`auraMightBonus`): `if (name === 'Dr. Mundo - Expert') b += s.players[u.owner]?.zones.trash.length`. This is NOT parsed by `effects.ts` at all.
- **StartOfTurn trigger (`parseTriggers`):** The pattern `(?:at\s+the\s+)?(?:start|beginning)\s+of\s+(?:your|the|each)\s+(?:turn|beginning\s+phase)` matches `"At the start of your Beginning Phase"` → fires `startOfTurn` / `scope:'global'` trigger.
- **Clause after trigger:** `"recycle 3 from your trash"` — passed to `parseEffectText()`.
- **`parse()` result for `"recycle 3 from your trash"`:** NO pattern in `effects.ts` matches `recycle N from your trash` (it's not `channel`, not `draw`, not `returnFromTrash`, not any recognized branch). Result: `manual: true`.
- **IMPLICATION:** The startOfTurn trigger fires but its effect resolves as `manual` — the engine logs a manual prompt and the player must resolve it by hand. A bespoke handler in `fireTriggers` or the startOfTurn processing is needed for full auto-resolution. The `/recycle (\d+) ... from your trash/` regex in `unitActivatedAbility` is the COST-side detector (not effect-side) — it does not help here.

---

### Cards 4–7 (spell / gear / unit — mixed)

#### 4. Arise! (`sfd-198-221`) — spell

- **`spellEffect` path:** `spellEffect()` calls `parse(card.text)` on the full text.
- **Named token parse:** Regex `play (?!me\b|this\b)...?\b(sand soldier)\b...?tokens?` matches `"play a 2 :rb_might: sand soldier unit token"`. count group is `None` (no numeric group 1 = 1 token), name = `"sand soldier"`, `exhausted: true` (no `ready` keyword in the match), `temporary: false`, `here: false`. Result:
  ```
  namedToken: { name: 'sand soldier', count: 1, exhausted: true, temporary: false, here: false, opponent: false }
  ```
- **"for each Equipment you control":** NOT parsed — no pattern in `effects.ts` handles a per-Equipment multiplier. The token count stays at 1; the actual "create N tokens" behavior needs a bespoke handler.
- **"Ready up to two of them":** The `readyUnits` regex requires the word `units` as a noun (`\bunits?\b`) after the count word. "Ready up to two of them" uses `"them"` (pronoun), not `"units"`. **No `readyUnits` match.** This clause is also not auto-parsed.
- **Overall:** `namedToken` fires (1 token), but both the Equipment-count multiplier and the "Ready up to two" are `manual: true`. Full Arise! resolution requires a bespoke handler.
- **Confirmed phrasings:**
  - ✓ `"for each Equipment you control"` — present verbatim
  - ✓ `"Ready up to two of them"` — present verbatim (uses "them", not "units")

#### 5. The List (`unl-138-219`) — gear

- **On-play name-a-tag:** `"As you play this, name a tag."` — `onPlayEffect()` checks `ON_PLAY` regex (`when (?:i...)... played|when you play (?:me|this)|^play`). "As you play this" does NOT match `ON_PLAY` (no `^play` / `when you play me` form). So `onPlayEffect` returns `EMPTY_EFFECT`. The name-a-tag interaction needs a bespoke handler at play time.
- **Activated ability (`unitActivatedAbility`):** `"::" ` separator found after `)` (closing the reminder parenthetical). Cost string = `:rb_exhaust:`. Effect text = `"Give a unit with the named tag -2 :rb_might: this turn"`.
- **`tempMight` parse:** The regex `give (?:it|a|an|...) (?:friendly|enemy)? (?:units?)?..?(-|\+)?(\d+)\s*(?:might) this turn` matches. Sign = `-1`, value = `2` → `tempMight: -2`.
- **`targetScope`:** defaults to `'enemy'` (negative Might is a debuff). But "a unit with the named tag" could be any unit — the tag filter is not in `targetScope`. **The `targetScope: 'enemy'` may be too restrictive if the tag applies to friendly units.** Needs care in implementation.
- **Exhaust cost:** `exhaust: true`.

#### 6. Ashe - Focused (`unl-169-219`) — unit

- **Trigger path:** Pattern `play self` matches `"When you play me"` → `play` / `scope:'self'` trigger.
- **Clause after trigger:** `"choose an opponent. They reveal their hand. Choose a card revealed this way and banish it."` — `clauseAfter` returns to first `.`: `"choose an opponent"`. Since that has no parseable effect, `parseEffectText` falls back to the full text.
- **`opponentHandStrip` parse:** Regex `they reveal their hand\.?[\s\S]*?choose (?:a|an) (non-unit )?card[\s\S]*?(?:they discard|recycle|banish)` matches. `to` = `'banish'` (text contains `"banish it"`). `nonUnit: false` (no "non-unit" qualifier). Result:
  ```
  opponentHandStrip: { to: 'banish', nonUnit: false }
  ```
- **Hold-return clause:** `"When they hold, return it to their hand"` — this is a second trigger on `hold` / `scope:'global'` (pattern matches `"When ... hold"`). The clause `"return it to their hand"` — `bounce` regex requires `"return a/an/target/another (friendly|enemy)? unit to ... hand"` but "return it" doesn't match (no unit noun). `manual: true` for the hold-return. Needs bespoke handler.
- **Note:** `"even if I'm no longer on the board"` — this cross-zone persistence also needs bespoke tracking.

#### 7. Insightful Investigator (`unl-135-219`) — unit

- **Trigger path:** Pattern `play self` matches `"When you play me"` → `play` / `scope:'self'` trigger.
- **`opponentHandStrip` parse:** Regex matches `"They reveal their hand ... you may pay 2 XP to choose a card from their hand. If you do, they discard"`. Result:
  ```
  opponentHandStrip: { to: 'trash', nonUnit: false }
  ```
  This fires unconditionally (the XP-gate `"You may pay 2 XP"` is not parsed as a cost gate; `parse()` has no XP-payment cost branch).
- **`draw 1` mis-parse:** The `"draw 1"` at the end of `"they discard that card and draw 1"` is matched by the draw regex → `draw: 1`. But this draw belongs to the opponent (`"they ... draw 1"`) not the controller. The `draw` field in `ParsedEffect` always means the controller draws. **This is a parse mismatch** — the controller will incorrectly draw 1 whenever this trigger fires.
- **Full parse result (approximate):** `opponentHandStrip: {to:'trash', nonUnit:false}`, `draw: 1` (wrong owner), `manual: false` (but semantically incorrect).

---

## Summary of Surprises

1. **All 11 guessed ids are exact** — no id corrections needed.
2. **Vex - Apathetic alternate art (`unl-150a-219`) has truncated text** — it omits the Deflect reminder and the stun parenthetical compared to the base `unl-150-219`. Use only the base id in tests.
3. **Dr. Mundo's `"recycle 3 from your trash"` is `manual: true`** — `effects.ts` has no parse branch for `recycle N from trash` as an effect (only as an activated-ability COST via `unitActivatedAbility`). The startOfTurn trigger fires correctly but resolves as a manual prompt; a bespoke handler is needed.
4. **Arise! "for each Equipment" multiplier and "Ready up to two of them" are both unresolved** — `namedToken.count` stays 1, and `readyUnits` = 0 because "them" is not "units". Both behaviors need bespoke code.
5. **Insightful Investigator mis-parses `draw 1`** — the draw belongs to the opponent in the card text (`"they discard that card and draw 1"`), but `parse()` assigns it to `draw: 1` (controller draws). This will cause the Investigator's controller to incorrectly draw a card on resolution.
6. **Caitlyn's "must be assigned combat damage last"** is confirmed present verbatim but is NOT handled by any auto-parse path — it needs the combat-damage-assignment bespoke logic.
