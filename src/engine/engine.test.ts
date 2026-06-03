import { describe, it, expect } from 'vitest'
import { reduce, beginTurn, canPlay, repeatCostFor, grantedAbilityFor, getLegalTargets, unitActivatedAbility, canActivateUnit } from './engine'
import { autoPayForCard, effectiveCostOf } from './autopay'
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
    expect(sand).toEqual({ name: 'sand soldier', count: 1, exhausted: true, temporary: false, here: false })
    const bird = spellEffect(mkCard('Play three Bird unit tokens.')).namedToken
    expect(bird).toEqual({ name: 'bird', count: 3, exhausted: true, temporary: false, here: false })
    const mech = spellEffect(mkCard('Play a ready 3 :rb_might: Mech unit token.')).namedToken
    expect(mech).toEqual({ name: 'mech', count: 1, exhausted: false, temporary: false, here: false })
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
    const dmgSpell = CARDS.find((c) => needsTarget(c) && spellEffect(c).damage > 0 && !hasUntargetedPart(spellEffect(c)))
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

describe('Vi deck — unit activated abilities', () => {
  const named = (n: string) => CARDS.find((c) => c.name === n)

  it('parses each unit activated ability (cost + effect)', () => {
    const ak = named('Arena Kingpin')
    if (ak) { const a = unitActivatedAbility(ak)!; expect(a.exhaust).toBe(true); expect(a.effect.tempMight).toBe(3) }
    const x = named('Xerath - Freed')
    if (x) { const a = unitActivatedAbility(x)!; expect(a.power.fury).toBe(1); expect(a.requiresBattlefield).toBe(true); expect(a.effect.damage).toBe(3) }
    const vh = named('Vi - Hotheaded')
    if (vh) { const a = unitActivatedAbility(vh)!; expect(a.energy).toBe(2); expect(a.power.fury).toBe(1); expect(a.doubleMight).toBe(true) }
    const vd = named('Vi - Destructive')
    if (vd) { const a = unitActivatedAbility(vd)!; expect(a.recycleTrash).toBe(1); expect(a.effect.tempMightSelf).toBe(1) }
    const ds = named('Divining Shells')
    if (ds) { const a = unitActivatedAbility(ds)!; expect(a.killThis).toBe(true); expect(a.effect.tempMight).toBe(2) }
  })

  it('Arena Kingpin: exhaust to give a unit +3 Might this turn', () => {
    const ak = named('Arena Kingpin')
    if (!ak) return
    const s = baseState()
    const src = mk(ak.id, 0)
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(src, ally)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid, targets: [ally.iid] })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === ally.iid)?.tempMight).toBe(3)
    expect(r.state.players[0].zones.base.find((u) => u.iid === src.iid)?.exhausted).toBe(true)
  })

  it('Xerath - Freed: fury+exhaust to deal 3, only while at a battlefield', () => {
    const x = named('Xerath - Freed')
    if (!x) return
    // At base → cannot activate.
    const s0 = baseState()
    const src0 = mk(x.id, 0)
    s0.players[0].zones.base.push(src0)
    for (let i = 0; i < 3; i++) s0.players[0].zones.runePool.push(mk(furyRune.id, 0))
    expect(reduce(s0, { type: 'ACTIVATE_UNIT', player: 0, iid: src0.iid, targets: [] }).error).toBeDefined()
    // At a battlefield → deal 3.
    const s = baseState()
    const src = mk(x.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [src], controller: 0 }
    for (let i = 0; i < 3; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[1] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid, targets: [enemy.iid] })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.find((u) => u.iid === enemy.iid)?.damage).toBe(3)
  })

  it('Vi - Hotheaded: 2 Energy + fury to double its Might this turn', () => {
    const vh = named('Vi - Hotheaded')
    if (!vh) return
    const s = baseState()
    const src = mk(vh.id, 0)
    s.players[0].zones.base.push(src)
    for (let i = 0; i < 4; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === src.iid)?.tempMight).toBe((vh as { might: number }).might)
  })

  it('Vi - Destructive: recycle 1 from trash to give itself +1 Might', () => {
    const vd = named('Vi - Destructive')
    if (!vd) return
    const s = baseState()
    const src = mk(vd.id, 0)
    s.players[0].zones.base.push(src)
    s.players[0].zones.trash.push(mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === src.iid)?.tempMight).toBe(1)
    expect(r.state.players[0].zones.trash.length).toBe(0)
  })

  it('Divining Shells: kill this + exhaust to give a unit +2 Might', () => {
    const ds = named('Divining Shells')
    if (!ds) return
    const s = baseState()
    const src = mk(ds.id, 0)
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(src, ally)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid, targets: [ally.iid] })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === ally.iid)?.tempMight).toBe(2)
    expect(r.state.players[0].zones.base.some((u) => u.iid === src.iid)).toBe(false) // killed
  })
})

