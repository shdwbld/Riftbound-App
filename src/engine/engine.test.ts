import { describe, it, expect } from 'vitest'
import { reduce, beginTurn, canPlay, repeatCostFor, grantedAbilityFor } from './engine'
import { autoPayForCard, effectiveCostOf } from './autopay'
import { RULES, createMatch, TOKEN_PILE_IDS, TOKEN_BY_NAME } from './setup'
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

  it('lets one rune pay both Energy (exhaust) and Power (recycle)', async () => {
    const { autoPay } = await import('./autopay')
    const s = baseState()
    // A single fury rune in the pool, paying a 1 Energy + 1 fury Power cost.
    const r = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(r)
    const payment = autoPay(s.players[0], { energy: 1, power: { fury: 1 } })
    expect(payment).not.toBeNull()
    // The same rune is exhausted for Energy and recycled for Power — 1 rune total.
    expect(payment!.exhaust).toEqual([r.iid])
    expect(payment!.recycle).toEqual([r.iid])

    // And the engine accepts that payment for a real play.
    const unitCard = furyUnit as Extract<typeof furyUnit, { type: 'unit' }>
    if (unitCard.energy === 1 && (unitCard.power.fury ?? 0) === 1) {
      const unit = mk(unitCard.id, 0)
      s.players[0].zones.hand.push(unit)
      const { error } = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: unit.iid, payment: payment! })
      expect(error).toBeUndefined()
    }
  })

  it('mightBreakdown reports base/buffs/temp/damage and total', async () => {
    const { mightBreakdown } = await import('./engine')
    const u = mk(furyUnit.id, 0, { buffs: 1, tempMight: 2, damage: 1 } as Partial<EngineCard>)
    const b = mightBreakdown(u)!
    const base = (furyUnit as Extract<typeof furyUnit, { type: 'unit' }>).might
    expect(b.base).toBe(base)
    expect(b.buffs).toBe(1)
    expect(b.temp).toBe(2)
    expect(b.damage).toBe(1)
    expect(b.hasTemp).toBe(true)
    expect(b.total).toBe(Math.max(0, base + 1 + 2 - 1))
  })

  it('matchUsesXp is false with no XP cards, true once XP is present', async () => {
    const { matchUsesXp } = await import('./engine')
    const s = baseState()
    expect(matchUsesXp(s)).toBe(false)
    s.players[0].xp = 1
    expect(matchUsesXp(s)).toBe(true)
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
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1)) // avoid Burn Out
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

  it('pauses for manual damage assignment across multiple defenders', async () => {
    const { pendingAssignment } = await import('./engine')
    const s = baseState()
    const d1 = mk(furyUnit.id, 1, { exhausted: true })
    const d2 = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[0].units.push(d1, d2)
    const attacker = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    expect(r.state.phase).toBe('showdown')
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // Attacker (Might 5) can kill exactly one of the two Might-5 defenders → choice.
    expect(r.state.showdown?.assign).toBeTruthy()
    const step = pendingAssignment(r.state, 0)!
    expect(step.targets.length).toBe(2)
    expect(step.dealer).toBe(0)
    // Assign all 5 damage to d1.
    r = reduce(r.state, { type: 'ASSIGN_DAMAGE', player: 0, allocations: { [d1.iid]: step.hp[d1.iid] } })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('action')
    const ids = r.state.battlefields[0].units.map((u) => u.iid)
    expect(ids).toContain(d2.iid) // chosen survivor
    expect(ids).not.toContain(d1.iid) // assigned lethal
    expect(ids).not.toContain(attacker.iid) // took 10, defeated
  })

  it('rejects an illegal damage allocation (wrong total)', async () => {
    const { validateAllocation } = await import('./engine')
    const step = {
      dealer: 0 as const,
      side: 'defenders' as const,
      targets: ['a', 'b'],
      amount: 5,
      manual: true,
      defeated: [],
      hp: { a: 5, b: 5 },
      tanks: [],
    }
    expect(validateAllocation(step, { a: 5 })).toBeNull() // exactly 5 = OK
    expect(validateAllocation(step, { a: 3 })).toBeTruthy() // under-assigned
    expect(validateAllocation(step, { a: 3, b: 2 })).toBeTruthy() // two sub-lethal
  })

  it('Vision: playing a Vision unit lets you recycle the top of your deck', async () => {
    const visionUnit = CARDS.find((c) => isUnit(c) && /\[vision\]/i.test(c.text ?? ''))
    if (!visionUnit) return // dataset has none — skip
    const s = baseState()
    const u = mk(visionUnit.id, 0)
    s.players[0].zones.hand.push(u)
    const top = mk(furyUnit.id, 0)
    s.players[0].zones.mainDeck.push(top, mk(furyRune.id, 0))
    // pay whatever it costs from a big rune pool
    for (let i = 0; i < 12; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const { autoPayForCard } = await import('./autopay')
    const pay = autoPayForCard(s.players[0], visionUnit)!
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: pay })
    expect(r.state.vision?.player).toBe(0)
    expect(r.state.vision?.cardId).toBe(top.cardId)
    const before = r.state.players[0].zones.mainDeck[0].iid
    r = reduce(r.state, { type: 'VISION_DECIDE', player: 0, recycle: true })
    expect(r.state.vision).toBeUndefined()
    // top card moved to the bottom
    expect(r.state.players[0].zones.mainDeck[0].iid).not.toBe(before)
  })

  it('Ambush: a unit can enter a contested battlefield at Reaction speed', async () => {
    const ambushUnit = CARDS.find((c) => isUnit(c) && /\[ambush\]/i.test(c.text ?? ''))
    if (!ambushUnit) return
    const s = baseState()
    // I have a unit at bf0; opponent contests it → showdown will open via a move
    s.battlefields[0].units.push(mk(furyUnit.id, 0))
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: s.battlefields[0].units[1].iid }
    const amb = mk(ambushUnit.id, 0)
    s.players[0].zones.hand.push(amb)
    for (let i = 0; i < 12; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const { autoPayForCard } = await import('./autopay')
    const pay = autoPayForCard(s.players[0], ambushUnit)!
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: amb.iid, payment: pay, toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.some((x) => x.iid === amb.iid)).toBe(true)
    expect(r.state.players[0].zones.base.some((x) => x.iid === amb.iid)).toBe(false)
  })

  it('Deflect: targeting a Deflect unit adds an additional cost', async () => {
    const { deflectSurcharge } = await import('./engine')
    const { parseKeywords } = await import('./keywords')
    const deflectUnit = CARDS.find((c) => isUnit(c) && /\[deflect/i.test(c.text ?? ''))
    if (!deflectUnit) return
    const s = baseState()
    const enemy = mk(deflectUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    const k = parseKeywords(deflectUnit)
    // surcharge for player 0 targeting the enemy = its Deflect value
    expect(deflectSurcharge(s, [enemy.iid], 0)).toBe(k.deflect)
    // no surcharge when the owner targets their own unit
    expect(deflectSurcharge(s, [enemy.iid], 1)).toBe(0)
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

describe('interactive setup (turn-order roll → first → mulligan)', () => {
  const miniDeck = (name: string): Deck => ({
    id: name,
    name,
    legendId: null,
    main: { [furyUnit.id]: 10 },
    runes: { [furyRune.id]: 12 },
    battlefields: [battlefield.id],
    sideboard: {},
    updatedAt: 0,
  })

  it('championVariants collapses identical-art reprints, keeps distinct art', async () => {
    const { championVariants } = await import('./setup')
    const heim = CARDS.find((c) => c.name === 'Heimerdinger - Inventor') // 3 identical reprints
    const vayne = CARDS.find((c) => c.name === 'Vayne - Hunter') // distinct alt arts
    if (heim) expect(championVariants(heim.id).length).toBe(1) // no meaningless picker
    if (vayne) expect(championVariants(vayne.id).length).toBeGreaterThan(1)
  })

  it('rolls for turn order; the winner chooses first; then mulligan', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B')], { interactiveSetup: true })
    expect(s.phase).toBe('setup')
    expect(s.setup?.step).toBe('roll')
    // Hand is NOT drawn yet (deferred past the roll, Core Rules §117–118).
    expect(s.players[0].zones.hand.length).toBe(0)
    // Player B rolls higher → B is the winner who chooses.
    let r = reduce(s, { type: 'ROLL_TURN_ORDER', player: 0, rolls: [4, 17] })
    expect(r.error).toBeUndefined()
    expect(r.state.setup?.winner).toBe(1)
    expect(r.state.setup?.step).toBe('first')
    // Only the winner may choose.
    expect(reduce(r.state, { type: 'CHOOSE_FIRST', player: 0, firstPlayer: 0 }).error).toBeTruthy()
    // B chooses to make A go first.
    r = reduce(r.state, { type: 'CHOOSE_FIRST', player: 1, firstPlayer: 0 })
    expect(r.error).toBeUndefined()
    s = r.state
    expect(s.firstPlayer).toBe(0)
    // Single battlefield option each → no choice → straight to mulligan.
    expect(s.phase).toBe('mulligan')
    expect(s.battlefields.length).toBe(2)
    // Hand is drawn now (after the roll), in finalizeSetup.
    expect(s.players[0].zones.hand.length).toBe(4)
  })
})

describe('multiplayer (3-4 players)', () => {
  const miniDeck = (name: string): Deck => ({
    id: name,
    name,
    legendId: null,
    main: { [furyUnit.id]: 10 }, // enough cards to avoid Burn Out during the test
    runes: {},
    battlefields: [battlefield.id],
    sideboard: {},
    updatedAt: 0,
  })

  it('creates a 3-player match: 8 pts (FFA), 3 battlefields, rotation', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B'), miniDeck('C')])
    expect(s.players.length).toBe(3)
    expect(s.pointsToWin).toBe(8) // FFA3 Victory Score is 8 (Core Rules v1.2)
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

  it('setup honors the declared Chosen Champion', () => {
    const champ = CARDS.find((c) => c.type === 'unit' && c.supertype === 'champion')
    if (!champ) return
    const deck = (championId?: string): Deck => ({
      id: 'cd',
      name: 'CD',
      legendId: null,
      championId,
      main: { [champ.id]: 1, [furyUnit.id]: 2 },
      runes: {},
      battlefields: [battlefield.id],
      sideboard: {},
      updatedAt: 0,
    })
    const m = createMatch([deck(champ.id), deck()])
    expect(m.players[0].champion?.cardId).toBe(champ.id)
    // The champion is pulled OUT of the main deck (set aside in the Champion Zone).
    expect(m.players[0].zones.mainDeck.concat(m.players[0].zones.hand).filter((c) => c.cardId === champ.id).length).toBe(0)
  })

  it('supports 4 players and rejects out-of-range counts', () => {
    const four = createMatch([
      miniDeck('A'),
      miniDeck('B'),
      miniDeck('C'),
      miniDeck('D'),
    ])
    expect(four.players.length).toBe(4)
    // FFA4: 8 Victory Score, and the first player removes their battlefield → 3.
    expect(four.pointsToWin).toBe(8)
    expect(four.battlefields.length).toBe(3)
    expect(() => createMatch([miniDeck('A')])).toThrow()
  })

  it('FFA first-turn process: first player skips their first draw; last player channels +1', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B'), miniDeck('C')], {
      // give everyone runes so the +1 channel is observable
    })
    // seed rune decks so channeling is visible
    for (const pl of s.players) for (let i = 0; i < 5; i++) pl.zones.runeDeck.push(mk(furyRune.id, pl.id))
    for (let i = 0; i < 3; i++) s = reduce(s, { type: 'MULLIGAN', player: i, toBottom: [] }).state
    // After all mulligans, the first player's (seat 0) turn has begun.
    const p0HandAfterFirst = s.players[0].zones.hand.length
    // Opening hand is 4 and the first player skips their first draw → still 4.
    expect(p0HandAfterFirst).toBe(RULES.openingHand)
    // First player channels the base 2 (no bonus).
    expect(s.players[0].zones.runePool.length).toBe(RULES.channelPerTurn)
    // Advance to the last player's (seat 2) first turn.
    s = reduce(s, { type: 'END_TURN', player: 0 }).state // → seat 1
    s = reduce(s, { type: 'END_TURN', player: 1 }).state // → seat 2 (last)
    // Last player channels the base 2 + 1 bonus = 3 on their first turn.
    expect(s.players[2].zones.runePool.length).toBe(RULES.channelPerTurn + 1)
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

  it('burn out reshuffles trash and awards a point to the next player', () => {
    const s = baseState()
    s.activePlayer = 1
    s.turn = 4
    s.players[0].zones.mainDeck = [] // player 0 will draw from an empty deck
    s.players[0].zones.trash = [mk(furyUnit.id, 0)] // has trash to recycle
    const { state } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(state.players[1].points).toBeGreaterThanOrEqual(1)
    // trash was reshuffled back into the deck
    expect(state.players[0].zones.trash.length).toBe(0)
  })

  it('burn out with no trash makes the opponent win', () => {
    const s = baseState()
    s.activePlayer = 1
    s.turn = 4
    s.players[0].zones.mainDeck = []
    s.players[0].zones.trash = []
    const { state } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(state.winner).toBe(1)
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

  it('auto-parses named token creation (Sand Soldier / Bird / Mech)', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    const sand = spellEffect(mkCard('Play a 2 :rb_might: Sand Soldier unit token.')).namedToken
    expect(sand).toEqual({ name: 'sand soldier', count: 1, exhausted: true })
    const bird = spellEffect(mkCard('Play three Bird unit tokens.')).namedToken
    expect(bird).toEqual({ name: 'bird', count: 3, exhausted: true })
    const mech = spellEffect(mkCard('Play a ready 3 :rb_might: Mech unit token.')).namedToken
    expect(mech).toEqual({ name: 'mech', count: 1, exhausted: false })
  })

  it('spawns a named token onto the base when an on-play effect resolves', () => {
    const tokId = TOKEN_BY_NAME['sand soldier']
    if (!tokId) return // dataset has no Sand Soldier token
    // 0-cost unit whose on-play text creates a Sand Soldier token.
    const unitId = injectCard('ss-maker', 'When you play me, play a 2 :rb_might: Sand Soldier unit token.', { energy: 0, power: {} })
    const s = baseState()
    const card = mk(unitId, 0)
    s.players[0].zones.hand.push(card)
    const { state, error } = reduce(s, {
      type: 'PLAY_UNIT', player: 0, iid: card.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(error).toBeUndefined()
    expect(state.players[0].zones.base.some((u) => u.cardId === tokId)).toBe(true)
  })
})

describe('interactions & battlefield passives', () => {
  it('parses static and on-hold battlefield passives', async () => {
    const { battlefieldPassive } = await import('./battlefields')
    const climb = CARDS.find((c) => c.type === 'battlefield' && c.name.includes('Aspirant'))
    const grove = CARDS.find((c) => c.type === 'battlefield' && c.name.includes('Grove of the God'))
    if (climb) expect(battlefieldPassive(climb.id).winDelta).toBe(1)
    if (grove) expect(battlefieldPassive(grove.id).onHold?.draw).toBe(1)
  })

  it('buffs increase a unit\'s combat Might', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    const attacker = mk(furyUnit.id, 0, { buffs: 5 })
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.battlefields[0].controller).toBe(0)
  })

  it('clears temp Might at end of turn', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { tempMight: 3 })
    s.players[0].zones.base.push(u)
    const { state } = reduce(s, { type: 'END_TURN', player: 0 })
    expect(state.players[0].zones.base[0].tempMight).toBe(0)
  })
})

describe('utility actions (hotkeys / context menu)', () => {
  it('BUFF_UNIT adds one buff, capped at 1', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'BUFF_UNIT', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base[0].buffs).toBe(1)
    expect(reduce(r.state, { type: 'BUFF_UNIT', player: 0, iid: u.iid }).error).toBeDefined()
  })

  it('TRASH_CARD moves a hand card to the trash', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'TRASH_CARD', player: 0, iid: u.iid })
    expect(r.state.players[0].zones.trash.some((c) => c.iid === u.iid)).toBe(true)
    expect(r.state.players[0].zones.hand.some((c) => c.iid === u.iid)).toBe(false)
  })

  it('RECYCLE_RUNE returns a rune to the bottom of the rune deck', () => {
    const s = baseState()
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'RECYCLE_RUNE', player: 0, iid: rune.iid })
    expect(r.state.players[0].zones.runeDeck.some((c) => c.iid === rune.iid)).toBe(true)
  })

  it('DRAW moves the top of the deck to hand', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'DRAW', player: 0 })
    expect(r.state.players[0].zones.hand.length).toBe(1)
  })
})

