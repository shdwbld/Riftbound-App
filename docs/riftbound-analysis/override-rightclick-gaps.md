# Override & Right-Click Gap Analysis
_Audited 2026-06-07. READ-ONLY output; implementation spec only._

---

## 1. Surface Inventory

### 1a. Sandbox Override HUD

**File:** `src/components/ControlHUD.tsx`  
**Location:** Left rail, collapsible, 300 px wide at xl breakpoints.  
**Entry point:** `export default function ControlHUD(...)` (line 66).  
**Gate:** Rendered only when `match.sandbox === true` (the parent page gates it).  
**Three tabs:**

| Tab | Label | What it does |
|---|---|---|
| ① Selected | Contextual per-card ops | Auto-opens when a card is clicked on the board |
| ② Player | Score/resources, deck browse/tutor, trash retrieve, spawn-any-card | Targets a selected player |
| ③ Game | Advanced state overrides, bulk zone tools | |

**Selected tab — unit ops** (`SelectedTab` component, line 333):

| UI label | `OverrideOp` dispatched | Engine case |
|---|---|---|
| Stun / Unstun | `stun` / `unstun` | `u.stunned = true/false` |
| Exhaust / Ready | `exhaust` / `ready` | `u.exhausted = true/false` |
| Facedown toggle | `grant` flag=`'facedown'` | `u.facedown = !u.facedown` |
| [Ganking] toggle | `grant` flag=`'ganking'` | `u.grantGanking = !u.grantGanking` |
| [Temporary] toggle | `grant` flag=`'temporary'` | `u.temporary = !u.temporary` |
| Death shield toggle | `grant` flag=`'deathShield'` | `u.deathShield = !u.deathShield` |
| Banish shield toggle | `grant` flag=`'banishShield'` | `u.banishShield = !u.banishShield` |
| Token toggle | `grant` flag=`'token'` | `u.token = !u.token` |
| Clear sickness | `grant` flag=`'sickness'` | `u.enteredTurn = 0` |
| Clear can't-move | `grant` flag=`'cantmove'` | `u.cantMoveTurn = undefined` |
| Re-fire enter triggers | `triggerEnterPlay` | Calls `onPlayEffect` + `firePlayTriggers` |
| Marker cycle / clear | `marker` | `u.marker = (0-4)` |
| Recall to base | `toBase` | `sendUnitToBase(s, iid)` |
| Might +1 / +5 / -1 | `mightUp` / `mightDown` | `u.tempMight += delta` |
| Set temp Might | `setTempMight` | `u.tempMight = value` |
| Buff +1 / -1 | `buff` / `unbuff` | `u.buffs += delta` |
| [Assault] ±1 | `grant` flag=`'assault'` amount=±1 | `u.grantAssault = max(0, …)` |
| Damage ±1, set 0/2/4/6 | `damage` / `setDamage` | `u.damage = …` |
| Set controller | `setController` | `bf.controller = value` |
| Move to… (many destinations) | `move` (toZone / toBattlefield) | `pluckCardAnywhere` + re-insert |
| Kill / Sacrifice / Banish / Trash | `kill` / `sacrifice` / `banish` / `trash` | routes through `fireDeaths` or splice |

**Player tab — player-scoped ops:**

