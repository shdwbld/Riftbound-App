import { describe, it, expect } from 'vitest'
import {
  reduce,
  teamOf, sameTeam, teammateOf, isFriendlyTo, isEnemyTo, teamPoints, scoreFor,
} from './engine'
import { createMatch, RULES } from './setup'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS } from '../data/cards'
import { isUnit } from '../types/cards'
import { emptyDeck } from '../types/deck'

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `t${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(owner: PlayerId): Record<ZoneId, EngineCard[]> {
  // Stock the deck so end-of-turn draws don't burn the player out.
  const mainDeck = Array.from({ length: 12 }, () => mk(furyUnit.id, owner))
  return { mainDeck, runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId, team: 0 | 1): PlayerState {
  return {
    id, name: `P${id + 1}`, team, legend: null, champion: null, tokenPile: [],
    points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} },
    zones: emptyZones(id), mulliganed: true,
  } as PlayerState
}
/** 4-player team match: seats 0,2 = Left (team 0); seats 1,3 = Right (team 1). */
function teamState(): MatchState {
  return {
    players: [player(0, 0), player(1, 1), player(2, 0), player(3, 1)],
    activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    teamMode: true,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 11, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

describe('2v2 — team model & helpers', () => {
  it('groups seats into two teams (Left = 0,2 · Right = 1,3)', () => {
    const s = teamState()
    expect(teamOf(s, 0)).toBe(0)
    expect(teamOf(s, 2)).toBe(0)
    expect(teamOf(s, 1)).toBe(1)
    expect(sameTeam(s, 0, 2)).toBe(true)
    expect(sameTeam(s, 0, 1)).toBe(false)
    expect(teammateOf(s, 0)).toBe(2)
    expect(teammateOf(s, 3)).toBe(1)
  })

  it('friendly = you + teammate; enemy = the other team', () => {
    const s = teamState()
    const mate = mk(furyUnit.id, 2) // teammate's unit
    const foe = mk(furyUnit.id, 1) // enemy unit
    s.battlefields[0].units.push(mate, foe)
    expect(isFriendlyTo(s, 0, mate)).toBe(true)
    expect(isEnemyTo(s, 0, mate)).toBe(false)
    expect(isEnemyTo(s, 0, foe)).toBe(true)
    expect(isFriendlyTo(s, 0, foe)).toBe(false)
  })

  it('helpers collapse to per-player identity when teamMode is off', () => {
    const s = teamState()
    s.teamMode = false
    expect(sameTeam(s, 0, 2)).toBe(false)
    expect(teamOf(s, 0)).toBe(null)
    const mate = mk(furyUnit.id, 2)
    expect(isFriendlyTo(s, 0, mate)).toBe(false) // without teams, only your own are friendly
  })
})

describe('2v2 — shared Victory Score', () => {
  it('sums both teammates toward the shared 11-point total', () => {
    const s = teamState()
    s.players[0].points = 6
    s.players[2].points = 5
    expect(teamPoints(s, 0)).toBe(11)
    expect(scoreFor(s, 0)).toBe(11) // race target is the team total
    expect(scoreFor(s, 2)).toBe(11)
    expect(teamPoints(s, 1)).toBe(0)
  })
})

describe('2v2 — turn order alternates teams', () => {
  it('advances 0 → 1 → 2 → 3 → 0 (Left, Right, Left, Right)', () => {
    let s = teamState()
    const seen: PlayerId[] = [s.activePlayer]
    for (let i = 0; i < 4; i++) {
      const r = reduce(s, { type: 'END_TURN', player: s.activePlayer })
      expect(r.error).toBeFalsy()
      s = r.state
      seen.push(s.activePlayer)
    }
    expect(seen).toEqual([0, 1, 2, 3, 0])
    // Each consecutive pair is on opposite teams.
    for (let i = 0; i < 4; i++) expect(sameTeam(s, seen[i], seen[i + 1])).toBe(false)
  })
})

describe('2v2 — teams win and lose together', () => {
  it('a concede drops both teammates and awards the other team', () => {
    const s = teamState()
    const r = reduce(s, { type: 'CONCEDE', player: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].out).toBe(true)
    expect(r.state.players[2].out).toBe(true) // teammate out too
    expect(r.state.players[1].out).toBeFalsy()
    expect(r.state.winner).not.toBeNull()
    expect(r.state.winnerTeam).toBe(1)
    expect(r.state.phase).toBe('gameover')
  })
})

describe('2v2 — createMatch wiring', () => {
  it('builds a team match: teamMode, 11 points, 3 battlefields, seats teamed', () => {
    const decks = [0, 1, 2, 3].map((i) => {
      const d = emptyDeck(`d${i}`, `Deck ${i}`)
      d.battlefields = [battlefield.id]
      return d
    })
    const m = createMatch(decks, { teams: [0, 1, 0, 1], names: ['A', 'B', 'C', 'D'] })
    expect(m.teamMode).toBe(true)
    expect(m.pointsToWin).toBe(RULES.pointsToWin2v2)
    expect(m.players.map((p) => p.team)).toEqual([0, 1, 0, 1])
    expect(m.battlefields.length).toBe(3) // first player's BF dropped (Core Rules §466)
  })
})
