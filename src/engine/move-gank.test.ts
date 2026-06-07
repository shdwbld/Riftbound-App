import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `g${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

const gankUnit = injectCard('gank-u', '[Ganking] (I can move from battlefield to battlefield.)', { might: 3 })

describe('Multi-Gank lateral move (MOVE_UNITS)', () => {
  it('moves several Ganking units from one battlefield to another together', () => {
    const s = baseState()
    const a = mk(gankUnit, 0)
    const b = mk(gankUnit, 0)
    s.battlefields[0].units.push(a, b)
    s.battlefields[0].controller = 0
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [a.iid, b.iid], toBattlefield: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.length).toBe(0)
    const dest = r.state.battlefields[1].units
    expect(dest.some((u) => u.iid === a.iid)).toBe(true)
    expect(dest.some((u) => u.iid === b.iid)).toBe(true)
    expect(dest.every((u) => u.exhausted)).toBe(true) // a move exhausts them
  })

  it('rejects moving a non-Ganking unit laterally between battlefields', () => {
    const s = baseState()
    const plain = mk(furyUnit.id, 0) // no [Ganking]
    s.battlefields[0].units.push(plain)
    s.battlefields[0].controller = 0
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [plain.iid], toBattlefield: 1 })
    expect(r.error).toBeTruthy() // only Ganking units can move battlefield-to-battlefield
  })
})

describe('Batched move-back-to-base (RETREAT_UNITS)', () => {
  it('recalls several units from battlefields to base in one action', () => {
    const s = baseState()
    const a = mk(furyUnit.id, 0)
    const b = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(a)
    s.battlefields[1].units.push(b)
    s.battlefields[0].controller = 0
    s.battlefields[1].controller = 0
    const r = reduce(s, { type: 'RETREAT_UNITS', player: 0, iids: [a.iid, b.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.length).toBe(0)
    expect(r.state.battlefields[1].units.length).toBe(0)
    const base = r.state.players[0].zones.base
    expect(base.some((u) => u.iid === a.iid && u.exhausted)).toBe(true)
    expect(base.some((u) => u.iid === b.iid && u.exhausted)).toBe(true)
  })
})