| UI label | `OverrideOp` | Engine case |
|---|---|---|
| Points ±1/+5 | `points` | `p.points = max(0, p.points + delta)` |
| XP ±1 | `xp` | `p.xp = max(0, p.xp + delta)` |
| Energy ±1 | `energy` | `p.pool.energy = max(0, …)` |
| +Power (per domain) | `power` domain=d | `p.pool.power[d] = max(0, …)` |
| Draw 1 / Draw 2 | `draw` amount=1/2 | `drawN(p, n)` |
| Channel 1 / Channel 1 (exh) | `channel` / `channelExhausted` | `channelN(p, n, …)` |
| Browse / tutor deck → to hand | `move` iid=card.iid toZone=`'hand'` | `pluckCardAnywhere` |
| Move deck card to bottom | `move` iid=card.iid toZone=`'mainDeck'` bottom=true | |
| Trash deck card | `move` iid=card.iid toZone=`'trash'` | |
| Retrieve from trash → hand | `move` iid=card.iid toZone=`'hand'` | |
| Shuffle deck | `shuffle` | `shuffle(p.zones.mainDeck)` |
| Mill 1 | `mill` amount=1 | `p.zones.trash.push(mainDeck.shift())` |
| Ready all | `readyAll` | sets `exhausted=false` for all own units |
| Spawn card (search by name → zone) | `spawn` cardId / toZone or toBattlefield | creates fresh `EngineCard` |

**Game tab — advanced overrides:**

| UI label | `OverrideOp` | Engine case |
|---|---|---|
| Set active player | `setActive` value=i | `s.activePlayer = i` |
| Set phase → Action / Showdown | `setPhase` phase=… | `s.phase = phase` |
| Turn # ±1 | `setTurn` | `s.turn = max(1, value)` |
| Win-at points ±1 | `setPointsToWin` | `s.pointsToWin = max(1, value)` |
| Set winner / clear | `setWinner` value=i/-1 | `s.winner = …` |
| Clear chain / showdown / turn counters / recompute control | `clearChain` / `clearShowdown` / `clearTurnState` / `recomputeControllers` | as named |
| Bulk zone move (from/to pickers) | `bulkMove` fromZone / toZone | splice + reassign owner |
| Swap zone with other player | `swapZone` fromZone / targetPlayer | swap two players' zones |

---

### 1b. Right-Click Drill-Down Context Menu

**File:** `src/components/MatchBoard.tsx`  
**State variables:** `menu`, `drill`, `sub`, `stepper` (lines 219–240).  
**Entry point function:** `openMenu(e, ci, zone)` (line ~480).  
**Zone right-click function:** `openZoneMenu(e, kind, owner)` (line 686).  
**Battlefield right-click:** `openBfMenu(e, bfIndex)` (line 721).  
**Gate:** Always-available items (own cards); sandbox-only drill-down `groups` and `statuses` (line 554).

**Always-available items (any player, own cards):**

| Condition | Menu item | Action dispatched |
|---|---|---|
| unit | Stun | `STUN_UNIT` |
| unit | Banish | `BANISH` |
| own unit — battlefield ability | ⚡ Activate (granted ability) | `ACTIVATE_ABILITY` |
| own unit — printed ability ready | ⚡ Activate (unit ability) | triggers `onActivateUnit` callback |
| own rune in runePool | Recycle rune | `RECYCLE_RUNE` |
| own unit | Buff +1 | `BUFF_UNIT` |
| own unit with attached gear | Detach [gear name] | `DETACH` |
| own unit with attached gear (sandbox) | Move [gear] to a unit | `onMoveGear` callback |
| own Equipment in base | Equip to a unit | `onAttachGear` callback |
| own Gold gear token | Domain Power (per domain) | `USE_GOLD` |
| own facedown unit at battlefield | Reveal | `REVEAL` |
| own [Hidden] card in hand | Hide (facedown) at BF N | `HIDE` |
| any | Trash | `TRASH_CARD` |

**Sandbox-only status toggles (fly-out, units only):**

Same as SelectedTab above — Stunned, Exhausted, Facedown, [Ganking], [Temporary], Death shield, Banish shield, Token, [Assault] ±1, Buff ±1, Clear sickness, Clear can't-move, Re-fire enter, Marker, Recall to base.

**Sandbox-only drill-down groups (units):**