describe('Batch G mechanics', () => {
  it('STUN_UNIT stuns a target unit', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'STUN_UNIT', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units[0].stunned).toBe(true)
  })

  it('MOVE_UNITS moves a group together to one battlefield', () => {
    const s = baseState()
    const a = mk(furyUnit.id, 0)
    const b = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(a, b)
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [a.iid, b.iid], toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.length).toBe(2)
    expect(r.state.players[0].zones.base.length).toBe(0)
  })

  it('a defeated token ceases to exist (not sent to trash)', () => {
    if (TOKEN_PILE_IDS.length === 0) return
    const s = baseState()
    // token defender with might 1 vs a stronger attacker
    s.battlefields[0].units.push(mk(TOKEN_PILE_IDS[0], 1, { exhausted: true }))
    const attacker = mk(furyUnit.id, 0, { buffs: 5 })
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // token defeated → not in player 1's trash
    expect(r.state.players[1].zones.trash.some((c) => c.cardId === TOKEN_PILE_IDS[0])).toBe(false)
  })
})

describe('guards', () => {
  it("rejects acting out of turn", () => {
    const s = baseState()
    const { error } = reduce(s, { type: 'END_TURN', player: 1 })
    expect(error).toBeDefined()
  })
})

describe('Batch D — Banish + Hidden', () => {
  it('BANISH removes a unit to the Banishment zone without firing Deathknell', () => {
    const dk = injectCard('d-dk', '[Deathknell] Play a 1 :rb_might: Recruit unit token.')
    const s = baseState()
    const u = mk(dk, 1)
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'BANISH', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[1].banished.some((c) => c.iid === u.iid)).toBe(true)
    expect(r.state.players[1].zones.trash.length).toBe(0)
    expect(r.state.battlefields[0].units.length).toBe(0)
    // Banish is not a Kill → no Deathknell, no Recruit spawned.
    expect(r.state.log.some((l) => /deathknell/i.test(l.text))).toBe(false)
    expect(r.state.players[1].zones.base.length).toBe(0)
  })

  it('a banished token ceases to exist (not in Banishment)', () => {
    if (TOKEN_PILE_IDS.length === 0) return
    const s = baseState()
    const t = mk(TOKEN_PILE_IDS[0], 1)
    s.battlefields[0].units.push(t)
    const r = reduce(s, { type: 'BANISH', player: 0, iid: t.iid })
    expect(r.state.players[1].banished.length).toBe(0)
    expect(r.state.players[1].zones.trash.length).toBe(0)
  })

  it('HIDE places a Hidden unit facedown at a controlled battlefield, recycling a rune', () => {
    const hid = injectCard('d-hidden', '[Hidden]')
    const s = baseState()
    s.battlefields[0].controller = 0
    const hu = mk(hid, 0)
    s.players[0].zones.base.push(hu)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hu.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeUndefined()
    const placed = r.state.battlefields[0].units.find((u) => u.iid === hu.iid)
    expect(placed?.facedown).toBe(true)
    expect(r.state.players[0].zones.base.some((u) => u.iid === hu.iid)).toBe(false)
    expect(r.state.players[0].zones.runeDeck.some((c) => c.iid === rune.iid)).toBe(true)
  })

  it('rejects HIDE for a non-Hidden unit', () => {
    const s = baseState()
    s.battlefields[0].controller = 0
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: u.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeDefined()
  })

  it('REVEAL flips a facedown unit faceup', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { facedown: true })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'REVEAL', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units[0].facedown).toBe(false)
  })

  it('removes an unsupported Hidden card at begin turn (owner no longer controls)', () => {
    const s = baseState()
    s.activePlayer = 0
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    // bf0: 1 facedown p0 unit but 2 p1 units → p1 controls → p0's Hidden is orphaned.
    s.battlefields[0].units.push(mk(furyUnit.id, 0, { facedown: true, exhausted: true }))
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    const after = beginTurn(s)
    expect(after.battlefields[0].units.some((u) => u.facedown)).toBe(false)
    expect(after.players[0].zones.trash.length).toBeGreaterThan(0)
  })
})