describe('Vi deck — temporary keyword grants', () => {
  it('parses [Assault]/[Ganking] grants (Square Up, Vault Breaker, Lord Broadmane)', async () => {
    const { spellEffect, onPlayEffect } = await import('./effects')
    const sq = CARDS.find((c) => c.type === 'spell' && c.name === 'Square Up')
    if (sq) expect(spellEffect(sq).grantAssault).toBe(4)
    const vb = CARDS.find((c) => c.type === 'spell' && c.name === 'Vault Breaker')
    if (vb) { expect(spellEffect(vb).grantAssault).toBe(2); expect(spellEffect(vb).grantGanking).toBe(true) }
    const lb = CARDS.find((c) => c.type === 'unit' && c.name === 'Lord Broadmane')
    if (lb) expect(onPlayEffect(lb).grantAssaultHere).toBeGreaterThan(0)
  })

  it('Square Up: grants [Assault N] to a friendly unit this turn', () => {
    const spellId = injectCard('su-test', 'Give a unit [Assault 4] this turn.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const myUnit = mk(injectCard('su-unit', 'A unit.', { might: 1 }), 0)
    s.players[0].zones.base.push(myUnit)
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [myUnit.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.base.find((u) => u.iid === myUnit.iid)?.grantAssault).toBe(4)
  })

  it('Vault Breaker: granted [Ganking] enables a battlefield-to-battlefield move', () => {
    const spellId = injectCard('vb-test', 'Give a unit [Assault 2] and [Ganking] this turn.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    s.battlefields[1] = { cardId: battlefield.id, units: [], controller: null }
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [u.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    r = reduce(r.state, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 1 }) // ganking move
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.some((x) => x.iid === u.iid)).toBe(true)
  })
})

describe('Vi deck — excess-damage conquer', () => {
  it('a self-conquer unit makes its tokens only at 3+ excess damage (Yeti Brawler)', () => {
    if (!GOLD_TOKEN_ID) return
    const id = injectCard('yeti-test', 'When I conquer, if you assigned 3 or more excess damage, play two Gold gear tokens exhausted.', { might: 8 })
    function goldAfter(defMight: number): number {
      const s = baseState()
      s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('yd' + defMight, 'x', { might: defMight }), 1, { exhausted: true })], controller: 1 }
      const atk = mk(id, 0)
      s.players[0].zones.base.push(atk)
      let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
      r = reduce(r.state, { type: 'PASS', player: 1 })
      r = reduce(r.state, { type: 'PASS', player: 0 })
      return r.state.players[0].zones.base.filter((u) => u.cardId === GOLD_TOKEN_ID).length
    }
    expect(goldAfter(1)).toBe(2) // 8−1 = 7 excess ≥ 3 → 2 Gold
    expect(goldAfter(7)).toBe(0) // 8−7 = 1 excess < 3 → none
  })

  it('Vi - Piltover Enforcer: 3+ excess readies a unit and exhausts the legend', () => {
    const vi = CARDS.find((c) => c.type === 'legend' && c.name === 'Vi - Piltover Enforcer')
    if (!vi) return
    const s = baseState()
    s.players[0].legend = mk(vi.id, 0)
    s.players[0].zones.base.push(mk(furyUnit.id, 0, { exhausted: true })) // a unit to ready
    const atk = mk(injectCard('vi-atk', 'A unit.', { might: 8 }), 0)
    s.players[0].zones.base.push(atk)
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('vi-def', 'x', { might: 1 }), 1, { exhausted: true })], controller: 1 }
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.readyChoice?.player).toBe(0) // ready-a-unit prompt
    expect(r.state.players[0].legend?.exhausted).toBe(true) // exhaust me
  })
})

describe('Vi deck — combat/targeting', () => {
  it('Soul Harvest: restricts kill to units with N Might or less', () => {
    const spellId = injectCard('sh-test', 'Kill a unit at a battlefield with 3 :rb_might: or less.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const small = mk(injectCard('sh-small', 'A unit.', { might: 2 }), 1)
    const big = mk(injectCard('sh-big', 'A unit.', { might: 8 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [small, big], controller: 1 }
    const tgts = getLegalTargets(s, CARD_INDEX[spellId], 0)
    expect(tgts).toContain(small.iid)
    expect(tgts).not.toContain(big.iid)
  })

  it('a stun spell stuns the chosen target', () => {
    const spellId = injectCard('stun-test', 'Stun an enemy unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.find((u) => u.iid === enemy.iid)?.stunned).toBe(true)
  })

  it('Right of Conquest: draws 1 per battlefield you control', () => {
    const id = injectCard('roc-test', 'When you play me, draw 1 for each battlefield you control.', { energy: 0, power: {} })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    s.battlefields[1] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const u = mk(id, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(2) // drew 1 per 2 controlled battlefields
  })

  it('Crimson Pigeons: +2 Might while attacking with another unit', () => {
    const pigeonId = injectCard('pigeon-test', "I have +2 :rb_might: while I'm attacking with another unit.", { might: 3 })
    const allyId = injectCard('pigeon-ally', 'A unit.', { might: 1 })
    function defenderSurvives(attackerIds: string[]): boolean {
      const s = baseState()
      // Stunned defender (Might 5) — deals no return damage, so combat auto-resolves.
      s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 1, { exhausted: true, stunned: true })], controller: 1 }
      const atk = attackerIds.map((id) => mk(id, 0))
      atk.forEach((u) => s.players[0].zones.base.push(u))
      let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: atk.map((u) => u.iid), toBattlefield: 0 })
      r = reduce(r.state, { type: 'PASS', player: 1 })
      r = reduce(r.state, { type: 'PASS', player: 0 })
      return r.state.battlefields[0].units.some((u) => u.owner === 1)
    }
    expect(defenderSurvives([pigeonId, allyId])).toBe(false) // 3+2 + 1 = 6 ≥ 5 → defender dies
    expect(defenderSurvives([pigeonId])).toBe(true) // 3 alone (no +2) < 5 → survives
  })
})

