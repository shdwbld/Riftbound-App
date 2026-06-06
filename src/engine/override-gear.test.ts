import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { CARDS, CARD_INDEX } from '../data/cards'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId, Action } from './types'
import { isUnit } from '../types/cards'

// Covers the sandbox OVERRIDE ops added for the manual-control surfaces:
//   - grant flag = shield / tank / deflect (combat keywords for the turn)
//   - killGear / bounceGear (remove an attached or unattached gear)

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

const GEAR_ID = 'ov-test-gear'
CARD_INDEX[GEAR_ID] = {
  id: GEAR_ID, name: 'Test Gear', type: 'gear', domains: ['fury'],
  rarity: 'common', set: 'X', number: 1, text: '', energy: 1, power: {},
} as never

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({
  iid: `og${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o,
})
const emptyZones = (): Record<ZoneId, EngineCard[]> => ({ mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] })
const player = (id: PlayerId): PlayerState => ({
  id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0,
  banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true,
})
const baseState = (): MatchState => ({
  players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
  battlefields: [
    { cardId: battlefield.id, units: [], controller: null },
    { cardId: battlefield.id, units: [], controller: null },
    { cardId: battlefield.id, units: [], controller: null },
  ],
  pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0, sandbox: true,
})

describe('sandbox OVERRIDE — combat-keyword grants', () => {
  it('grants [Shield N], [Tank] and [Deflect N] to a unit', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(u)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'shield', amount: 2 } as Action)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'tank' } as Action)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'deflect', amount: 1 } as Action)
    const out = r.state.battlefields[0].units[0]
    expect(out.grantShield).toBe(2)
    expect(out.grantTank).toBe(true)
    expect(out.grantDeflect).toBe(1)
  })

  it('clamps [Shield] at 0 when removed below zero', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { grantShield: 1 })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'shield', amount: -3 } as Action)
    expect(r.state.battlefields[0].units[0].grantShield).toBe(0)
  })
})

describe('sandbox OVERRIDE — kill / bounce gear', () => {
  it('kills an attached gear → owner trash, unit detached', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { attached: [`${GEAR_ID}|gear-1`] })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'killGear', iid: 'gear-1' } as Action)
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units[0].attached).toHaveLength(0)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === GEAR_ID)).toBe(true)
  })

  it('bounces an unattached gear in base → owner hand', () => {
    const s = baseState()
    const g = mk(GEAR_ID, 1)
    s.players[1].zones.base.push(g)
    const r = reduce(s, { type: 'OVERRIDE', player: 1, op: 'bounceGear', iid: g.iid } as Action)
    expect(r.error).toBeUndefined()
    expect(r.state.players[1].zones.base.some((c) => c.iid === g.iid)).toBe(false)
    expect(r.state.players[1].zones.hand.some((c) => c.cardId === GEAR_ID)).toBe(true)
  })
})