describe('Batch E — resource pool', () => {
  it('ADD puts resources into the pool instantly (no chain)', () => {
    const s = baseState()
    const r = reduce(s, { type: 'ADD', player: 0, energy: 2, power: { fury: 1 } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].pool.energy).toBe(2)
    expect(r.state.players[0].pool.power.fury).toBe(1)
    expect(r.state.chain.length).toBe(0)
  })

  it('pays a unit entirely from the pool when it covers the cost', () => {
    const unitCard = furyUnit as Extract<typeof furyUnit, { type: 'unit' }>
    const energy = unitCard.energy
    const power = unitCard.power.fury ?? 0
    if (energy + power === 0) return // a free unit can't exercise the pool
    let s = baseState()
    s = reduce(s, { type: 'ADD', player: 0, energy, power: { fury: power } }).state
    const unit = mk(unitCard.id, 0)
    s.players[0].zones.hand.push(unit)
    // Player has NO runes — auto-pay must source everything from the pool.
    const pay = autoPayForCard(s.players[0], unitCard)
    expect(pay).toBeTruthy()
    expect(pay!.exhaust.length).toBe(0)
    expect(pay!.recycle.length).toBe(0)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: unit.iid, payment: pay! })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((c) => c.iid === unit.iid)).toBe(true)
    expect(r.state.players[0].pool.energy).toBe(0)
    expect(r.state.players[0].pool.power.fury ?? 0).toBe(0)
  })

  it('empties the pool at end of turn', () => {
    let s = baseState()
    s.players[1].zones.runeDeck.push(mk(furyRune.id, 1))
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1)) // avoid Burn Out
    s = reduce(s, { type: 'ADD', player: 0, energy: 3 }).state
    expect(s.players[0].pool.energy).toBe(3)
    const r = reduce(s, { type: 'END_TURN', player: 0 })
    expect(r.state.players[0].pool.energy).toBe(0)
  })
})

