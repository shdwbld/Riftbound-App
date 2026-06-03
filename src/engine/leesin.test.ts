import { describe, it, expect } from 'vitest'
import { reduce, combatMightAt } from './engine'
import { spellEffect, parseEffectText } from './effects'
import { parseTriggers } from './triggers'
import { CARD_INDEX } from '../data/cards'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'

// Real Lee Sin "Blind Monk" starter-deck card IDs (featuredDecks.json).
const ID = {
  legend: 'ogn-257-298', // Lee Sin - Blind Monk: "1, exhaust: Buff a friendly unit"
  centered: 'ogn-151-298', // Lee Sin - Centered: aura +2 to OTHER buffed allies here
  pitRookie: 'ogn-136-298', // Pit Rookie: "When you play me, buff another friendly unit"
  firstMate: 'ogn-132-298', // First Mate: "When you play me, ready another unit"
  bully: 'ogn-125-298', // Bilgewater Bully: "While I'm buffed, I have [Ganking]"
  wizened: 'ogn-065-298', // Wizened Elder: "While I'm buffed, +1 additional Might"
  wielder: 'ogn-055-298', // Wielder of Water: "While attacking/defending alone, +2 Might"
  poro: 'ogn-052-298', // Stalwart Poro
  standUnited: 'ogn-053-298', // Stand United: "Buff a friendly unit. ..."
  rune: 'ogn-042-298', // Calm Rune
  bodyRune: 'ogn-126-298', // Body Rune (produces body)
  mistfall: 'ogn-152-298', // Mistfall (gear): "When you buff ... ready it"
  mask: 'ogn-060-298', // Mask of Foresight
  wildclaw: 'ogn-147-298', // Wildclaw Shaman: "spend a buff to buff me and ready me"
} as const