| Group label | Items | Actions |
|---|---|---|
| Might & damage | Might ±1/+5, Damage ±1, Set damage 0/2/4/6, Buff/Might/Damage stepper, Set temp Might exact | `OVERRIDE` mightUp/mightDown/damage/setDamage/buff/unbuff/setTempMight |
| Control battlefield | → each player / Uncontrolled | `OVERRIDE` setController |
| Hidden card (facedown only) | Reveal to hand, Remove (trash), Remove (banish) | `OVERRIDE` revealFacedown / removeFacedown |
| Move to… | Hand, Base, BF 1–N, Deck top/bottom, Deck X from top stepper, Trash, Banished, Legend zone, Champion zone | `OVERRIDE` move |
| Remove | Kill, Sacrifice, Banish, Trash | `OVERRIDE` kill/sacrifice/banish/trash |
| Owner | Draw 1, Channel 1, Ready all units | `OVERRIDE` draw/channel/readyAll |

**Sandbox-only zone right-click menus:**

| Zone | Items | Actions |
|---|---|---|
| deck | Search deck…, Manage top cards, Draw 1/3, Mill 1, Shuffle | CardSearchOverlay / `OVERRIDE` draw/mill/shuffle |
| runeDeck | Search rune deck…, Channel 1/3, Channel 1 (exhausted) | CardSearchOverlay / `OVERRIDE` channel/channelExhausted |
| trash | Search trash… | CardSearchOverlay |
| hand | Draw 1/3 | `OVERRIDE` draw |
| base / battlefield | Ready all units | `OVERRIDE` readyAll |
| battlefield art | ↩ Revert to [original name] | `OVERRIDE` revertBf |

---

## 2. Gap → Control Mapping (Prioritized)

Candidates evaluated: kill gear, bounce gear, heal/clear-damage, exhaust↔ready toggle, stun↔unstun toggle, add/remove keyword ([Shield]/[Tank]/[Deflect]), set/clear a state ([Mighty]), move an ENEMY unit, score ±1 adjust, draw/mill N, reveal a card, create a token, recall to hand, give temporary +Might, tap energy/add runes.

**Already fully covered and excluded from gaps:**
- stun/unstun — both surfaces
- exhaust/ready toggle — both surfaces
- ±Might (temp), ±buff (permanent) — both surfaces
- score ±1 — HUD Player tab
- draw N, mill N — both surfaces (zone menus + HUD)
- add energy, add power/runes — HUD Player tab
- channel runes — HUD Player tab + zone menus
- recall to base (`toBase`) — both surfaces (as "Recall to base")
- create a token / spawn card — HUD Player tab spawn
- move a unit (drag/menu) — both surfaces
- kill, banish, trash — both surfaces

**Genuine gaps:**