describe('Viktor deck — minor faithfulness', () => {
  function resolveChainSpell(s: MatchState, spIid: string, targets?: string[]) {
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: spIid, targets, payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    return r
  }

  it('Soaring Scout: channels a rune EXHAUSTED', () => {
    const id = injectCard('sc-test', 'When you play me, channel 1 rune exhausted.', { energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    const u = mk(id, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.state.players[0].zones.runePool.find((x) => x.cardId === furyRune.id)?.exhausted).toBe(true)
  })

  it('Hidden Blade: the killed unit\'s controller draws 2', () => {
    const spellId = injectCard('hb-test', 'Kill a unit at a battlefield. Its controller draws 2.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [victim], controller: 1 }
    for (let i = 0; i < 5; i++) s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    const before = s.players[1].zones.hand.length
    const r = resolveChainSpell(s, sp.iid, [victim.iid])
    expect(r.state.battlefields[0].units.some((u) => u.iid === victim.iid)).toBe(false) // killed
    expect(r.state.players[1].zones.hand.length - before).toBe(2) // controller drew 2
  })

  it('a -Might debuff respects "to a minimum of 1 Might"', () => {
    const targetId = injectCard('floor-target', 'A unit.', { might: 3 })
    const spellId = injectCard('floor-spell', 'Give a unit -4 :rb_might: this turn, to a minimum of 1 :rb_might:.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const target = mk(targetId, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [target], controller: 1 }
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    const r = resolveChainSpell(s, sp.iid, [target.iid])
    expect(r.state.battlefields[0].units.some((u) => u.iid === target.iid)).toBe(true) // survived (floored at 1, not -1)
  })

  it('Cull the Weak: each player kills their lowest-Might unit', () => {
    const spellId = injectCard('cull-test', 'Each player kills one of their units.', { type: 'spell', energy: 0, power: {} })
    const low = mk(injectCard('cull-low', 'A unit.', { might: 1 }), 0)
    const high = mk(injectCard('cull-high', 'A unit.', { might: 9 }), 0)
    const enemy = mk(furyUnit.id, 1)
    const s = baseState()
    s.players[0].zones.base.push(low, high)
    s.players[1].zones.base.push(enemy)
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    const r = resolveChainSpell(s, sp.iid)
    expect(r.state.players[0].zones.base.some((u) => u.iid === low.iid)).toBe(false) // lowest died
    expect(r.state.players[0].zones.base.some((u) => u.iid === high.iid)).toBe(true) // kept
    expect(r.state.players[1].zones.base.some((u) => u.iid === enemy.iid)).toBe(false) // each player loses one
  })
})

describe('Viktor deck — buffs + tokens', () => {
  it('Grand Strategem: parses "give friendly units +5 Might this turn"', async () => {
    const { spellEffect } = await import('./effects')
    const gs = CARDS.find((c) => c.type === 'spell' && c.name === 'Grand Strategem')
    if (!gs) return
    expect(spellEffect(gs).tempMightAll).toBe(5)
  })

  it('a board-wide +Might buff applies to all your units this turn', () => {
    const id = injectCard('gs-test', 'When you play me, give friendly units +5 :rb_might: this turn.', { energy: 0, power: {} })
    const s = baseState()
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(ally)
    const self = mk(id, 0)
    s.players[0].zones.hand.push(self)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: self.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === ally.iid)?.tempMight).toBe(5)
  })

  it('Sprite Mother: the spawned Sprite is granted [Temporary]', () => {
    const spriteId = TOKEN_BY_NAME['sprite']
    if (!spriteId) return
    const id = injectCard('sm-test', 'When you play me, play a ready 3 :rb_might: Sprite unit token with [Temporary] here.', { energy: 0, power: {} })
    const s = baseState()
    const self = mk(id, 0)
    s.players[0].zones.hand.push(self)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: self.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    const sprite = r.state.players[0].zones.base.find((u) => u.cardId === spriteId)
    expect(sprite?.temporary).toBe(true)
    expect(sprite?.exhausted).toBe(false) // "ready"
  })
})

describe('Viktor deck — core engine', () => {
  const recruit = TOKEN_PILE_IDS[0]
  const recruitCount = (st: MatchState, pl: number) => st.players[pl].zones.base.filter((u) => u.cardId === recruit).length

  it('Viktor - Herald (legend): does NOT auto-recruit (exhaust ability is optional); manual activation recruits + pays 1 Energy', () => {
    const herald = CARDS.find((c) => c.type === 'legend' && c.name === 'Viktor - Herald of the Arcane')
    if (!herald || !recruit) return
    const s = baseState()
    s.players[0].legend = mk(herald.id, 0)
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0), mk(furyRune.id, 0)] // channels → can pay 1
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r0 = beginTurn(s)
    // Optional activated ability → it must NOT fire on its own.
    expect(recruitCount(r0, 0)).toBe(0)
    expect(r0.players[0].legend!.exhausted).toBe(false)
    // The player chooses to activate it.
    const ab = canActivateUnit(r0, 0, r0.players[0].legend!.iid)
    expect(ab).toBeTruthy()
    const r = reduce(r0, { type: 'ACTIVATE_UNIT', player: 0, iid: r0.players[0].legend!.iid })
    expect(r.error).toBeFalsy()
    expect(recruitCount(r.state, 0)).toBe(1)
    expect(r.state.players[0].legend!.exhausted).toBe(true)
  })

  it('Viktor - Herald: not activatable when it can\'t pay the Energy', () => {
    const herald = CARDS.find((c) => c.type === 'legend' && c.name === 'Viktor - Herald of the Arcane')
    if (!herald || !recruit) return
    const s = baseState()
    s.players[0].legend = mk(herald.id, 0)
    s.players[0].zones.runeDeck = [] // nothing to channel → no Energy
    const r0 = beginTurn(s)
    expect(recruitCount(r0, 0)).toBe(0) // never auto-fires
    expect(canActivateUnit(r0, 0, r0.players[0].legend!.iid)).toBeNull() // can't pay → not offered
  })

  it('Viktor - Leader: a non-Recruit ally dying makes a Recruit; a Recruit dying does not', () => {
    const leader = CARDS.find((c) => c.type === 'unit' && c.name === 'Viktor - Leader')
    if (!leader || !recruit) return
    const leaderId = leader.id
    const strongId = injectCard('vl-strong', 'A unit.', { might: 9 })
    function killAllyAtBf(victim: EngineCard): number {
      const s = baseState()
      s.players[0].zones.base.push(mk(leaderId, 0)) // Leader in play
      s.battlefields[0] = { cardId: battlefield.id, units: [mk(strongId, 1, { exhausted: true })], controller: 1 }
      s.players[0].zones.base.push(victim)
      let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: victim.iid, toBattlefield: 0 }) // victim dies (5/9)
      r = reduce(r.state, { type: 'PASS', player: 1 })
      r = reduce(r.state, { type: 'PASS', player: 0 })
      return recruitCount(r.state, 0)
    }
    expect(killAllyAtBf(mk(furyUnit.id, 0))).toBe(1) // non-Recruit died → +1 Recruit
    expect(killAllyAtBf(mk(recruit, 0))).toBe(0) // a Recruit died → gated, no new Recruit
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

describe('Master Yi — Unstoppable', () => {
  const unst = () => CARDS.find((c) => c.type === 'unit' && c.name.startsWith('Master Yi - Unstoppable'))

  it('level-tier cost reductions cut Energy and Calm by the best tier reached', () => {
    const card = unst()
    if (!card) return
    const s = baseState()
    expect(effectiveCostOf(s, 0, card)).toEqual({ energy: 12, power: { calm: 3 } }) // xp 0 — no tier
    s.players[0].xp = 6
    expect(effectiveCostOf(s, 0, card)).toEqual({ energy: 8, power: { calm: 1 } }) // [Level 6] −4/−2
    s.players[0].xp = 11
    expect(effectiveCostOf(s, 0, card)).toEqual({ energy: 6, power: { calm: 0 } }) // [Level 11] −6/−3
  })

  it('[Level 16] makes it unchoosable by enemy spells', () => {
    const card = unst()
    if (!card) return
    const spellId = injectCard('uns-spell', 'Deal 3 to a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const u = mk(card.id, 1) // enemy unit
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 1 }
    expect(getLegalTargets(s, CARD_INDEX[spellId], 0)).toContain(u.iid) // xp 0 → targetable
    s.players[1].xp = 16
    expect(getLegalTargets(s, CARD_INDEX[spellId], 0)).not.toContain(u.iid) // xp 16 → untargetable
  })
})

describe('Master Yi — conditional + legend Might', () => {
  // Run a 1-defender showdown; return whether the defender survived.
  function defenderSurvives(s: MatchState, defIid: string, attacker: EngineCard): boolean {
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    return r.state.battlefields[0].units.some((u) => u.iid === defIid)
  }

  it('Meditative: +4 Might (8 HP) while you have 8+ runes lets it survive 5 damage', () => {
    const med = CARDS.find((c) => c.type === 'unit' && c.name === 'Master Yi - Meditative')
    if (!med) return
    const s = baseState()
    const medU = mk(med.id, 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [medU], controller: 1 }
    for (let i = 0; i < 8; i++) s.players[1].zones.runePool.push(mk(furyRune.id, 1)) // 8 runes → +4
    expect(defenderSurvives(s, medU.iid, mk(furyUnit.id, 0))).toBe(true) // 4+4 HP > 5 dmg
  })

  it('Meditative: without 8 runes it dies to the same 5 damage', () => {
    const med = CARDS.find((c) => c.type === 'unit' && c.name === 'Master Yi - Meditative')
    if (!med) return
    const s = baseState()
    const medU = mk(med.id, 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [medU], controller: 1 }
    expect(defenderSurvives(s, medU.iid, mk(furyUnit.id, 0))).toBe(false) // 4 HP < 5 dmg
  })

  it('Wuju Bladesman: a lone defender gets +2 Might', () => {
    const bm = CARDS.find((c) => c.type === 'legend' && c.name.startsWith('Master Yi - Wuju Bladesman'))
    if (!bm) return
    const s = baseState()
    s.players[1].legend = mk(bm.id, 1)
    const d = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [d], controller: 1 }
    const atk = mk(injectCard('bm-atk', 'A unit.', { might: 6 }), 0)
    expect(defenderSurvives(s, d.iid, atk)).toBe(true) // 5+2 HP > 6 dmg
  })

  it('Wuju Master: [Level 6] your units +1 Might (with 6+ XP)', () => {
    const wm = CARDS.find((c) => c.type === 'legend' && c.name === 'Master Yi - Wuju Master')
    if (!wm) return
    const s = baseState()
    s.players[1].legend = mk(wm.id, 1)
    s.players[1].xp = 6
    const d = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [d], controller: 1 }
    expect(defenderSurvives(s, d.iid, mk(furyUnit.id, 0))).toBe(true) // 5+1 HP > 5 dmg
  })

  it('Wuju Master: [Level 11] your units enter ready (with 11+ XP)', () => {
    const wm = CARDS.find((c) => c.type === 'legend' && c.name === 'Master Yi - Wuju Master')
    if (!wm) return
    const s = baseState()
    s.players[0].legend = mk(wm.id, 0)
    s.players[0].xp = 11
    const u = mk(injectCard('wm-unit', 'A unit.', { energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted).toBe(false)
  })
})

describe('Master Yi — quick wins', () => {
  it('Honed: a base "I enter ready" unit enters ready', () => {
    const id = injectCard('honed-test', '[Ganking] (I can move from battlefield to battlefield.) I enter ready.', { energy: 0, power: {} })
    const s = baseState()
    const u = mk(id, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted).toBe(false)
  })

  it('Tempered: [Level 6] grants Deflect/Ganking only at 6+ XP', async () => {
    const { keywordsAt } = await import('./keywords')
    const tempered = CARDS.find((c) => c.type === 'unit' && c.name.startsWith('Master Yi - Tempered'))
    if (!tempered) return
    expect(keywordsAt(tempered, 0).ganking).toBe(false) // below level 6
    expect(keywordsAt(tempered, 0).deflect).toBe(0)
    expect(keywordsAt(tempered, 0).hunt).toBe(2) // Hunt 2 is before the [Level 6] gate → ungated
    expect(keywordsAt(tempered, 6).ganking).toBe(true) // at level 6
    expect(keywordsAt(tempered, 6).deflect).toBe(1)
  })
})

describe('Lillia / Plundering Poro', () => {
  it('Plundering Poro: conquering plays an exhausted Gold token', () => {
    const poro = CARDS.find((c) => c.type === 'unit' && c.name === 'Plundering Poro')
    if (!poro || !GOLD_TOKEN_ID) return
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    const u = mk(poro.id, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.error).toBeUndefined()
    const gold = r.state.players[0].zones.base.filter((c) => c.cardId === GOLD_TOKEN_ID)
    expect(gold.length).toBe(1)
    expect(gold[0].exhausted).toBe(true)
  })

  it('Lillia: +1 Might this turn when you create a token unit', () => {
    const lillia = CARDS.find((c) => c.type === 'unit' && c.name === 'Lillia - Protector of Dreams')
    const recruit = TOKEN_PILE_IDS[0]
    if (!lillia || !recruit) return
    const s = baseState()
    const lil = mk(lillia.id, 0)
    s.players[0].zones.base.push(lil)
    s.players[0].tokenPile = [...TOKEN_PILE_IDS]
    const r = reduce(s, { type: 'CREATE_TOKEN', player: 0, cardId: recruit })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === lil.iid)?.tempMight).toBe(1)
  })

  it('Lillia: does NOT buff when a non-token card is played', () => {
    const lillia = CARDS.find((c) => c.type === 'unit' && c.name === 'Lillia - Protector of Dreams')
    if (!lillia) return
    const unitId = injectCard('lil-other', 'A vanilla unit.', { energy: 0, power: {} })
    const s = baseState()
    const lil = mk(lillia.id, 0)
    s.players[0].zones.base.push(lil)
    const other = mk(unitId, 0)
    s.players[0].zones.hand.push(other)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: other.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((u) => u.iid === lil.iid)?.tempMight ?? 0).toBe(0)
  })

  it('Lillia: your token units count as [Tank] in damage assignment', async () => {
    const { pendingAssignment } = await import('./engine')
    const lillia = CARDS.find((c) => c.type === 'unit' && c.name === 'Lillia - Protector of Dreams')
    const recruit = TOKEN_PILE_IDS[0]
    if (!lillia || !recruit) return
    const s = baseState()
    const tok = mk(recruit, 1) // a token unit owned by the defender
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(lillia.id, 1), tok, mk(furyUnit.id, 1)], controller: 1 }
    const atk = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(atk)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    const step = pendingAssignment(r.state, 0)
    expect(step?.tanks).toContain(tok.iid) // granted Tank via Lillia
  })
})