function card(id: string) {
  const c = CARD_INDEX[id]
  if (!c) throw new Error(`missing card ${id}`)
  return c
}
function might(id: string): number {
  const c = card(id)
  return c.type === 'unit' ? (c as { might: number }).might : 0
}

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `t${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return {
    id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [],
    points: 0, xp: 0, banished: [], pool: { energy: 9, power: {} },
    zones: emptyZones(), mulliganed: true,
  } as PlayerState
}
function baseState(): MatchState {
  const bf = 'ogn-289-298'
  return {
    players: [player(0), player(1)],
    activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [
      { cardId: bf, units: [], controller: null },
      { cardId: bf, units: [], controller: null },
      { cardId: bf, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

describe('Lee Sin — buff verb parsing', () => {
  it('parses targeted "buff a friendly unit"', () => {
    const e = parseEffectText('Buff a friendly unit.')
    expect(e.buff).toBe(1)
    expect(e.buffSelf).toBe(false)
  })
  it('parses "buff me" as a self-buff', () => {
    const e = parseEffectText('When you play me, buff me and ready me.')
    expect(e.buff).toBe(1)
    expect(e.buffSelf).toBe(true)
    expect(e.readySelf).toBe(true)
  })
  it('parses "buff another" as targeted-excluding-self', () => {
    const e = parseEffectText('buff another friendly unit')
    expect(e.buff).toBe(1)
    expect(e.buffExcludesSelf).toBe(true)
  })
  it('legend & Stand United yield a buff', () => {
    expect(spellEffect(card(ID.legend)).buff).toBe(1)
    expect(spellEffect(card(ID.standUnited)).buff).toBe(1)
  })
  it('Pit Rookie play trigger carries a (self-excluding) buff', () => {
    const play = parseTriggers(card(ID.pitRookie)).find((t) => t.event === 'play')!
    expect(play.effect.buff).toBe(1)
    expect(play.effect.buffExcludesSelf).toBe(true)
  })
  it('does NOT treat "spend a buff" / "buffed" as the buff verb', () => {
    expect(parseEffectText('you may spend a buff to draw 1').buff).toBe(0)
    expect(parseEffectText('while a friendly unit is buffed, draw 1').buff).toBe(0)
  })
})

describe('Lee Sin — Pit Rookie buffs another unit on play', () => {
  it('buffs a different friendly unit, not itself', () => {
    const s = baseState()
    const ally = mk(ID.poro, 0)
    s.players[0].zones.base.push(ally)
    const rookie = mk(ID.pitRookie, 0)
    s.players[0].zones.hand.push(rookie)
    // Pit Rookie costs 2 Energy — pay with two exhausted runes.
    const runes = [mk(ID.rune, 0), mk(ID.rune, 0)]
    s.players[0].zones.runePool.push(...runes)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: rookie.iid, payment: { exhaust: runes.map((x) => x.iid), recycle: [] } })
    expect(r.error).toBeUndefined()
    const allyAfter = r.state.players[0].zones.base.find((u) => u.iid === ally.iid)!
    const rookieAfter = r.state.players[0].zones.base.find((u) => u.iid === rookie.iid)!
    expect(allyAfter.buffs).toBe(1) // the OTHER unit got the buff
    expect(rookieAfter.buffs ?? 0).toBe(0) // not itself
  })
})

describe('Lee Sin — legend activated ability', () => {
  it('charges 1 Energy, exhausts, and auto-buffs a friendly unit', () => {
    const s = baseState()
    s.players[0].legend = mk(ID.legend, 0)
    const ally = mk(ID.poro, 0)
    s.players[0].zones.base.push(ally)
    s.players[0].pool = { energy: 1, power: {} }
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].pool.energy).toBe(0) // 1 Energy spent
    expect(r.state.players[0].legend!.exhausted).toBe(true)
    expect(r.state.players[0].zones.base[0].buffs).toBe(1) // buff applied
  })
  it('fails when Energy is unavailable', () => {
    const s = baseState()
    s.players[0].legend = mk(ID.legend, 0)
    s.players[0].zones.base.push(mk(ID.poro, 0))
    s.players[0].pool = { energy: 0, power: {} }
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeDefined()
  })
})

describe('Lee Sin — combat-Might conditionals & auras', () => {
  it('Lee Sin - Centered gives +2 to OTHER buffed allies at his battlefield', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.centered, 0), mk(ID.poro, 0, { buffs: 1 }))
    const ally = s.battlefields[0].units[1]
    // poro base + own buff(1) + Centered aura(2)
    expect(combatMightAt(s, 0, ally, 'defender')).toBe(might(ID.poro) + 1 + 2 + 1) // +1 = Poro Shield as defender
  })
  it('Centered does NOT buff an UNbuffed ally', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.centered, 0), mk(ID.poro, 0))
    const ally = s.battlefields[0].units[1]
    expect(combatMightAt(s, 0, ally, 'defender')).toBe(might(ID.poro) + 1) // only its Shield
  })
  it('Wizened Elder gets +1 extra while buffed', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.wizened, 0, { buffs: 1 }))
    const u = s.battlefields[0].units[0]
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(might(ID.wizened) + 1 /*buff*/ + 1 /*while-buffed*/)
  })
  it('Wielder of Water gets +2 while attacking/defending alone', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.wielder, 0))
    const u = s.battlefields[0].units[0]
    expect(combatMightAt(s, 0, u, 'defender')).toBe(might(ID.wielder) + 2)
  })
  it('Wielder of Water gets NO alone-bonus with an ally present', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.wielder, 0), mk(ID.poro, 0))
    const u = s.battlefields[0].units[0]
    expect(combatMightAt(s, 0, u, 'defender')).toBe(might(ID.wielder))
  })
})

describe('Lee Sin — Mistfall readies a buffed unit', () => {
  it('pays a body rune + exhausts itself to ready a just-buffed exhausted unit', () => {
    const s = baseState()
    s.players[0].legend = mk(ID.legend, 0)
    s.players[0].pool = { energy: 1, power: {} } // for the legend's Energy cost
    const ally = mk(ID.poro, 0, { exhausted: true })
    const mistfall = mk(ID.mistfall, 0)
    s.players[0].zones.base.push(ally, mistfall)
    s.players[0].zones.runePool.push(mk(ID.bodyRune, 0))
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeUndefined()
    const allyAfter = r.state.players[0].zones.base.find((u) => u.iid === ally.iid)!
    const mistAfter = r.state.players[0].zones.base.find((u) => u.iid === mistfall.iid)!
    expect(allyAfter.buffs).toBe(1) // buffed by the legend
    expect(allyAfter.exhausted).toBe(false) // readied by Mistfall
    expect(mistAfter.exhausted).toBe(true) // Mistfall exhausted itself
    expect(r.state.players[0].zones.runePool.length).toBe(0) // body rune recycled
    expect(r.state.players[0].zones.runeDeck.length).toBe(1)
  })
  it('does NOT fire without a body rune to pay', () => {
    const s = baseState()
    s.players[0].legend = mk(ID.legend, 0)
    s.players[0].pool = { energy: 1, power: {} }
    const ally = mk(ID.poro, 0, { exhausted: true })
    s.players[0].zones.base.push(ally, mk(ID.mistfall, 0))
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.state.players[0].zones.base.find((u) => u.iid === ally.iid)!.buffs).toBe(1)
    expect(r.state.players[0].zones.base.find((u) => u.iid === ally.iid)!.exhausted).toBe(true) // not readied
  })
})

describe('Lee Sin — Mask of Foresight (lone-combatant aura)', () => {
  it('gives a lone friendly defender +1', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(ID.mask, 0))
    s.battlefields[0].units.push(mk(ID.poro, 0))
    const u = s.battlefields[0].units[0]
    // poro base + Shield(1) + Mask(1)
    expect(combatMightAt(s, 0, u, 'defender')).toBe(might(ID.poro) + 1 + 1)
  })
  it('does NOT apply when the unit has an ally present', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(ID.mask, 0))
    s.battlefields[0].units.push(mk(ID.poro, 0), mk(ID.wielder, 0))
    const u = s.battlefields[0].units[0]
    expect(combatMightAt(s, 0, u, 'defender')).toBe(might(ID.poro) + 1) // Shield only
  })
})

describe('Lee Sin — Wildclaw Shaman spends a buff', () => {
  function playWildclaw(s: MatchState) {
    const wild = mk(ID.wildclaw, 0)
    s.players[0].zones.hand.push(wild)
    const runes = [mk(ID.rune, 0), mk(ID.rune, 0), mk(ID.rune, 0), mk(ID.rune, 0)] // E4
    s.players[0].zones.runePool.push(...runes)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: wild.iid, payment: { exhaust: runes.map((x) => x.iid), recycle: [] } })
    return { r, wildIid: wild.iid }
  }
  it('spends an ally buff to buff and ready itself', () => {
    const s = baseState()
    const donor = mk(ID.poro, 0, { buffs: 1 })
    s.players[0].zones.base.push(donor)
    const { r, wildIid } = playWildclaw(s)
    expect(r.error).toBeUndefined()
    const wildAfter = r.state.players[0].zones.base.find((u) => u.iid === wildIid)!
    const donorAfter = r.state.players[0].zones.base.find((u) => u.iid === donor.iid)!
    expect(donorAfter.buffs ?? 0).toBe(0) // buff spent
    expect(wildAfter.buffs).toBe(1) // buffed self
    expect(wildAfter.exhausted).toBe(false) // readied self
  })
  it('does nothing extra when there is no ally buff to spend', () => {
    const s = baseState()
    const { r, wildIid } = playWildclaw(s)
    const wildAfter = r.state.players[0].zones.base.find((u) => u.iid === wildIid)!
    expect(wildAfter.buffs ?? 0).toBe(0) // not buffed
    expect(wildAfter.exhausted).toBe(true) // entered exhausted, not readied
  })
})

describe('Lee Sin — Bilgewater Bully conditional Ganking', () => {
  it('cannot Gank while UNbuffed', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.bully, 0))
    const u = s.battlefields[0].units[0]
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 1 })
    expect(r.error).toBeDefined()
  })
  it('CAN Gank while buffed', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(ID.bully, 0, { buffs: 1 }))
    const u = s.battlefields[0].units[0]
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 1 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.some((x) => x.iid === u.iid)).toBe(true)
  })
})