| # | Mechanic | Priority | Surface | Engine Action / Op | File + anchor | Effort |
|---|---|---|---|---|---|---|
| 1 | Grant [Shield N] this turn | High | Both | `OVERRIDE` op=`'grant'` flag=`'shield'` amount=N | engine.ts:7336 `grant` switch — add `case 'shield'`; ControlHUD.tsx SelectedTab State section; MatchBoard.tsx statuses array | **trivial** |
| 2 | Grant [Tank] this turn | High | Both | `OVERRIDE` op=`'grant'` flag=`'tank'` | engine.ts:7336 `grant` switch — add `case 'tank'`; same UI sections | **trivial** |
| 3 | Grant [Deflect N] this turn | High | Both | `OVERRIDE` op=`'grant'` flag=`'deflect'` amount=N | engine.ts:7336 `grant` switch — add `case 'deflect'`; same UI sections | **trivial** |
| 4 | Kill gear (send to trash) | High | Right-click only | `OVERRIDE` op=`'killGear'` iid=gearIid | New `case 'killGear'` in OVERRIDE at engine.ts:7263; call existing `killGearByIid(s, action.iid!)`; add `'killGear'` to `OverrideOp` union in types.ts:21; add right-click item for gear cards (any zone) | **small** |
| 5 | Bounce gear to owner's hand | High | Right-click only | `OVERRIDE` op=`'bounceGear'` iid=gearIid | New `case 'bounceGear'`; call existing `bounceGearByIid(s, action.iid!)`; add to `OverrideOp`; right-click item on gear | **small** |
| 6 | Heal / clear damage on a unit | Med | Both | Already exists via `OVERRIDE` op=`'setDamage'` value=0 | **Already present** — `setDamage` to 0 IS the heal; a labeled "Heal (clear damage)" alias is purely a UI clarity gap — add a **button** "Heal (set dmg 0)" as an alias in SelectedTab's Might & damage section and the right-click Might & damage group | **trivial** |
| 7 | Recall to hand (bounce unit, not base) | Med | Both | Reuse `OVERRIDE` op=`'move'` toZone=`'hand'` | Already works via "Move to → Hand" in the Move-to group. Needs a **shortcut button** "↩ Bounce to hand" in the Selected tab State section (next to "Recall to base"), and a quick right-click item in the status flyout | **trivial** |
| 8 | Set / clear [Mighty] state | Med | Both | `OVERRIDE` op=`'grant'` flag=`'mighty'` | New `case 'mighty'` in `grant` switch: set/clear `u.buffs` to satisfy [Mighty] (which the engine evaluates via `stateActive('Mighty', …)`). Requires reading the state definition — see engine.ts for `STATES`. Add toggle button to SelectedTab + right-click statuses | **small** |
| 9 | Move an ENEMY unit (to a BF or base) | Med | Right-click only | `OVERRIDE` op=`'move'` on ANY iid regardless of owner | **Already works** — the `move` op has no owner guard (engine.ts:7295 uses `card.owner` from the card itself). Gap is UI: the right-click "Move to…" group only shows for **own** cards (gated by `ci.owner === perspective` at line ~554 of MatchBoard.tsx). In sandbox mode the group is already built for all cards via the `match.sandbox` block starting at line 554 — check: the `moveItems` group IS added regardless of ownership. So this gap may already be covered. Verify that `openMenu` is called for enemy battlefield units — it is (line 1740). **No engine change needed; UI likely already correct.** | **trivial (verify)** |
| 10 | Give exact temp Might with stepper | Low | Right-click only | `OVERRIDE` op=`'setTempMight'` value=N | Already present in the "Might & damage" drill-down group (line 595 of MatchBoard.tsx). **Already covered.** | n/a |
| 11 | Add a keyword to a unit beyond [Ganking]/[Assault] — specifically [Vision], [Backline] | Low | HUD only | `OVERRIDE` op=`'grant'` flag=`'vision'` / `'backline'` | engine.ts `grant` switch — new cases setting `u.grantVision = true` / `u.grantBackline = true` on `EngineCard` (requires adding those fields to `EngineCard` in types.ts); then `unitHasVision` checks etc. must read them. Significant engine-touch. | **engine-touch** |
| 12 | Reveal top card of main deck (non-Vision) | Low | Right-click on deck zone | `REVEAL_TOP` | Already an `Action` type (`REVEAL_TOP` at types.ts line 435). Expose as a right-click item in the deck zone menu | **trivial** |

---

## 3. Concrete Implementation Spec: Top 7 Additions

Ordered by value-to-risk ratio. All additions are ADDITIVE; they do not alter any existing behavior.

---

### Spec 1 — Grant [Shield N] / [Tank] / [Deflect N] toggles

**Why high value:** `grantShield`, `grantTank`, `grantDeflect` are already tracked on `EngineCard` (types.ts lines 95–104) and read by `bfCombatBonus()` / combat resolution. The engine already clears them at end-of-turn. The only gap is the OVERRIDE wire-up.

**Engine change (engine.ts, inside `case 'grant'` switch, line 7338):**
```
case 'shield':  u.grantShield  = Math.max(0, (u.grantShield ?? 0) + (action.amount ?? 1)); break
case 'tank':    u.grantTank    = !u.grantTank; break
case 'deflect': u.grantDeflect = Math.max(0, (u.grantDeflect ?? 0) + (action.amount ?? 1)); break
```

