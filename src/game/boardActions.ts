import { type GameState, type CardInstance, type ZoneId, card } from './state'
import { getCard } from '../data/cards'

// ---------------------------------------------------------------------------
// Manual board mutations for the Phase 3 goldfish board. Each returns a new
// GameState (no in-place mutation of the input). No rules are enforced — these
// are the "physical" moves a player could make with real cards on a table.
// ---------------------------------------------------------------------------

export type MoveTarget =
  | { kind: 'zone'; zone: ZoneId }
  | { kind: 'battlefield'; index: number }

function clone(state: GameState): GameState {
  return {
    ...state,
    zones: {
      mainDeck: [...state.zones.mainDeck],
      runeDeck: [...state.zones.runeDeck],
      hand: [...state.zones.hand],
      base: [...state.zones.base],
      runePool: [...state.zones.runePool],
      trash: [...state.zones.trash],
    },
    battlefields: state.battlefields.map((b) => ({ ...b, units: [...b.units] })),
    log: state.log,
  }
}

function log(state: GameState, msg: string): GameState {
  return { ...state, log: [...state.log, msg] }
}

function name(cardId: string): string {
  return getCard(cardId)?.name ?? cardId
}

/** Remove an instance from wherever it is. Returns new state + the instance. */
function pluck(
  state: GameState,
  iid: string,
): { state: GameState; instance: CardInstance | null } {
  const next = clone(state)
  for (const zone of Object.keys(next.zones) as ZoneId[]) {
    const idx = next.zones[zone].findIndex((c) => c.iid === iid)
    if (idx >= 0) {
      const [instance] = next.zones[zone].splice(idx, 1)
      return { state: next, instance }
    }
  }
  for (const bf of next.battlefields) {
    const idx = bf.units.findIndex((c) => c.iid === iid)
    if (idx >= 0) {
      const [instance] = bf.units.splice(idx, 1)
      return { state: next, instance }
    }
  }
  return { state: next, instance: null }
}

function place(state: GameState, target: MoveTarget, instance: CardInstance): GameState {
  const next = clone(state)
  if (target.kind === 'zone') {
    next.zones[target.zone] = [...next.zones[target.zone], instance]
  } else {
    next.battlefields[target.index] = {
      ...next.battlefields[target.index],
      units: [...next.battlefields[target.index].units, instance],
    }
  }
  return next
}

/** Move an instance to a target location. */
export function move(state: GameState, iid: string, target: MoveTarget): GameState {
  const { state: s1, instance } = pluck(state, iid)
  if (!instance) return state
  let s2 = place(s1, target, instance)
  const dest =
    target.kind === 'zone' ? target.zone : name(state.battlefields[target.index].cardId)
  s2 = log(s2, `Moved ${name(instance.cardId)} → ${dest}`)
  return s2
}

export function draw(state: GameState, n = 1): GameState {
  let next = clone(state)
  let drawn = 0
  for (let i = 0; i < n && next.zones.mainDeck.length > 0; i++) {
    const c = next.zones.mainDeck.shift()!
    next.zones.hand.push(c)
    drawn++
  }
  return log(next, `Drew ${drawn} card${drawn === 1 ? '' : 's'}`)
}

/** Channel runes: top of rune deck → rune pool, entering ready. */
export function channel(state: GameState, n = 2): GameState {
  let next = clone(state)
  let ch = 0
  for (let i = 0; i < n && next.zones.runeDeck.length > 0; i++) {
    const c = next.zones.runeDeck.shift()!
    next.zones.runePool.push({ ...c, exhausted: false })
    ch++
  }
  return log(next, `Channeled ${ch} rune${ch === 1 ? '' : 's'}`)
}

/** Recycle a rune: send it to the bottom of the rune deck. */
export function recycle(state: GameState, iid: string): GameState {
  const { state: s1, instance } = pluck(state, iid)
  if (!instance) return state
  const next = clone(s1)
  next.zones.runeDeck.push({ ...instance, exhausted: false, damage: 0 })
  return log(next, `Recycled ${name(instance.cardId)}`)
}

export function toggleExhaust(state: GameState, iid: string): GameState {
  const next = clone(state)
  if (next.legend?.iid === iid) {
    next.legend = { ...next.legend, exhausted: !next.legend.exhausted }
    return next
  }
  for (const zone of Object.keys(next.zones) as ZoneId[]) {
    const c = next.zones[zone].find((x) => x.iid === iid)
    if (c) {
      c.exhausted = !c.exhausted
      return next
    }
  }
  for (const bf of next.battlefields) {
    const c = bf.units.find((x) => x.iid === iid)
    if (c) {
      c.exhausted = !c.exhausted
      return next
    }
  }
  return next
}

/** Awaken step: ready everything, advance the turn counter. */
export function awaken(state: GameState): GameState {
  const next = clone(state)
  if (next.legend) next.legend = { ...next.legend, exhausted: false }
  for (const zone of Object.keys(next.zones) as ZoneId[])
    next.zones[zone] = next.zones[zone].map((c) => ({ ...c, exhausted: false }))
  next.battlefields = next.battlefields.map((b) => ({
    ...b,
    units: b.units.map((c) => ({ ...c, exhausted: false })),
  }))
  next.turn = state.turn + 1
  return log(next, `— Turn ${next.turn}: Awaken (readied all) —`)
}

export function adjustPoints(state: GameState, delta: number): GameState {
  const next = { ...state, points: Math.max(0, state.points + delta) }
  return log(next, `Points ${delta >= 0 ? '+' : ''}${delta} → ${next.points}`)
}

export function toggleHold(state: GameState, index: number): GameState {
  const next = clone(state)
  const bf = next.battlefields[index]
  next.battlefields[index] = { ...bf, held: !bf.held }
  return log(
    next,
    `${next.battlefields[index].held ? 'Holding' : 'Released'} ${name(bf.cardId)}`,
  )
}

/** Mulligan: shuffle hand back, redraw the same number. */
export function mulligan(state: GameState): GameState {
  let next = clone(state)
  const handSize = next.zones.hand.length
  next.zones.mainDeck = [...next.zones.mainDeck, ...next.zones.hand]
  next.zones.hand = []
  // shuffle
  for (let i = next.zones.mainDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next.zones.mainDeck[i], next.zones.mainDeck[j]] = [
      next.zones.mainDeck[j],
      next.zones.mainDeck[i],
    ]
  }
  next.zones.hand = next.zones.mainDeck.splice(0, handSize)
  return log(next, `Mulligan (redrew ${handSize})`)
}

/** Convenience: which resources are available from the ready rune pool. */
export function availableResources(state: GameState): {
  energy: number
  power: Record<string, number>
} {
  let energy = 0
  const power: Record<string, number> = {}
  for (const r of state.zones.runePool) {
    if (r.exhausted) continue
    energy++ // any ready rune can be exhausted for 1 energy
    const def = card(r)
    if (def && def.type === 'rune')
      for (const d of def.produces) power[d] = (power[d] ?? 0) + 1
  }
  return { energy, power }
}
