import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'spell', domains: ['mind'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `w${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
function zones(owner: PlayerId): Record<ZoneId, EngineCard[]> {
  return { mainDeck: Array.from({ length: 12 }, () => mk(furyUnit.id, owner)), runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: zones(id), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

/** Cast a 0-cost spell from P0 and let the chain resolve (1v1). */
function cast(s: MatchState, iid: string): MatchState {
  let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid, targets: [], payment: emptyPayment() })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
  expect(r.error).toBeFalsy()
  return r.state
}

describe('Time Warp — extra turn', () => {
  const TW = injectCard('tw-test', 'Take a turn after this one. Banish this.')

  it('queues an extra turn and banishes itself (not trashed)', () => {
    const s = baseState()
    const tw = mk(TW, 0)
    s.players[0].zones.hand.push(tw)
    const after = cast(s, tw.iid)
    expect(after.extraTurns).toEqual([0])
    expect(after.players[0].banished.some((c) => c.iid === tw.iid)).toBe(true) // "Banish this"
    expect(after.players[0].zones.trash.some((c) => c.iid === tw.iid)).toBe(false)
  })

  it('the caster takes the next turn (opponent deferred, not skipped)', () => {
    const s = baseState()
    const tw = mk(TW, 0)
    s.players[0].zones.hand.push(tw)
    let st = cast(s, tw.iid)
    st = reduce(st, { type: 'END_TURN', player: 0 }).state
    expect(st.activePlayer).toBe(0) // extra turn back to the caster
    expect(st.extraTurns).toEqual([])
    st = reduce(st, { type: 'END_TURN', player: 0 }).state
    expect(st.activePlayer).toBe(1) // normal order resumes
  })

  it('chains: two Time Warps give two consecutive extra turns before the opponent', () => {
    const s = baseState()
    const a = mk(TW, 0); const b = mk(TW, 0)
    s.players[0].zones.hand.push(a, b)
    let st = cast(s, a.iid)
    st = cast(st, b.iid)
    expect(st.extraTurns).toEqual([0, 0])
    st = reduce(st, { type: 'END_TURN', player: 0 }).state
    expect(st.activePlayer).toBe(0)
    expect(st.extraTurns).toEqual([0])
    st = reduce(st, { type: 'END_TURN', player: 0 }).state
    expect(st.activePlayer).toBe(0) // second extra turn
    expect(st.extraTurns).toEqual([])
    st = reduce(st, { type: 'END_TURN', player: 0 }).state
    expect(st.activePlayer).toBe(1) // finally the opponent
  })
})
