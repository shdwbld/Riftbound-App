# A5 Recon: Persistent / Cascading Mechanics

> Recon date: 2026-06-06  
> Scope: forced-discard cascades, banish-and-return-on-hold, mid-resolution XP optional cost, plus any other persistent/cascading cards missed.

---

## 1. `forcedDiscardCascade` — victim's discard triggers do NOT fire

### Current gap (engine.ts:669–707)

**opponentHandStrip block** (engine.ts:669–693) — the acknowledged comment at line 671–674:

```ts
// NOTE: a forced discard here does NOT
// cascade the victim's own "when you discard" reactions (applyParsed can't fire
// the log-cloning trigger pass) — only discardedThisTurn is set.
```

When `to === 'trash'` the stripped card goes to `foe`'s trash (line 689) and `foe.discardedThisTurn = true` is set, but `fireDiscard(s, foe.id, [card])` is **never called**.

**opponentDiscards block** (engine.ts:695–707) — same omission, no `fireDiscard` call:

```ts
if (n > 0) { foe.discardedThisTurn = true; lines.push(`Opponent discarded ${n}.`) }
// ← fireDiscard(s, foe.id, discardedCards) is absent
```

### The `fireDiscard` function (engine.ts:1858–1873)

```ts
function fireDiscard(s: MatchState, player: PlayerId, discarded: EngineCard[] = []): MatchState {
  if (s.players[player]) s.players[player].discardedThisTurn = true
  s = fireTriggers(s, collectGlobal(s, player, 'discard'))
  for (const c of discarded) {
    const cost = discardSelfReplayCost(getCard(c.cardId))
    if (cost && ...) { offerChoice(s, { kind: 'discardReplay', ... }); break }
  }
  return s
}
```

This fires:
1. Global `'discard'` triggers owned by `player` (e.g. Jinx - Rebel if the victim runs her).
2. Self-replay offers for each discarded card (Flame Chompers, etc.).

### Cards affected

| Card | ID | Text |
|------|----|------|
| Mindsplitter | `ogn-192-298` | "When you play me, choose an opponent. They reveal their hand. Choose a card from it, and they discard that card." |
| Sabotage | `ogn-156-298` | "Choose an opponent. They reveal their hand. Choose a non-unit card from it, and recycle that card." (recycles; no discard so lower priority, but included for completeness) |
| Bewitching Spirit | `unl-121-219` | "When you play me, choose a player. They discard 1." |

> Note: Sabotage sends to 'deck' (`to === 'deck'`), not trash, so the "discard" cascade is moot for it. Mindsplitter and Bewitching Spirit are the real actors.

### Effect parser mapping (effects.ts:613–625)

- Mindsplitter text `"they discard that card"` → regex `ohsM` matches → `eff.opponentHandStrip = { to: 'trash', nonUnit: false }`.
- Bewitching Spirit text `"they discard 1"` → regex `odM` matches → `eff.opponentDiscards = 1`.

### Fix plan

**Step 1 — opponentHandStrip block** (engine.ts:686–689):

After the `else { sendToTrash(foe, card); foe.discardedThisTurn = true; ... }` line, add:

```ts
const discardedCards = to === 'trash' ? [card] : []
if (discardedCards.length) s = fireDiscard(s, foe.id, discardedCards)
```

Full patched block at engine.ts:686–689:

```ts
if (to === 'deck') {
  foe.zones.mainDeck.push({ ...card, exhausted: false, damage: 0, attached: [] })
  lines.push(`Opponent revealed hand — recycled ${nm}.`)
} else if (to === 'banish') {
  foe.banished.push(card)
  lines.push(`Opponent revealed hand — banished ${nm}.`)
} else {
  sendToTrash(foe, card)
  foe.discardedThisTurn = true
  lines.push(`Opponent revealed hand — discarded ${nm}.`)
  s = fireDiscard(s, foe.id, [card])   // ← ADD THIS
}
```

**Step 2 — opponentDiscards block** (engine.ts:701–706):

Collect discarded cards and call `fireDiscard`:

```ts
const discardedCards: EngineCard[] = []
for (let k = 0; k < n; k++) {
  const lowest = [...foe.zones.hand].sort((a, b) => cardCost(a) - cardCost(b))[0]
  const [d] = foe.zones.hand.splice(foe.zones.hand.findIndex((x) => x.iid === lowest.iid), 1)
  sendToTrash(foe, d)
  discardedCards.push(d)
}
if (n > 0) {
  foe.discardedThisTurn = true
  lines.push(`Opponent discarded ${n}.`)
  s = fireDiscard(s, foe.id, discardedCards)   // ← ADD THIS
}
```

