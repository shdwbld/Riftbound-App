import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'unit', domains: ['order'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const ELDER_TEXT = 'Any amount of your damage is enough to kill enemy units. When you play me, choose up to one enemy unit at each location. Deal 1 to them.'

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `ed${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
function zones(owner: PlayerId): Record<ZoneId, EngineCard[]> {
  return { mainDeck: Array.from({ length: 6 }, () => mk(furyUnit.id, owner)), runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: zones(id), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }, { cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

describe('Elder Dragon', () => {
  it('passive (state-based): a pre-damaged enemy dies the instant Elder enters', () => {
    const dragon = injectCard('ed-dragon', ELDER_TEXT, { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    const hurt = mk(furyUnit.id, 1, { damage: 1 }) // already has 1 damage before Elder
    const healthy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(hurt)
    s.battlefields[1].units.push(healthy)
    // The opponent holds an affordable Reaction, so smart auto-pass keeps the window open.
    s.players[1].zones.hand.push(mk(injectCard('ed-react1', '[Reaction] Draw 1.', { type: 'spell', energy: 0, power: {} }), 1))
    const d = mk(dragon, 0); s.players[0].zones.hand.push(d)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    // The pre-damaged unit dies immediately (before any reaction window).
    expect(r.state.battlefields[0].units.some((u) => u.iid === hurt.iid)).toBe(false)
    // The healthy unit is only TARGETED by the on-play trigger, which is on the chain.
    expect(r.state.chain.length).toBe(1)
    expect(r.state.battlefields[1].units.some((u) => u.iid === healthy.iid)).toBe(true) // still alive (trigger unresolved)
  })

  it('smart auto-pass: with no reactions anywhere, the on-play trigger resolves instantly', () => {
    const dragon = injectCard('ed-dragon-ap', ELDER_TEXT, { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    const d = mk(dragon, 0); s.players[0].zones.hand.push(d)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.chain.length).toBe(0) // auto-passed all seats → resolved in the same action
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(false) // 1 = lethal
  })

  it('on-play opens a reaction window (opponent holds a Reaction); resolves to kill on pass', () => {
    const dragon = injectCard('ed-dragon2', ELDER_TEXT, { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    s.players[1].zones.hand.push(mk(injectCard('ed-react2', '[Reaction] Draw 1.', { type: 'spell', energy: 0, power: {} }), 1))
    const d = mk(dragon, 0); s.players[0].zones.hand.push(d)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: emptyPayment() })
    expect(r.state.chain.length).toBe(1) // reaction window open
    expect(r.state.priority).toBe(1) // opponent may respond first
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    // P1's manual pass + P0's auto-pass (no reaction) → the trigger resolved.
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(false) // 1 = lethal
  })

  it('a target that leaves during the reaction window takes no damage', () => {
    const dragon = injectCard('ed-dragon3', ELDER_TEXT, { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    s.sandbox = true
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    s.players[1].zones.hand.push(mk(injectCard('ed-react3', '[Reaction] Draw 1.', { type: 'spell', energy: 0, power: {} }), 1))
    const d = mk(dragon, 0); s.players[0].zones.hand.push(d)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: emptyPayment() })
    expect(r.state.chain.length).toBe(1)
    // The opponent "reacts" by moving the targeted unit to base (simulated via override),
    // then passes — the trigger's target is no longer valid, so no damage.
    r = reduce(r.state, { type: 'OVERRIDE', player: 1, op: 'move', iid: enemy.iid, toZone: 'base' })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.players[1].zones.base.some((u) => u.iid === enemy.iid)).toBe(true) // saved
  })

  it('Unyielding Spirit prevents the on-play (ability) damage', () => {
    const dragon = injectCard('ed-dragon4', ELDER_TEXT, { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    s.preventAbilityDamageThisTurn = true // as if Unyielding Spirit resolved this turn
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    const d = mk(dragon, 0); s.players[0].zones.hand.push(d)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(true) // damage prevented → survives
  })

  it('Unyielding Spirit spell sets the prevention flag', () => {
    const us = injectCard('ed-us', '[Reaction] Prevent all spell and ability damage this turn.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const c = mk(us, 0); s.players[0].zones.hand.push(c)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: c.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.preventAbilityDamageThisTurn).toBe(true)
  })
})

describe('Counter Strike — prevent the next damage to a chosen unit', () => {
  const CS = injectCard('cs-prevent', '[Reaction] Choose a unit. The next time that unit would be dealt damage this turn, prevent it. Draw 1.', { type: 'spell', energy: 0, power: {} })
  const BOLT = injectCard('cs-bolt', 'Deal 3 to a unit at a battlefield.', { type: 'spell', energy: 0, power: {} })

  it('shields the unit from the next (spell) damage, once, and draws', () => {
    const s = baseState()
    const ally = mk(injectCard('cs-ally', 'A unit.', { type: 'unit', might: 2 }), 0)
    s.battlefields[0].units.push(ally)
    const cs = mk(CS, 0); const bolt1 = mk(BOLT, 1); const bolt2 = mk(BOLT, 1)
    s.players[0].zones.hand.push(cs)
    s.players[1].zones.hand.push(bolt1, bolt2)
    // Counter Strike on the ally.
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: cs.iid, targets: [ally.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 }); r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.find((u) => u.iid === ally.iid)?.preventNextDamage).toBe(true)
    expect(r.state.players[0].zones.hand.length).toBe(1) // drew 1 (CS left hand)
    // First bolt is prevented (3 to a 3-Might unit would kill, but it's shielded).
    r = reduce({ ...r.state, activePlayer: 1, priority: null, passes: 0 }, { type: 'PLAY_SPELL', player: 1, iid: bolt1.iid, targets: [ally.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 }); r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.battlefields[0].units.some((u) => u.iid === ally.iid)).toBe(true) // survived (prevented)
    expect(r.state.battlefields[0].units.find((u) => u.iid === ally.iid)?.preventNextDamage).toBeFalsy() // consumed
    // Second bolt now kills it (shield used up).
    r = reduce(r.state, { type: 'PLAY_SPELL', player: 1, iid: bolt2.iid, targets: [ally.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 }); r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.battlefields[0].units.some((u) => u.iid === ally.iid)).toBe(false) // dead
  })
})