describe('auto-activated abilities', () => {
  it('auto-activates the Legend ability at the start of the turn', () => {
    const lid = injectCard('h-legend-draw', 'Draw 1.', { type: 'legend', identity: [] })
    const s = baseState()
    s.turn = 1
    s.activePlayer = 0
    s.players[0].legend = mk(lid, 0)
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    const after = beginTurn(s)
    // 1 from the Draw step + 1 from the auto-fired Legend ability.
    expect(after.players[0].zones.hand.length).toBe(2)
    expect(after.players[0].legend!.exhausted).toBe(true)
    expect(after.log.some((l) => /auto/i.test(l.text))).toBe(true)
  })
})

describe('Batch F — Spiritforged attach', () => {
  it('PLAY_GEAR attaches to a chosen friendly unit', () => {
    const gear = injectCard('f-gear', '+1 Might', { type: 'gear' })
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, payment: { exhaust: [], recycle: [] }, targetIid: u.iid })
    expect(r.error).toBeUndefined()
    const eq = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(eq?.attached.some((a) => a.startsWith(`${gear}|`))).toBe(true)
  })

  it('DETACH returns the gear to your Base unattached', () => {
    const gear = injectCard('f-gear2', '+1 Might', { type: 'gear' })
    const s = baseState()
    const g = mk(gear, 0)
    const u = mk(furyUnit.id, 0, { attached: [`${gear}|${g.iid}`] })
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'DETACH', player: 0, unitIid: u.iid, gearIid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.length).toBe(0)
    expect(r.state.players[0].zones.base.some((x) => x.iid === g.iid)).toBe(true)
  })

  it('Weaponmaster auto-attaches a gear from hand on entry', () => {
    const wm = injectCard('f-wm', '[Weaponmaster]')
    const gear = injectCard('f-wm-gear', '+1 Might', { type: 'gear' })
    const s = baseState()
    const u = mk(wm, 0)
    s.players[0].zones.hand.push(u)
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    const placed = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(placed?.attached.some((a) => a.startsWith(`${gear}|`))).toBe(true)
    expect(r.state.players[0].zones.hand.some((x) => x.iid === g.iid)).toBe(false)
  })

  it('Quick-Draw gear may be played at Reaction speed; ordinary gear may not', () => {
    const qd = injectCard('f-qd', '[Quick-Draw] +1 Might', { type: 'gear' })
    const normal = injectCard('f-normal-gear', '+1 Might', { type: 'gear' })
    const s = baseState()
    // Simulate an open chain with player 1 holding priority.
    s.chain = [{ id: 'c0', kind: 'spell', controller: 0, cardId: furyUnit.id, instance: mk(furyUnit.id, 0), payment: { exhaust: [], recycle: [] } }]
    s.priority = 1
    const qg = mk(qd, 1)
    const ng = mk(normal, 1)
    s.players[1].zones.hand.push(qg, ng)
    expect(canPlay(s, 1, qg.iid).valid).toBe(true)
    expect(canPlay(s, 1, ng.iid).valid).toBe(false)
  })

  it('a "when I move" trigger auto-creates its Gold token on a move', async () => {
    const { GOLD_TOKEN_ID } = await import('./setup')
    const mover = CARDS.find(
      (c) => isUnit(c) && /when(?:ever)?\s+i\s+move/i.test(c.text ?? '') && /gold gear token/i.test(c.text ?? ''),
    )
    if (!mover || !GOLD_TOKEN_ID) return // dataset guard
    const s = baseState()
    const u = mk(mover.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    // a Gold gear token was created on Base by the move trigger
    expect(r.state.players[0].zones.base.some((g) => g.cardId === GOLD_TOKEN_ID)).toBe(true)
  })

  it('READY_UNIT readies a chosen exhausted unit and clears the pending choice', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0, { exhausted: true })
    s.players[0].zones.base.push(u)
    s.readyChoice = { player: 0, count: 1 }
    const r = reduce(s, { type: 'READY_UNIT', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted).toBe(false)
    expect(r.state.readyChoice).toBeUndefined()
  })

  it('USE_GOLD cashes a Gold token in for 1 Power of the chosen domain', async () => {
    const { GOLD_TOKEN_ID } = await import('./setup')
    if (!GOLD_TOKEN_ID) return
    const s = baseState()
    const goldTok = mk(GOLD_TOKEN_ID, 0, { exhausted: true })
    s.players[0].zones.base.push(goldTok)
    const r = reduce(s, { type: 'USE_GOLD', player: 0, iid: goldTok.iid, domain: 'fury' })
    expect(r.error).toBeUndefined()
    // token is consumed (ceases to exist) and pool gains 1 fury Power
    expect(r.state.players[0].zones.base.some((x) => x.iid === goldTok.iid)).toBe(false)
    expect(r.state.players[0].pool.power.fury).toBe(1)
  })
})