**Step 3 — State shape concern**: `applyParsed` returns `string[]` (lines), not a `MatchState`. The `s` inside `applyParsed` is the same shared reference; `fireDiscard` mutates `s` through `fireTriggers`. The existing comment "applyParsed can't fire the log-cloning trigger pass" is stale — `fireDiscard` is a top-level helper that calls `fireTriggers` directly on `s`, so it _can_ be called here. The prior limitation was a design caution, not a technical blocker. Verify by checking `applyParsed`'s signature (it accepts and mutates a shared `s` via closure).

---

## 2. `banishAndReturnOnHold` — Ashe - Focused

### Card

| Card | ID | Text |
|------|----|------|
| Ashe - Focused | `unl-169-219` | "When you play me, choose an opponent. They reveal their hand. Choose a card revealed this way and banish it. When they hold, return it to their hand (even if I'm no longer on the board)." |

### Current state

**Play resolution** (engine.ts:669–693): Ashe's on-play text parses via `opponentHandStrip` with `to: 'banish'` (effects.ts:618). The card goes to `foe.banished[]` (engine.ts:688). The banish push stores a raw `EngineCard` with no metadata linking it back to the Ashe play event.

**Hold triggers** (engine.ts:3177–3183): The hold phase fires `collectGlobal(s, ap, 'hold')` and `collectSelf(s, ap, 'hold', heldUnitIids)`. Neither looks at `foe.banished` to return a card. There is **no handler** for the "when they hold, return it" clause anywhere in engine.ts, battlefieldScripts.ts, effects.ts, or triggers.ts.

**Persistent state**: `PlayerState` (types.ts:103–168) has `banished: EngineCard[]` but no field to track "banished by Ashe" or link a banished card to a future opponent-hold trigger. `MatchState` (types.ts:260–308) also has no such field.

### Persistent-state approach

Add a field to `MatchState` (types.ts):

```ts
/** Cards banished by Ashe - Focused pending return on the owner's hold.
 *  Each entry: { banishedIid: string; owner: PlayerId; victimId: PlayerId }
 *  `owner` = the Ashe player; `victimId` = the opponent whose hold triggers return. */
asheBanishPending?: { banishedIid: string; owner: PlayerId; victimId: PlayerId }[]
```

### Fix plan

**Step 1 — On banish** (engine.ts:688, after `foe.banished.push(card)`):

```ts
else if (to === 'banish') {
  foe.banished.push(card)
  lines.push(`Opponent revealed hand — banished ${nm}.`)
  // Ashe - Focused: record for return-on-victim-hold
  if (/when they hold, return it/i.test(getCard(srcId)?.text ?? '')) {
    s.asheBanishPending = s.asheBanishPending ?? []
    s.asheBanishPending.push({ banishedIid: card.iid, owner: p.id, victimId: foe.id })
  }
}
```

