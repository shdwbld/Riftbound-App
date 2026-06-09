import { describe, it, expect } from 'vitest'
import { reduce, combatMightAt } from './engine'
import { effectiveCostOf } from './autopay'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const furyRune = CARDS.find((c) => c.type === 'rune' && (c as { produces: string[] }).produces.includes('fury'))!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const zeroUnit = injectCard('zero-unit-aura', 'A plain unit.', { energy: 0, power: {}, might: 1 })
let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `a${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
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

describe('Batch 1 — Katarina - Reckless (from face down)', () => {
  it('does NOT deal 2 on a normal (not-from-face-down) card play', () => {
    const s = baseState()
    const kat = mk(injectCard('kat-test', 'When you hide a card, ready me. When you play a card from face down, deal 2 to an enemy unit.', { name: 'Katarina - Reckless', might: 5 }), 0)
    s.battlefields[0].units.push(kat)
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[1].units.push(enemy)
    const u = mk(zeroUnit, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    const e = r.state.battlefields[1].units.find((x) => x.iid === enemy.iid)!
    expect(e.damage).toBe(0) // over-fire fixed: normal play deals nothing
  })
})

describe('Batch 1 — Katarina - Reckless (hide → ready me)', () => {
  it('readies Katarina when you hide a card', () => {
    const s = baseState()
    const kat = mk(injectCard('kat-hide', 'When you hide a card, ready me. When you play a card from face down, deal 2 to an enemy unit.', { name: 'Katarina - Reckless', might: 5 }), 0, { exhausted: true })
    s.battlefields[0].units.push(kat)
    s.battlefields[0].controller = 0 // must control the bf to hide there
    const hidden = mk(injectCard('hid-card', 'x', { type: 'spell', energy: 0, power: {}, keywords: ['Hidden'] }), 0)
    // give the injected card [Hidden] via text marker that parseKeywords reads
    CARD_INDEX['hid-card'] = { ...CARD_INDEX['hid-card'], text: '[Hidden] Do nothing.' } as never
    s.players[0].zones.hand.push(hidden)
    const rune = mk(furyUnit.id, 0) // any ready rune to pay the hide cost
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hidden.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((x) => x.iid === kat.iid)?.exhausted).toBe(false)
  })
})

describe('Batch 1 — Kinkou Initiate (total Might condition)', () => {
  const KIN = 'When you play me, draw 1 if your other units have total Might 5 or more.'
  it('draws when other units total Might >= 5', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    s.battlefields[0].units.push(mk(furyUnit.id, 0, {}), mk(furyUnit.id, 0, {})) // two fury units
    const kin = mk(injectCard('kin-test', KIN, { name: 'Kinkou Initiate', might: 3 }), 0)
    s.players[0].zones.hand.push(kin)
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: kin.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    // played Kinkou (−1 from hand) then drew 1 (+1) → net same hand size as before play
    expect(r.state.players[0].zones.hand.length).toBe(before)
  })
  it('does NOT draw when other units total Might < 5', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    // a single low-might unit (inject 2-might) → total 2 < 5
    s.battlefields[0].units.push(mk(injectCard('weak-1', 'x', { might: 2 }), 0))
    const kin = mk(injectCard('kin-test2', KIN, { name: 'Kinkou Initiate', might: 3 }), 0)
    s.players[0].zones.hand.push(kin)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: kin.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.mainDeck.length).toBe(1) // no draw
  })
})

describe('Batch 1 — Yordle Explorer (Power-cost threshold)', () => {
  const YOR = 'When you play a card with Power cost :rb_rune_rainbow::rb_rune_rainbow: or more, draw 1.'
  it('draws when a played card has total Power cost >= 2', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.battlefields[0].units.push(mk(injectCard('yor-test', YOR, { name: 'Yordle Explorer', might: 4 }), 0))
    const big = mk(injectCard('big-power', 'x', { energy: 0, power: { fury: 2 }, might: 3 }), 0)
    s.players[0].zones.hand.push(big)
    const runes = [mk(furyRune.id, 0), mk(furyRune.id, 0)]
    s.players[0].zones.runePool.push(...runes)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: big.iid, payment: { exhaust: [], recycle: runes.map((x) => x.iid) } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.mainDeck.length).toBe(0) // drew the 1 deck card
  })
  it('does NOT draw when a played card has total Power cost < 2', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.battlefields[0].units.push(mk(injectCard('yor-test2', YOR, { name: 'Yordle Explorer', might: 4 }), 0))
    const small = mk(injectCard('small-power', 'x', { energy: 0, power: { fury: 1 }, might: 3 }), 0)
    s.players[0].zones.hand.push(small)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: small.iid, payment: { exhaust: [], recycle: [rune.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.mainDeck.length).toBe(1) // no draw
  })
})

describe('Batch 1 — Revna the Lorekeeper (spent 4+ Energy = this spell)', () => {
  const REVNA = '[Ganking] When you play a spell, if you spent :rb_energy_4: or more, ready me.'
  it('readies on a 4-Energy spell', () => {
    const s = baseState()
    const revna = mk(injectCard('revna-t', REVNA, { name: 'Revna the Lorekeeper', might: 7 }), 0, { exhausted: true })
    s.battlefields[0].units.push(revna)
    const sp = mk(injectCard('rev-spell4', 'Do nothing.', { type: 'spell', energy: 4, power: {} }), 0)
    s.players[0].zones.hand.push(sp)
    const runes = Array.from({ length: 4 }, () => mk(furyRune.id, 0))
    s.players[0].zones.runePool.push(...runes)
    const r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: { exhaust: runes.map((x) => x.iid), recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((x) => x.iid === revna.iid)?.exhausted).toBe(false)
  })
  it('does NOT ready on a 3-Energy spell', () => {
    const s = baseState()
    const revna = mk(injectCard('revna-t2', REVNA, { name: 'Revna the Lorekeeper', might: 7 }), 0, { exhausted: true })
    s.battlefields[0].units.push(revna)
    const sp = mk(injectCard('rev-spell3', 'Do nothing.', { type: 'spell', energy: 3, power: {} }), 0)
    s.players[0].zones.hand.push(sp)
    const runes = Array.from({ length: 3 }, () => mk(furyRune.id, 0))
    s.players[0].zones.runePool.push(...runes)
    const r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: { exhaust: runes.map((x) => x.iid), recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((x) => x.iid === revna.iid)?.exhausted).toBe(true)
  })
})

describe('Batch 2 — Blood Rose (pay 1 Energy to gain 1 XP)', () => {
  const BR = 'When you play a unit, you may pay :rb_energy_1: to gain 1 XP.'
  it('offers to pay 1 Energy to gain 1 XP, and pays on accept (P0 optional-pay)', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('bloodrose', BR, { type: 'gear', energy: 1, power: {} }), 0))
    s.players[0].pool = { energy: 1, power: {} }
    const u = mk(zeroUnit, 0)
    s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.pendingChoice?.kind).toBe('optionalPay') // surfaced, not auto-paid
    expect(r.state.players[0].xp).toBe(0)
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.state.players[0].xp).toBe(1)
    expect(r.state.players[0].pool.energy).toBe(0)
  })
  it('does NOT gain XP when no Energy is affordable', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('bloodrose2', BR, { type: 'gear', energy: 1, power: {} }), 0))
    s.players[0].pool = { energy: 0, power: {} }
    const u = mk(zeroUnit, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].xp).toBe(0)
  })
})

describe('Batch 2 — Fresh Beans (showdown-gated)', () => {
  const FB = 'When you play a unit during a showdown, you may exhaust this to draw 1.'
  it('does NOT draw when no showdown is active', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('beans1', FB, { type: 'gear', energy: 2, power: {} }), 0))
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const u = mk(zeroUnit, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.mainDeck.length).toBe(1)
  })
})

describe('Batch 3 — Eager Apprentice (spell cost -1, min 1)', () => {
  const EA = "While I'm at a battlefield, the Energy cost for spells you play is reduced by :rb_energy_1:, to a minimum of :rb_energy_1:."
  it('reduces a 3-Energy spell to 2; a 1-Energy spell stays at 1', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(injectCard('eager', EA, { name: 'Eager Apprentice', might: 3 }), 0))
    const spell3 = CARD_INDEX[injectCard('ea-spell3', 'x', { type: 'spell', energy: 3, power: {} })]
    const spell1 = CARD_INDEX[injectCard('ea-spell1', 'x', { type: 'spell', energy: 1, power: {} })]
    expect(effectiveCostOf(s, 0, spell3 as never).energy).toBe(2)
    expect(effectiveCostOf(s, 0, spell1 as never).energy).toBe(1)
  })
})

describe('Batch 3 — Tianna Crownguard (opponents cannot gain points)', () => {
  it('blocks an opponent from scoring on conquer', () => {
    const s = baseState()
    s.battlefields[2].units.push(mk(injectCard('tianna', "[Deflect] While I'm at a battlefield, opponents can't gain points.", { name: 'Tianna Crownguard', might: 4 }), 1))
    s.battlefields[2].controller = 1
    s.players[0].zones.base.push(mk(furyUnit.id, 0))
    const u = s.players[0].zones.base[0]
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].controller).toBe(0)
    expect(r.state.players[0].points).toBe(0)
  })
})

describe('Batch 4 — Sivir - Mercenary (spent 2 Power -> +2 Might)', () => {
  const SIVIR = "[Accelerate] If you've spent at least :rb_rune_rainbow::rb_rune_rainbow: this turn, I have +2 :rb_might: and [Ganking]."
  it('grants +2 Might once 2 Power has been spent this turn', () => {
    const s = baseState()
    const sivir = mk(injectCard('sivir', SIVIR, { name: 'Sivir - Mercenary', might: 4 }), 0)
    s.battlefields[0].units.push(sivir)
    expect(combatMightAt(s, 0, sivir, 'attacker')).toBe(4)
    s.players[0].powerSpentThisTurn = 2
    expect(combatMightAt(s, 0, sivir, 'attacker')).toBe(6)
  })
})

describe('Batch 3 — Volibear - Imposing (opponent move -> draw)', () => {
  it('draws when an opponent moves to a battlefield other than Volibear\'s', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(injectCard('voli-imp', 'When an opponent moves to a battlefield other than mine, draw 1.', { name: 'Volibear - Imposing', might: 10 }), 0))
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.battlefields[0].controller = 0
    s.players[1].zones.base.push(mk(furyUnit.id, 1))
    s.activePlayer = 1
    const u = s.players[1].zones.base[0]
    const r = reduce(s, { type: 'MOVE_UNIT', player: 1, iid: u.iid, toBattlefield: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.mainDeck.length).toBe(0)
  })
})

describe('Batch 4 — Jhin - Virtuoso (4 banished spells -> channel 4 + draw 1)', () => {
  const JHIN = 'When you play a spell, if you spent :rb_energy_4: or more, you may banish it. Then, if there are four spells banished with me, put each in its trash, channel 4 runes, and draw 1.'
  it('counts 4+-Energy spells and fires the payoff on the 4th', () => {
    const s = baseState()
    s.players[0].legend = mk(injectCard('jhin', JHIN, { type: 'legend' }), 0)
    for (let i = 0; i < 8; i++) { s.players[0].zones.runeDeck.push(mk(furyRune.id, 0)); s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)) }
    const playOne = (st: MatchState, idx: number) => {
      const sp = mk(injectCard(`jhin-sp-${idx}`, 'Do nothing.', { type: 'spell', energy: 4, power: {} }), 0)
      st.players[0].zones.hand.push(sp)
      const runes = Array.from({ length: 4 }, () => mk(furyRune.id, 0))
      st.players[0].zones.runePool.push(...runes)
      let r = reduce(st, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: { exhaust: runes.map((x) => x.iid), recycle: [] } })
      // Resolve the chain so the next spell can be played.
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
      return r.state
    }
    let st: MatchState = s
    for (let i = 0; i < 3; i++) st = playOne(st, i)
    expect(st.players[0].legend?.jhinBanished?.length).toBe(3)
    const deckBefore = st.players[0].zones.mainDeck.length
    st = playOne(st, 3)
    expect(st.players[0].legend?.jhinBanished?.length).toBe(0)
    expect(st.players[0].zones.mainDeck.length).toBe(deckBefore - 1)
  })
})