describe('validity API (canPlay / getLegalTargets)', () => {
  // Seed a generous, multi-domain rune pool so affordability is never the
  // limiting factor when we want to isolate other rejection reasons.
  const DOMAINS = ['fury', 'calm', 'mind', 'body', 'chaos', 'order'] as const
  function seedRunes(s: MatchState, who: PlayerId) {
    for (const d of DOMAINS) {
      const r = CARDS.find((c) => c.type === 'rune' && c.produces.includes(d))
      if (!r) continue
      for (let i = 0; i < 4; i++) s.players[who].zones.runePool.push(mk(r.id, who))
    }
  }

  it('rejects an unaffordable card', async () => {
    const { canPlay } = await import('./engine')
    const s = baseState() // no runes in pool
    const unit = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(unit)
    const chk = canPlay(s, 0, unit.iid)
    expect(chk.valid).toBe(false)
    expect(chk.reason).toMatch(/resources/i)
  })

  it('rejects a play in the wrong phase / out of turn', async () => {
    const { canPlay } = await import('./engine')
    const s = baseState()
    seedRunes(s, 1)
    const unit = mk(furyUnit.id, 1)
    s.players[1].zones.hand.push(unit)
    // It is player 0's action phase, so player 1 cannot play.
    const chk = canPlay(s, 1, unit.iid)
    expect(chk.valid).toBe(false)
    expect(chk.reason).toMatch(/turn/i)
  })

  it('allows an affordable unit on your action turn', async () => {
    const { canPlay } = await import('./engine')
    const s = baseState()
    seedRunes(s, 0)
    const unit = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(unit)
    expect(canPlay(s, 0, unit.iid).valid).toBe(true)
  })

  it('gates a damage spell that has no legal target, then allows it once a unit is in play', async () => {
    const { canPlay, getLegalTargets } = await import('./engine')
    const { needsTarget, spellEffect, hasUntargetedPart } = await import('./effects')
    // A PURE-damage spell (no draw/channel part), so no-target truly blocks it.
    const dmgSpell = CARDS.find((c) => needsTarget(c) && !hasUntargetedPart(spellEffect(c)))
    if (!dmgSpell) return
    const s = baseState()
    seedRunes(s, 0)
    const spell = mk(dmgSpell.id, 0)
    s.players[0].zones.hand.push(spell)

    // No units anywhere → no legal target → can't play.
    expect(getLegalTargets(s, dmgSpell, 0).length).toBe(0)
    const blocked = canPlay(s, 0, spell.iid)
    expect(blocked.valid).toBe(false)
    expect(blocked.reason).toMatch(/target/i)

    // Add an enemy unit → exactly one legal target → playable.
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    expect(getLegalTargets(s, dmgSpell, 0)).toEqual([enemy.iid])
    const ok = canPlay(s, 0, spell.iid)
    expect(ok.valid).toBe(true)
    expect(ok.needsTarget).toBe(true)
  })

  it('isValidTarget tracks units in play', async () => {
    const { isValidTarget } = await import('./engine')
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    expect(isValidTarget(s, u.iid)).toBe(true)
    expect(isValidTarget(s, 'ghost')).toBe(false)
  })
})

describe('feedback events', () => {
  it('emits a play event when a unit is played', () => {
    const s = baseState()
    const unitCard = furyUnit as Extract<typeof furyUnit, { type: 'unit' }>
    const energy = unitCard.energy
    const power = unitCard.power.fury ?? 0
    const unit = mk(unitCard.id, 0)
    s.players[0].zones.hand.push(unit)
    const runes: EngineCard[] = []
    for (let i = 0; i < energy + power; i++) {
      const r = mk(furyRune.id, 0)
      s.players[0].zones.runePool.push(r)
      runes.push(r)
    }
    const res = reduce(s, {
      type: 'PLAY_UNIT',
      player: 0,
      iid: unit.iid,
      payment: {
        exhaust: runes.slice(0, energy).map((r) => r.iid),
        recycle: runes.slice(energy, energy + power).map((r) => r.iid),
      },
    })
    expect(res.events?.some((e) => e.kind === 'play' && e.iid === unit.iid)).toBe(true)
  })

  it('emits a draw event on DRAW', () => {
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const res = reduce(s, { type: 'DRAW', player: 0 })
    expect(res.events?.some((e) => e.kind === 'draw')).toBe(true)
  })

  it('emits move + score/conquer when taking an uncontested battlefield', () => {
    const s = baseState()
    const unit = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(unit)
    const res = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: unit.iid, toBattlefield: 0 })
    expect(res.events?.some((e) => e.kind === 'move' && e.iid === unit.iid)).toBe(true)
    expect(res.events?.some((e) => e.kind === 'score')).toBe(true)
  })

  it('does not attach events to a rejected action', () => {
    const s = baseState()
    const res = reduce(s, { type: 'END_TURN', player: 1 }) // out of turn
    expect(res.error).toBeDefined()
    expect(res.events).toBeUndefined()
  })
})

describe('battlefield scripts (Batch 1)', () => {
  const bfByName = (name: string) => CARDS.find((c) => c.type === 'battlefield' && c.name === name)

  it("Vilemaw's Lair blocks retreating to base", () => {
    const v = bfByName("Vilemaw's Lair")
    if (!v) return
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: v.id, units: [u], controller: 0 }
    const r = reduce(s, { type: 'RETREAT', player: 0, iid: u.iid })
    expect(r.error).toBeTruthy()
  })

  it('The Grand Plaza: holding with 7+ units here wins', () => {
    const p = bfByName('The Grand Plaza')
    if (!p) return
    const s = baseState()
    s.turn = 3
    s.battlefields[0] = { cardId: p.id, units: Array.from({ length: 7 }, () => mk(furyUnit.id, 0)), controller: 0 }
    for (let i = 0; i < 4; i++) {
      s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
      s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    }
    const after = beginTurn(s)
    expect(after.winner).toBe(0)
  })

  it('Frozen Fortress deals 1 to each unit here at the start of a turn', () => {
    const f = bfByName('Frozen Fortress')
    if (!f) return
    const s = baseState()
    s.turn = 2
    const u = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: f.id, units: [u], controller: null }
    for (let i = 0; i < 4; i++) {
      s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
      s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    }
    const after = beginTurn(s)
    const unit = after.battlefields[0].units.find((x) => x.iid === u.iid)
    expect(unit?.damage).toBe(1)
  })

  it('Forgotten Monument: no scoring until the controller’s 3rd turn', () => {
    const m = bfByName('Forgotten Monument')
    if (!m) return
    const seed = (s: ReturnType<typeof baseState>) => {
      for (let i = 0; i < 4; i++) {
        s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
        s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
      }
      s.battlefields[0] = { cardId: m.id, units: [mk(furyUnit.id, 0)], controller: 0 }
      return s
    }
    const early = beginTurn(seed({ ...baseState(), turn: 3 })) // player 0's 2nd turn
    expect(early.players[0].points).toBe(0)
    const onThird = beginTurn(seed({ ...baseState(), turn: 5 })) // player 0's 3rd turn
    expect(onThird.players[0].points).toBe(1)
  })
})