describe('Garen - Might of Demacia legend (conquer-conditioned draw)', () => {
  const garen = () => CARDS.find((c) => c.type === 'legend' && c.name === 'Garen - Might of Demacia')

  function conquerWith(units: number): number {
    const s = baseState()
    s.players[0].legend = mk(garen()!.id, 0)
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    const us = Array.from({ length: units }, () => mk(furyUnit.id, 0))
    us.forEach((u) => s.players[0].zones.base.push(u))
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: us.map((u) => u.iid), toBattlefield: 0 })
    return r.state.players[0].zones.hand.length - before
  }

  it('draws 2 only when conquering with 4+ units at that battlefield', () => {
    if (!garen()) return
    expect(conquerWith(4)).toBe(2) // 4+ units → draw 2
    expect(conquerWith(3)).toBe(0) // fewer than 4 → no draw
  })

  it('does NOT auto-draw at the start of turn (it is a conquer trigger, not passive)', () => {
    if (!garen()) return
    const s = baseState()
    s.players[0].legend = mk(garen()!.id, 0)
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    expect(beginTurn(s).players[0].zones.hand.length).toBe(1) // just the regular draw, not +2
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

describe('Vex - Gloomist legend (draws only on hold, not every turn)', () => {
  const legendText = 'When you or an ally hold, you may exhaust me to draw 1.'
  const legendId = injectCard('vex-gloomist-test', legendText, { type: 'legend' })

  // Cards gained over a Beginning Phase, with vs. without actually holding a
  // battlefield, isolating the legend's hold-draw from the constant regular draw.
  function gain(holding: boolean): number {
    const s = baseState()
    s.players[0].legend = mk(legendId, 0)
    for (let i = 0; i < 12; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    if (holding) s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    return beginTurn(s).players[0].zones.hand.length
  }

  it('draws its bonus card only when holding a battlefield', () => {
    expect(gain(true) - gain(false)).toBe(1)
  })

  it('does not auto-draw every turn when holding nothing', () => {
    // Regression: "When you OR AN ALLY hold" was not recognized as a hold
    // trigger, so the parsed "draw 1" fell through to the legend auto-activation
    // and fired every Beginning Phase regardless of holding. Now a non-holding
    // turn matches a no-ability legend exactly (just the one regular draw).
    const baselineId = injectCard('vex-baseline', 'A legend with no beginning-phase ability.', { type: 'legend' })
    const s = baseState()
    s.players[0].legend = mk(baselineId, 0)
    for (let i = 0; i < 12; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    expect(gain(false)).toBe(beginTurn(s).players[0].zones.hand.length)
  })
})

describe('[Level N][>] gated on-play draw (Wuju Apprentice)', () => {
  // "[Level 6][>] When you play me, draw 1." — the draw must only happen with
  // 6+ XP. Previously the parser stripped the gate and drew on every play.
  const unitId = injectCard(
    'wuju-apprentice-test',
    '[Hunt] [Level 6][&gt;] When you play me, draw 1.',
    { energy: 0, power: {} },
  )

  function drawnAtXp(xp: number): number {
    const s = baseState()
    s.players[0].xp = xp
    for (let i = 0; i < 6; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const card = mk(unitId, 0)
    s.players[0].zones.hand.push(card)
    const before = s.players[0].zones.hand.length
    const { state, error } = reduce(s, {
      type: 'PLAY_UNIT', player: 0, iid: card.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(error).toBeUndefined()
    // -1 because the played unit left the hand; the net delta is the cards drawn.
    return state.players[0].zones.hand.length - (before - 1)
  }

  it('does not draw below the XP threshold', () => {
    expect(drawnAtXp(0)).toBe(0)
    expect(drawnAtXp(5)).toBe(0)
  })

  it('draws once at or above the XP threshold', () => {
    expect(drawnAtXp(6)).toBe(1)
    expect(drawnAtXp(9)).toBe(1)
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

describe('Lux — spell-cost play triggers gate on cost', () => {
  // Play a spell of the given Energy cost (paying with that many runes) and
  // resolve the chain, returning the post-resolution state.
  function playSpellOfCost(s: MatchState, energy: number) {
    const spellId = injectCard(`lux-spell-${energy}-${n}`, 'Channel 1.', { type: 'spell', energy, power: {} })
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    const runeIids: string[] = []
    for (let i = 0; i < energy; i++) {
      const r = mk(furyRune.id, 0)
      s.players[0].zones.runePool.push(r)
      runeIids.push(r.iid)
    }
    let r = reduce(s, {
      type: 'PLAY_SPELL', player: 0, iid: sp.iid,
      payment: { exhaust: runeIids, recycle: [], poolEnergy: 0, poolPower: {} },
    })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    return r.state
  }

  it('Lux - Illuminated: +3 Might only when the spell costs 5+', () => {
    // Cheap spell (cost 1) — no buff.
    let s = baseState()
    const luxA = mk('ogs-006-024', 0)
    s.players[0].zones.base.push(luxA)
    s = playSpellOfCost(s, 1)
    expect(s.players[0].zones.base.find((u) => u.iid === luxA.iid)!.tempMight ?? 0).toBe(0)

    // Expensive spell (cost 6) — +3 Might this turn.
    let s2 = baseState()
    const luxB = mk('ogs-006-024', 0)
    s2.players[0].zones.base.push(luxB)
    s2 = playSpellOfCost(s2, 6)
    expect(s2.players[0].zones.base.find((u) => u.iid === luxB.iid)!.tempMight ?? 0).toBe(3)
  })

  it('Lux - Lady of Luminosity (legend): draw 1 only when the spell costs 5+', () => {
    // Cheap spell — no extra draw.
    let s = baseState()
    s.players[0].legend = mk('ogs-021-024', 0)
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const handBeforeCheap = s.players[0].zones.hand.length
    s = playSpellOfCost(s, 1)
    // played spell left hand (−1), no draw → hand back to start − 1 net of the added spell.
    expect(s.players[0].zones.hand.length).toBe(handBeforeCheap)

    // Expensive spell — draw 1.
    let s2 = baseState()
    s2.players[0].legend = mk('ogs-021-024', 0)
    for (let i = 0; i < 4; i++) s2.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const handBeforeBig = s2.players[0].zones.hand.length
    s2 = playSpellOfCost(s2, 6)
    expect(s2.players[0].zones.hand.length).toBe(handBeforeBig + 1)
  })
})

describe('sandbox manual overrides', () => {
  it('rejects OVERRIDE while sandbox is off, allows it once enabled', () => {
    let s = baseState()
    const u = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(u)
    // Off by default.
    expect(reduce(s, { type: 'OVERRIDE', player: 0, op: 'stun', iid: u.iid }).error).toBeTruthy()
    s = reduce(s, { type: 'SET_SANDBOX', player: 0, on: true }).state
    expect(s.sandbox).toBe(true)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'stun', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect((r.state.battlefields[0].units[0] as { stunned?: boolean }).stunned).toBe(true)
  })

  it('applies unit ops on EITHER player\'s card (kill, might, ready)', () => {
    let s = baseState()
    s.sandbox = true
    const enemy = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[0].units.push(enemy)
    // ±Might via tempMight.
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'mightUp', iid: enemy.iid }).state
    expect((s.battlefields[0].units[0] as { tempMight?: number }).tempMight).toBe(1)
    // Ready an exhausted enemy unit.
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'ready', iid: enemy.iid }).state
    expect(s.battlefields[0].units[0].exhausted).toBe(false)
    // Kill removes it from the battlefield.
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: enemy.iid }).state
    expect(s.battlefields[0].units.find((x) => x.iid === enemy.iid)).toBeUndefined()
  })

  it('banishes / draws for the targeted card owner', () => {
    let s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(u)
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const handBefore = s.players[1].zones.hand.length
    s = reduce(s, { type: 'OVERRIDE', player: 1, op: 'draw' }).state
    expect(s.players[1].zones.hand.length).toBe(handBefore + 1)
    s = reduce(s, { type: 'OVERRIDE', player: 1, op: 'banish', iid: u.iid }).state
    expect(s.battlefields[0].units.length).toBe(0)
    expect(s.players[1].banished.some((x) => x.iid === u.iid)).toBe(true)
  })

  it('move relocates a card between any zones / battlefields', () => {
    let s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(u)
    // hand → battlefield 1 (enters ready, faceup).
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'move', iid: u.iid, toBattlefield: 1 }).state
    expect(s.battlefields[1].units.some((x) => x.iid === u.iid)).toBe(true)
    expect(s.players[0].zones.hand.length).toBe(0)
    // battlefield → top of deck.
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'move', iid: u.iid, toZone: 'mainDeck' }).state
    expect(s.battlefields[1].units.length).toBe(0)
    expect(s.players[0].zones.mainDeck[0].iid).toBe(u.iid) // on top
    // deck → hand.
    s = reduce(s, { type: 'OVERRIDE', player: 0, op: 'move', iid: u.iid, toZone: 'hand' }).state
    expect(s.players[0].zones.hand.some((x) => x.iid === u.iid)).toBe(true)
    expect(s.players[0].zones.mainDeck.length).toBe(0)
  })
})

describe('Legend own activated abilities (Energy + Exhaust)', () => {
  it('Lee Sin - Blind Monk: 1,exhaust → Buff a chosen friendly unit', () => {
    const s = baseState()
    s.players[0].legend = mk('ogn-257-298', 0) // "1, exhaust: Buff a friendly unit"
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // pays the 1 Energy
    const ally = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(ally)
    // The legend's own ability is offerable (not exhausted, affordable).
    const ab = canActivateUnit(s, 0, s.players[0].legend.iid)
    expect(ab).toBeTruthy()
    expect(ab!.effect.buff).toBeGreaterThan(0)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid, targets: [ally.iid] })
    expect(r.error).toBeFalsy()
    const buffed = r.state.battlefields[0].units.find((u) => u.iid === ally.iid)!
    expect(buffed.buffs).toBe(1)
    expect(r.state.players[0].legend!.exhausted).toBe(true)
    expect(r.state.players[0].zones.runePool.filter((x) => x.exhausted).length).toBe(1)
  })

  it('Yasuo - Unforgiven: 2,exhaust → move a friendly battlefield unit to its base', () => {
    const s = baseState()
    s.players[0].legend = mk('ogn-259-298', 0) // "2, exhaust: Move a friendly unit to or from its base"
    for (let i = 0; i < 2; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const ally = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(ally)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid, targets: [ally.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.length).toBe(0)
    expect(r.state.players[0].zones.base.some((u) => u.iid === ally.iid)).toBe(true)
    expect(r.state.players[0].legend!.exhausted).toBe(true)
  })

  it('The Syren (gear): 1,exhaust → move a friendly unit at a battlefield to its base', () => {
    const s = baseState()
    const syren = mk('ogn-184-298', 0)
    s.players[0].zones.base.push(syren)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const ally = mk(furyUnit.id, 0)
    s.battlefields[1].units.push(ally)
    const ab = canActivateUnit(s, 0, syren.iid)
    expect(ab).toBeTruthy()
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: syren.iid, targets: [ally.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[1].units.length).toBe(0)
    expect(r.state.players[0].zones.base.some((u) => u.iid === ally.iid)).toBe(true)
    expect(r.state.players[0].zones.base.find((u) => u.iid === syren.iid)!.exhausted).toBe(true)
  })

  it('Teemo - Swift Scout: 1,exhaust → return a unit to hand from the board', () => {
    const s = baseState()
    s.players[0].legend = mk('ogn-263-298', 0) // "1, exhaust: Put a Teemo unit you own into your hand…"
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const u = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid, targets: [u.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.length).toBe(0)
    expect(r.state.players[0].zones.hand.some((c) => c.iid === u.iid)).toBe(true)
    expect(r.state.players[0].legend!.exhausted).toBe(true)
  })

  it('Pyke - Bloodharbor Ripper: 1,exhaust → return a unit to hand + play a Gold token', () => {
    const s = baseState()
    s.players[0].legend = mk('unl-185-219', 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const u = mk(furyUnit.id, 0)
    s.battlefields[1].units.push(u)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid, targets: [u.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[1].units.length).toBe(0)
    expect(r.state.players[0].zones.hand.some((c) => c.iid === u.iid)).toBe(true)
    // A Gold gear token (exhausted) was added to base.
    expect(r.state.players[0].zones.base.some((c) => c.cardId === GOLD_TOKEN_ID && c.exhausted)).toBe(true)
  })

  it('Azir - Emperor of the Sands: Sand Soldier only after playing an Equipment this turn', () => {
    const s = baseState()
    s.players[0].legend = mk('sfd-197-221', 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    // Gate unmet → not activatable.
    expect(canActivateUnit(s, 0, s.players[0].legend.iid)).toBeNull()
    // After playing an Equipment this turn → activatable.
    s.players[0].playedEquipmentThisTurn = true
    const ab = canActivateUnit(s, 0, s.players[0].legend.iid)
    expect(ab).toBeTruthy()
    const baseBefore = s.players[0].zones.base.length
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.length).toBe(baseBefore + 1)
    const tok = r.state.players[0].zones.base[r.state.players[0].zones.base.length - 1]
    expect(tok.cardId).toBe(TOKEN_BY_NAME['sand soldier'])
    expect(r.state.players[0].legend!.exhausted).toBe(true)
  })

  it('Jax - Grandmaster At Arms: 1,exhaust → attach a detached Equipment to a unit (2-step)', () => {
    const s = baseState()
    s.players[0].legend = mk('sfd-193-221', 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    const equip = mk('opp-009-221', 0) // Serrated Dirk [Equip]
    s.players[0].zones.base.push(equip)
    const unit = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(unit)
    // Activate → prompts which Equipment.
    let r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.pendingChoice?.kind).toBe('forgePickEquip')
    expect(r.state.players[0].legend!.exhausted).toBe(true)
    // Pick the Equipment → prompts which unit.
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: equip.iid })
    expect(r.state.pendingChoice?.kind).toBe('forgePickTarget')
    // Pick the unit → it's now attached.
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: unit.iid })
    expect(r.error).toBeFalsy()
    const u = r.state.battlefields[0].units.find((x) => x.iid === unit.iid)!
    expect(u.attached.some((a) => a.startsWith(equip.cardId))).toBe(true)
    expect(r.state.players[0].zones.base.some((c) => c.iid === equip.iid)).toBe(false) // left base
  })

  it("Scryer's Bloom (gear): Kill this, 1, exhaust → Predict, Draw 1, Gain 1 XP", () => {
    const s = baseState()
    const bloom = mk('unl-136-219', 0, { exhausted: false }) // enters exhausted; readied here
    s.players[0].zones.base.push(bloom)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    for (let i = 0; i < 2; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const ab = canActivateUnit(s, 0, bloom.iid)
    expect(ab).toBeTruthy()
    expect(ab!.killThis).toBe(true)
    const handBefore = s.players[0].zones.hand.length
    const xpBefore = s.players[0].xp
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: bloom.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(handBefore + 1) // drew 1
    expect(r.state.players[0].xp).toBe(xpBefore + 1) // gained 1 XP
    expect(r.state.vision?.player).toBe(0) // Predict — top card peek pending
    // "Kill this": the gear is gone from base (sacrificed).
    expect(r.state.players[0].zones.base.some((c) => c.iid === bloom.iid)).toBe(false)
  })

  it('Garbage Grabber (gear): Recycle 3, 1, exhaust → Draw 1', () => {
    const s = baseState()
    const grab = mk('ogn-099-298', 0)
    s.players[0].zones.base.push(grab)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    for (let i = 0; i < 3; i++) s.players[0].zones.trash.push(mk(furyUnit.id, 0))
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)) // a card to draw
    const ab = canActivateUnit(s, 0, grab.iid)
    expect(ab).toBeTruthy()
    expect(ab!.recycleTrash).toBe(3)
    const handBefore = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: grab.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(handBefore + 1) // drew 1
    expect(r.state.players[0].zones.trash.length).toBe(0) // recycled 3
    expect(r.state.players[0].zones.base.find((u) => u.iid === grab.iid)!.exhausted).toBe(true)
  })
})

