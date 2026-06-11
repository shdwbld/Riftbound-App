import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// Phase G of the rules-fidelity campaign: triggered abilities go on the Chain
// (rule 376.4) with a smart auto-pass — a seat with no legal reaction passes
// automatically, so reaction-free boards resolve synchronously (exactly like the
// old inline firing), while a seat holding an affordable Reaction gets a real
// window before the trigger resolves.

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'unit', domains: ['order'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.length === 1 && c.produces.includes('fury'))!

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `cf${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
function zones(owner: PlayerId): Record<ZoneId, EngineCard[]> {
  return { mainDeck: Array.from({ length: 8 }, () => mk(furyUnit.id, owner)), runeDeck: [mk(furyRune.id, owner), mk(furyRune.id, owner)], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: zones(id), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 1, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

const SOT_DRAW = injectCard('cf-sot-draw', 'At the start of your turn, draw 1.', { name: 'Tactician' })

describe('Phase G1 — triggers on the chain with smart auto-pass', () => {
  it('start-of-turn trigger resolves synchronously when no seat holds a reaction', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(SOT_DRAW, 0))
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'END_TURN', player: 1 }) // P1 ends → P0's turn begins
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(0) // every seat auto-passed → resolved inline
    // +1 from the Draw Phase, +1 from the chained-and-resolved trigger.
    expect(r.state.players[0].zones.hand.length).toBe(before + 2)
  })

  it('the window stays open when an opponent holds an affordable Reaction', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(SOT_DRAW, 0))
    const react = mk(injectCard('cf-react', '[Reaction] Draw 1.', { type: 'spell', energy: 0, power: {} }), 1)
    s.players[1].zones.hand.push(react)
    const before = s.players[0].zones.hand.length
    let r = reduce(s, { type: 'END_TURN', player: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(1) // paused — P1 can respond
    expect(r.state.chain[0].kind).toBe('trigger')
    expect(r.state.priority).toBe(1)
    expect(r.state.players[0].zones.hand.length).toBe(before + 1) // turn draw only — trigger unresolved
    // P1 passes; P0 has no reaction → auto-pass → the trigger resolves.
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(0)
    expect(r.state.players[0].zones.hand.length).toBe(before + 2)
  })

  it('an unaffordable Reaction does not hold the window open', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(SOT_DRAW, 0))
    // P1 holds a Reaction costing 3 Energy with no runes/pool to pay it.
    s.players[1].zones.hand.push(mk(injectCard('cf-pricey', '[Reaction] Draw 1.', { type: 'spell', energy: 3, power: {} }), 1))
    s.players[1].zones.runeDeck = []
    const r = reduce(s, { type: 'END_TURN', player: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(0) // can't actually respond → auto-passed
  })

  it("trigger items can't be countered (counters hit spells only)", () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(SOT_DRAW, 0))
    const counter = mk(injectCard('cf-counter', '[Reaction] Counter a spell.', { type: 'spell', energy: 0, power: {} }), 1)
    s.players[1].zones.hand.push(counter)
    let r = reduce(s, { type: 'END_TURN', player: 1 })
    expect(r.state.chain.length).toBe(1) // window open (P1 holds the counter)
    const trigId = r.state.chain[0].id
    r = reduce(r.state, { type: 'COUNTER', player: 1, iid: counter.iid, targetChainId: trigId, payment: emptyPayment() })
    expect(r.error).toMatch(/can't be countered/i)
  })

  it('a Reaction played in the window resolves before the trigger (LIFO)', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(SOT_DRAW, 0))
    const react = mk(injectCard('cf-react2', '[Reaction] Draw 1.', { type: 'spell', energy: 0, power: {} }), 1)
    s.players[1].zones.hand.push(react)
    let r = reduce(s, { type: 'END_TURN', player: 1 })
    expect(r.state.priority).toBe(1)
    const p1Before = r.state.players[1].zones.hand.length // after END_TURN bookkeeping
    r = reduce(r.state, { type: 'PLAY_SPELL', player: 1, iid: react.iid, targets: [], payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(2) // trigger below, reaction on top
    // Both seats now reaction-less: P0 passes manually, P1 auto-passes → spell
    // resolves; then the trigger auto-resolves too.
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.chain.length).toBe(0)
    expect(r.state.players[1].zones.hand.length).toBe(p1Before) // played 1, drew 1
  })
})