describe('battlefield scripts (Batch 2)', () => {
  const bfByName = (name: string) => CARDS.find((c) => c.type === 'battlefield' && c.name === name)

  it('Sigil of the Storm: conquering recycles one of your runes', () => {
    const v = bfByName('Sigil of the Storm')
    if (!v) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [], controller: null }
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.battlefields[0].controller).toBe(0)
    expect(r.state.players[0].zones.runeDeck.length).toBe(1)
    expect(r.state.players[0].zones.runePool.length).toBe(0)
  })

  it("Targon's Peak: conquering readies up to 2 runes", () => {
    const v = bfByName("Targon's Peak")
    if (!v) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [], controller: null }
    s.players[0].zones.runePool.push(mk(furyRune.id, 0, { exhausted: true }), mk(furyRune.id, 0, { exhausted: true }))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.players[0].zones.runePool.filter((x) => !x.exhausted).length).toBe(2)
  })

  it('Back-Alley Bar: a unit moving from here gets +1 Might this turn', () => {
    const v = bfByName('Back-Alley Bar')
    if (!v) return
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: v.id, units: [u], controller: 0 }
    const r = reduce(s, { type: 'RETREAT', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.tempMight).toBe(1)
  })

  it('Ravenbloom Conservatory: defending reveals a top-deck spell to hand', () => {
    const v = bfByName('Ravenbloom Conservatory')
    const spell = CARDS.find((c) => c.type === 'spell')
    if (!v || !spell) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [mk(furyUnit.id, 1, { exhausted: true })], controller: 1 }
    s.players[1].zones.mainDeck.push(mk(spell.id, 1))
    const atk = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(atk)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.players[1].zones.hand.some((c) => c.cardId === spell.id)).toBe(true)
  })
})

describe('battlefield scripts (Batch 3a)', () => {
  const bfByName = (name: string) => CARDS.find((c) => c.type === 'battlefield' && c.name === name)

  it('Minefield: conquering mills the top 2 cards', () => {
    const v = bfByName('Minefield')
    if (!v) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [], controller: null }
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.players[0].zones.trash.length).toBe(2)
  })

  it('Seat of Power: conquering draws 1 per other battlefield held', () => {
    const v = bfByName('Seat of Power')
    if (!v) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [], controller: null }
    s.battlefields[1] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('Hall of Legends: conquering pays 1 to ready your legend', () => {
    const v = bfByName('Hall of Legends')
    const legend = CARDS.find((c) => c.type === 'legend')
    if (!v || !legend) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [], controller: null }
    s.players[0].legend = mk(legend.id, 0, { exhausted: true })
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.players[0].legend?.exhausted).toBe(false)
    expect(r.state.players[0].zones.runePool[0].exhausted).toBe(true)
  })
})

