import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'

// --- minimal local fixtures (mirroring steal.test.ts) ----------------------
function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `c${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return {
    id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [],
    points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} },
    zones: emptyZones(), mulliganed: true,
  } as PlayerState
}
function baseState(players = 2): MatchState {
  return {
    players: Array.from({ length: players }, (_, i) => player(i)),
    activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

describe('Choice restoration — activated dealMight honors the chosen target', () => {
  it('Caitlyn-style "deal my Might to a unit at a battlefield" hits the PLAYER-picked enemy, not auto-strongest', () => {
    const s = baseState()
    const caitId = injectCard(
      'cait-test',
      "I must be assigned combat damage last.:rb_exhaust:: Deal damage equal to my Might to a unit at a battlefield. Use this ability only while I'm at a battlefield.",
      { name: 'Caitlyn - Patrolling', might: 5 },
    )
    const cait = mk(caitId, 0)
    const strong = mk(injectCard('strong-test', 'vanilla', { name: 'Strong', might: 9 }), 1)
    const weak = mk(injectCard('weak-test', 'vanilla', { name: 'Weak', might: 1 }), 1)
    s.battlefields[0].units.push(cait, strong, weak)

    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: cait.iid, targets: [weak.iid] })
    expect(r.error).toBeFalsy()
    // The chosen weak enemy took 5 (its Might 1) → dies and leaves the battlefield.
    expect(r.state.battlefields[0].units.some((u) => u.iid === weak.iid)).toBe(false)
    // The strongest enemy was NOT auto-targeted — it survives untouched.
    const strongAfter = r.state.battlefields[0].units.find((u) => u.iid === strong.iid)
    expect(strongAfter).toBeTruthy()
    expect(strongAfter!.damage ?? 0).toBe(0)
  })
})
