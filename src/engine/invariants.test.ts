import { describe, it, expect } from 'vitest'
import { checkInvariants } from './invariants'
import type { MatchState, EngineCard, PlayerId, ZoneId } from './types'

let n = 0
const mk = (cardId = 'c', owner: PlayerId = 0, o: Partial<EngineCard> = {}): EngineCard =>
  ({ iid: `iv${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })

const zones = (): Record<ZoneId, EngineCard[]> => ({ mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] })
const player = (id: PlayerId) => ({
  id, name: `P${id}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0,
  banished: [] as EngineCard[], pool: { energy: 0, power: {} }, zones: zones(), mulliganed: true,
})

function clean(): MatchState {
  return {
    players: [player(0), player(1)],
    activePlayer: 0,
    firstPlayer: 0,
    phase: 'action',
    turn: 1,
    battlefields: [
      { cardId: 'bf', units: [], controller: null },
      { cardId: 'bf', units: [], controller: null },
    ],
    pointsToWin: 8,
    winner: null,
    showdown: null,
    chain: [],
    priority: null,
    passes: 0,
    log: [],
    seq: 0,
  } as unknown as MatchState
}

describe('checkInvariants', () => {
  it('passes a clean state', () => {
    expect(checkInvariants(clean())).toEqual([])
  })

  it('flags a duplicate iid across zones', () => {
    const s = clean()
    const dup = mk('c', 0)
    s.players[0].zones.base.push(dup)
    s.battlefields[0].units.push(dup) // same instance in two places
    s.battlefields[0].controller = 0
    const out = checkInvariants(s)
    expect(out.some((m) => m.includes('duplicate card iid'))).toBe(true)
  })

  it('flags negative scalars and damage', () => {
    const s = clean()
    s.players[0].points = -1
    s.players[1].zones.base.push(mk('c', 1, { damage: -3 }))
    const out = checkInvariants(s)
    expect(out.some((m) => m.includes('negative points'))).toBe(true)
    expect(out.some((m) => m.includes('negative damage'))).toBe(true)
  })

  it('flags a controller with no units there', () => {
    const s = clean()
    s.battlefields[0].controller = 1 // but bf0 is empty
    expect(checkInvariants(s).some((m) => m.includes('no units'))).toBe(true)
  })

  it('flags chain/priority + showdown inconsistencies', () => {
    const s = clean()
    s.priority = 0 // priority set but chain empty
    expect(checkInvariants(s).some((m) => m.includes('priority is set but the chain is empty'))).toBe(true)
    const s2 = clean()
    s2.phase = 'showdown'
    expect(checkInvariants(s2).some((m) => m.includes('phase is showdown but showdown is null'))).toBe(true)
  })
})