(`srcId` is the source card's id — accessible in `applyParsed` as the card currently resolving, or pass it via effect context.)

**Step 2 — On hold phase** (engine.ts:3178–3183, after `if (holdsAny)`):

```ts
if (holdsAny && s.asheBanishPending?.length) {
  // Return any cards banished for this holder (victimId === ap)
  const toReturn = s.asheBanishPending.filter((e) => e.victimId === ap)
  for (const entry of toReturn) {
    const foeState = s.players[entry.victimId]
    const idx = foeState.banished.findIndex((c) => c.iid === entry.banishedIid)
    if (idx >= 0) {
      const [returned] = foeState.banished.splice(idx, 1)
      foeState.zones.hand.push({ ...returned, exhausted: false, damage: 0, attached: [] })
      s = log(s, ap, `Ashe - Focused: returned ${getCard(returned.cardId)?.name} to ${s.players[entry.victimId].name}'s hand.`)
    }
  }
  s.asheBanishPending = s.asheBanishPending.filter((e) => e.victimId !== ap)
}
```

**Step 3 — copyState** (engine.ts:48–57): Add `asheBanishPending` to the `copyState` function:

```ts
asheBanishPending: s.asheBanishPending ? s.asheBanishPending.map((e) => ({ ...e })) : undefined,
```

**Step 4 — Hold trigger attribution**: The return fires even if Ashe is no longer on the board (card text explicitly says so). No need to check if Ashe is in play. The `asheBanishPending` entries persist in `MatchState` across turns until the victim holds.

**Step 5 — FFA / multi-player**: In 3–4 player games the victim may hold while a different player is active. The hold phase (engine.ts:3177) fires for `ap` (the active player). The check at Step 2 correctly gates on `victimId === ap`, so it fires for the right player.

**Step 6 — Edge: victim never holds** (elimination / concede): If the victim is eliminated (`out = true`) the pending entries become inert. Add cleanup in the elimination code path to purge entries for `out` players (search for `pl.out = true` assignments).

---

## 3. Insightful Investigator (unl-135-219) — mid-resolution optional XP cost

### Card

| Card | ID | Text |
|------|----|------|
| Insightful Investigator | `unl-135-219` | "When you play me, choose an opponent. They reveal their hand. You may pay 2 XP to choose a card from their hand. If you do, they discard that card and draw 1." |

### Current state

There is **no handler** for `unl-135-219` anywhere in engine.ts, effects.ts, or triggers.ts. The card's on-play effect parses partially:

- `"They reveal their hand"` + `"they discard that card"` → matches `ohsM` regex in effects.ts:616 → `eff.opponentHandStrip = { to: 'trash', nonUnit: false }`.
- `"draw 1"` → `eff.draw = 1` (for the caster), but the draw is supposed to go to the victim, not the caster.
- The `"you may pay 2 XP"` gating is **not parsed** — there is no `optionalXpCost` field in `ParsedEffect`, and the effects parser has no regex for it.

Result: currently the card probably fires as if the strip were unconditional (Mindsplitter-like), and the draw goes to the wrong player.

### Design: pendingChoice-driven optional XP cost

The pattern closest to this is `counterUnlessPay` (engine.ts:4622–4634) — a pending choice offered to the controller, then resolved in `RESOLVE_CHOICE`.

#### Option A — Bespoke handler (recommended)

Add a dedicated handler in the on-play `PLAY_CARD` resolution (or in `applyParsed` guarded by `srcName === 'Insightful Investigator'`):

```ts
if (srcName === 'Insightful Investigator') {
  // Step 1: foe reveals hand — find the opponent with the most cards
  const foe = s.players
    .filter((pl) => pl.id !== player && !pl.out && pl.zones.hand.length > 0)
    .sort((a, b) => b.zones.hand.length - a.zones.hand.length)[0]
  if (!foe) return s
  // Step 2: offer the optional 2 XP cost
  if (p.xp >= 2 && foe.zones.hand.length > 0) {
    offerChoice(s, {
      player,
      kind: 'insightfulInvestigator',   // new kind
      bfIndex: -1,
      prompt: `Insightful Investigator — pay 2 XP to strip a card from ${foe.name}'s hand? (You have ${p.xp} XP)`,
      options: [
        { iid: foe.zones.hand[0].iid, label: 'Pay 2 XP & strip' },  // placeholder iid
        { iid: 'decline', label: 'Decline' },
      ],
      payload: JSON.stringify({ victimId: foe.id }),
    })
  }
  return s  // pause for choice
}
```

Add `'insightfulInvestigator'` to the `pendingChoice.kind` union in types.ts:291.

Then in `RESOLVE_CHOICE` (engine.ts, near line 5689 where `discardReplay` is handled):

```ts
if (pc.kind === 'insightfulInvestigator') {
  const { victimId } = JSON.parse(pc.payload ?? '{}')
  if (action.iid !== 'decline') {
    // Pay 2 XP
    p.xp -= 2
    const foeState = s.players[victimId]
    // Auto-pick highest-cost card from foe's hand
    const pick = [...foeState.zones.hand].sort((a, b) => cardCost(b) - cardCost(a))[0]
    if (pick) {
      foeState.zones.hand.splice(foeState.zones.hand.findIndex((c) => c.iid === pick.iid), 1)
      sendToTrash(foeState, pick)
      s = log(s, action.player, `Insightful Investigator — paid 2 XP, stripped ${getCard(pick.cardId)?.name} from opponent's hand.`)
      s = fireDiscard(s, victimId, [pick])   // victim discard cascade
      // Victim draws 1
      drawN(foeState, 1)
      s = log(s, victimId, `Insightful Investigator — drew 1.`)
    }
  } else {
    s = log(s, action.player, `Insightful Investigator — declined (kept 2 XP).`)
  }
  s.pendingChoice = undefined
  return ok(s)
}
```

#### Option B — ParsedEffect extension

Add `optionalXpCost` to `ParsedEffect` in effects.ts. Then gate the `opponentHandStrip` execution in engine.ts on `s.players[p.id].xp >= e.optionalXpCost` (auto-pay) or use `pendingChoice`. This is more generic but requires more structural work; Option A is simpler given only one card needs it.

### Note on draw attribution

The "draw 1" in Insightful Investigator's text applies to the **victim** ("If you do, they discard that card and draw 1"). The current parser would assign `eff.draw = 1` to the caster (`p`). The bespoke handler must call `drawN(foeState, 1)` not `drawN(p, 1)`.

---

## 4. Other persistent/cascading cards missed

Cards found in the pool with persistent or cross-event mechanics not covered by existing handlers:

### 4a. Ripper's Bay (unl-214-219) — return-to-hand → channel trigger

```
"When a unit here is returned to a player's hand, that player may pay :rb_energy_1: to channel 1 rune exhausted."
```

This is a **battlefield** passive that fires whenever ANY unit bounces from this battlefield to hand (enemy or friendly). Currently `battlefieldPassive()` only parses basic `onHold`/`onConquer` etc. The "when a unit here is returned to a player's hand" pattern has no regex in `battlefieldScripts.ts` or `battlefieldPassive()`. Needs a scripted `onBounce` hook or regex addition.

### 4b. Bone Skewer (unl-139-219) — force-play + stun cascade

```
"An opponent reveals their hand. You may choose a unit from it. They play that unit to that battlefield, ignoring any and all costs. When they do, [Stun] it."
```

This forces the opponent to **play** one of their own units and immediately stuns it. The play-for-opponent is not a discard; no cascade issue. But the stun must fire AFTER the forced play lands the unit on the battlefield. No handler found. Documented as a deferred card; verify before implementing.

### 4c. Vex - Apathetic (unl-150-219) — opponent-play trigger stun

```
"When an opponent plays a unit while I'm at a battlefield, [Stun] it. They can't move it this turn."
```

This is an opponent-play watcher. The engine's trigger system has no `'opponentPlay'` event type (triggers.ts:23–43 only lists player-centric events). Unless there's a bespoke handler for Vex, it is not firing. Confirmed no handler in engine.ts. Previously flagged in playtest-bugfix-pass memory note. Needs either a new `TriggerEvent` `'opponentPlayUnit'` or a named check in the `PLAY_CARD` resolution path.

### 4d. Sumpworks Map (unl-085-219) — opponent-score draw trigger

```
"[Temporary] When an opponent scores, draw 1."
```

The score is awarded via `awardPoints` (engine.ts:606). There is no hook in `awardPoints` to fire triggers for non-scoring players. A `collectGlobal` call for `'opponentScore'` would be needed, but that event does not exist in `TriggerEvent`. Currently not firing.

---

## Summary table

| Mechanic | Card(s) | Gap | Fix location |
|----------|---------|-----|--------------|
| Forced-discard cascade (handStrip) | Mindsplitter | `fireDiscard(s, foe.id, [card])` missing after trash | engine.ts:689 |
| Forced-discard cascade (opponentDiscards) | Bewitching Spirit | `fireDiscard(s, foe.id, discardedCards)` missing | engine.ts:706 |
| Banish-and-return on hold | Ashe - Focused | No persistent state; no hold-phase return handler | types.ts + engine.ts:688 + :3178 |
| Optional XP cost mid-resolution | Insightful Investigator | No handler; parser fires unconditional strip + wrong-player draw | New `pendingChoice` kind + RESOLVE_CHOICE |
| Bounce trigger on BF | Ripper's Bay | `onBounce` hook absent in battlefieldPassive | battlefieldScripts.ts |
| Force-play-opponent + stun | Bone Skewer | No handler | Bespoke in PLAY_CARD |
| Opponent-play trigger | Vex - Apathetic | No `opponentPlayUnit` event in trigger system | triggers.ts + engine.ts PLAY_CARD |
| Opponent-score trigger | Sumpworks Map | No `opponentScore` event; `awardPoints` has no hook | triggers.ts + awardPoints |

---

## Key file anchors

| File | Line | Content |
|------|------|---------|
| engine.ts | 669 | `opponentHandStrip` block start |
| engine.ts | 688 | banish push — where `asheBanishPending` entry should be added |
| engine.ts | 689 | trash push — where `fireDiscard(s, foe.id, [card])` is missing |
| engine.ts | 695 | `opponentDiscards` block start |
| engine.ts | 706 | `foe.discardedThisTurn = true` — where `fireDiscard(s, foe.id, discardedCards)` is missing |
| engine.ts | 1858 | `fireDiscard` function definition |
| engine.ts | 3177 | hold-phase trigger section — where Ashe return-on-hold goes |
| engine.ts | 4627 | `counterUnlessPay` pendingChoice pattern (reference for Insightful Investigator) |
| effects.ts | 142–150 | `opponentHandStrip` field doc |
| effects.ts | 613–625 | parser regex for opponentHandStrip + opponentDiscards |
| types.ts | 103 | `PlayerState` interface |
| types.ts | 260 | `MatchState` interface — add `asheBanishPending` here |
| types.ts | 289 | `pendingChoice.kind` union — add `'insightfulInvestigator'` |