describe('cost modifiers (state-aware effectiveCostOf)', () => {
  it('applies a flat self reduction ("I cost N less")', () => {
    const id = injectCard('cm-flat', 'I cost :rb_energy_2: less.', { energy: 3, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(1)
  })

  it('never reduces a cost below zero', () => {
    const id = injectCard('cm-floor0', 'I cost :rb_energy_5: less.', { energy: 1, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(0)
  })

  it('gates a [Legion] reduction on having played a card this turn', () => {
    const id = injectCard('cm-legion', '[Legion] — I cost :rb_energy_2: less.', { energy: 3, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(3) // none played yet
    s.players[0].cardsPlayedThisTurn = 1
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(1)
  })

  it('reduces 1 per card in your trash', () => {
    const id = injectCard('cm-trash', 'I cost :rb_energy_1: less for each card in your trash.', { energy: 4, power: {} })
    const s = baseState()
    s.players[0].zones.trash.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(2)
  })

  it('honors a "to a minimum of" floor on the per-card-played reduction', () => {
    const id = injectCard('cm-min', "I cost :rb_energy_1: less for each card you've played this turn, to a minimum of :rb_energy_1:.", { energy: 3, power: {} })
    const s = baseState()
    s.players[0].cardsPlayedThisTurn = 9
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(1)
  })

  it('applies a conditional "if you control a <Tag>" reduction', () => {
    const mechId = TOKEN_BY_NAME['mech']
    if (!mechId) return
    const id = injectCard('cm-cond', 'This costs :rb_energy_2: less if you control a Mech.', { energy: 3, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(3) // no Mech
    s.players[0].zones.base.push(mk(mechId, 0))
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(1)
  })

  it("Ornn's Forge: non-token gear you play costs 1 less while you control it", () => {
    const forge = CARDS.find((c) => c.type === 'battlefield' && c.name.startsWith("Ornn's Forge"))
    if (!forge) return
    const gearId = injectCard('cm-gear', 'A piece of gear.', { type: 'gear', energy: 2, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[gearId]).energy).toBe(2)
    s.battlefields[0] = { cardId: forge.id, units: [], controller: 0 }
    expect(effectiveCostOf(s, 0, CARD_INDEX[gearId]).energy).toBe(1)
  })
})

describe('Granted activated abilities (Gardens of Becoming / Forge of the Fluft)', () => {
  const bfByName = (name: string) => CARDS.find((c) => c.type === 'battlefield' && c.name === name)

  it('Gardens of Becoming: a unit here can exhaust to gain 1 XP', () => {
    const g = bfByName('Gardens of Becoming')
    if (!g) return
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: g.id, units: [u], controller: 0 }
    expect(grantedAbilityFor(s, 0, u.iid)?.kind).toBe('gainXP')
    const r = reduce(s, { type: 'ACTIVATE_ABILITY', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].xp).toBe(1)
    expect(r.state.battlefields[0].units.find((x) => x.iid === u.iid)?.exhausted).toBe(true)
    // No longer activatable once exhausted.
    expect(grantedAbilityFor(r.state, 0, u.iid)).toBeNull()
  })

  it('Forge of the Fluft: legend exhausts to attach an Equipment via a 2-step prompt', () => {
    const f = bfByName('Forge of the Fluft')
    const legend = CARDS.find((c) => c.type === 'legend')
    if (!f || !legend) return
    const equipId = injectCard('fg-equip', '[Equip] (Gear that attaches to a unit.) +1 :rb_might:', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.players[0].legend = mk(legend.id, 0)
    s.battlefields[0] = { cardId: f.id, units: [mk(furyUnit.id, 0)], controller: 0 } // control Forge
    const equip = mk(equipId, 0)
    const target = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(equip, target)
    expect(grantedAbilityFor(s, 0, s.players[0].legend.iid)?.kind).toBe('forgeAttach')
    let r = reduce(s, { type: 'ACTIVATE_ABILITY', player: 0, iid: s.players[0].legend!.iid })
    expect(r.state.players[0].legend?.exhausted).toBe(true)
    expect(r.state.pendingChoice?.kind).toBe('forgePickEquip')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: equip.iid })
    expect(r.state.pendingChoice?.kind).toBe('forgePickTarget')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: target.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === target.iid)?.attached.some((a) => a.startsWith(equipId))).toBe(true)
    expect(r.state.players[0].zones.base.some((c) => c.iid === equip.iid)).toBe(false) // gear moved out of base
  })
})

describe('Reflection copy token', () => {
  it('a Reflection copy is a token + Temporary and ceases to exist next turn', () => {
    const s = baseState()
    const refl = { ...mk(furyUnit.id, 0), token: true, temporary: true, enteredTurn: s.turn - 1 }
    s.battlefields[0] = { cardId: battlefield.id, units: [refl], controller: 0 }
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r = beginTurn(s)
    expect(r.battlefields[0].units.some((u) => u.iid === refl.iid)).toBe(false) // expired
    expect(r.players[0].zones.trash.some((c) => c.iid === refl.iid)).toBe(false) // ceased to exist, not trashed
  })

  it('a copy spell (Mirror Image) plays a Reflection copy of the chosen unit', () => {
    const spellId = injectCard('mi-test', 'Choose a unit. Play a ready Reflection unit token to your base. It becomes a copy of that unit. Give it [Temporary].', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const target = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [target], controller: 1 }
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [target.iid], payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    const copy = r.state.players[0].zones.base.find((u) => u.cardId === furyUnit.id && u.token && u.temporary)
    expect(copy).toBeTruthy()
  })

  it('Keeper of Masks plays two Reflection copies of itself', () => {
    const id = injectCard('keeper-test', 'When you play me, play two Reflection unit tokens here. They become copies of me.', { name: 'Keeper of Masks', energy: 0, power: {} })
    const s = baseState()
    const keeper = mk(id, 0)
    s.players[0].zones.hand.push(keeper)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: keeper.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    const copies = r.state.players[0].zones.base.filter((u) => u.cardId === id && u.iid !== keeper.iid && u.token)
    expect(copies.length).toBe(2)
  })

  it('LeBlanc - Deceiver: conquering offers a copy that costs a discard + exhaust', () => {
    const leblanc = CARDS.find((c) => c.type === 'legend' && c.name === 'LeBlanc - Deceiver')
    if (!leblanc) return
    const s = baseState()
    s.players[0].legend = mk(leblanc.id, 0)
    s.players[0].zones.hand.push(mk(furyUnit.id, 0)) // a card to discard
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.state.pendingChoice?.kind).toBe('leblancCopy')
    const handBefore = r.state.players[0].zones.hand.length
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].legend?.exhausted).toBe(true)
    expect(r.state.players[0].zones.hand.length).toBe(handBefore - 1) // discarded
    expect(r.state.battlefields[0].units.some((x) => x.cardId === furyUnit.id && x.token && x.temporary)).toBe(true)
  })
})

describe('Trapping Grounds (excess combat damage)', () => {
  const trap = () => CARDS.find((c) => c.type === 'battlefield' && c.name === 'Trapping Grounds')
  const birdId = TOKEN_BY_NAME['bird']

  function conquerWith(attackMight: number) {
    const atkId = injectCard(`tg-atk-${attackMight}`, 'A unit.', { might: attackMight })
    const defId = injectCard(`tg-def-${attackMight}`, 'A unit.', { might: 1 })
    const s = baseState()
    s.battlefields[0] = { cardId: trap()!.id, units: [mk(defId, 1, { exhausted: true })], controller: 1 }
    const atk = mk(atkId, 0)
    s.players[0].zones.base.push(atk)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    return r.state
  }

  it('spawns a Bird when conquering with 3+ excess damage', () => {
    if (!trap() || !birdId) return
    const st = conquerWith(8) // 8 attack vs 1 defender Might = 7 excess
    expect(st.battlefields[0].controller).toBe(0)
    expect(st.battlefields[0].units.some((u) => u.cardId === birdId)).toBe(true)
  })

  it('does not spawn a Bird with less than 3 excess damage', () => {
    if (!trap() || !birdId) return
    const st = conquerWith(2) // 2 attack vs 1 = 1 excess
    expect(st.battlefields[0].controller).toBe(0)
    expect(st.battlefields[0].units.some((u) => u.cardId === birdId)).toBe(false)
  })
})

describe('Dusk Rose Lab (resumable Beginning Phase)', () => {
  const dusk = () => CARDS.find((c) => c.type === 'battlefield' && c.name === 'Dusk Rose Lab')

  function setup() {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: dusk()!.id, units: [u], controller: 0 }
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    return { s, u }
  }

  it('pauses before scoring with a sacrifice prompt; resolving kills + draws then resumes', () => {
    if (!dusk()) return
    const { s, u } = setup()
    const paused = beginTurn(s)
    expect(paused.pendingChoice?.kind).toBe('duskRoseSacrifice')
    expect(paused.phase).toBe('score') // not yet the action phase
    const r = reduce(paused, { type: 'RESOLVE_CHOICE', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.pendingChoice).toBeUndefined()
    expect(r.state.phase).toBe('action')
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(false) // killed
    expect(r.state.players[0].zones.hand.length).toBe(2) // Dusk Rose draw + regular draw
  })

  it('declining resumes the turn with no sacrifice', () => {
    if (!dusk()) return
    const { s, u } = setup()
    const paused = beginTurn(s)
    const r = reduce(paused, { type: 'RESOLVE_CHOICE', player: 0, iid: null })
    expect(r.state.phase).toBe('action')
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(true) // alive
    expect(r.state.players[0].zones.hand.length).toBe(1) // only the regular draw
  })
})

describe('Phase A — cost increases + Repeat grant/discount', () => {
  const bf = (name: string) => CARDS.find((c) => c.type === 'battlefield' && c.name === name)

  it('Vaults of Helia: a held player\'s non-token units cost 1 more', () => {
    const id = injectCard('vh-unit', 'A unit.', { energy: 3, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(3)
    s.players[0].unitCostBump = 1
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(4)
  })

  it('Vaults of Helia: holding it sets the cost bump in beginTurn', () => {
    const v = bf('Vaults of Helia')
    if (!v) return
    const s = baseState()
    s.battlefields[0] = { cardId: v.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r = beginTurn(s)
    expect(r.players[0].unitCostBump).toBe(1)
  })

  it('Marai Spire: a friendly Repeat costs 1 Energy less', () => {
    const m = bf('Marai Spire')
    if (!m) return
    const spellId = injectCard('ms-rep', 'Draw 1. [Repeat] :rb_energy_2: (You may pay the additional cost.)', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    expect(repeatCostFor(s, 0, CARD_INDEX[spellId])?.energy).toBe(2)
    s.battlefields[0] = { cardId: m.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    expect(repeatCostFor(s, 0, CARD_INDEX[spellId])?.energy).toBe(1)
  })

  it('The Academy: grants Repeat equal to base cost to a non-Repeat spell', () => {
    const spellId = injectCard('ac-spell', 'Draw 1.', { type: 'spell', energy: 2, power: {} })
    const s = baseState()
    expect(repeatCostFor(s, 0, CARD_INDEX[spellId])).toBeNull() // no grant, no keyword
    s.players[0].grantRepeatNextSpell = true
    expect(repeatCostFor(s, 0, CARD_INDEX[spellId])?.energy).toBe(2) // base cost
  })

  it('The Academy: holding it grants the next-spell Repeat flag in beginTurn', () => {
    const a = bf('The Academy')
    if (!a) return
    const s = baseState()
    s.battlefields[0] = { cardId: a.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    expect(beginTurn(s).players[0].grantRepeatNextSpell).toBe(true)
  })
})

describe("Jinx - Loose Cannon legend (conditional, no double-draw)", () => {
  const legendText = 'At start of your Beginning Phase, draw 1 if you have one or fewer cards in your hand.'
  const legendId = injectCard('jinx-loose-cannon', legendText, { type: 'legend' })

  // Cards gained over a turn for a given starting hand size, isolating the
  // legend's conditional draw from the constant regular draw.
  function gain(startHand: number): number {
    const s = baseState()
    s.players[0].legend = mk(legendId, 0)
    for (let i = 0; i < startHand; i++) s.players[0].zones.hand.push(mk(furyUnit.id, 0))
    for (let i = 0; i < 12; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    return beginTurn(s).players[0].zones.hand.length - startHand
  }

  it('draws its bonus card only when at one or fewer cards in hand', () => {
    // The only difference between the two runs is Jinx's conditional draw: it
    // fires from an empty hand, and is skipped from a full one. Exactly +1.
    expect(gain(0) - gain(3)).toBe(1)
  })

  it('does not double-fire (trigger + auto-activation)', () => {
    // With the bug, an empty hand drew 3 (regular + trigger + auto). The bonus
    // over the no-Jinx baseline must be exactly 1.
    const baselineId = injectCard('plain-legend', 'A legend with no beginning-phase ability.', { type: 'legend' })
    const withJinx = gain(0)
    const s = baseState()
    s.players[0].legend = mk(baselineId, 0)
    for (let i = 0; i < 12; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const baseline = beginTurn(s).players[0].zones.hand.length
    expect(withJinx - baseline).toBe(1)
  })
})

describe('battlefield choice prompts (Emperor\'s Dais / move-to-base)', () => {
  it("Emperor's Dais: conquering offers return-a-unit, which plays a Sand Soldier", () => {
    const dais = CARDS.find((c) => c.type === 'battlefield' && c.name === "Emperor's Dais")
    const tokId = TOKEN_BY_NAME['sand soldier']
    if (!dais || !tokId) return
    const s = baseState()
    s.battlefields[0] = { cardId: dais.id, units: [], controller: null }
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // to pay the 1 Energy
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.pendingChoice?.kind).toBe('daisReturn')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.pendingChoice).toBeUndefined()
    expect(r.state.players[0].zones.hand.some((c) => c.iid === u.iid)).toBe(true) // returned
    expect(r.state.battlefields[0].units.some((x) => x.cardId === tokId)).toBe(true) // token played
    expect(r.state.players[0].zones.runePool[0].exhausted).toBe(true) // paid 1
  })

  it('a move-to-base choice moves the chosen unit off its battlefield', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[1] = { cardId: battlefield.id, units: [u], controller: 0 }
    s.pendingChoice = { player: 0, kind: 'moveAnyToBase', bfIndex: 1, prompt: 'x', options: [{ iid: u.iid, label: 'U' }] }
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.length).toBe(0)
    expect(r.state.players[0].zones.base.some((x) => x.iid === u.iid)).toBe(true)
  })

  it('declining a battlefield choice clears it with no effect', () => {
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[1] = { cardId: battlefield.id, units: [u], controller: 0 }
    s.pendingChoice = { player: 0, kind: 'moveHereToBase', bfIndex: 1, prompt: 'x', options: [{ iid: u.iid, label: 'U' }] }
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: null })
    expect(r.error).toBeUndefined()
    expect(r.state.pendingChoice).toBeUndefined()
    expect(r.state.battlefields[1].units.length).toBe(1) // unchanged
  })
})

describe('Predict / Repeat keywords', () => {
  it('parses [Predict] and [Repeat] keywords', async () => {
    const { parseKeywords, repeatCost } = await import('./keywords')
    const predictId = injectCard('kw-predict', '[Predict] Draw 1.', { type: 'spell', energy: 0, power: {} })
    expect(parseKeywords(CARD_INDEX[predictId]).predict).toBe(true)
    const repeatId = injectCard('kw-repeat', 'Draw 1. [Repeat] :rb_energy_2::rb_rune_fury: (You may pay the additional cost to repeat this spell’s effect.)', { type: 'spell', energy: 1, power: {} })
    const kw = parseKeywords(CARD_INDEX[repeatId])
    expect(kw.repeat).toBe(true)
    expect(repeatCost(CARD_INDEX[repeatId])).toEqual({ energy: 2, power: { fury: 1 } })
  })

  it('a [Predict] unit surfaces a look-at-top decision on play', () => {
    const id = injectCard('pred-unit', '[Predict] When you play me, look at the top of your deck.', { energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const card = mk(id, 0)
    s.players[0].zones.hand.push(card)
    const r = reduce(s, {
      type: 'PLAY_UNIT', player: 0, iid: card.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(r.error).toBeUndefined()
    expect(r.state.vision?.player).toBe(0)
  })

  it('a [Repeat] spell resolves its effect twice when the cost is paid', () => {
    // 0-cost draw spell with a 1-Energy Repeat; pay the Repeat with one rune.
    const id = injectCard('rep-draw', 'Draw 1. [Repeat] :rb_energy_1: (You may pay the additional cost to repeat this spell’s effect.)', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const sp = mk(id, 0)
    s.players[0].zones.hand.push(sp)
    const before = s.players[0].zones.hand.length
    let r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: sp.iid, repeat: true,
      payment: { exhaust: [rune.iid], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(r.error).toBeUndefined()
    expect(r.state.chain.length).toBe(1)
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.chain.length).toBe(0)
    // -1 spell leaves hand, +2 drawn from the repeated effect → net +1.
    expect(r.state.players[0].zones.hand.length).toBe(before - 1 + 2)
  })
})