describe('Lillia - Bashful Bloom legend cost reduction', () => {
  const LILLIA = 'unl-189-219' // ":rb_energy_4:, exhaust: play a ready 3 Sprite (Temporary); costs 1 less per friendly Temporary unit"
  const readyRunes = (s: ReturnType<typeof baseState>, n: number) => {
    for (let i = 0; i < n; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0))
  }
  const exhaustedRunes = (st: ReturnType<typeof baseState>) =>
    st.players[0].zones.runePool.filter((x) => x.exhausted).length

  it('costs the full 4 energy with no friendly Temporary units', () => {
    const s = baseState()
    s.players[0].legend = mk(LILLIA, 0)
    readyRunes(s, 3) // only 3 — can't afford 4
    expect(reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 }).error).toBeTruthy()
    readyRunes(s, 1) // now 4
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeFalsy()
    expect(exhaustedRunes(r.state)).toBe(4)
  })

  it('is reduced by 1 energy per friendly Temporary unit', () => {
    const s = baseState()
    s.players[0].legend = mk(LILLIA, 0)
    s.battlefields[0].units.push(mk(furyUnit.id, 0, { temporary: true }))
    s.players[0].zones.base.push(mk(furyUnit.id, 0, { temporary: true }))
    readyRunes(s, 2) // two Temporary units → cost 2
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeFalsy()
    expect(exhaustedRunes(r.state)).toBe(2)
  })

  it('is completely free with four or more friendly Temporary units', () => {
    const s = baseState()
    s.players[0].legend = mk(LILLIA, 0)
    for (let i = 0; i < 4; i++) s.players[0].zones.base.push(mk(furyUnit.id, 0, { temporary: true }))
    const baseBefore = s.players[0].zones.base.length
    // No runes at all — still resolves (free) and makes a ready Sprite.
    const r = reduce(s, { type: 'ACTIVATE_LEGEND', player: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.length).toBe(baseBefore + 1)
    const sprite = r.state.players[0].zones.base[r.state.players[0].zones.base.length - 1]
    expect(sprite.exhausted).toBe(false)
  })
})
