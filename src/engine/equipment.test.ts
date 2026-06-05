import { describe, it, expect } from 'vitest'
import { reduce, combatMightAt, deflectSurcharge, displayMight } from './engine'
import { type MatchState, type PlayerState, type EngineCard, type PlayerId, type ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
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
