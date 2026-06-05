import { describe, it, expect } from 'vitest'
import { reduce, deflectSurcharge } from './engine'
import { RULES, createMatch, TOKEN_PILE_IDS, TOKEN_BY_NAME, GOLD_TOKEN_ID } from './setup'
import type { Deck } from '../types/deck'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
  emptyPayment,
} from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// Suppress unused-import warnings for harness symbols copied verbatim from engine.test.ts.
// They are retained so the harness is drop-in complete; only a subset is exercised here.
void RULES; void createMatch; void TOKEN_PILE_IDS; void TOKEN_BY_NAME; void GOLD_TOKEN_ID
void (null as unknown as Deck)
void emptyPayment

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

// Suppress unused-variable warnings for harness fixtures not yet exercised in this file.
void furyRune; void furyUnit

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
// Test 1: Spirit's Refuge — "Friendly buffed units have [Deflect]"
// ---------------------------------------------------------------------------
describe("Spirit's Refuge - conditional Deflect on buffed units", () => {
  // Inject the Spirit's Refuge permanent as a gear card in player 0's base.
  // controlledPermanents() scans base[], so placing it there is sufficient.
  const REFUGE_ID = 'ogn-063-298' // real card: "Friendly buffed units have [Deflect] if they didn't already."

  // A plain friendly unit with no printed Deflect keyword.
  const PLAIN_ID = injectCard('plain-unit-no-deflect', 'A plain unit with no keywords.', {
    type: 'unit',
    might: 2,
  })

  it("grants Deflect (+1 surcharge) to a buffed friendly unit when Spirit's Refuge is in play", () => {
    const s = baseState()
    // Place Spirit's Refuge in player 0's base (owned permanent, visible to controlledPermanents).
    const refuge = mk(REFUGE_ID, 0)
    s.players[0].zones.base.push(refuge)

    // Place a friendly unit at bf0 — buffed (buffs: 1).
    const unit = mk(PLAIN_ID, 0, { buffs: 1 })
    s.battlefields[0].units.push(unit)
    s.battlefields[0].controller = 0

    // Opponent (player 1) targets the unit — should pay +1 for Deflect granted by Spirit's Refuge.
    expect(deflectSurcharge(s, [unit.iid], 1)).toBe(1)
  })

  it("grants NO Deflect (0 surcharge) to an unbuffed friendly unit even with Spirit's Refuge in play", () => {
    const s = baseState()
    const refuge = mk(REFUGE_ID, 0)
    s.players[0].zones.base.push(refuge)

    // Same unit, NOT buffed (buffs: 0).
    const unit = mk(PLAIN_ID, 0, { buffs: 0 })
    s.battlefields[0].units.push(unit)
    s.battlefields[0].controller = 0

    expect(deflectSurcharge(s, [unit.iid], 1)).toBe(0)
  })

  it('owner targeting own buffed unit has no surcharge (Deflect only applies to opponents)', () => {
    const s = baseState()
    const refuge = mk(REFUGE_ID, 0)
    s.players[0].zones.base.push(refuge)

    const unit = mk(PLAIN_ID, 0, { buffs: 1 })
    s.battlefields[0].units.push(unit)
    s.battlefields[0].controller = 0

    // Player 0 targets their own buffed unit — surcharge is 0 (Deflect only taxes opponents).
    expect(deflectSurcharge(s, [unit.iid], 0)).toBe(0)
  })

  it("control: buffed unit without any Spirit's Refuge in play has 0 surcharge", () => {
    const s = baseState()
    // No Spirit's Refuge in any zone.
    const unit = mk(PLAIN_ID, 0, { buffs: 1 })
    s.battlefields[0].units.push(unit)
    s.battlefields[0].controller = 0

    expect(deflectSurcharge(s, [unit.iid], 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Test 2: Kha'Zix - Mutating Horror — "if an enemy unit is alone here" gate
// ---------------------------------------------------------------------------
describe("KhaZix - Mutating Horror - alone here gate on attack trigger", () => {
  // Inject a very weak (might 1) enemy unit to keep combat auto-resolving.
  const WEAK_ID = injectCard('weak-enemy-unit', 'A weak unit.', { type: 'unit', might: 1 })

  it('Case A: fires trigger (gains 2 XP + +2 tempMight) when exactly one enemy is at the battlefield', () => {
    const s = baseState()

    // One enemy unit already at bf0 (exhausted = was there before the attack).
    const enemy = mk(WEAK_ID, 1, { exhausted: true })
    s.battlefields[0].units.push(enemy)
    s.battlefields[0].controller = 1

    // Kha'Zix in player 0's base, ready to move.
    const khazix = mk('unl-143-219', 0)
    s.players[0].zones.base.push(khazix)

    // Player 0 attacks bf0.
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: khazix.iid, toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('showdown')

    // Both players pass → resolveShowdown fires attack trigger then resolves combat.
    r = reduce(r.state, { type: 'PASS', player: 1 })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('action')
    expect(r.state.showdown).toBeNull()

    // The trigger fired: player 0 gained 2 XP.
    expect(r.state.players[0].xp).toBe(2)
  })

  it('Case B: does NOT fire trigger (0 XP gained) when two enemy units are at the battlefield', () => {
    const s = baseState()

    // Two enemy units at bf0 — "enemy unit is alone here" gate blocks the trigger.
    const enemy1 = mk(WEAK_ID, 1, { exhausted: true })
    const enemy2 = mk(WEAK_ID, 1, { exhausted: true })
    s.battlefields[0].units.push(enemy1, enemy2)
    s.battlefields[0].controller = 1

    // Kha'Zix in player 0's base.
    const khazix = mk('unl-143-219', 0)
    s.players[0].zones.base.push(khazix)

    const xpBefore = s.players[0].xp // 0

    // Player 0 attacks bf0 (2 enemies → not alone → gate blocks).
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: khazix.iid, toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('showdown')

    r = reduce(r.state, { type: 'PASS', player: 1 })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('action')
    expect(r.state.showdown).toBeNull()

    // The trigger did NOT fire: XP unchanged.
    expect(r.state.players[0].xp).toBe(xpBefore)
  })
})