**No new GameEventKind needed** (cosmetic state change; no animation).

**ControlHUD.tsx wiring** (SelectedTab, inside the `isUnit` State section `<div className="flex flex-wrap gap-1">`, after the `[Ganking]` button, ~line 389):
```tsx
<button className={BTN} onClick={() => ov('grant', { flag: 'shield', amount: 1 })}>[Shield] +1 ({(cc as any).grantShield ?? 0})</button>
<button className={BTN} onClick={() => ov('grant', { flag: 'shield', amount: -1 })}>[Shield] −1</button>
<button className={BTN} onClick={() => ov('grant', { flag: 'tank' })}>{mark((cc as any).grantTank)}[Tank]</button>
<button className={BTN} onClick={() => ov('grant', { flag: 'deflect', amount: 1 })}>[Deflect] +1 ({(cc as any).grantDeflect ?? 0})</button>
<button className={BTN} onClick={() => ov('grant', { flag: 'deflect', amount: -1 })}>[Deflect] −1</button>
```

**MatchBoard.tsx wiring** (inside `statuses.push(...)` block for units, ~line 563, after `[Assault]` entries):
```tsx
{ label: `[Shield] ${(cc as any).grantShield ?? 0}　+1`, action: ov('grant', { flag: 'shield', amount: 1 }) },
{ label: `[Shield] ${(cc as any).grantShield ?? 0}　−1`, action: ov('grant', { flag: 'shield', amount: -1 }) },
{ label: `${mark((cc as any).grantTank)}[Tank]`, action: ov('grant', { flag: 'tank' }) },
{ label: `[Deflect] ${(cc as any).grantDeflect ?? 0}　+1`, action: ov('grant', { flag: 'deflect', amount: 1 }) },
{ label: `[Deflect] ${(cc as any).grantDeflect ?? 0}　−1`, action: ov('grant', { flag: 'deflect', amount: -1 }) },
```

**Effort: trivial** — engine change is 3 lines; UI change is ~10 lines total.

---

### Spec 2 — Kill Gear / Bounce Gear overrides

