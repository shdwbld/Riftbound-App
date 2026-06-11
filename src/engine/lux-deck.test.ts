import { describe, it, expect } from 'vitest'
import { reduce, beginTurn, grantedAbilityFor } from './engine'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'
import { CARDS, CARD_INDEX } from '../data/cards'

// --- harness ---------------------------------------------------------------
let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `t${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['mind'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return {
    id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [],
    points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} },
    zones: emptyZones(), mulliganed: true,
  }
}
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const anyRune = CARDS.find((c) => c.type === 'rune')!
function baseState(bf0 = battlefield.id): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0,
    phase: 'action', turn: 2,
    battlefields: [
      { cardId: bf0, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null,
    passes: 0, log: [], seq: 0,
  } as MatchState
}

// --- Lux cost threshold counts total cost (Energy + Power) -----------------
describe('Lux - Illuminated cost threshold', () => {
  const MIND_RUNE = 'ogn-089-298'
  it('triggers on a spell whose Energy+Power total is 5+ (e3 + 2 Power)', () => {
    const s = baseState()
    const lux = mk('ogs-006-024', 0)
    s.players[0].zones.base.push(lux)
    // A spell costing 3 Energy + 2 mind Power = total 5 → should trigger Lux.
    const spell = mk(injectCard('lux-pw-spell', 'Channel 1.', { type: 'spell', energy: 3, power: { mind: 2 } }), 0)
    s.players[0].zones.hand.push(spell)
    const exhaust: string[] = []
    const recycle: string[] = []
    for (let i = 0; i < 3; i++) { const r = mk(MIND_RUNE, 0); s.players[0].zones.runePool.push(r); exhaust.push(r.iid) }
    for (let i = 0; i < 2; i++) { const r = mk(MIND_RUNE, 0); s.players[0].zones.runePool.push(r); recycle.push(r.iid) }
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: spell.iid, payment: { exhaust, recycle, poolEnergy: 0, poolPower: {} } })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.base.find((u) => u.iid === lux.iid)!.tempMight ?? 0).toBe(3)
  })
})

// --- Crownguard mana ability ----------------------------------------------
describe('Lux - Crownguard', () => {
  it('exhausts to add 2 Energy to the pool', () => {
    const s = baseState()
    const cg = mk('ogs-014-024', 0)
    s.players[0].zones.base.push(cg)
    const ga = grantedAbilityFor(s, 0, cg.iid)
    expect(ga?.kind).toBe('addEnergySpells')
    const r = reduce(s, { type: 'ACTIVATE_ABILITY', player: 0, iid: cg.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].pool.energy).toBe(2)
    expect(r.state.players[0].zones.base.find((u) => u.iid === cg.iid)!.exhausted).toBe(true)
    // An exhausted Crownguard offers nothing further.
    expect(grantedAbilityFor(r.state, 0, cg.iid)).toBeNull()
  })
})

// --- Orb of Regret ---------------------------------------------------------
describe('Orb of Regret', () => {
  it('exhausts to give a chosen unit -1 Might this turn', () => {
    const s = baseState()
    const orb = mk('ogn-090-298', 0)
    s.players[0].zones.base.push(orb)
    const target = mk(injectCard('orb-victim', '', { might: 4 }), 1)
    s.battlefields[0].units.push(target)
    expect(grantedAbilityFor(s, 0, orb.iid)?.kind).toBe('minusMightTarget')
    let r = reduce(s, { type: 'ACTIVATE_ABILITY', player: 0, iid: orb.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.pendingChoice?.kind).toBe('orbMinusMight')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: target.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.find((u) => u.iid === target.iid)!.tempMight).toBe(-1)
  })

  it('respects the minimum of 1 Might floor', () => {
    const s = baseState()
    const orb = mk('ogn-090-298', 0)
    s.players[0].zones.base.push(orb)
    const target = mk(injectCard('orb-victim1', '', { might: 1 }), 1)
    s.battlefields[0].units.push(target)
    let r = reduce(s, { type: 'ACTIVATE_ABILITY', player: 0, iid: orb.iid })
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: target.iid })
    // Already at 1 Might → no reduction, and the unit survives.
    const u = r.state.battlefields[0].units.find((x) => x.iid === target.iid)
    expect(u).toBeTruthy()
    expect(u!.tempMight ?? 0).toBe(0)
  })
})

// --- Retreat ---------------------------------------------------------------
describe('Retreat', () => {
  it('returns a friendly unit to hand and its owner channels 1 rune exhausted', () => {
    const s = baseState()
    const friendly = mk(injectCard('retreat-unit', '', { might: 3 }), 0)
    s.battlefields[0].units.push(friendly)
    s.players[0].zones.runeDeck.push(mk(anyRune.id, 0)) // for the exhausted channel
    const retreat = mk('ogn-104-298', 0)
    s.players[0].zones.hand.push(retreat)
    const payRune = mk(anyRune.id, 0)
    s.players[0].zones.runePool.push(payRune)
    let r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: retreat.iid, targets: [friendly.iid],
      payment: { exhaust: [payRune.iid], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // Unit back in hand, off the battlefield.
    expect(r.state.battlefields[0].units.some((u) => u.iid === friendly.iid)).toBe(false)
    expect(r.state.players[0].zones.hand.some((c) => c.iid === friendly.iid)).toBe(true)
    // Owner channelled 1 rune, exhausted.
    const channelled = r.state.players[0].zones.runePool.filter((x) => x.cardId === anyRune.id && x.exhausted)
    expect(channelled.length).toBeGreaterThanOrEqual(1)
  })

  it('returns a bounced unit\'s attached gear to base instead of losing it', () => {
    const s = baseState()
    const gearIid = 'gear-1'
    const friendly = mk(injectCard('retreat-unit2', '', { might: 3 }), 0, {
      attached: [`sfd-073-221|${gearIid}`], // Experimental Hexplate equipped
    })
    s.battlefields[0].units.push(friendly)
    s.players[0].zones.runeDeck.push(mk(anyRune.id, 0))
    const retreat = mk('ogn-104-298', 0)
    s.players[0].zones.hand.push(retreat)
    const payRune = mk(anyRune.id, 0)
    s.players[0].zones.runePool.push(payRune)
    let r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: retreat.iid, targets: [friendly.iid],
      payment: { exhaust: [payRune.iid], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // Gear is now an unattached piece in base, not lost.
    expect(r.state.players[0].zones.base.some((c) => c.cardId === 'sfd-073-221')).toBe(true)
  })
})

// --- Chemtech Cask ---------------------------------------------------------
describe('Chemtech Cask', () => {
  function goldCount(p: PlayerState) {
    return p.zones.base.filter((c) => (CARD_INDEX[c.cardId] as { supertype?: string }).supertype === 'token' && (CARD_INDEX[c.cardId] as { type?: string }).type === 'gear').length
  }
  it('makes a Gold token when you play a spell on an opponent turn', () => {
    const s = baseState()
    s.activePlayer = 1 // opponent's turn
    const cask = mk('sfd-063-221', 0)
    s.players[0].zones.base.push(cask)
    // Open a chain so P0 may respond with a Reaction spell.
    s.chain.push({ id: 'c1', kind: 'spell', controller: 1, cardId: anyRune.id, instance: mk(anyRune.id, 1), targets: [] } as never)
    s.priority = 0
    const reaction = mk(injectCard('cask-react', '[Reaction] Channel 1.', { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(reaction)
    const before = goldCount(s.players[0])
    const r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: reaction.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(r.error).toBeUndefined()
    expect(goldCount(r.state.players[0])).toBe(before + 1)
    expect(r.state.players[0].zones.base.find((u) => u.iid === cask.iid)!.exhausted).toBe(true)
  })

  it('does nothing on your own turn', () => {
    const s = baseState()
    const cask = mk('sfd-063-221', 0)
    s.players[0].zones.base.push(cask)
    const spell = mk(injectCard('cask-own', 'Channel 1.', { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(spell)
    const before = goldCount(s.players[0])
    let r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: spell.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(goldCount(r.state.players[0])).toBe(before)
    expect(r.state.players[0].zones.base.find((u) => u.iid === cask.iid)!.exhausted).toBe(false)
  })
})

// --- Altar of Blood --------------------------------------------------------
describe('Altar of Blood', () => {
  it('pays 3 to heal, exhaust, and recall a defender that would die in combat', () => {
    const s = baseState('unl-206-219')
    const attacker = mk(injectCard('aob-atk', '', { might: 5 }), 0)
    const defender = mk(injectCard('aob-def', '', { might: 2 }), 1, { exhausted: true })
    s.battlefields[0].units.push(attacker, defender)
    s.battlefields[0].controller = 1
    // Defender's owner can pay 3 Power (any).
    for (let i = 0; i < 3; i++) s.players[1].zones.runePool.push(mk(anyRune.id, 1))
    s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: attacker.iid } as never
    let r = reduce(s, { type: 'PASS', player: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    // G3: the rescue is the OWNER'S choice now — an optionalPay pauses the
    // combat finalization before the death applies.
    expect(r.state.pendingChoice?.kind).toBe('optionalPay')
    expect(r.state.pendingChoice?.player).toBe(1)
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 1, iid: 'pay' })
    expect(r.error).toBeFalsy()
    // Combat resolved.
    expect(r.state.showdown).toBeNull()
    // Defender was recalled to base (exhausted, healed), NOT trashed.
    expect(r.state.battlefields[0].units.some((u) => u.iid === defender.iid)).toBe(false)
    const recalled = r.state.players[1].zones.base.find((u) => u.iid === defender.iid)
    expect(recalled).toBeTruthy()
    expect(recalled!.exhausted).toBe(true)
    expect(recalled!.damage).toBe(0)
    expect(r.state.players[1].zones.trash.some((c) => c.iid === defender.iid)).toBe(false)
  })

  it('lets the unit die normally when the controller cannot pay 3', () => {
    const s = baseState('unl-206-219')
    const attacker = mk(injectCard('aob-atk2', '', { might: 5 }), 0)
    const defender = mk(injectCard('aob-def2', '', { might: 2 }), 1, { exhausted: true })
    s.battlefields[0].units.push(attacker, defender)
    s.battlefields[0].controller = 1
    // No runes to pay with.
    s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: attacker.iid } as never
    let r = reduce(s, { type: 'PASS', player: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    expect(r.state.players[1].zones.base.some((u) => u.iid === defender.iid)).toBe(false)
    expect(r.state.players[1].zones.trash.some((c) => c.iid === defender.iid)).toBe(true)
  })
})

// --- Altar to Unity (handled by the generic battlefield passive) -----------
describe('Altar to Unity', () => {
  const isRecruitToken = (c: EngineCard) => {
    const d = CARD_INDEX[c.cardId] as { supertype?: string; type?: string }
    return d.supertype === 'token' && d.type === 'unit'
  }
  it('recruits a unit token to base when you hold here at start of turn', () => {
    const s = baseState('ogn-275-298')
    s.turn = 2
    s.battlefields[0].controller = 0
    s.battlefields[0].units.push(mk(injectCard('atu-hold', '', { might: 3 }), 0)) // P0 holds here
    for (let i = 0; i < 4; i++) {
      s.players[0].zones.runeDeck.push(mk(anyRune.id, 0))
      s.players[0].zones.mainDeck.push(mk(injectCard('atu-deck', '', { might: 1 }), 0))
    }
    const before = s.players[0].zones.base.filter(isRecruitToken).length
    const after = beginTurn(s)
    expect(after.players[0].zones.base.filter(isRecruitToken).length).toBe(before + 1)
  })
})
