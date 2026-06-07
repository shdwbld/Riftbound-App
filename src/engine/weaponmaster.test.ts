import { describe, it, expect } from 'vitest'
import { reduce, weaponmasterCost } from './engine'
import { parseKeywords } from './keywords'
import { CARDS, CARD_INDEX, getCard } from '../data/cards'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { isUnit } from '../types/cards'

// Weaponmaster (rule 747): the discount math + the WEAPONMASTER_RESOLVE action
// (attach an in-play Equipment, pay Equip cost − 1 Power, or skip).

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.includes('fury'))!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

function injectGear(id: string, text: string, extra: Record<string, unknown> = {}): string {
  CARD_INDEX[id] = { id, name: id, type: 'gear', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, ...extra } as never
  return id
}

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `wm${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
const emptyZones = (): Record<ZoneId, EngineCard[]> => ({ mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] })
const player = (id: PlayerId): PlayerState => ({ id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true })
const baseState = (): MatchState => ({
  players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
  battlefields: [
    { cardId: battlefield.id, units: [], controller: null },
    { cardId: battlefield.id, units: [], controller: null },
    { cardId: battlefield.id, units: [], controller: null },
  ],
  pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
})

describe('weaponmasterCost — Equip cost reduced by 1 Power', () => {
  it('drops exactly 1 rainbow Power, never Energy', () => {
    const gear = CARDS.find((c) => c.type === 'gear' && (parseKeywords(c).equipCost?.anyPower ?? 0) > 0)
    if (!gear) return // dataset guard
    const ec = parseKeywords(gear).equipCost!
    const disc = weaponmasterCost(gear)!
    expect(disc.anyPower).toBe(ec.anyPower - 1)
    expect(disc.energy).toBe(ec.energy)
  })

  it('yields a free (all-zero) cost when the card has no Equip cost', () => {
    const id = injectGear('wm-nocost', 'A plain gear, no [Equip] ability.')
    const d = weaponmasterCost(getCard(id))
    const free = d === null || (d.energy === 0 && d.anyPower === 0 && Object.keys(d.power).length === 0)
    expect(free).toBe(true)
  })
})

describe('WEAPONMASTER_RESOLVE', () => {
  it('attaches a chosen unattached gear from base and clears the pending', () => {
    const gearId = injectGear('wm-free', 'No equip cost.')
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const g = mk(gearId, 0)
    s.players[0].zones.base.push(g)
    s.weaponmaster = { player: 0, unitIids: [u.iid] }
    const r = reduce(s, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u.iid, gearIid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.weaponmaster).toBeNull()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.some((a) => a.startsWith(`${gearId}|`))).toBe(true)
    expect(r.state.players[0].zones.base.some((x) => x.iid === g.iid)).toBe(false)
  })

  it('skip (gearIid null) clears the pending and attaches nothing', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    s.players[0].zones.base.push(mk(injectGear('wm-skip-gear', 'gear'), 0))
    s.weaponmaster = { player: 0, unitIids: [u.iid] }
    const r = reduce(s, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u.iid, gearIid: null })
    expect(r.error).toBeUndefined()
    expect(r.state.weaponmaster).toBeNull()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.length).toBe(0)
  })

  it('still charges the remaining Equip cost after the 1-Power discount', () => {
    // A gear whose Equip cost is Energy-only (Energy is never discounted), so a
    // remaining cost must be paid from the pool/runes.
    const gear = CARDS.find((c) => {
      const ec = parseKeywords(c).equipCost
      return c.type === 'gear' && !!ec && ec.energy > 0 && Object.keys(ec.power).length === 0
    })
    if (!gear) return // dataset guard
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const g = mk(gear.id, 0)
    s.players[0].zones.base.push(g)
    s.players[0].pool = { energy: 10, power: {} }
    for (let i = 0; i < 6; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // cover any rainbow
    s.weaponmaster = { player: 0, unitIids: [u.iid] }
    const r = reduce(s, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u.iid, gearIid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.some((a) => a.startsWith(`${gear.id}|`))).toBe(true)
    expect(r.state.players[0].pool!.energy).toBeLessThan(10) // remaining Energy was paid
  })

  it('rejects a resolve that does not match the pending decision', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    // no s.weaponmaster set
    const r = reduce(s, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u.iid, gearIid: null })
    expect(r.error).toBeTruthy()
  })

  it('drains a multi-unit queue one decision at a time (Arise! chain)', () => {
    const s = baseState()
    const u1 = mk(furyUnit.id, 0)
    const u2 = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u1, u2)
    s.players[0].zones.base.push(mk(injectGear('q-g1', 'gear'), 0), mk(injectGear('q-g2', 'gear'), 0))
    s.weaponmaster = { player: 0, unitIids: [u1.iid, u2.iid] }
    const r1 = reduce(s, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u1.iid, gearIid: null })
    expect(r1.error).toBeUndefined()
    expect(r1.state.weaponmaster).toMatchObject({ player: 0, unitIids: [u2.iid] }) // advanced to the next
    const r2 = reduce(r1.state, { type: 'WEAPONMASTER_RESOLVE', player: 0, unitIid: u2.iid, gearIid: null })
    expect(r2.state.weaponmaster).toBeNull() // queue drained
  })
})

describe('token instance numbering (#N — monotonic, never reused)', () => {
  const SAND = 'tok-sand-soldier'
  const spawn = (st: MatchState) => reduce(st, { type: 'OVERRIDE', player: 0, op: 'spawn', cardId: SAND, toZone: 'base' }).state
  it('numbers 1,2,3,… per cardId and never reuses a dead token’s number', () => {
    let s = baseState()
    s.sandbox = true
    s = spawn(s); s = spawn(s); s = spawn(s); s = spawn(s) // #1 #2 #3 #4
    const sand = (st: MatchState) => st.players[0].zones.base.filter((c) => c.cardId === SAND)
    expect(sand(s).map((c) => c.tokenNo)).toEqual([1, 2, 3, 4])
    // Kill #2, then spawn again — the new one is #5, never #2.
    const two = sand(s).find((c) => c.tokenNo === 2)!
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: two.iid }).state
    s = spawn(s)
    const newest = sand(s).reduce((hi, c) => ((c.tokenNo ?? 0) > (hi.tokenNo ?? 0) ? c : hi))
    expect(newest.tokenNo).toBe(5)
  })
})