**Why high value:** `killGearByIid` and `bounceGearByIid` are already fully implemented internal functions (engine.ts lines 2482 and 2553). Gear-kill / gear-bounce (`killGear`, `bounceGear`) are the two highest-priority engine gaps in mechanics-and-symbols.md §G9. A sandbox control lets the host manually trigger these effects when auto-resolution fails (e.g., after Adaptatron's conquer trigger).

**types.ts change** — add to `OverrideOp` union (line 23, after `'tutorShuffle'`):
```ts
| 'killGear' | 'bounceGear'
```

**Engine change** — two new cases in `OVERRIDE` switch (engine.ts, after `case 'trash'` block, ~line 7291):
```ts
case 'killGear':   if (action.iid) killGearByIid(s, action.iid);   break
case 'bounceGear': if (action.iid) bounceGearByIid(s, action.iid); break
```

**No new GameEventKind** — gear kill goes to trash via `sendToTrash` inside `killGearByIid`; no new animation needed.

**MatchBoard.tsx wiring** — inside the `match.sandbox` block that builds `groups`, find the "Remove" group (line 664). Add right-click items for any `card?.type === 'gear'` card (whether unattached in base or as an `attached` ref on a unit). For unattached gear in base, use its `iid` directly. For attached gear shown via `GearPeek`, the user first needs to right-click the unit — add entries inside the loop that builds detach items (line 503):
```tsx
// Kill or bounce each attached gear (sandbox).
if (match.sandbox) {
  for (const ref of ci.attached) {
    const [, giid] = ref.split('|')
    items.push({ label: `⊗ Kill ${getCard(ref.split('|')[0])?.name ?? 'gear'}`, action: ov('killGear', { iid: giid }) })
    items.push({ label: `↩ Bounce ${getCard(ref.split('|')[0])?.name ?? 'gear'} to hand`, action: ov('bounceGear', { iid: giid }) })
  }
}
```
For unattached gear in base (own + opponent's), add to the sandbox block near the existing "Equip to a unit" check:
```tsx
if (match.sandbox && card?.type === 'gear') {
  groups.push({ label: 'Gear', items: [
    { label: '⊗ Kill (send to trash)', action: ov('killGear') },
    { label: '↩ Bounce to hand', action: ov('bounceGear') },
  ]})
}
```
Note: when `action.iid` is passed without an explicit `iid` in `ov()`, the outer `ov` helper already sets `iid: ci.iid` for unattached gear cards.

**ControlHUD.tsx wiring** — in SelectedTab, add a "Gear" section alongside "Remove & owner" that is gated on `card?.type === 'gear'`:
```tsx
{card?.type === 'gear' && (
  <div className={SECTION}>
    <div className={LABEL}>Gear</div>
    <div className="flex flex-wrap gap-1">
      <button className={BTN} onClick={() => ov('killGear')}>Kill (trash)</button>
      <button className={BTN} onClick={() => ov('bounceGear')}>Bounce to hand</button>
    </div>
  </div>
)}
```

**Effort: small** — 2 lines of engine logic; ~20 lines of UI wiring.

---

### Spec 3 — "Bounce to Hand" shortcut button

**Why:** `move` + `toZone='hand'` already works (it's in the "Move to…" group). But the "Recall to base" shortcut (single click in the State section) has no equivalent for returning to hand. Bouncing a unit to hand is a frequent manual-fix operation (Gust effects, Zaunite Bouncer, etc.). Making it a one-click op rather than drilling into "Move to… → Hand" materially speeds up play.

**Engine change: none** — reuses existing `OVERRIDE` op=`'move'` toZone=`'hand'`.

**GameEventKind: none** needed (the `move` event is emitted by the `OVERRIDE` log line).

**ControlHUD.tsx wiring** (SelectedTab, inside the State section `<div className="flex flex-wrap gap-1">`, after the "Recall to base" button, ~line 399):
```tsx
<button className={BTN} onClick={() => mv('hand', undefined)}>↩ Bounce to hand</button>
```

**MatchBoard.tsx wiring** (inside `statuses` block for units, after the existing "Recall to base" entry, ~line 582):
```tsx
{ label: '↩ Bounce to hand', action: mv('hand', undefined) },
```

**Effort: trivial** — 2 lines in each UI file.

---

### Spec 4 — "Heal (clear damage)" alias button

**Why:** `setDamage` value=0 is already in the "Might & damage" drill-down. But "heal" is a conceptually distinct verb from "Set damage 0" and players look for it in the State section alongside stun/ready. A labeled alias at the top level saves the extra drill-in.

**Engine change: none** — dispatches existing `OVERRIDE` op=`'setDamage'` value=0.

**GameEventKind: none** — no animation needed.

**ControlHUD.tsx wiring** (SelectedTab, inside Might & damage section, after the "Set 0" button row, ~line 419):
```tsx
<button className={BTN} title="Clear all damage (heal)" onClick={() => ov('setDamage', { value: 0 })}>Heal (dmg→0)</button>
```

**MatchBoard.tsx wiring** (inside "Might & damage" drill-down group items, after `'Set damage 6'`, ~line 592):
```tsx
{ label: 'Heal (set damage 0)', action: ov('setDamage', { value: 0 }) },
```

**Effort: trivial** — 2 lines total.

---

### Spec 5 — Set / Clear [Mighty] state

**Why:** [Mighty] is a mid-game state for several marquee champions (Fiora, Volibear, Kadregrin). In playtesting, the engine may not auto-detect the transition when a board state is manually altered. A toggle lets the host force `[Mighty]` on/off.

**Understanding the engine's [Mighty] model:** `stateActive('Mighty', s, unit)` in `engine.ts` evaluates `STATES['Mighty']` — a condition array (e.g., `u.buffs >= 1` AND is at a battlefield). The engine does NOT store `[Mighty]` as a flag; it is derived. To FORCE a unit into [Mighty] we grant it a buff counter (since `[Mighty]` = has buff AND at battlefield). To FORCE a unit OUT of [Mighty] we clear its buffs. The existing `buff` / `unbuff` ops (already in both surfaces) already do this indirectly. A dedicated "Toggle [Mighty]" button is therefore a UI alias that reads the current `stateActive` value and dispatches `buff` or `unbuff`.

**Engine change: none** — reuse `buff` (op) / `unbuff` (op).

**GameEventKind: none** — `buff` events are already emitted by the `buff` op.

**ControlHUD.tsx wiring** (SelectedTab, inside State section, after `[Ganking]` entries, ~line 392):
```tsx
{/* [Mighty] = has ≥1 buff AND at a battlefield; the toggle sets/clears the buff. */}
<button className={BTN} onClick={() => ov((ci.buffs ?? 0) >= 1 ? 'unbuff' : 'buff')}>{mark((ci.buffs ?? 0) >= 1)}[Mighty] (buff)</button>
```

**MatchBoard.tsx wiring** (inside `statuses` array, after `[Assault]` entries, ~line 575):
```tsx
{ label: `${mark((cc as any).buffs >= 1)}[Mighty] (buff=${(cc as any).buffs ?? 0})`, action: ov((cc.buffs ?? 0) >= 1 ? 'unbuff' : 'buff') },
```

**Effort: trivial** — 2 lines in each UI file; no engine change.

---

### Spec 6 — Reveal Top Card of Deck

**Why:** `REVEAL_TOP` is an existing `Action` type (types.ts line 435). It peeks the top card of the main deck and opens a `vision` pending decision (keep or recycle). It is already handled in the engine reducer. But it is NOT exposed in the zone right-click menu for the deck zone, nor via any sandbox button. Playtesting frequently needs "let me see the top card" for scripted scenarios.

**Engine change: none** — dispatches existing `REVEAL_TOP` action.

**GameEventKind: none** needed.

**MatchBoard.tsx wiring** (inside `openZoneMenu` for `kind === 'deck'`, after the existing shuffle item, ~line 698):
```tsx
items.push({ label: '👁 Reveal top card (Vision)', action: { type: 'REVEAL_TOP', player: owner } as Action })
```

Note: `REVEAL_TOP` is dispatched with `player: owner` (not always `perspective` — the zone menu's `owner` parameter already tracks which player owns the deck).

**ControlHUD.tsx wiring** (Player tab, inside the Deck section, next to "Browse / tutor" and "Shuffle", ~line 208):
```tsx
<button className={BTN} title="Peek top card (opens Vision choice)" onClick={() => pov('draw', { amount: 0 })} /* ... */ >
```
Wait — `REVEAL_TOP` is not an `OverrideOp`. It must be dispatched as a raw `Action`, not via `pov()`. Add it via `onAct` directly:
```tsx
<button className={BTN} title="Peek top card (opens Vision choice)" onClick={() => onAct({ type: 'REVEAL_TOP', player: target } as Action)}>👁 Reveal top</button>
```
Place this in the Deck section of the Player tab (~line 209, after "Mill 1").

**Effort: trivial** — 1 line in MatchBoard.tsx, 1 line in ControlHUD.tsx.

---

### Spec 7 — Deck-Zone "Search Trash" quick link in ControlHUD

**Why:** The right-click trash-zone menu already has "Search trash…" (opens `CardSearchOverlay` with source=`'trash'`). The ControlHUD's Player tab browse only covers the MAIN DECK (lines 207–225) and shows a trash list as "click to take back" (lines 226–237). There is no way from the HUD to SEARCH the trash with name-filtering. The HUD already has a query input for the deck browse. Extending the trash list to use the same filter input would let players do filtered "search trash" without right-clicking.

**Engine change: none.**  
**GameEventKind: none.**

**ControlHUD.tsx wiring** (Player tab, Deck section, inside the trash display block ~line 226):
Replace the unconditional trash list render with a filtered version that reuses the existing `query` state:
```tsx
{p.zones.trash.length > 0 && (
  <>
    <div className={LABEL}>Trash ({p.zones.trash.length}) — {query ? 'filtered' : 'click to retrieve'}</div>
    <div className="max-h-24 space-y-0.5 overflow-y-auto">
      {p.zones.trash
        .filter(c => !query || (getCard(c.cardId)?.name ?? '').toLowerCase().includes(query.toLowerCase()))
        .map((c) => (
          <button key={c.iid} onClick={() => pov('move', { iid: c.iid, toZone: 'hand' })} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/70 hover:bg-white/10">
            ↩ {bare(getCard(c.cardId)?.name) || c.cardId}
          </button>
        ))}
    </div>
  </>
)}
```

**Effort: trivial** — ~5 lines changed.

---

## 4. Summary of What Already Exists (Do Not Re-Implement)

| Mechanic | Already in HUD | Already in right-click |
|---|---|---|
| stun / unstun | Yes (Selected tab) | Yes (top-level + sandbox) |
| exhaust / ready | Yes | Yes |
| buff +1 / -1 | Yes | Yes (Might & damage group) |
| temp Might ±1, set exact | Yes | Yes |
| damage ±1, set to N | Yes | Yes |
| score ±1 | Yes (Player tab) | No (player-level, not card) |
| draw N | Yes (Player tab + deck zone) | Yes (zone menus) |
| mill N | Yes (Player tab) | Yes (deck zone menu) |
| channel N | Yes (Player tab + rune-deck zone) | Yes (zone menus) |
| recall to base | Yes (Selected tab) | Yes (status flyout) |
| move any unit to any zone/bf | Yes (Move to… section) | Yes (Move to… group) |
| kill / sacrifice / banish / trash | Yes | Yes |
| spawn any card | Yes (Player tab) | No |
| energy / power adjust | Yes (Player tab) | No |
| set controller | Yes (Selected tab) | Yes (Control battlefield group) |
| [Ganking] toggle | Yes | Yes |
| [Temporary] toggle | Yes | Yes |
| deathShield / banishShield | Yes | Yes |
| re-fire enter triggers | Yes | Yes |
| marker cycle/clear | Yes | Yes |
| facedown toggle | Yes | Yes |
| [Assault] ±1 | Yes | Yes |
| revealFacedown / removeFacedown | No (HUD), but facedown toggle covers it | Yes (Hidden card group) |
| reveal REVEAL (play for 0) | No | Yes (own facedown) |
| set temp Might exact | Yes (stepper) | Yes (stepper in Might group) |
| move-to-champion/legend zone | Yes (Move to…) | Yes (Move to… group) |
| bulk zone move | Yes (Game tab) | No |
| zone swap | Yes (Game tab) | No |

---

## 5. Implementation Order Recommendation

1. **Spec 1** (Shield/Tank/Deflect grants) — highest value-per-line; unblocks 3 keyword gaps
2. **Spec 2** (Kill/Bounce Gear) — highest cross-card impact; unblocks the anti-equipment archetype for manual testing
3. **Spec 3** (Bounce to Hand shortcut) — QoL; trivial
4. **Spec 4** (Heal alias) — QoL; trivial
5. **Spec 6** (Reveal Top from HUD/zone menu) — exposes existing action; trivial
6. **Spec 5** ([Mighty] toggle alias) — low confusion risk; trivial
7. **Spec 7** (Filtered trash search in HUD) — comfort feature; trivial

All 7 specs together represent approximately 50 lines of code changes across 3 files, with zero risk to existing engine behavior.
