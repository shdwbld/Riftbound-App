import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { type MatchState, type PlayerState, type PlayerId, type ZoneId, type EngineCard } from './types'
import { CARDS } from '../data/cards'

// A real battlefield card to stand in as the "original" identity.
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const BRUSH_ID = 'unl-t03-219'

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
    sandbox: true,
  }
}

describe('brush / token battlefield revert', () => {
  it('revertBf restores the original cardId and clears originalCardId', () => {
    const s = baseState()
    // Simulate a Brush having replaced battlefield 0.
    s.battlefields[0].cardId = BRUSH_ID
    s.battlefields[0].originalCardId = battlefield.id

    const { state, error } = reduce(s, { type: 'OVERRIDE', player: 0, op: 'revertBf', toBattlefield: 0 })
    expect(error).toBeUndefined()
    expect(state.battlefields[0].cardId).toBe(battlefield.id)
    expect(state.battlefields[0].originalCardId).toBeUndefined()
  })

  it('revertBf is a harmless no-op on a battlefield with no stored original', () => {
    const s = baseState()
    const before = s.battlefields[1].cardId
    const { state, error } = reduce(s, { type: 'OVERRIDE', player: 0, op: 'revertBf', toBattlefield: 1 })
    expect(error).toBeUndefined()
    expect(state.battlefields[1].cardId).toBe(before)
    expect(state.battlefields[1].originalCardId).toBeUndefined()
  })

  it('originalCardId survives a reduce() clone (so the revert stays available)', () => {
    const s = baseState()
    s.battlefields[0].cardId = BRUSH_ID
    s.battlefields[0].originalCardId = battlefield.id
    // Any unrelated action triggers a clone; the field must persist.
    const { state, error } = reduce(s, { type: 'OVERRIDE', player: 0, op: 'recomputeControllers' })
    expect(error).toBeUndefined()
    expect(state.battlefields[0].cardId).toBe(BRUSH_ID)
    expect(state.battlefields[0].originalCardId).toBe(battlefield.id)
  })
})
