import { describe, it, expect } from 'vitest'
import { reduce, combatMightAt, deflectSurcharge, displayMight, hasTank } from './engine'
import { parseKeywords } from './keywords'
import { type MatchState, type PlayerState, type EngineCard, type PlayerId, type ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.includes('fury'))!
const calmRune = CARDS.find((c) => c.type === 'rune' && c.produces.includes('calm') && !c.produces.includes('fury'))!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `eq${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
const emptyZones = (): Record<ZoneId, EngineCard[]> => ({ mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] })
const player = (id: PlayerId): PlayerState => ({ id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true })
function baseState(): MatchState {
  return { players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }, { cardId: battlefield.id, units: [], controller: null }, { cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0 }
}

describe('equipment — attached effects reach the host unit', () => {
  const base = displayMight(mk(furyUnit.id, 0)) // furyUnit's printed Might

  it('Serrated Dirk [Assault 2]: +2 while attacking, nothing while defending, no flat double-count', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { attached: ['opp-009-221|g1'] })
    s.battlefields[0].units.push(u)
    expect(displayMight(u)).toBe(base) // role-agnostic: conditional Assault is NOT a flat bonus
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(base + 2)
    expect(combatMightAt(s, 0, u, 'defender')).toBe(base)
  })

  it('Cloth Armor: flat +2 always + [Shield 2] another +2 while defending', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { attached: ['opp-064-221|g1'] })
    s.battlefields[0].units.push(u)
    expect(displayMight(u)).toBe(base + 2) // the flat +2 (outside the Shield reminder)
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(base + 2) // flat only
    expect(combatMightAt(s, 0, u, 'defender')).toBe(base + 4) // flat +2 + Shield +2
  })

  it("Doran's Blade: flat +2 in both roles", () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { attached: ['opp-095-221|g1'] })
    s.battlefields[0].units.push(u)
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(base + 2)
    expect(combatMightAt(s, 0, u, 'defender')).toBe(base + 2)
  })

  it('gear-granted [Tank] folds into the host (assigned damage first)', () => {
    const tankGear = CARDS.find((c) => c.type === 'gear' && parseKeywords(c).tank)
    if (!tankGear) return // dataset guard
    const s = baseState()
    const bare = mk(furyUnit.id, 0)
    const tanked = mk(furyUnit.id, 0, { attached: [`${tankGear.id}|g1`] })
    s.battlefields[0].units.push(bare, tanked)
    expect(hasTank(s, tanked)).toBe(true) // [Tank] reaches the host through the gear
    expect(hasTank(s, bare)).toBe(false)
  })

  it('Hexdrinker [Deflect]: an opponent pays +1 to choose the equipped unit', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { attached: ['sfd-102-221|g1'] })
    s.battlefields[0].units.push(u)
    expect(deflectSurcharge(s, [u.iid], 1)).toBe(1) // Hexdrinker grants [Deflect]
    const bare = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(bare)
    expect(deflectSurcharge(s, [bare.iid], 1)).toBe(0) // no gear → no surcharge
  })

  it('the restored [Equip] cards carry their attached effect text', () => {
    expect(/\[assault 2\]/i.test(CARD_INDEX['opp-009-221']?.text ?? '')).toBe(true)
    expect(/when i move/i.test(CARD_INDEX['opp-153-221']?.text ?? '')).toBe(true) // Eye of the Herald
    expect(/when i conquer/i.test(CARD_INDEX['opp-124-221']?.text ?? '')).toBe(true) // Doran's Ring
  })
})

// Inject a deterministic gear so the integration tests don't depend on a specific
// printed card's wording staying parseable. Only `text` matters for triggersFor.
function injectGear(id: string, text: string): string {
  CARD_INDEX[id] = {
    id, name: id, type: 'gear', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {},
  } as never
  return id
}

describe('equipment — gear triggers fire on the HOST unit’s event', () => {
  it('"When I move, draw 1" on attached gear: moving the equipped unit draws 1', () => {
    const gear = injectGear('test-gear-move', 'When I move, draw 1.')
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(furyUnit.id, 0, { attached: [`${gear}|g1`] })
    s.players[0].zones.base.push(u)
    const { state, error } = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(error).toBeUndefined()
    // The gear has no conquer trigger, so the only draw is from its move trigger.
    expect(state.players[0].zones.hand.length).toBe(1)
  })

  it('"When I conquer, draw 1" on attached gear: taking an empty battlefield draws 1', () => {
    const gear = injectGear('test-gear-conquer', 'When I conquer, draw 1.')
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(furyUnit.id, 0, { attached: [`${gear}|g1`] })
    s.players[0].zones.base.push(u)
    const { state, error } = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(error).toBeUndefined()
    expect(state.battlefields[0].controller).toBe(0) // uncontested move = conquer
    expect(state.players[0].zones.hand.length).toBe(1)
  })

  it('a bare unit (no gear) moving onto an empty battlefield draws nothing', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const { state } = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(state.players[0].zones.hand.length).toBe(0)
  })
})

describe('equipment — bespoke per-card effects', () => {
  it('Guardian Angel: the equipped unit that would die is recalled; the gear kills itself', () => {
    const s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0, { attached: ['sfd-051-221|ga1'], damage: 1 })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(false)
    const recalled = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(recalled).toBeTruthy()
    expect(recalled?.damage).toBe(0) // healed
    expect(recalled?.attached.some((a) => a.startsWith('sfd-051-221'))).toBe(false) // gear gone
    expect(r.state.players[0].zones.trash.some((x) => x.cardId === 'sfd-051-221')).toBe(true) // GA trashed
  })

  it('Skyfall: with "hold effects are also conquer effects", a hold-gear fires on conquer', () => {
    const holdGear = injectGear('test-gear-hold', 'When I hold, draw 1.')
    const withSkyfall = (attach: string[]) => {
      const s = baseState()
      s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
      const u = mk(furyUnit.id, 0, { attached: attach })
      s.players[0].zones.base.push(u)
      return reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 }).state
    }
    // Without Skyfall, a hold trigger does NOT fire on conquer.
    expect(withSkyfall([`${holdGear}|h1`]).players[0].zones.hand.length).toBe(0)
    // With Skyfall (sfd-030), conquer is aliased to hold → the hold-gear draws.
    expect(withSkyfall([`${holdGear}|h2`, 'sfd-030-221|sky1']).players[0].zones.hand.length).toBe(1)
  })

  it('level-gated gear Might: unl-039 gives +1, plus an extra +1 at 3+ XP', () => {
    const bare0 = displayMight(mk(furyUnit.id, 0), 0)
    const bare3 = displayMight(mk(furyUnit.id, 0), 3)
    const u = mk(furyUnit.id, 0, { attached: ['unl-039-219|lv1'] })
    expect(displayMight(u, 0)).toBe(bare0 + 1) // flat +1 only
    expect(displayMight(u, 3)).toBe(bare3 + 2) // flat +1 + level-3 additional +1
  })
})

describe('equipment — proper equip flow (play-to-bench + [Equip] cost is no longer bypassed)', () => {
  const injectGear = (id: string, text: string): string => {
    CARD_INDEX[id] = { id, name: id, type: 'gear', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} } as never
    return id
  }

  it('a normal gear played from hand lands on base UNATTACHED even when a target is named', () => {
    const gear = injectGear('flow-normal', '[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) +1 :rb_might:')
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const { state, error } = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, payment: { exhaust: [], recycle: [] }, targetIid: u.iid })
    expect(error).toBeUndefined()
    expect(state.players[0].zones.base.some((x) => x.iid === g.iid && x.attached.length === 0)).toBe(true) // on base, unattached
    expect(state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.length).toBe(0) // unit got nothing
  })

  it('ATTACH pays the [Equip] cost: recycles a matching rune, and FAILS (no attach) when unaffordable', () => {
    const gear = injectGear('flow-equipcost', '[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) +1 :rb_might:')
    const make = () => {
      const s = baseState()
      const u = mk(furyUnit.id, 0); s.battlefields[0].units.push(u)
      const g = mk(gear, 0); s.players[0].zones.base.push(g)
      return { s, u, g }
    }
    // No runes → can't pay the Fury [Equip] cost → error, gear stays on base.
    const a = make()
    const r1 = reduce(a.s, { type: 'ATTACH', player: 0, unitIid: a.u.iid, gearIid: a.g.iid })
    expect(r1.error).toBeTruthy()
    expect(r1.state.players[0].zones.base.some((x) => x.iid === a.g.iid)).toBe(true) // still on base
    expect(r1.state.battlefields[0].units[0].attached.length).toBe(0)
    // Wrong-color rune (Calm) can't satisfy a Fury cost → still fails.
    const b = make(); b.s.players[0].zones.runePool.push(mk(calmRune.id, 0))
    expect(reduce(b.s, { type: 'ATTACH', player: 0, unitIid: b.u.iid, gearIid: b.g.iid }).error).toBeTruthy()
    // A ready Fury rune → attaches and the rune is recycled out of the pool.
    const c = make(); c.s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const r3 = reduce(c.s, { type: 'ATTACH', player: 0, unitIid: c.u.iid, gearIid: c.g.iid })
    expect(r3.error).toBeUndefined()
    expect(r3.state.battlefields[0].units[0].attached.some((ref) => ref.startsWith(gear))).toBe(true)
    expect(r3.state.players[0].zones.runePool.length).toBe(0) // Fury rune recycled to pay [Equip]
  })

  it('sandbox ATTACH stays free (no equip cost)', () => {
    const gear = injectGear('flow-sandbox', '[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) +1 :rb_might:')
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0); s.battlefields[0].units.push(u)
    const g = mk(gear, 0); s.players[0].zones.base.push(g)
    const r = reduce(s, { type: 'ATTACH', player: 0, unitIid: u.iid, gearIid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units[0].attached.some((ref) => ref.startsWith(gear))).toBe(true) // attached, no runes needed
  })
})
