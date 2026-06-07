import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'spell', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `cc${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
const zones = (): Record<ZoneId, EngineCard[]> => ({ mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] })
const player = (id: PlayerId): PlayerState => ({ id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: zones(), mulliganed: true } as PlayerState)
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}
/** Pass priority back and forth until the chain fully resolves. */
function drainChain(s: MatchState): MatchState {
  let guard = 0
  while (s.chain.length && s.priority != null && guard++ < 20) {
    s = reduce(s, { type: 'PASS_PRIORITY', player: s.priority }).state
  }
  return s
}

describe('Chain — countering a counter (Defy → Defy)', () => {
  const BOLT = injectCard('cc-bolt', 'Deal 5 to a unit at a battlefield.', { might: undefined })
  const DEFY = injectCard('cc-defy', '[Reaction] Counter a spell.', {})

  it('your counter targets their counter; resolves first, so the original spell still lands', () => {
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(victim)
    const bolt = mk(BOLT, 0)
    const defyP1 = mk(DEFY, 1) // opponent will counter the bolt
    const defyP0 = mk(DEFY, 0) // you counter their counter
    s.players[0].zones.hand.push(bolt, defyP0)
    s.players[1].zones.hand.push(defyP1)

    // P0 plays the bolt at the victim → chain [bolt], priority to P1.
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: bolt.iid, targets: [victim.iid], payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    const boltItem = r.state.chain[r.state.chain.length - 1]
    // P1 counters the bolt.
    r = reduce(r.state, { type: 'COUNTER', player: 1, iid: defyP1.iid, targetChainId: boltItem.id, payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    const counter1 = r.state.chain[r.state.chain.length - 1]
    expect(counter1.kind).toBe('counter')
    // P0 counters P1's counter (Defy on Defy).
    r = reduce(r.state, { type: 'COUNTER', player: 0, iid: defyP0.iid, targetChainId: counter1.id, payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(3)
    // Everyone passes → LIFO: your Defy counters their Defy, then the bolt resolves.
    r = { ...r, state: drainChain(r.state) }
    expect(r.state.chain.length).toBe(0)
    expect(r.state.battlefields[0].units.some((u) => u.iid === victim.iid)).toBe(false) // bolt landed → victim dead
  })
})
