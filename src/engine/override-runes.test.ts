import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
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

describe('sandbox override', () => {
  it('RUNE exhaust: OVERRIDE exhaust sets runePool card to exhausted=true, then ready → false', () => {
    const s = baseState()
    s.sandbox = true
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)

    // exhaust the rune
    const { state: s1, error: e1 } = reduce(s, {
      type: 'OVERRIDE',
      player: 0,
      op: 'exhaust',
      iid: rune.iid,
    })
    expect(e1).toBeUndefined()
    const runeAfterExhaust = s1.players[0].zones.runePool.find((c) => c.iid === rune.iid)
    expect(runeAfterExhaust).toBeDefined()
    expect(runeAfterExhaust!.exhausted).toBe(true)

    // ready the rune
    const { state: s2, error: e2 } = reduce(s1, {
      type: 'OVERRIDE',
      player: 0,
      op: 'ready',
      iid: rune.iid,
    })
    expect(e2).toBeUndefined()
    const runeAfterReady = s2.players[0].zones.runePool.find((c) => c.iid === rune.iid)
    expect(runeAfterReady).toBeDefined()
    expect(runeAfterReady!.exhausted).toBe(false)
  })

  it('ATTACH free in sandbox: attaches gear from base to unit, DETACH returns gear to base', () => {
    // Inject a minimal gear card
    const gearId = injectCard(
      'test-gear-override-sandbox',
      '[Equip] Attach this to a unit.',
      { type: 'gear', energy: 0, power: {} },
    )

    const s = baseState()
    s.sandbox = true

    // Place a unit at battlefield 0 owned by player 0
    const unit = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(unit)

    // Place the gear in player 0's base
    const gear = mk(gearId, 0)
    s.players[0].zones.base.push(gear)

    // ATTACH: gear from base onto unit at battlefield
    const { state: s1, error: e1 } = reduce(s, {
      type: 'ATTACH',
      player: 0,
      unitIid: unit.iid,
      gearIid: gear.iid,
    })
    expect(e1).toBeUndefined()

    // gear should be gone from base
    expect(s1.players[0].zones.base.some((c) => c.iid === gear.iid)).toBe(false)

    // gear should be referenced in unit.attached as "cardId|iid"
    const unitAfterAttach = s1.battlefields[0].units.find((u) => u.iid === unit.iid)
    expect(unitAfterAttach).toBeDefined()
    expect(unitAfterAttach!.attached.some((ref) => ref.split('|')[1] === gear.iid)).toBe(true)

    // DETACH: remove gear from unit, returns to owner's base
    const { state: s2, error: e2 } = reduce(s1, {
      type: 'DETACH',
      player: 0,
      unitIid: unit.iid,
      gearIid: gear.iid,
    })
    expect(e2).toBeUndefined()

    // gear should be back in base
    expect(s2.players[0].zones.base.some((c) => c.iid === gear.iid)).toBe(true)

    // unit.attached should no longer reference the gear
    const unitAfterDetach = s2.battlefields[0].units.find((u) => u.iid === unit.iid)
    expect(unitAfterDetach).toBeDefined()
    expect(unitAfterDetach!.attached.some((ref) => ref.split('|')[1] === gear.iid)).toBe(false)
  })
})
