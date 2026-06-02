import { describe, it, expect } from 'vitest'
import { reduce, beginTurn } from './engine'
import { RULES, createMatch, TOKEN_PILE_IDS } from './setup'
import type { Deck } from '../types/deck'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
  emptyPayment,
} from './types'
import { CARDS } from '../data/cards'
import { isUnit } from '../types/cards'

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
    log: [],
    seq: 0,
  }
}

describe('resource payment', () => {
  it('plays a unit when energy+power is paid correctly', () => {
    const s = baseState()
    const unitCard = furyUnit as Extract<typeof furyUnit, { type: 'unit' }>
    const energy = unitCard.energy
    const power = unitCard.power.fury ?? 0
    const unit = mk(unitCard.id, 0)
    s.players[0].zones.hand.push(unit)
    // Give exactly enough fury runes.
    const runes: EngineCard[] = []
    for (let i = 0; i < energy + power; i++) {
      const r = mk(furyRune.id, 0)
      s.players[0].zones.runePool.push(r)
      runes.push(r)
    }
    const payment = {
      exhaust: runes.slice(0, energy).map((r) => r.iid),
      recycle: runes.slice(energy, energy + power).map((r) => r.iid),
    }
    const { state, error } = reduce(s, {
      type: 'PLAY_UNIT',
      player: 0,
      iid: unit.iid,
      payment,
    })
    expect(error).toBeUndefined()
    expect(state.players[0].zones.base.some((c) => c.iid === unit.iid)).toBe(true)
    // Energy runes exhausted, power runes recycled to rune deck.
    expect(state.players[0].zones.runeDeck.length).toBe(power)
  })

  it('rejects underpayment', () => {
    const s = baseState()
    const unit = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(unit)
    const { error } = reduce(s, {
      type: 'PLAY_UNIT',
      player: 0,
      iid: unit.iid,
      payment: emptyPayment(),
    })
    expect(error).toBeDefined()
  })
})

describe('turn flow', () => {
  it('beginTurn awakens, channels, and draws', () => {
    const s = baseState()
    s.turn = 1
    // seed rune deck + main deck
    for (let i = 0; i < 5; i++) s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    for (let i = 0; i < 5; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const after = beginTurn(s)
    expect(after.phase).toBe('action')
    expect(after.players[0].zones.runePool.length).toBe(RULES.channelPerTurn)
    expect(after.players[0].zones.hand.length).toBe(RULES.drawPerTurn)
  })

  it('end turn passes to opponent and runs their begin-turn', () => {
    const s = baseState()
    for (let i = 0; i < 3; i++) s.players[1].zones.runeDeck.push(mk(furyRune.id, 1))
    const { state } = reduce(s, { type: 'END_TURN', player: 0 })
    expect(state.activePlayer).toBe(1)
    expect(state.phase).toBe('action')
  })
})

describe('battlefields, combat, scoring, win', () => {
  it('moving an uncontested unit takes control', () => {
    const s = baseState()
    const unit = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(unit)
    const { state, error } = reduce(s, {
      type: 'MOVE_UNIT',
      player: 0,
      iid: unit.iid,
      toBattlefield: 0,
    })
    expect(error).toBeUndefined()
    expect(state.battlefields[0].controller).toBe(0)
    expect(state.battlefields[0].units[0].exhausted).toBe(true)
  })

  it('contested move opens a showdown; two passes resolve it', () => {
    const s = baseState()
    // defender already holds battlefield 0 with a weaker presence
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    const attacker = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    expect(r.state.phase).toBe('showdown')
    // both players pass -> combat resolves (equal might -> attacker loses tie)
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.phase).toBe('action')
    expect(r.state.showdown).toBeNull()
  })

  it('scores points for held battlefields at start of turn and can win', () => {
    const s = baseState()
    s.pointsToWin = 2
    s.players[0].points = 1
    s.battlefields[0].units.push(mk(furyUnit.id, 0))
    s.battlefields[0].controller = 0
    // simulate opponent ending their turn, passing back to player 0
    s.activePlayer = 1
    s.turn = 4
    const { state } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(state.activePlayer).toBe(0)
    expect(state.players[0].points).toBeGreaterThanOrEqual(2)
    expect(state.winner).toBe(0)
  })
})

