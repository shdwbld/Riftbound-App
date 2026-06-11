import { describe, it, expect } from 'vitest'
import { reduce, stateActive } from './engine'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
  type ShowdownState,
} from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}

// Find real cards to exercise the engine deterministically.
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.includes('fury'))!
const furyUnit = CARDS.find(
  (c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury',
)!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `t${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}

function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}

function player(id: PlayerId): PlayerState {
  return {
    id,
    name: `P${id + 1}`,
    legend: null,
    champion: null,
    tokenPile: [],
    points: 0,
    xp: 0,
    banished: [],
    pool: { energy: 0, power: {} },
    zones: emptyZones(),
    mulliganed: true,
  }
}

function baseState(): MatchState {
  return {
    players: [player(0), player(1)],
    activePlayer: 0,
    firstPlayer: 0,
    phase: 'action',
    turn: 2,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8,
    winner: null,
    showdown: null,
    chain: [],
    priority: null,
    passes: 0,
    log: [],
    seq: 0,
  }
}

// ---------------------------------------------------------------------------
// Helper: a minimal valid ShowdownState
// ---------------------------------------------------------------------------
function mkShowdown(battlefield: number): ShowdownState {
  return {
    battlefield,
    priority: 1,
    passes: 0,
    movedUnit: 'x',
    priorController: null,
  }
}

// ---------------------------------------------------------------------------
describe('state engine', () => {

  // ── mighty — base ────────────────────────────────────────────────────────
  describe('mighty — base', () => {
    it('base-6 unit in a battlefield is mighty', () => {
      const id = injectCard('test-mighty-6', '', { might: 6 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-4 unit is NOT mighty', () => {
      const id = injectCard('test-mighty-4', '', { might: 4 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(false)
    })

    it('base-5 unit is mighty (boundary)', () => {
      const id = injectCard('test-mighty-5', '', { might: 5 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })
  })

  // ── mighty — buff-induced ─────────────────────────────────────────────────
  describe('mighty — buff-induced', () => {
    it('base-4 unit with buffs:1 IS mighty (4+1=5)', () => {
      const id = injectCard('test-buff-4', '', { might: 4 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-3 unit with buffs:1 is NOT mighty (3+1=4)', () => {
      const id = injectCard('test-buff-3', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(false)
    })

    it('base-3 unit with buffs:2 IS mighty (3+2=5)', () => {
      const id = injectCard('test-buff-3b', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 2 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })
  })

  // ── mighty — tempMight ────────────────────────────────────────────────────
  describe('mighty — tempMight', () => {
    it('base-4 unit with tempMight:1 IS mighty (4+1=5)', () => {
      const id = injectCard('test-tmp-4', '', { might: 4 })
      const s = baseState()
      const u = mk(id, 0, { tempMight: 1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-6 unit with tempMight:-1 IS still mighty (6-1=5)', () => {
      const id = injectCard('test-tmp-6-neg1', '', { might: 6 })
      const s = baseState()
      const u = mk(id, 0, { tempMight: -1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-6 unit with tempMight:-2 is NOT mighty (6-2=4)', () => {
      const id = injectCard('test-tmp-6-neg2', '', { might: 6 })
      const s = baseState()
      const u = mk(id, 0, { tempMight: -2 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(false)
    })

    it('base-3 unit with buffs:1 and tempMight:1 IS mighty (3+1+1=5)', () => {
      const id = injectCard('test-tmp-3-combo', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 1, tempMight: 1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })
  })

  // ── mighty — damage does NOT lower the Might stat (Rule 142.2) ────────────
  describe('mighty — damage', () => {
    it('base-6 unit with damage:2 is STILL mighty (Might stat is 6, damage doesn\'t reduce it)', () => {
      const id = injectCard('test-dmg-6', '', { might: 6 })
      const s = baseState()
      const u = mk(id, 0, { damage: 2 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-5 unit with damage:3 is STILL mighty (stat 5 ≥ 5 regardless of damage)', () => {
      const id = injectCard('test-dmg-5', '', { might: 5 })
      const s = baseState()
      const u = mk(id, 0, { damage: 3 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(true)
    })

    it('base-4 unit with damage:0 is NOT mighty (stat 4 < 5)', () => {
      const id = injectCard('test-dmg-4', '', { might: 4 })
      const s = baseState()
      const u = mk(id, 0, { damage: 0 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'mighty')).toBe(false)
    })
  })

  // ── alone ─────────────────────────────────────────────────────────────────
  describe('alone', () => {
    it('one friendly unit at battlefield 0 is alone', () => {
      const id = injectCard('test-alone-1', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'alone')).toBe(true)
    })

    it('a unit at battlefield 0 with a second friendly unit is NOT alone', () => {
      const id = injectCard('test-alone-2', '', { might: 3 })
      const s = baseState()
      const u1 = mk(id, 0)
      const u2 = mk(id, 0)
      s.battlefields[0].units.push(u1, u2)
      expect(stateActive(s, u1, 'alone')).toBe(false)
      expect(stateActive(s, u2, 'alone')).toBe(false)
    })

    it('a unit in zones.base is NOT alone', () => {
      const id = injectCard('test-alone-base', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.players[0].zones.base.push(u)
      // unit is not in any battlefield — bfIndexOfUnit returns -1
      expect(stateActive(s, u, 'alone')).toBe(false)
    })

    it('a unit at battlefield 0 with only an enemy unit there is still alone (enemies do not count)', () => {
      const id = injectCard('test-alone-enemy', '', { might: 3 })
      const s = baseState()
      const friendly = mk(id, 0)
      const enemy = mk(id, 1)
      s.battlefields[0].units.push(friendly, enemy)
      expect(stateActive(s, friendly, 'alone')).toBe(true)
      expect(stateActive(s, enemy, 'alone')).toBe(true)
    })

    it('a unit at battlefield 1 is not affected by units at battlefield 0', () => {
      const id = injectCard('test-alone-bf1', '', { might: 3 })
      const s = baseState()
      const u0 = mk(id, 0)
      const u1 = mk(id, 0)
      s.battlefields[0].units.push(u0)
      s.battlefields[1].units.push(u1)
      expect(stateActive(s, u0, 'alone')).toBe(true)
      expect(stateActive(s, u1, 'alone')).toBe(true)
    })
  })

  // ── buffed ────────────────────────────────────────────────────────────────
  describe('buffed', () => {
    it('unit with buffs:1 is buffed', () => {
      const id = injectCard('test-buffed-1', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 1 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'buffed')).toBe(true)
    })

    it('unit with buffs:0 is NOT buffed', () => {
      const id = injectCard('test-buffed-0', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 0 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'buffed')).toBe(false)
    })

    it('unit with buffs:undefined is NOT buffed', () => {
      const id = injectCard('test-buffed-undef', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0) // no buffs property
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'buffed')).toBe(false)
    })

    it('unit with buffs:2 is buffed', () => {
      const id = injectCard('test-buffed-2', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0, { buffs: 2 })
      s.battlefields[0].units.push(u)
      expect(stateActive(s, u, 'buffed')).toBe(true)
    })
  })

  // ── inCombat ──────────────────────────────────────────────────────────────
  describe('inCombat', () => {
    it('unit at the showdown battlefield is inCombat', () => {
      const id = injectCard('test-ic-1', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      s.showdown = mkShowdown(0)
      expect(stateActive(s, u, 'inCombat')).toBe(true)
    })

    it('unit at a different battlefield than the showdown is NOT inCombat', () => {
      const id = injectCard('test-ic-2', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[1].units.push(u)
      s.showdown = mkShowdown(0) // showdown at bf 0, unit at bf 1
      expect(stateActive(s, u, 'inCombat')).toBe(false)
    })

    it('unit at showdown battlefield 2 is inCombat', () => {
      const id = injectCard('test-ic-3', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[2].units.push(u)
      s.showdown = mkShowdown(2)
      expect(stateActive(s, u, 'inCombat')).toBe(true)
    })

    it('with showdown:null, no unit is inCombat', () => {
      const id = injectCard('test-ic-null', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.battlefields[0].units.push(u)
      s.showdown = null
      expect(stateActive(s, u, 'inCombat')).toBe(false)
    })

    it('enemy unit at the same showdown battlefield is also inCombat', () => {
      const id = injectCard('test-ic-enemy', '', { might: 3 })
      const s = baseState()
      const friendly = mk(id, 0)
      const enemy = mk(id, 1)
      s.battlefields[0].units.push(friendly, enemy)
      s.showdown = mkShowdown(0)
      expect(stateActive(s, friendly, 'inCombat')).toBe(true)
      expect(stateActive(s, enemy, 'inCombat')).toBe(true)
    })

    it('unit in base is NOT inCombat even if showdown is open', () => {
      const id = injectCard('test-ic-base', '', { might: 3 })
      const s = baseState()
      const u = mk(id, 0)
      s.players[0].zones.base.push(u)
      s.showdown = mkShowdown(0)
      // bfIndexOfUnit returns -1 for base units; -1 !== 0, so not inCombat
      expect(stateActive(s, u, 'inCombat')).toBe(false)
    })
  })
})

describe('state engine — behavior', () => {
  const orderRune = CARDS.find((c) => c.type === 'rune' && (c as { produces?: string[] }).produces?.includes('order'))!

  it('drawPerMighty: "draw 1 for each of your [Mighty] units" counts EFFECTIVE Mighty (Kadregrin)', () => {
    const kad = injectCard('kad-t', 'When you play me, draw 1 for each of your [Mighty] units.', { type: 'unit', might: 1 })
    const big6 = injectCard('big6-t', 'x', { type: 'unit', might: 6 })
    const four = injectCard('four-t', 'x', { type: 'unit', might: 4 })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    s.players[0].zones.base.push(mk(big6, 0)) // mighty (base 6)
    s.players[0].zones.base.push(mk(four, 0, { buffs: 1 })) // mighty (4+1 buff = 5)
    const k = mk(kad, 0)
    s.players[0].zones.hand.push(k)
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: k.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(before - 1 + 2) // played Kadregrin, drew 2
  })

  it('play-trigger [Mighty] filter fires for a Mighty unit, not a small one', () => {
    const watcher = injectCard('mighty-watch-t', 'When you play a [Mighty] unit, draw 1.', { type: 'unit', might: 1 })
    const big6 = injectCard('pw-big6-t', 'x', { type: 'unit', might: 6 })
    const small3 = injectCard('pw-small3-t', 'x', { type: 'unit', might: 3 })
    // Mighty unit played → watcher draws 1.
    let s = baseState()
    s.players[0].zones.base.push(mk(watcher, 0))
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    let u = mk(big6, 0)
    s.players[0].zones.hand.push(u)
    let before = s.players[0].zones.hand.length
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.hand.length).toBe(before - 1 + 1)
    // Small unit played → no draw.
    s = baseState()
    s.players[0].zones.base.push(mk(watcher, 0))
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    u = mk(small3, 0)
    s.players[0].zones.hand.push(u)
    before = s.players[0].zones.hand.length
    r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.hand.length).toBe(before - 1)
  })

  it('Fiora - Victorious: has [Deflect] only WHILE [Mighty] (conditional keyword grant)', async () => {
    const { deflectSurcharge } = await import('./engine')
    const fid = injectCard('fiora-vic-t', "While I'm [Mighty], I have [Deflect], [Ganking], and [Shield].", { type: 'unit', might: 4 })
    const s = baseState()
    const f = mk(fid, 0)
    s.battlefields[0].units.push(f)
    expect(deflectSurcharge(s, [f.iid], 1)).toBe(0) // base 4, not Mighty → no Deflect
    f.buffs = 1 // → 5, Mighty
    expect(deflectSurcharge(s, [f.iid], 1)).toBe(1) // Deflect 1 surcharge
  })

  it('Fiora - Worthy: a unit becoming [Mighty] prompts to pay Order to ready it', () => {
    const worthy = injectCard('fiora-worthy-t', 'When a unit you control becomes [Mighty], you may pay :rb_rune_order: to ready it.', { type: 'unit', might: 1 })
    const target = injectCard('worthy-target-t', 'x', { type: 'unit', might: 4 })
    const s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(worthy, 0, { stateSnapshot: [] }))
    const t = mk(target, 0, { exhausted: true, stateSnapshot: [] })
    s.battlefields[0].units.push(t)
    s.players[0].zones.runePool.push(mk(orderRune.id, 0)) // a ready Order rune to pay
    const r1 = reduce(s, { type: 'OVERRIDE', player: 0, op: 'buff', iid: t.iid }) // base 4 → 5, becomes Mighty
    expect(r1.error).toBeFalsy()
    expect(r1.state.pendingChoice?.kind).toBe('optionalPay') // C2: Pay/Decline + rune picker
    const r2 = reduce(r1.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r2.error).toBeFalsy()
    expect(r2.state.battlefields[0].units.find((x) => x.iid === t.iid)?.exhausted).toBe(false) // readied
    expect(r2.state.players[0].zones.runePool.length).toBe(0) // Order rune spent
  })

  it('Fiora - Grand Duelist: a unit becoming [Mighty] auto-exhausts it to channel 1 exhausted', () => {
    const gd = injectCard('fiora-gd-t', 'When one of your units becomes [Mighty], you may exhaust me to channel 1 rune exhausted.', { type: 'unit', might: 1 })
    const target = injectCard('gd-target-t', 'x', { type: 'unit', might: 4 })
    const s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(gd, 0, { stateSnapshot: [] }))
    s.players[0].zones.base.push(mk(target, 0, { stateSnapshot: [] }))
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0)) // a rune to channel
    const gdUnit = s.players[0].zones.base[0]
    const t = s.players[0].zones.base[1]
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'buff', iid: t.iid }) // → Mighty
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === gdUnit.iid)?.exhausted).toBe(true) // exhausted me
    expect(r.state.players[0].zones.runePool.length).toBe(1) // channeled 1
    expect(r.state.players[0].zones.runePool[0].exhausted).toBe(true) // …exhausted
  })
})