describe('multiplayer (3-4 players)', () => {
  const miniDeck = (name: string): Deck => ({
    id: name,
    name,
    legendId: null,
    main: {},
    runes: {},
    battlefields: [battlefield.id],
    updatedAt: 0,
  })

  it('creates a 3-player match: 11 pts, 3 battlefields, rotation', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B'), miniDeck('C')])
    expect(s.players.length).toBe(3)
    expect(s.pointsToWin).toBe(11)
    expect(s.battlefields.length).toBe(3)
    for (let i = 0; i < 3; i++)
      s = reduce(s, { type: 'MULLIGAN', player: i, toBottom: [] }).state
    expect(s.phase).toBe('action')
    expect(s.activePlayer).toBe(0)
    s = reduce(s, { type: 'END_TURN', player: 0 }).state
    expect(s.activePlayer).toBe(1)
    s = reduce(s, { type: 'END_TURN', player: 1 }).state
    expect(s.activePlayer).toBe(2)
    s = reduce(s, { type: 'END_TURN', player: 2 }).state
    expect(s.activePlayer).toBe(0)
  })

  it('supports 4 players and rejects out-of-range counts', () => {
    const four = createMatch([
      miniDeck('A'),
      miniDeck('B'),
      miniDeck('C'),
      miniDeck('D'),
    ])
    expect(four.players.length).toBe(4)
    expect(() => createMatch([miniDeck('A')])).toThrow()
  })
})

describe('keywords & new mechanics', () => {
  it('parses Tank / Shield / Assault from text', async () => {
    const { parseKeywords } = await import('./keywords')
    const card = {
      id: 'kw-test',
      name: 'Test',
      type: 'unit',
      domains: ['fury'],
      rarity: 'common',
      set: 'X',
      number: 1,
      text: '[Tank] [Shield 2] [Assault 1] [Deathknell]',
      energy: 1,
      power: {},
      might: 3,
    } as never
    const k = parseKeywords(card)
    expect(k.tank).toBe(true)
    expect(k.shield).toBe(2)
    expect(k.assault).toBe(1)
    expect(k.deathknell).toBe(true)
  })

  it('mulligan sets aside up to 2 to the bottom and redraws', () => {
    const s = baseState()
    s.phase = 'mulligan'
    s.players[0].mulliganed = false
    s.players[1].mulliganed = false // keep phase in mulligan after p0 acts
    const hand = [mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    s.players[0].zones.hand = hand
    s.players[0].zones.mainDeck = [mk(furyRune.id, 0), mk(furyRune.id, 0), mk(furyRune.id, 0)]
    const aside = [hand[0].iid, hand[1].iid]
    const { state, error } = reduce(s, { type: 'MULLIGAN', player: 0, toBottom: aside })
    expect(error).toBeUndefined()
    expect(state.players[0].zones.hand.length).toBe(4)
    const bottom = state.players[0].zones.mainDeck.slice(-2).map((c) => c.iid)
    expect(bottom).toEqual(aside)
  })

  it('burn out awards a point to the next player', () => {
    const s = baseState()
    s.activePlayer = 1
    s.turn = 4
    s.players[0].zones.mainDeck = [] // player 0 will draw from an empty deck
    const { state } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(state.players[1].points).toBeGreaterThanOrEqual(1)
  })
})

describe('tokens (Recruit)', () => {
  it('creates a token from the pile onto the base', () => {
    if (TOKEN_PILE_IDS.length === 0) return // dataset has no Recruit token
    const s = baseState()
    s.players[0].tokenPile = [...TOKEN_PILE_IDS]
    const { state, error } = reduce(s, {
      type: 'CREATE_TOKEN',
      player: 0,
      cardId: TOKEN_PILE_IDS[0],
    })
    expect(error).toBeUndefined()
    expect(state.players[0].zones.base.length).toBe(1)
    expect(state.players[0].zones.base[0].cardId).toBe(TOKEN_PILE_IDS[0])
  })

  it('rejects creating a token not in your pile', () => {
    const s = baseState()
    s.players[0].tokenPile = []
    const { error } = reduce(s, { type: 'CREATE_TOKEN', player: 0, cardId: 'nope' })
    expect(error).toBeDefined()
  })

  it('auto-parses Recruit creation from card text', async () => {
    const { onPlayEffect, spellEffect } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 't', name: 'T', type: 'unit', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 1 }) as never
    expect(onPlayEffect(mkCard('When you play me, play a 1 :rb_might: Recruit unit token here.')).recruits).toBe(1)
    expect(spellEffect(mkCard('Play three 1 :rb_might: Recruit unit tokens.')).recruits).toBe(3)
  })
})

describe('guards', () => {
  it("rejects acting out of turn", () => {
    const s = baseState()
    const { error } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(error).toBeDefined()
  })
})
