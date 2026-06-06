import { describe, it, expect } from 'vitest'
import { reduce, beginTurn, canPlay, repeatCostFor, grantedAbilityFor, getLegalTargets, unitActivatedAbility, canActivateUnit, combatMightAt } from './engine'
import { autoPayForCard, effectiveCostOf } from './autopay'
import { parseTriggers } from './triggers'
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

  it('emits a payment event with the right exhaust/recycle counts when a unit is played', () => {
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
    const payment = {
      exhaust: runes.slice(0, energy).map((r) => r.iid),
      recycle: runes.slice(energy, energy + power).map((r) => r.iid),
    }
    const { error, events } = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: unit.iid, payment })
    expect(error).toBeUndefined()
    const pay = events?.find((e) => e.kind === 'payment')
    expect(pay).toBeDefined()
    expect(pay!.player).toBe(0)
    expect(pay!.cardId).toBe(unitCard.id)
    expect(pay!.exhaust).toBe(energy)
    expect(pay!.recycle).toBe(power)
    // And the matching 'play' event is still emitted alongside it.
    expect(events?.some((e) => e.kind === 'play' && e.cardId === unitCard.id)).toBe(true)
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

  it('rolls for turn order; the winner chooses first; then concurrent select', () => {
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
    // Now in the single CONCURRENT 'select' step (still phase 'setup'), with
    // every player's opening hand already drawn for the mulligan.
    expect(s.phase).toBe('setup')
    expect(s.setup?.step).toBe('select')
    expect(s.setup?.ready).toEqual([false, false])
    expect(s.players[0].zones.hand.length).toBe(4)
    expect(s.players[1].zones.hand.length).toBe(4)
  })

  it('concurrent pre-game: first SUBMIT_PREGAME waits, second starts the game', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B')], { interactiveSetup: true })
    s = reduce(s, { type: 'ROLL_TURN_ORDER', player: 0, rolls: [9, 3] }).state // A wins
    s = reduce(s, { type: 'CHOOSE_FIRST', player: 0, firstPlayer: 0 }).state
    expect(s.setup?.step).toBe('select')
    // Player 0 sets aside 2 cards and readies up — the match must NOT start yet.
    const p0Hand = s.players[0].zones.hand.map((c) => c.iid)
    let r = reduce(s, {
      type: 'SUBMIT_PREGAME',
      player: 0,
      championId: null,
      battlefieldId: null,
      toBottom: [p0Hand[0], p0Hand[1]],
    })
    expect(r.error).toBeUndefined()
    s = r.state
    expect(s.phase).toBe('setup') // still waiting
    expect(s.setup?.ready).toEqual([true, false])
    expect(s.players[0].mulliganed).toBe(true)
    expect(s.players[0].zones.hand.length).toBe(4) // mulligan redrew the 2
    // The 2 set-aside cards are now at the bottom of the main deck.
    expect(s.players[0].zones.mainDeck.slice(-2).map((c) => c.iid)).toEqual([p0Hand[0], p0Hand[1]])
    // Re-submitting is rejected.
    expect(reduce(s, { type: 'SUBMIT_PREGAME', player: 0, championId: null, battlefieldId: null, toBottom: [] }).error).toBeTruthy()
    // Player 1 readies → barrier met → the game starts (beginTurn ran).
    r = reduce(s, { type: 'SUBMIT_PREGAME', player: 1, championId: null, battlefieldId: null, toBottom: [] })
    expect(r.error).toBeUndefined()
    s = r.state
    expect(s.phase).toBe('action') // beginTurn ran
    expect(s.setup).toBeUndefined()
    expect(s.activePlayer).toBe(0)
    expect(s.players[1].mulliganed).toBe(true)
    // Battlefields were built from each player's pick (defaults auto-filled).
    expect(s.battlefields.length).toBe(2)
    expect(s.battlefields.every((b) => b.cardId === battlefield.id)).toBe(true)
  })

  it('SUBMIT_PREGAME validates champion + battlefield picks against options', () => {
    let s = createMatch([miniDeck('A'), miniDeck('B')], { interactiveSetup: true })
    s = reduce(s, { type: 'ROLL_TURN_ORDER', player: 0, rolls: [9, 3] }).state
    s = reduce(s, { type: 'CHOOSE_FIRST', player: 0, firstPlayer: 0 }).state
    // A battlefield not in this player's options is rejected.
    const bad = reduce(s, {
      type: 'SUBMIT_PREGAME',
      player: 0,
      championId: null,
      battlefieldId: 'not-a-real-battlefield',
      toBottom: [],
    })
    expect(bad.error).toBeTruthy()
    // Too many mulligan cards is rejected.
    const tooMany = reduce(s, {
      type: 'SUBMIT_PREGAME',
      player: 0,
      championId: null,
      battlefieldId: null,
      toBottom: s.players[0].zones.hand.slice(0, 3).map((c) => c.iid),
    })
    expect(tooMany.error).toBeTruthy()
  })

  it('setup pulls the Chosen Champion to the Champion Zone via SUBMIT_PREGAME', () => {
    const champ = CARDS.find((c) => c.type === 'unit' && c.supertype === 'champion')
    if (!champ) return
    const champDeck = (name: string): Deck => ({
      id: name,
      name,
      legendId: null,
      championId: champ.id,
      main: { [champ.id]: 2, [furyUnit.id]: 10 },
      runes: { [furyRune.id]: 12 },
      battlefields: [battlefield.id],
      sideboard: {},
      updatedAt: 0,
    })
    let s = createMatch([champDeck('A'), miniDeck('B')], { interactiveSetup: true })
    s = reduce(s, { type: 'ROLL_TURN_ORDER', player: 0, rolls: [9, 3] }).state
    s = reduce(s, { type: 'CHOOSE_FIRST', player: 0, firstPlayer: 0 }).state
    const champOpt = s.setup?.championOptions[0]?.[0]
    expect(champOpt).toBeTruthy()
    s = reduce(s, { type: 'SUBMIT_PREGAME', player: 0, championId: champOpt ?? null, battlefieldId: null, toBottom: [] }).state
    s = reduce(s, { type: 'SUBMIT_PREGAME', player: 1, championId: null, battlefieldId: null, toBottom: [] }).state
    expect(s.phase).toBe('action')
    expect(s.players[0].champion?.cardId).toBe(champOpt)
    // The champion is set aside, not left in the deck/hand.
    const stillSomewhere = s.players[0].zones.mainDeck
      .concat(s.players[0].zones.hand)
      .filter((c) => c.cardId === champ.id).length
    expect(stillSomewhere).toBe(1) // the second copy stays; the chosen one is set aside
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

  it('auto-parses "return a card from your trash to your hand"', async () => {
    const { onPlayEffect, spellEffect } = await import('./effects')
    const mkCard = (text: string, type = 'unit') =>
      ({ id: 't', name: 'T', type, domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 1 }) as never
    expect(onPlayEffect(mkCard('When you play me, return a unit from your trash to your hand.')).returnFromTrash).toEqual({ type: 'unit', count: 1 })
    expect(spellEffect(mkCard('Return a spell from your trash to your hand.', 'spell')).returnFromTrash).toEqual({ type: 'spell', count: 1 })
    expect(spellEffect(mkCard('Return up to two cards with [Hidden] from your trash to your hand.', 'spell')).returnFromTrash).toEqual({ type: 'card', count: 2 })
    expect(spellEffect(mkCard('Return a unit or gear from your trash to your hand.', 'spell')).returnFromTrash).toEqual({ type: 'card', count: 1 })
  })

  it('returnFromTrash: a played unit returns a trash unit to hand', () => {
    const uid = injectCard('rft-attendant', 'When you play me, return a unit from your trash to your hand.', { type: 'unit', might: 1, energy: 0, power: {} })
    const s = baseState()
    const u = mk(uid, 0)
    s.players[0].zones.hand.push(u)
    const a = mk(furyUnit.id, 0)
    const b = mk(furyUnit.id, 0)
    s.players[0].zones.trash.push(a, b) // two units in trash
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    // One unit pulled back from trash → hand.
    expect(r.state.players[0].zones.trash.filter((x) => CARD_INDEX[x.cardId]?.type === 'unit').length).toBe(1)
    expect(r.state.players[0].zones.hand.some((x) => x.iid === a.iid || x.iid === b.iid)).toBe(true)
  })

  it('auto-parses "play a unit from your trash, ignoring its cost" (+ cost cap)', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    // "ignoring its ENERGY cost" still owes Power (energyOnly: true).
    expect(spellEffect(mkCard('Play a unit from your trash, ignoring its Energy cost.')).playUnitFromTrash).toEqual({ maxEnergy: null, maxPower: null, energyOnly: true })
    // "ignoring its cost" (no qualifier) waives everything.
    expect(spellEffect(mkCard('Play a unit costing no more than :rb_energy_3: and no more than :rb_rune_rainbow: from your trash, ignoring its cost.')).playUnitFromTrash).toEqual({ maxEnergy: 3, maxPower: 1, energyOnly: false })
  })

  it('playUnitFromTrash: a played unit brings a qualifying trash unit into base', () => {
    const uid = injectCard('put-soulgorger', 'When you play me, play a unit from your trash, ignoring its Energy cost.', { type: 'unit', might: 1, energy: 0, power: {} })
    const s = baseState()
    const u = mk(uid, 0)
    s.players[0].zones.hand.push(u)
    const dead = mk(furyUnit.id, 0)
    s.players[0].zones.trash.push(dead)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    // The trash unit is now in base (exhausted), no longer in trash.
    expect(r.state.players[0].zones.trash.some((x) => x.iid === dead.iid)).toBe(false)
    expect(r.state.players[0].zones.base.some((x) => x.iid === dead.iid && x.exhausted)).toBe(true)
  })

  it('on-play "give me +N Might this turn" applies via applyParsed (Teemo - Scout)', () => {
    const uid = injectCard('tms-onplay', 'When you play me, give me +3 :rb_might: this turn.', { type: 'unit', might: 2, energy: 0, power: {} })
    const s = baseState()
    const u = mk(uid, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.tempMight).toBe(3)
  })

  it('playUnitFromTrash "ignoring its Energy cost" still pays the Power cost (The Harrowing)', () => {
    const sid = injectCard('harrowing-test', 'Play a unit from your trash, ignoring its Energy cost.', { type: 'spell', energy: 0, power: {} })
    const trashUnit = injectCard('powered-trash-unit', 'A unit.', { type: 'unit', might: 3, energy: 5, power: { fury: 1 } })
    // A ready Power rune available → unit enters play, the rune is spent.
    let s = baseState()
    const dead = mk(trashUnit, 0)
    s.players[0].zones.trash.push(dead)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    let sp = mk(sid, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.base.some((x) => x.iid === dead.iid)).toBe(true)
    expect(r.state.players[0].zones.runePool.length).toBe(0) // Power rune spent
    // No Power available → the unit is NOT played for free (stays in trash).
    s = baseState()
    const dead2 = mk(trashUnit, 0)
    s.players[0].zones.trash.push(dead2)
    sp = mk(sid, 0)
    s.players[0].zones.hand.push(sp)
    r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.base.some((x) => x.iid === dead2.iid)).toBe(false)
    expect(r.state.players[0].zones.trash.some((x) => x.iid === dead2.iid)).toBe(true)
  })

  it('parse: playSpellFromTrash (Fizz fixed cap, Kai\'Sa dynamic "points") (Gap 5)', async () => {
    const { onPlayEffect, parseEffectText } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 'x', name: 'x', type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3 }) as never
    expect(onPlayEffect(mkCard('When you play me, you may play a spell from your trash with Energy cost no more than :rb_energy_3:, ignoring its Energy cost. Recycle that spell after you play it.')).playSpellFromTrash)
      .toEqual({ maxEnergy: 3, dynamicCap: null, energyOnly: true, recycleAfter: true })
    // Kai'Sa is a conquer-trigger clause (parsed by parseEffectText, not on-play).
    expect(parseEffectText('play a spell from your trash with Energy cost less than your points without paying its Energy cost').playSpellFromTrash)
      .toEqual({ maxEnergy: null, dynamicCap: 'points', energyOnly: true, recycleAfter: true })
  })

  it('Fizz - Trickster: on play, replays a spell from trash then recycles it (Gap 5)', () => {
    const drawSpell = injectCard('fizz-draw-t', 'Draw 2.', { type: 'spell', energy: 2, power: {} })
    const fizz = injectCard('fizz-t', 'When you play me, you may play a spell from your trash with Energy cost no more than :rb_energy_3:, ignoring its Energy cost. Recycle that spell after you play it.', { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0)] // 2 to draw
    s.players[0].zones.trash = [mk(drawSpell, 0)]
    const f = mk(fizz, 0)
    s.players[0].zones.hand.push(f)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: f.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(2) // replayed Draw 2 → drew 2
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === drawSpell)).toBe(false) // recycled out of trash
    expect(r.state.players[0].zones.mainDeck.some((c) => c.cardId === drawSpell)).toBe(true) // recycled to deck
  })

  it("Kai'Sa - Evolutionary: on conquer, replays a trash spell costing < your points (Gap 5)", () => {
    const drawSpell = injectCard('kaisa-draw-t', 'Draw 1.', { type: 'spell', energy: 2, power: {} })
    const kaisa = injectCard('kaisa-t', 'When I conquer, you may play a spell from your trash with Energy cost less than your points without paying its Energy cost. Then recycle it.', { type: 'unit', energy: 0, power: {}, might: 6 })
    const s = baseState()
    s.players[0].points = 5
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.trash = [mk(drawSpell, 0)]
    const k = mk(kaisa, 0)
    s.players[0].zones.base.push(k)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: k.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(1) // replayed Draw 1
    expect(r.state.players[0].zones.mainDeck.some((c) => c.cardId === drawSpell)).toBe(true) // recycled
  })

  it('Hallowed Tomb: on hold, returns your Chosen Champion from trash to Champion Zone (Gap 5)', () => {
    const champ = CARDS.find((c) => c.supertype === 'champion')!
    const s = baseState()
    s.activePlayer = 0
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    s.players[0].champion = null // Champion Zone empty
    s.players[0].zones.trash = [mk(champ.id, 0)]
    s.battlefields[0] = { cardId: 'ogn-281-298', units: [mk(furyUnit.id, 0)], controller: 0 } // holding Hallowed Tomb
    const after = beginTurn(s)
    expect(after.players[0].champion?.cardId).toBe(champ.id)
    expect(after.players[0].zones.trash.some((c) => c.cardId === champ.id)).toBe(false)
  })

  it("Viktor - Innovator: play-trigger does NOT fire on your own turn (Gap 11)", () => {
    const viktor = injectCard('viktor-innov-t', "When you play a card on an opponent's turn, play a 1 :rb_might: Recruit unit token in your base.", { type: 'unit', energy: 0, power: {}, might: 3 })
    const vanilla = injectCard('viktor-vanilla', 'A unit.', { type: 'unit', energy: 0, power: {}, might: 2 })
    const s = baseState() // activePlayer 0 — it's player 0's own turn
    s.players[0].zones.base.push(mk(viktor, 0))
    const u = mk(vanilla, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    // Own turn → no Recruit token created.
    expect(r.state.players[0].zones.base.some((x) => x.cardId === TOKEN_PILE_IDS[0])).toBe(false)
  })

  it('Walking Roost: on play, the OPPONENT gets a Bird token in their base (Gap 11)', () => {
    const roost = injectCard('walking-roost-t', 'When you play me, choose an opponent. They play a 1 :rb_might: Bird unit token with [Deflect].', { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    const u = mk(roost, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[1].zones.base.some((x) => x.cardId === TOKEN_BY_NAME['bird'])).toBe(true) // opponent got it
    expect(r.state.players[0].zones.base.some((x) => x.cardId === TOKEN_BY_NAME['bird'])).toBe(false) // not me
  })

  it("Noxus Saboteur: an opponent can't reveal a Hidden card where you control it (Gap 11)", () => {
    const sab = injectCard('noxus-sab-t', "Your opponents' [Hidden] cards can't be revealed here.", { type: 'unit', might: 3 })
    const hid = injectCard('sab-hidden', '[Hidden]', { type: 'spell', energy: 1, power: {} })
    const s = baseState()
    s.turn = 6
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(sab, 0)], controller: 0 }
    s.battlefields[0].facedown = mk(hid, 1, { facedown: true, hiddenTurn: 4 })
    // Player 1 tries to reveal at bf0 where player 0 controls a Saboteur → blocked.
    const r = reduce(s, { type: 'REVEAL', player: 1, iid: s.battlefields[0].facedown!.iid })
    expect(r.error).toBeTruthy()
  })

  it('Scuttle Crab: on-play draws (no XP); Deathknell gains 1 XP (no draw) (Gap 11)', () => {
    const crab = injectCard('scuttle-crab-t', 'When you play me, draw 1.[Deathknell][&gt;] Choose an opponent. They reveal their hand. Gain 1 XP.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const u = mk(crab, 0)
    s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(1) // drew 1 on play
    expect(r.state.players[0].xp).toBe(0) // XP is Deathknell-only, not on-play
    // Now kill it → Deathknell gains 1 XP (and does not draw again).
    const inPlay = r.state.players[0].zones.base.find((x) => x.cardId === crab)!
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'kill', iid: inPlay.iid })
    expect(r.state.players[0].xp).toBe(1) // Deathknell XP
    expect(r.state.players[0].zones.hand.length).toBe(1) // no extra draw
  })

  it('Jax - Unrelenting: draw 1 (pay 1 Energy) when an Equipment is attached (Gap 9)', () => {
    const jax = injectCard('jax-unrel-t', 'When you attach an Equipment to me, you may pay :rb_energy_1: to draw 1.', { type: 'unit', might: 5 })
    // [Quick-Draw] so the gear attaches on play (the proper attach-on-play path);
    // a normal gear would now land on base and need a separate ATTACH.
    const gear = injectCard('jax-gear-t', '[Quick-Draw] +1 Might', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const j = mk(jax, 0)
    s.players[0].zones.base.push(j)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // 1 ready rune for the draw cost
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)) // a card to draw
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, targetIid: j.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(1) // gear left hand, drew 1
    expect(r.state.players[0].zones.runePool.every((x) => x.exhausted)).toBe(true) // paid 1 Energy
  })

  it('Prize of Progress: +1 Might this turn when you use a gear ability (Gap 9)', () => {
    const prize = injectCard('prize-prog-t', 'When you use an activated ability of a gear, give me +1 :rb_might: this turn.', { type: 'unit', might: 3 })
    const gear = injectCard('prize-gear-t', ':rb_exhaust:: Draw 1.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const pz = mk(prize, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [pz], controller: 0 }
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const g = mk(gear, 0)
    s.players[0].zones.base.push(g)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.find((x) => x.iid === pz.iid)?.tempMight).toBe(1)
  })

  it('Heimerdinger - Inventor: borrows a friendly [Exhaust] ability; exhausts Heimerdinger, not the source', () => {
    const heimer = injectCard('heimer-inventor-t', 'I have all :rb_exhaust: abilities of all friendly legends, units, and gear.', { type: 'unit', name: 'Heimerdinger - Inventor', might: 3 })
    const gear = injectCard('heimer-gear-t', ':rb_exhaust:: Draw 1.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const hz = mk(heimer, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [hz], controller: 0 }
    const g = mk(gear, 0)
    s.players[0].zones.base.push(g)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const handBefore = s.players[0].zones.hand.length
    // Heimerdinger is offered as activatable (synthetic borrow ability).
    expect(canActivateUnit(s, 0, hz.iid)?.label).toBe('Borrow an ability')
    // Activating Heimerdinger opens a borrow choice listing the gear's ability.
    const r1 = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: hz.iid })
    expect(r1.error).toBeUndefined()
    expect(r1.state.pendingChoice?.kind).toBe('heimerBorrow')
    expect(r1.state.pendingChoice?.options.some((o) => o.iid === g.iid)).toBe(true)
    expect(r1.state.battlefields[0].units.find((x) => x.iid === hz.iid)?.exhausted).toBeFalsy() // not yet paid
    // Resolve the choice (borrow the gear's "Draw 1").
    const r2 = reduce(r1.state, { type: 'RESOLVE_CHOICE', player: 0, iid: g.iid })
    expect(r2.error).toBeUndefined()
    expect(r2.state.players[0].zones.hand.length).toBe(handBefore + 1) // drew 1
    expect(r2.state.battlefields[0].units.find((x) => x.iid === hz.iid)?.exhausted).toBe(true) // Heimerdinger exhausted
    expect(r2.state.players[0].zones.base.find((x) => x.iid === g.iid)?.exhausted).toBeFalsy() // source gear NOT exhausted
  })

  it('Heimerdinger - Inventor: not activatable with no borrowable [Exhaust] ability', () => {
    const heimer = injectCard('heimer-inventor-t2', 'I have all :rb_exhaust: abilities of all friendly legends, units, and gear.', { type: 'unit', name: 'Heimerdinger - Inventor', might: 3 })
    const s = baseState()
    const hz = mk(heimer, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [hz], controller: 0 }
    expect(canActivateUnit(s, 0, hz.iid)).toBeNull()
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: hz.iid })
    expect(r.error).toBeTruthy()
  })

  it('Stalking Wolf: required kill of a tribe unit; enters at its battlefield (Gap 4)', () => {
    const wolf = injectCard('stalking-wolf-t', "[Ambush] As an additional cost to play me, kill a Bird, Cat, Dog, or Poro you control. You may play me to its battlefield (even if you don't have other units there).", { type: 'unit', energy: 0, power: {}, might: 6 })
    const poro = injectCard('sw-poro', 'A unit.', { might: 1, tags: ['Poro'] })
    const s = baseState()
    const por = mk(poro, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [por], controller: 0 }
    const w = mk(wolf, 0)
    s.players[0].zones.hand.push(w)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: w.iid, toBattlefield: 0, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.some((x) => x.iid === por.iid)).toBe(false) // Poro killed as cost
    expect(r.state.battlefields[0].units.some((x) => x.iid === w.iid)).toBe(true) // Wolf entered here
  })

  it('Stalking Wolf: cannot be played without a tribe unit to kill (Gap 4)', () => {
    const wolf = injectCard('stalking-wolf-t2', '[Ambush] As an additional cost to play me, kill a Bird, Cat, Dog, or Poro you control.', { type: 'unit', energy: 0, power: {}, might: 6 })
    const s = baseState()
    const w = mk(wolf, 0)
    s.players[0].zones.hand.push(w)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: w.iid, toBattlefield: 0, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeTruthy() // no Poro/Bird/Cat/Dog to pay the cost
  })

  it('Cruel Patron: required kill of a friendly unit on play (Gap 4)', () => {
    const patron = injectCard('cruel-patron-t', 'As an additional cost to play me, kill a friendly unit.', { type: 'unit', energy: 0, power: {}, might: 4 })
    const ally = injectCard('cp-ally', 'A unit.', { might: 1 })
    const s = baseState()
    const a = mk(ally, 0)
    s.players[0].zones.base.push(a)
    const c = mk(patron, 0)
    s.players[0].zones.hand.push(c)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: c.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => x.iid === a.iid)).toBe(false) // ally killed
    expect(r.state.players[0].zones.base.some((x) => x.iid === c.iid)).toBe(true) // Patron in play
  })

  it('Rift Herald / LeBlanc: Deathknell parses only the post-[Deathknell] clause (Gap 13)', async () => {
    const { parseTriggers } = await import('./triggers')
    const rh = { id: 'rh-test', name: 'Rift Herald', type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, might: 4, energy: 0, power: {}, text: 'When I move to a battlefield, look at the top 3 cards of your Main Deck. You may reveal a unit from among them and draw it. Recycle the rest.[Deathknell][&gt;] Play a unit from your hand to your base, ignoring its Energy cost.' } as never
    const death = parseTriggers(rh).find((a: { event: string }) => a.event === 'death') as { text: string } | undefined
    expect(death).toBeTruthy()
    expect(/look at the top/i.test(death!.text)).toBe(false) // move-trigger text no longer leaks into Deathknell
  })

  it('Dazzling Aurora: at end of turn, reveal-until-unit → play it free, recycle the rest', () => {
    const aurora = injectCard('aurora-gear', 'At the end of your turn, reveal cards from the top of your Main Deck until you reveal a unit and banish it. Play it, ignoring its cost, and recycle the rest.', { type: 'gear' })
    const spellId = injectCard('aurora-spell', 'Deal 1.', { type: 'spell', energy: 1, power: {} })
    const s = baseState()
    s.players[0].zones.base.push(mk(aurora, 0)) // Aurora in base
    // Deck: a non-unit on top, then a unit.
    s.players[0].zones.mainDeck = [mk(spellId, 0), mk(furyUnit.id, 0), mk(spellId, 0)]
    const unitInDeck = s.players[0].zones.mainDeck[1]
    const r = reduce(s, { type: 'END_TURN', player: 0 })
    expect(r.error).toBeFalsy()
    // The unit was pulled into base (free, exhausted); the passed spell recycled.
    expect(r.state.players[0].zones.base.some((x) => x.iid === unitInDeck.iid && x.exhausted)).toBe(true)
    expect(r.state.players[0].zones.mainDeck.some((x) => x.iid === unitInDeck.iid)).toBe(false)
  })

  it('Glasc Mixologist (real card): Deathknell plays a qualifying unit from trash, skips over-cost ones', () => {
    const small = injectCard('glasc-small-t', 'A small unit.', { type: 'unit', energy: 2, power: { order: 1 }, might: 2 })
    const big = injectCard('glasc-big-t', 'Too expensive.', { type: 'unit', energy: 9, power: {}, might: 9 })
    const s = baseState()
    s.sandbox = true
    const glasc = mk('sfd-165-221', 0)
    s.players[0].zones.base.push(glasc)
    s.players[0].zones.trash.push(mk(big, 0), mk(small, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: glasc.iid })
    expect(r.error).toBeFalsy()
    // The ≤3 Energy / ≤1 rune unit came into base for free; the 9-cost one stayed in trash.
    expect(r.state.players[0].zones.base.some((x) => x.cardId === small)).toBe(true)
    expect(r.state.players[0].zones.trash.some((x) => x.cardId === big)).toBe(true)
  })

  it('Rift Herald (real card): Deathknell plays a unit from hand, ignoring its Energy cost', () => {
    const handUnit = injectCard('rh-hand-t', 'A unit to drop.', { type: 'unit', energy: 7, power: {}, might: 5 })
    const s = baseState()
    s.sandbox = true
    const rh = mk('unl-179-219', 0)
    s.players[0].zones.base.push(rh)
    s.players[0].zones.hand.push(mk(handUnit, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: rh.iid })
    expect(r.error).toBeFalsy()
    // 7-Energy unit dropped into base for free (no Power cost); gone from hand.
    expect(r.state.players[0].zones.base.some((x) => x.cardId === handUnit)).toBe(true)
    expect(r.state.players[0].zones.hand.some((x) => x.cardId === handUnit)).toBe(false)
  })

  it('parse: play-from-hand (Rift Herald) and full-cost play-from-trash (Last Rites)', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('Play a unit from your hand to your base, ignoring its Energy cost.').playUnitFromHand)
      .toEqual({ energyOnly: true })
    expect(parseEffectText('Play a unit from your hand, ignoring its cost.').playUnitFromHand)
      .toEqual({ energyOnly: false })
    expect(parseEffectText('When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)').playUnitFromTrash)
      .toEqual({ maxEnergy: null, maxPower: null, energyOnly: false, fullCost: true })
  })

  it('Last Rites (real card): text patch restores the conquer/hold play-from-trash bonus', () => {
    expect(/play a unit from your trash/i.test(CARD_INDEX['sfd-150-221']?.text ?? '')).toBe(true)
  })

  it('full-cost play-from-trash pays the unit\'s full Energy + Power (Last Rites pattern)', () => {
    const trashUnit = injectCard('fullcost-trash-t', 'A unit.', { type: 'unit', energy: 2, power: { fury: 1 }, might: 4 })
    const src = injectCard('fullcost-src-t', 'When you play me, play a unit from your trash. (You still pay its costs.)', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    s.players[0].pool.energy = 2 // 2 Energy from the pool
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // 1 ready rune for the 1 Power
    s.players[0].zones.trash.push(mk(trashUnit, 0))
    const u = mk(src, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((x) => x.cardId === trashUnit)).toBe(true)
    expect(r.state.players[0].pool.energy).toBe(0) // 2 Energy spent
    expect(r.state.players[0].zones.runePool.length).toBe(0) // 1 Power rune spent
  })

  it('activated peekBanishPlay resolves via ACTIVATE_UNIT (Baited Hook pattern)', () => {
    const gear = injectCard('peek-gear-t', ':rb_exhaust:: Look at the top 5 cards of your Main Deck. You may banish a unit from among them and play it, ignoring its cost. Then recycle the rest.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const g = mk(gear, 0)
    s.players[0].zones.base.push(g)
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: g.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((x) => x.cardId === furyUnit.id)).toBe(true)
  })

  it('Baited Hook (real card): activated effect parses to peekBanishPlay (top 5)', () => {
    const ab = unitActivatedAbility(CARD_INDEX['ogn-242-298'])
    expect(ab?.effect.peekBanishPlay?.n).toBe(5)
  })

  it('Flame Chompers (real card): on discard, prompt to pay Fury → play it from trash', () => {
    const discarder = injectCard('fc-discarder-t', 'When you play me, discard 1.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    const fc = mk('ogn-006-298', 0) // Flame Chompers (e3, no printed Power)
    const d = mk(discarder, 0)
    s.players[0].zones.hand.push(d, fc)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // 1 ready Fury for the alt cost
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: d.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.trash.some((x) => x.iid === fc.iid)).toBe(true) // discarded
    expect(r.state.pendingChoice?.kind).toBe('discardReplay')
    // Accept → pay Fury, play Flame Chompers from trash to base.
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: fc.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((x) => x.iid === fc.iid)).toBe(true)
    expect(r.state.players[0].zones.trash.some((x) => x.iid === fc.iid)).toBe(false)
    expect(r.state.players[0].zones.runePool.filter((x) => !x.exhausted).length).toBe(0) // Fury recycled
  })

  it('Flame Chompers: declining the discard-replay prompt leaves it in the trash', () => {
    const discarder = injectCard('fc-discarder-t2', 'When you play me, discard 1.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    const fc = mk('ogn-006-298', 0)
    s.players[0].zones.hand.push(mk(discarder, 0), fc)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: s.players[0].zones.hand[0].iid, payment: { exhaust: [], recycle: [] } })
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: null })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.trash.some((x) => x.iid === fc.iid)).toBe(true) // still in trash
    expect(r.state.players[0].zones.runePool.filter((x) => !x.exhausted).length).toBe(1) // Fury not spent
  })

  it('Super Mega Death Rocket! (real card): on conquer, discard 1 to return it from trash to hand', () => {
    const s = baseState()
    s.activePlayer = 0
    const rocket = mk('ogn-252-298', 0)
    s.players[0].zones.trash.push(rocket) // sits in the trash
    s.players[0].zones.hand.push(mk(furyUnit.id, 0)) // a card to discard as the cost
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.error).toBeFalsy()
    expect(r.state.pendingChoice?.kind).toBe('trashConquerReturn')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: rocket.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.some((x) => x.iid === rocket.iid)).toBe(true) // returned to hand
    expect(r.state.players[0].zones.trash.some((x) => x.iid === rocket.iid)).toBe(false)
  })

  it('opponent hand-strip (Mindsplitter): reveal + discard the highest-cost card', () => {
    const stripper = injectCard('mindsplit-t', 'When you play me, choose an opponent. They reveal their hand. Choose a card from it, and they discard that card.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const cheap = injectCard('strip-cheap-t', 'x', { type: 'unit', energy: 1, power: {}, might: 1 })
    const pricey = injectCard('strip-pricey-t', 'x', { type: 'unit', energy: 6, power: {}, might: 6 })
    const s = baseState()
    s.players[1].zones.hand.push(mk(cheap, 1), mk(pricey, 1))
    const u = mk(stripper, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[1].zones.trash.some((x) => x.cardId === pricey)).toBe(true) // highest-cost discarded
    expect(r.state.players[1].zones.hand.some((x) => x.cardId === cheap)).toBe(true) // cheap kept
  })

  it('opponent hand-strip (Sabotage): recycle the highest-cost NON-UNIT to deck, keep units', () => {
    const sab = injectCard('sabotage-t', 'When you play me, choose an opponent. They reveal their hand. Choose a non-unit card from it, and recycle that card.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const bigUnit = injectCard('sab-unit-t', 'x', { type: 'unit', energy: 9, power: {}, might: 9 })
    const spell = injectCard('sab-spell-t', 'Draw 1.', { type: 'spell', energy: 4, power: {} })
    const s = baseState()
    s.players[1].zones.hand.push(mk(bigUnit, 1), mk(spell, 1))
    const u = mk(sab, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[1].zones.mainDeck.some((x) => x.cardId === spell)).toBe(true) // non-unit recycled to deck
    expect(r.state.players[1].zones.hand.some((x) => x.cardId === bigUnit)).toBe(true) // unit kept (non-unit filter)
    expect(r.state.players[1].zones.trash.some((x) => x.cardId === spell)).toBe(false) // recycled, not trashed
  })

  it('opponentDiscards (Bewitching Spirit): opponent discards their lowest-cost card', () => {
    const bew = injectCard('bewitch-t', 'When you play me, choose a player. They discard 1.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const cheap = injectCard('bw-cheap-t', 'x', { type: 'unit', energy: 1, power: {}, might: 1 })
    const pricey = injectCard('bw-pricey-t', 'x', { type: 'unit', energy: 7, power: {}, might: 7 })
    const s = baseState()
    s.players[1].zones.hand.push(mk(pricey, 1), mk(cheap, 1))
    const u = mk(bew, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[1].zones.trash.some((x) => x.cardId === cheap)).toBe(true) // lowest-cost discarded
    expect(r.state.players[1].zones.hand.some((x) => x.cardId === pricey)).toBe(true) // pricey kept
  })

  it('opponent-strip: real cards parse correctly (Mindsplitter / Sabotage / Bewitching Spirit)', async () => {
    const { onPlayEffect, spellEffect } = await import('./effects')
    expect(onPlayEffect(CARD_INDEX['ogn-192-298']).opponentHandStrip).toEqual({ to: 'trash', nonUnit: false }) // Mindsplitter
    expect(spellEffect(CARD_INDEX['ogn-156-298']).opponentHandStrip).toEqual({ to: 'deck', nonUnit: true }) // Sabotage
    expect(onPlayEffect(CARD_INDEX['unl-121-219']).opponentDiscards).toBe(1) // Bewitching Spirit
  })

  it("Zhonya's Hourglass: an equipped unit that would die is healed + recalled; the gear dies", () => {
    const s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0, { attached: ['ogn-077-298|zh-1'], damage: 2 })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(false)
    const recalled = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(recalled).toBeTruthy()
    expect(recalled?.damage).toBe(0) // healed
    expect(recalled?.attached.some((a) => a.startsWith('ogn-077-298'))).toBe(false) // gear gone
    expect(r.state.players[0].zones.trash.some((x) => x.cardId === 'ogn-077-298')).toBe(true) // Hourglass trashed
  })

  it('attached gear survives the equipped unit dying — detaches to the owner\'s base (not lost/trashed)', () => {
    const gearId = injectCard('surv-gear-t', 'When the equipped unit attacks, draw 1.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0, { attached: [`${gearId}|surv-1`] })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(false) // unit dead
    // The gear is back in its owner's base, unattached — NOT in the trash, NOT lost.
    const inBase = r.state.players[0].zones.base.find((x) => x.cardId === gearId)
    expect(inBase).toBeTruthy()
    expect(inBase?.attached.length).toBe(0)
    expect(r.state.players[0].zones.trash.some((x) => x.cardId === gearId)).toBe(false)
  })

  it('attached gear survives a banished unit — detaches to base', () => {
    const gearId = injectCard('surv-gear-t2', 'x', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0, { attached: [`${gearId}|surv-2`] })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'banish', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((x) => x.cardId === gearId && x.attached.length === 0)).toBe(true)
    expect(r.state.players[0].banished.some((x) => x.cardId === gearId)).toBe(false) // gear not banished
  })

  it('death shield: a shielded unit recalls to base instead of dying; shield consumed', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) => ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    expect(spellEffect(mkCard('Choose a friendly unit. The next time it would die this turn, heal it, exhaust it, and recall it instead.')).deathShield).toBe(true)
    const s = baseState()
    s.sandbox = true
    const u = mk(furyUnit.id, 0, { deathShield: true })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    const recalled = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(recalled).toBeTruthy()
    expect(recalled?.deathShield).toBeFalsy() // consumed
  })

  it('Soraka - Wanderer: a lesser-Might ally here recalls instead of dying', () => {
    const soraka = injectCard('soraka-test', 'If another unit you control here would die, if it has less Might than me, instead heal it, exhaust it, and recall it.', { might: 7 })
    const allyId = injectCard('soraka-ally', 'A unit.', { might: 3 })
    const s = baseState()
    s.sandbox = true
    const sk = mk(soraka, 0)
    const al = mk(allyId, 0)
    s.battlefields[0].units.push(sk, al)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: al.iid })
    expect(r.error).toBeFalsy()
    // The ally is recalled to base (exhausted), not sent to trash.
    expect(r.state.players[0].zones.base.some((x) => x.iid === al.iid && x.exhausted)).toBe(true)
    expect(r.state.players[0].zones.trash.some((x) => x.iid === al.iid)).toBe(false)
  })

  it('Soraka - Wanderer: an ally with >= her Might still dies normally', () => {
    const soraka = injectCard('soraka-test2', 'If another unit you control here would die, if it has less Might than me, instead heal it, exhaust it, and recall it.', { might: 4 })
    const bigId = injectCard('soraka-big', 'A unit.', { might: 9 })
    const s = baseState()
    s.sandbox = true
    s.battlefields[0].units.push(mk(soraka, 0))
    const big = mk(bigId, 0)
    s.battlefields[0].units.push(big)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: big.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.trash.some((x) => x.iid === big.iid)).toBe(true)
    expect(r.state.players[0].zones.base.some((x) => x.iid === big.iid)).toBe(false)
  })

  it('Sett - The Boss: pays a rune + exhausts to recall a buffed unit, spending its buff', () => {
    const sett = injectCard('sett-test', 'If a buffed unit you control would die, you may pay :rb_rune_rainbow:, exhaust me, and spend its buff to heal it, exhaust it, and recall it instead.', { type: 'legend' })
    const s = baseState()
    s.sandbox = true
    s.players[0].legend = mk(sett, 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // a ready rune to pay
    const u = mk(furyUnit.id, 0, { buffs: 1 })
    s.battlefields[0].units.push(u)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    const recalled = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(recalled).toBeTruthy()
    expect(recalled?.buffs).toBe(0) // buff spent
    expect(r.state.players[0].legend?.exhausted).toBe(true) // Sett exhausted
    expect(r.state.players[0].zones.trash.some((x) => x.iid === u.iid)).toBe(false)
  })

  it("Kog'Maw - Caustic (champion): Deathknell deals 4 to all units at its battlefield, doubled by Karthus", () => {
    const kog = 'ogn-190-298'
    if (!CARD_INDEX[kog]) return // dataset lacks Kog'Maw - Caustic
    const bigId = injectCard('kog-target', 'A unit.', { might: 12 })
    // Without Karthus → 4 damage to the co-located enemy.
    let s = baseState()
    s.sandbox = true
    let kogU = mk(kog, 0)
    let enemy = mk(bigId, 1)
    s.battlefields[0].units.push(kogU, enemy)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: kogU.iid })
    expect(r.state.battlefields[0].units.find((u) => u.iid === enemy.iid)?.damage).toBe(4)
    // With Karthus - Eternal in base → the Deathknell fires twice (4 → 8).
    const karthus = injectCard('karthus-kog', 'Your [Deathknell] effects trigger an additional time.', { might: 5 })
    s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(karthus, 0))
    kogU = mk(kog, 0)
    enemy = mk(bigId, 1)
    s.battlefields[0].units.push(kogU, enemy)
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: kogU.iid })
    expect(r.state.battlefields[0].units.find((u) => u.iid === enemy.iid)?.damage).toBe(8)
  })

  it('Ekko - Recurrent (champion): Deathknell recycles itself and readies your runes', () => {
    const ekko = 'ogn-110-298'
    if (!CARD_INDEX[ekko]) return // dataset lacks Ekko - Recurrent
    const s = baseState()
    s.sandbox = true
    const ek = mk(ekko, 0)
    s.battlefields[0].units.push(ek)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0, { exhausted: true }), mk(furyRune.id, 0, { exhausted: true }))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: ek.iid })
    expect(r.state.players[0].zones.runeDeck.some((c) => c.cardId === ekko)).toBe(true) // recycled
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === ekko)).toBe(false)
    expect(r.state.players[0].zones.runePool.every((rr) => !rr.exhausted)).toBe(true) // runes readied
  })

  it('score effect: "you score N points" adds points (and parses, not the noun "Score")', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) => ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    expect(spellEffect(mkCard('You score 2 points.')).score).toBe(2)
    expect(spellEffect(mkCard("If an opponent's score is within 3 points of the Victory Score, do nothing.")).score).toBe(0) // noun, not the verb
    const uid = injectCard('score-test', 'When you play me, you score 2 points.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    const u = mk(uid, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].points).toBe(2)
  })

  it('score effect: reaching pointsToWin ends the game', () => {
    const uid = injectCard('score-win', 'When you play me, you score 1 point.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.pointsToWin = 5
    s.players[0].points = 4
    const u = mk(uid, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].points).toBe(5)
    expect(r.state.winner).toBe(0)
  })

  it("Kha'Zix - Voidreaver (legend): gains 1 XP when you win a combat", () => {
    const khazix = 'unl-201-219'
    if (!CARD_INDEX[khazix]) return // dataset lacks Kha'Zix - Voidreaver
    const s = baseState()
    s.players[0].legend = mk(khazix, 0)
    // A stunned weak defender (deals 0) so combat auto-resolves; attacker wins.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('kz-def', 'A unit.', { might: 3 }), 1, { exhausted: true, stunned: true })], controller: 1 }
    const atk = mk(injectCard('kz-atk', 'A unit.', { might: 8 }), 0)
    s.players[0].zones.base.push(atk)
    let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atk.iid], toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.players[0].xp).toBe(1)
  })

  // --- Combat-timing group: attack/defend triggers fire BEFORE the damage math
  // (fireCombatTriggers), so pre-combat board effects shape the showdown. ---
  const openShowdown = (s: MatchState, atk: EngineCard) => {
    let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atk.iid], toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    return r
  }

  it('Yasuo - Remorseful (champion): on attack, deals Might to a blocker BEFORE combat (so Yasuo survives)', () => {
    const yasuo = 'ogn-076-298' // might 6, "When I attack, deal damage equal to my Might to an enemy unit here."
    if (!CARD_INDEX[yasuo]) return
    const s = baseState()
    // Equal-Might blocker (6): pre-combat kill → no defender → Yasuo wins. If the
    // trigger fired AFTER the math, 6-vs-6 trades and Yasuo would also die.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('yas-def', 'A unit.', { might: 6 }), 1)], controller: 1 }
    const ya = mk(yasuo, 0)
    s.players[0].zones.base.push(ya)
    const r = openShowdown(s, ya)
    expect(r.state.battlefields[0].units.some((u) => u.iid === ya.iid)).toBe(true) // Yasuo survived
    expect(r.state.battlefields[0].units.length).toBe(1) // the blocker is gone
  })

  it("Kha'Zix - Evolving Hunter (champion): spends 3 XP on attack to deal Might pre-combat", () => {
    const kha = 'unl-119-219' // might 5, "may spend 3 XP to deal damage equal to my Might to an enemy unit here."
    if (!CARD_INDEX[kha]) return
    // With 3 XP: pre-combat kill of an equal-Might blocker → Kha'Zix survives.
    let s = baseState()
    s.players[0].xp = 3
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('kha-def', 'A unit.', { might: 5 }), 1)], controller: 1 }
    let kz = mk(kha, 0)
    s.players[0].zones.base.push(kz)
    let r = openShowdown(s, kz)
    expect(r.state.battlefields[0].units.some((u) => u.iid === kz.iid)).toBe(true) // survived
    expect(r.state.players[0].xp).toBeLessThan(3) // 3 XP spent (a conquer Hunt may add 1 back)
    // Without the XP: no pre-combat damage → 5-vs-5 trade kills Kha'Zix.
    s = baseState()
    s.players[0].xp = 0
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('kha-def2', 'A unit.', { might: 5 }), 1)], controller: 1 }
    kz = mk(kha, 0)
    s.players[0].zones.base.push(kz)
    r = openShowdown(s, kz)
    expect(r.state.battlefields[0].units.some((u) => u.iid === kz.iid)).toBe(false) // traded away
  })

  it('Warwick - Hunter (champion): on attack, kills already-damaged enemies BEFORE combat', () => {
    const ww = 'ogn-159-298' // might 5, "When I attack, kill all damaged enemy units here."
    if (!CARD_INDEX[ww]) return
    const s = baseState()
    // A big (10) but damaged blocker: combat alone wouldn't kill it (and it would
    // kill Warwick), but the pre-combat trigger destroys it outright.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('ww-def', 'A unit.', { might: 10 }), 1, { damage: 1 })], controller: 1 }
    const w = mk(ww, 0)
    s.players[0].zones.base.push(w)
    const r = openShowdown(s, w)
    expect(r.state.battlefields[0].units.some((u) => u.iid === w.iid)).toBe(true) // Warwick survived
    expect(r.state.battlefields[0].units.length).toBe(1) // the damaged blocker is gone
  })

  it('Ahri - Inquisitive (champion): on attack, applies -2 Might (min 1) BEFORE combat', () => {
    const ahri = 'ogn-119-298' // might 3, "When I attack or defend, give an enemy unit here -2 Might this turn, min 1."
    if (!CARD_INDEX[ahri]) return
    const s = baseState()
    // Blocker at 4: after -2 it's 2, so Ahri (3) wins and survives. Without the
    // pre-combat debuff, 3-vs-4 kills Ahri.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('ahri-def', 'A unit.', { might: 4 }), 1)], controller: 1 }
    const a = mk(ahri, 0)
    s.players[0].zones.base.push(a)
    const r = openShowdown(s, a)
    expect(r.state.battlefields[0].units.some((u) => u.iid === a.iid)).toBe(true) // Ahri survived
    expect(r.state.battlefields[0].units.length).toBe(1) // the blocker is gone
  })

  it('Vi - Peacekeeper (champion): on attack, stuns a blocker BEFORE combat (it deals 0)', () => {
    const vi = 'unl-176-219' // might 5, "When I attack, [Stun] an enemy unit here."
    if (!CARD_INDEX[vi]) return
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('vi-def', 'A unit.', { might: 5 }), 1)], controller: 1 }
    const v = mk(vi, 0)
    s.players[0].zones.base.push(v)
    const r = openShowdown(s, v)
    expect(r.state.battlefields[0].units.some((u) => u.iid === v.iid)).toBe(true) // Vi survived (blocker stunned → dealt 0)
    expect(r.state.battlefields[0].units.length).toBe(1)
  })

  const TF_TEXT = 'When I attack, reveal the top rune of your rune deck, then recycle it. Do one of the following based on its domain::rb_rune_fury: — Deal 2 to an enemy unit here and 1 to all other enemy units here.:rb_rune_mind: — Draw 1.:rb_rune_order: — Stun an enemy unit.'
  it('Twisted Fate - Gambler: on attack, Mind rune → draw 1, rune recycled (P1)', () => {
    const tf = injectCard('tf-gambler-t', TF_TEXT, { name: 'Twisted Fate - Gambler', type: 'unit', energy: 0, power: {}, might: 4 })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('tf-def', 'A unit.', { might: 1 }), 1, { stunned: true, exhausted: true })], controller: 1 }
    s.players[0].zones.runeDeck = [mk('ogn-089-298', 0)] // Mind rune on top
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)] // a card to draw
    const t = mk(tf, 0)
    s.players[0].zones.base.push(t)
    const r = openShowdown(s, t)
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(1) // Mind branch drew 1
    expect(r.state.players[0].zones.runeDeck.some((x) => x.cardId === 'ogn-089-298')).toBe(true) // recycled
  })

  it('Twisted Fate - Gambler: on attack, Fury rune → 2+1 AoE kills enemies pre-combat (P1)', () => {
    // TF Might 1 so combat alone CANNOT kill both (2+1) — only the Fury AoE can, and
    // it fires pre-combat so a 1-Might TF survives with no defenders left.
    const tf = injectCard('tf-gambler-t2', TF_TEXT, { name: 'Twisted Fate - Gambler', type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('tf-d1', 'A unit.', { might: 2 }), 1), mk(injectCard('tf-d2', 'A unit.', { might: 1 }), 1)], controller: 1 }
    s.players[0].zones.runeDeck = [mk('ogn-007a-298', 0)] // Fury rune on top
    const t = mk(tf, 0)
    s.players[0].zones.base.push(t)
    const r = openShowdown(s, t)
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.filter((u) => u.owner === 1).length).toBe(0) // AoE killed both
    expect(r.state.battlefields[0].units.some((u) => u.iid === t.iid)).toBe(true) // TF survived (no defenders)
  })

  it('Yone - Blademaster: conquering an uncontrolled bf deals its Might to an enemy in a base (P1)', () => {
    const yone = injectCard('yone-t', 'When I conquer a battlefield that was uncontrolled, deal damage equal to my Might to an enemy unit in a base.', { name: 'Yone - Blademaster', type: 'unit', energy: 0, power: {}, might: 5 })
    const enemyU = injectCard('yone-enemy', 'A unit.', { might: 3 })
    const s = baseState()
    const y = mk(yone, 0)
    s.players[0].zones.base.push(y)
    const e = mk(enemyU, 1)
    s.players[1].zones.base.push(e)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: y.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.error).toBeFalsy()
    expect(r.state.players[1].zones.base.some((x) => x.iid === e.iid)).toBe(false) // took 5, died
  })

  it('Teemo - Strategist: on defend, deals 1 per [Hidden] in top 5 to an enemy here (P1)', () => {
    // Teemo Might 2, attacker Might 3: combat alone would kill Teemo (attacker survives),
    // so the attacker dying proves the pre-combat 3-Hidden damage did it.
    const teemo = injectCard('teemo-strat-t', 'When I defend, choose an enemy unit here and reveal the top 5 cards of your Main Deck. Deal 1 to that unit for each card with [Hidden] revealed this way, then recycle the revealed cards.', { name: 'Teemo - Strategist', type: 'unit', energy: 0, power: {}, might: 2 })
    const hiddenCard = injectCard('ts-hidden', '[Hidden]', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.activePlayer = 1
    const tm = mk(teemo, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [tm], controller: 0 }
    s.players[0].zones.mainDeck = [mk(hiddenCard, 0), mk(hiddenCard, 0), mk(hiddenCard, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)] // 3 Hidden in top 5
    const atk = mk(injectCard('ts-atk', 'A unit.', { might: 3 }), 1)
    s.players[1].zones.base.push(atk)
    let r = reduce(s, { type: 'MOVE_UNITS', player: 1, iids: [atk.iid], toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.some((x) => x.iid === atk.iid)).toBe(false) // took 3 pre-combat, died
    expect(r.state.battlefields[0].units.some((x) => x.iid === tm.iid)).toBe(true) // Teemo survived
  })

  it('Adaptatron: conquer kills a gear to buff itself; no gear → no buff (P1)', () => {
    const ada = injectCard('adapt-t', "When I conquer, you may kill a gear. If you do, buff me. (If I don't have a buff, I get a +1 :rb_might: buff.)", { name: 'Adaptatron', type: 'unit', energy: 0, power: {}, might: 3 })
    const gear = injectCard('adapt-gear', 'A gear.', { type: 'gear', energy: 1, power: {} })
    let s = baseState()
    let a = mk(ada, 0)
    s.players[0].zones.base.push(a, mk(gear, 0))
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: a.iid, toBattlefield: 0 }) // uncontested conquer
    expect(r.state.players[0].zones.base.some((x) => x.cardId === gear)).toBe(false) // gear killed
    expect(r.state.battlefields[0].units.find((x) => x.iid === a.iid)?.buffs).toBe(1) // buffed
    s = baseState()
    a = mk(ada, 0)
    s.players[0].zones.base.push(a)
    r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: a.iid, toBattlefield: 0 })
    expect((r.state.battlefields[0].units.find((x) => x.iid === a.iid)?.buffs) ?? 0).toBe(0) // no gear → no buff
  })

  it('Jax - Unmatched: a played gear auto-attaches via Quick-Draw aura (P1)', () => {
    const jax = injectCard('jax-unm-t', 'Your Equipment everywhere have [Quick-Draw]. (Each gains [Reaction]. When you play it, attach it to a unit you control.)', { name: 'Jax - Unmatched', type: 'unit', might: 5 })
    const gear = injectCard('ju-gear', 'A gear.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.base.push(mk(jax, 0), mk(furyUnit.id, 0))
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, payment: { exhaust: [], recycle: [] } }) // no targetIid
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((u) => u.attached.some((a) => a.startsWith(`${gear}|`)))).toBe(true) // auto-attached
    expect(r.state.players[0].zones.base.some((u) => u.cardId === gear)).toBe(false) // not sitting unattached
  })

  it("Rek'Sai - Breacher: a unit played from a non-hand zone enters ready (P1)", () => {
    const breacher = injectCard('breacher-t', "Friendly units played from anywhere other than a player's hand have [Accelerate].", { name: "Rek'Sai - Breacher", type: 'unit', might: 3 })
    const hid = injectCard('br-hidden', '[Hidden]', { type: 'unit', might: 3, energy: 0, power: {} })
    const s = baseState()
    s.turn = 6
    s.players[0].zones.base.push(mk(breacher, 0))
    const u = mk(hid, 0, { facedown: true, hiddenTurn: 4 })
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: 0 }
    s.battlefields[0].facedown = u
    const r = reduce(s, { type: 'REVEAL', player: 0, iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((x) => x.iid === u.iid)?.exhausted).toBe(false) // entered ready via Breacher
  })

  it('Blitzcrank - Impassive: returns to hand when it holds (P1)', () => {
    const blitz = injectCard('blitz-t', "[Tank] When I hold, return me to my owner's hand.", { name: 'Blitzcrank - Impassive', type: 'unit', might: 5 })
    const s = baseState()
    s.activePlayer = 0
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    const b = mk(blitz, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [b], controller: 0 } // holding
    const after = beginTurn(s)
    expect(after.players[0].zones.hand.some((x) => x.cardId === blitz)).toBe(true) // returned to hand
    expect(after.battlefields[0].units.some((x) => x.iid === b.iid)).toBe(false) // left the battlefield
  })

  it('Royal Entourage: on play, exhausts an opponent legend (or readies your own) (P1)', () => {
    const re = injectCard('royal-ent-t', 'When you play me, ready or exhaust a legend.', { type: 'unit', energy: 0, power: {}, might: 4 })
    let s = baseState()
    s.players[1].legend = mk(furyUnit.id, 1) // opponent's ready legend
    let u = mk(re, 0)
    s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[1].legend?.exhausted).toBe(true) // denied the opponent's legend
    // No opponent ready legend → ready your own exhausted legend.
    s = baseState()
    s.players[0].legend = mk(furyUnit.id, 0, { exhausted: true })
    u = mk(re, 0)
    s.players[0].zones.hand.push(u)
    r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].legend?.exhausted).toBe(false) // readied your own
  })

  it('Strike Down: an equipped friendly unit deals its Might to an enemy, then detaches (P1)', () => {
    const spell = injectCard('strike-down-t', 'Choose an equipped friendly unit. It deals damage equal to its Might to an enemy unit. Then detach an Equipment from it.', { type: 'spell', energy: 0, power: {} })
    const gear = injectCard('sd-gear', 'A gear.', { type: 'gear', energy: 0, power: {} })
    const dealerC = injectCard('sd-dealer', 'A unit.', { might: 5 })
    const s = baseState()
    const g = mk(gear, 0)
    const dealer = mk(dealerC, 0, { attached: [`${gear}|${g.iid}`] })
    s.battlefields[0] = { cardId: battlefield.id, units: [dealer, mk(injectCard('sd-enemy', 'A unit.', { might: 3 }), 1)], controller: 0 }
    const sp = mk(spell, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.filter((x) => x.owner === 1).length).toBe(0) // enemy took 5, died
    expect(r.state.players[0].zones.base.some((x) => x.cardId === gear)).toBe(true) // gear detached to base
  })

  it('Teemo - Swift Scout: bounces a Teemo from the Champion Zone to hand (P1)', () => {
    const tss = injectCard('tss-t', 'You may pay :rb_energy_1: to hide a card with [Hidden] instead of :rb_rune_rainbow:.:rb_energy_1:, :rb_exhaust:: Put a Teemo unit you own into your hand from your Champion Zone or the board.', { name: 'Teemo - Swift Scout', type: 'legend' })
    const teemoChamp = injectCard('tss-champ', 'A unit.', { type: 'unit', supertype: 'champion', tags: ['Teemo'], might: 2 })
    const s = baseState()
    s.players[0].legend = mk(tss, 0)
    s.players[0].champion = mk(teemoChamp, 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // 1 Energy
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend!.iid, targets: [s.players[0].champion!.iid] })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].champion).toBeNull()
    expect(r.state.players[0].zones.hand.some((x) => x.cardId === teemoChamp)).toBe(true)
  })

  it('Gearhead: doubles the base Might bonus of attached static Equipment (P1)', () => {
    const gearhead = injectCard('gearhead-t', 'Each Equipment attached to me gives double its base Might bonus.', { name: 'Gearhead', type: 'unit', might: 3 })
    const gear = injectCard('gh-gear', '+2 :rb_might:', { type: 'gear' }) // a static stat-stick
    const s = baseState()
    const g = mk(gear, 0)
    const u = mk(gearhead, 0, { attached: [`${gear}|${g.iid}`] })
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    expect(combatMightAt(s, 0, u, 'defender')).toBe(7) // 3 + (2 doubled)
  })

  it('Rell - Magnetic: on attack, plays a cheap Equipment free and attaches it (P1)', () => {
    const rell = injectCard('rell-t', '[Tank] When I attack, you may play an Equipment with Energy cost no more than :rb_energy_2:, ignoring its cost. If you do, then do this: Attach it to me.', { name: 'Rell - Magnetic', type: 'unit', might: 4 })
    const gear = injectCard('rell-gear', 'A gear.', { type: 'gear', energy: 1, power: {} })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('rell-def', 'A unit.', { might: 1 }), 1, { stunned: true, exhausted: true })], controller: 1 }
    const rl = mk(rell, 0)
    s.players[0].zones.base.push(rl)
    s.players[0].zones.hand.push(mk(gear, 0))
    const r = openShowdown(s, rl)
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((x) => x.iid === rl.iid)?.attached.some((a) => a.startsWith(`${gear}|`))).toBe(true) // free-attached on attack
  })

  it('Sivir - Battle Mistress: recycle a rune → exhaust to play a Gold token (P2)', () => {
    const sivir = injectCard('sivir-bm-t', 'When you recycle a rune, you may exhaust me to play a Gold gear token exhausted. When one or more enemy units die, ready me.', { name: 'Sivir - Battle Mistress', type: 'legend' })
    const s = baseState()
    s.players[0].legend = mk(sivir, 0)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'RECYCLE_RUNE', player: 0, iid: rune.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => x.cardId === GOLD_TOKEN_ID)).toBe(true) // Gold token
    expect(r.state.players[0].legend?.exhausted).toBe(true) // Sivir exhausted to pay
  })

  it('Karma - Channeler: recycling a card (Vision) buffs a friendly unit (P2)', () => {
    const karma = injectCard('karma-ch-t', "[Vision] When you recycle one or more cards, buff a friendly unit. (Runes aren't cards.)", { name: 'Karma - Channeler', type: 'unit', might: 6 })
    const s = baseState()
    s.players[0].zones.base.push(mk(karma, 0), mk(furyUnit.id, 0))
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)] // a card to recycle
    s.vision = { player: 0, cardId: s.players[0].zones.mainDeck[0].cardId }
    const r = reduce(s, { type: 'VISION_DECIDE', player: 0, recycle: true })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => (x.buffs ?? 0) > 0)).toBe(true) // a friendly unit buffed
  })

  it('Fae Dragon: playing a Gold token when you spend a buff (P2)', () => {
    const fae = injectCard('fae-dragon-t', 'When you spend a buff, play a Gold gear token exhausted.', { name: 'Fae Dragon', type: 'unit', might: 7 })
    const spender = injectCard('fae-spender', 'When you play me, spend a buff to ready me.', { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    s.players[0].zones.base.push(mk(fae, 0), mk(furyUnit.id, 0, { buffs: 1 })) // a buffed donor
    const sp = mk(spender, 0)
    s.players[0].zones.hand.push(sp)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: sp.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => x.cardId === GOLD_TOKEN_ID)).toBe(true) // Fae Dragon Gold
  })

  it('Wily Newtfish: +1 Might and [Ganking] only if you gained XP this turn (P2)', () => {
    const wily = injectCard('wily-t', "If you've gained XP this turn, I have +1 :rb_might: and [Ganking].", { type: 'unit', might: 4 })
    const s = baseState()
    const u = mk(wily, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(4) // no XP gained
    expect(reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [u.iid], toBattlefield: 1 }).error).toBeTruthy() // can't gank
    s.players[0].xpGainedThisTurn = true
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(5) // +1 Might
    expect(reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [u.iid], toBattlefield: 1 }).error).toBeFalsy() // can gank
  })

  it('Ember Monk: +2 Might when a card is played from [Hidden], not on normal plays (P2)', () => {
    const ember = injectCard('ember-monk-t', 'When you play a card from [Hidden], give me +2 :rb_might: this turn.', { name: 'Ember Monk', type: 'unit', might: 4 })
    const hid = injectCard('em-hidden', '[Hidden]', { type: 'spell', energy: 0, power: {} })
    const vanilla = injectCard('em-vanilla', 'A unit.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    s.turn = 6
    const em = mk(ember, 0)
    s.players[0].zones.base.push(em)
    // Normal play → no boost.
    s.players[0].zones.hand.push(mk(vanilla, 0))
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: s.players[0].zones.hand[0].iid, payment: { exhaust: [], recycle: [] } })
    expect((r.state.players[0].zones.base.find((x) => x.iid === em.iid)?.tempMight) ?? 0).toBe(0)
    // Reveal a facedown card (played from Hidden) → +2.
    const fd = mk(hid, 0, { facedown: true, hiddenTurn: 4 })
    r.state.battlefields[0] = { cardId: battlefield.id, units: [], controller: 0 }
    r.state.battlefields[0].facedown = fd
    r = reduce(r.state, { type: 'REVEAL', player: 0, iid: fd.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === em.iid)?.tempMight).toBe(2)
  })

  it('Weaponmaster: re-seats an already-attached gear when none in hand/base (P3)', () => {
    const wm = injectCard('wm-reseat-t', "[Weaponmaster] (When you play me, you may [Equip] one of your Equipment to me, even if it's already attached.)", { type: 'unit', energy: 0, power: {}, might: 4 })
    const gear = injectCard('wm-gear', 'A gear.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const g = mk(gear, 0)
    const otherUnit = mk(furyUnit.id, 0, { attached: [`${gear}|${g.iid}`] })
    s.players[0].zones.base.push(otherUnit)
    const u = mk(wm, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.some((a) => a.startsWith(`${gear}|`))).toBe(true) // re-seated to the new unit
    expect(r.state.players[0].zones.base.find((x) => x.iid === otherUnit.iid)?.attached.length).toBe(0) // taken from the other unit
  })

  it('Bard - Mercurial: paying the legend-exhaust moves a unit to conquer an open battlefield (P4)', () => {
    const bard = injectCard('bard-merc-t', 'You may exhaust your legend as an additional cost to play me. When you play me, if you paid the additional cost, move any number of your units to an open battlefield.', { name: 'Bard - Mercurial', type: 'unit', energy: 0, power: {}, might: 4 })
    const s = baseState()
    s.players[0].legend = mk(furyUnit.id, 0) // a ready legend
    const mover = mk(furyUnit.id, 0) // a ready base unit to send
    s.players[0].zones.base.push(mover)
    const b = mk(bard, 0)
    s.players[0].zones.hand.push(b)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: b.iid, payment: { exhaust: [], recycle: [] }, payAdditionalCost: true })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].legend?.exhausted).toBe(true) // additional cost paid
    expect(r.state.battlefields[0].units.some((x) => x.iid === mover.iid)).toBe(true) // moved to bf0
    expect(r.state.battlefields[0].controller).toBe(0) // conquered the open battlefield
  })

  it('Bard - Mercurial: declining the legend-exhaust skips both the cost and the bonus', () => {
    const bard = injectCard('bard-merc-t2', 'You may exhaust your legend as an additional cost to play me. When you play me, if you paid the additional cost, move any number of your units to an open battlefield.', { name: 'Bard - Mercurial', type: 'unit', energy: 0, power: {}, might: 4 })
    const s = baseState()
    s.players[0].legend = mk(furyUnit.id, 0)
    const mover = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(mover)
    const b = mk(bard, 0)
    s.players[0].zones.hand.push(b)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: b.iid, payment: { exhaust: [], recycle: [] } }) // no opt-in
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].legend?.exhausted).toBeFalsy() // cost NOT paid
    expect(r.state.battlefields[0].units.some((x) => x.iid === mover.iid)).toBe(false) // bonus NOT applied
  })

  it('Azir - Ascendant: swap locations with a friendly unit, steal its Equipment, once per turn (P4)', () => {
    const azirId = injectCard('azir-ascendant-t', ":rb_rune_calm:: [Action] — Choose a unit you control. Move me to its location and it to my original location. If it's equipped, you may attach one of its Equipment to me. Use only once per turn.", { name: 'Azir - Ascendant', type: 'unit', might: 6, energy: 6, power: { calm: 1 } })
    const gearId = injectCard('azir-gear-t', '+2 :rb_might:', { type: 'gear', energy: 0, power: {} })
    const allyId = injectCard('azir-ally-t', 'A unit.', { type: 'unit', might: 3, energy: 0, power: {} })
    const s = baseState()
    const calmRune = CARDS.find((c) => c.type === 'rune' && c.produces?.includes('calm'))
    s.players[0].zones.runePool.push(mk((calmRune ?? furyRune).id, 0))
    const azir = mk(azirId, 0)
    s.players[0].zones.base.push(azir)
    const gear = mk(gearId, 0)
    const ally = mk(allyId, 0, { attached: [`${gearId}|${gear.iid}`] })
    s.battlefields[1] = { cardId: battlefield.id, units: [ally], controller: 0 }
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: azir.iid, targets: [ally.iid] })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.some((u) => u.iid === azir.iid)).toBe(true) // Azir moved to bf1
    expect(r.state.players[0].zones.base.some((u) => u.iid === ally.iid)).toBe(true) // ally moved to base
    expect(r.state.battlefields[1].units.find((u) => u.iid === azir.iid)?.attached.some((a) => a.startsWith(`${gearId}|`))).toBe(true) // stole the gear
    expect(reduce(r.state, { type: 'ACTIVATE_UNIT', player: 0, iid: azir.iid, targets: [ally.iid] }).error).toBeTruthy() // once per turn
  })

  it('Jax - Grandmaster At Arms: re-seats an already-attached Equipment to another unit (P4)', () => {
    const jax = injectCard('jax-gm-t', ':rb_energy_1:, :rb_exhaust:: Attach a detached Equipment you control to a unit you control.:rb_exhaust:: Attach an attached Equipment you control to a unit you control.', { name: 'Jax - Grandmaster At Arms', type: 'legend' })
    const gearId = injectCard('jax-gm-gear', '+1 :rb_might:', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.players[0].legend = mk(jax, 0)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // 1 Energy for the ability cost
    const g = mk(gearId, 0)
    const unitA = mk(furyUnit.id, 0, { attached: [`${gearId}|${g.iid}`] })
    const unitB = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(unitA, unitB)
    let r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: s.players[0].legend!.iid, targets: [] })
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: g.iid }) // pick the attached gear
    expect(r.error).toBeUndefined()
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: unitB.iid }) // re-seat to unit B
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === unitB.iid)?.attached.some((a) => a.startsWith(`${gearId}|`))).toBe(true) // re-seated to B
    expect(r.state.players[0].zones.base.find((x) => x.iid === unitA.iid)?.attached.length).toBe(0) // taken from A
  })

  it('Ahri - Nine-Tailed Fox (legend): an enemy attacking your battlefield gets -1 Might (min 1)', () => {
    const ahri9 = 'ogn-255-298'
    if (!CARD_INDEX[ahri9]) return
    const s = baseState()
    s.players[1].legend = mk(ahri9, 1)
    // P1 controls bf 0 with a stunned weak defender (deals 0, auto-resolves).
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('a9-def', 'A unit.', { might: 1 }), 1, { stunned: true, exhausted: true })], controller: 1 }
    const atk = mk(injectCard('a9-atk', 'A unit.', { might: 3 }), 0)
    s.players[0].zones.base.push(atk)
    const r = openShowdown(s, atk)
    const after = r.state.battlefields[0].units.find((u) => u.iid === atk.iid)
    expect(after).toBeTruthy() // attacker won and stayed
    expect(after?.tempMight).toBe(-1) // got the -1 Might debuff
  })

  // --- Deck-dig: "look at the top N, draw the best match, recycle the rest" ---
  it('peekDraw: draws the highest-cost gear from the top N and recycles the rest', () => {
    const gearId = injectCard('pk-gear', 'A gear.', { type: 'gear', energy: 3 })
    const ornn = injectCard('pk-ornn', 'When you play me, look at the top 4 cards of your Main Deck. You may reveal a gear from among them and draw it. Then recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    // Top 4 = [unit, gear, unit, unit] + filler; only the gear qualifies.
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(gearId, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    const u = mk(ornn, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === gearId)).toBe(true) // gear drawn
    expect(r.state.players[0].zones.mainDeck.length).toBe(4) // 5 - 1 drawn (3 recycled to bottom)
  })

  it('peekDraw: honors the "Energy cost 4+" filter (Fate Weaver) — skips the cheap spell', () => {
    const cheap = injectCard('pk-spell2', 'A spell.', { type: 'spell', energy: 2 })
    const pricey = injectCard('pk-spell5', 'A spell.', { type: 'spell', energy: 5 })
    const fw = injectCard('pk-fw', 'When you play me, look at the top 4 cards of your Main Deck. You may reveal a spell with Energy cost :rb_energy_4: or more from among them and draw it. Recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(cheap, 0), mk(furyUnit.id, 0), mk(pricey, 0), mk(furyUnit.id, 0)]
    const u = mk(fw, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === pricey)).toBe(true) // 5-cost drawn
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === cheap)).toBe(false) // 2-cost skipped
  })

  it('peekDraw: with no matching type, draws nothing and recycles all', () => {
    const ornn = injectCard('pk-ornn2', 'When you play me, look at the top 3 cards of your Main Deck. You may reveal a gear from among them and draw it. Recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)] // no gear
    const handBefore = s.players[0].zones.hand.length
    const u = mk(ornn, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.hand.length).toBe(handBefore) // nothing drawn (the played unit left hand)
    expect(r.state.players[0].zones.mainDeck.length).toBe(3) // all recycled
  })

  it('peekToHand: draws the highest-cost of the top N (Stacked Deck / Called Shot)', () => {
    const cheap = injectCard('pth-1', 'A unit.', { energy: 1 })
    const dear = injectCard('pth-4', 'A unit.', { energy: 4 })
    const mid = injectCard('pth-2', 'A unit.', { energy: 2 })
    const sd = injectCard('pth-sd', 'When you play me, look at the top 3 cards of your Main Deck. Put 1 into your hand and recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(cheap, 0), mk(dear, 0), mk(mid, 0), mk(furyUnit.id, 0)]
    const u = mk(sd, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === dear)).toBe(true) // best of 3 drawn
    expect(r.state.players[0].zones.mainDeck.length).toBe(3)
  })

  it('Ivern - Nurturer (champion): peek draws a unit AND buffs a friendly when a Bird/Cat/Dog/Poro is revealed', () => {
    const bird = injectCard('iv-bird', 'A unit.', { energy: 2, tags: ['Bird'] })
    const ivern = injectCard('iv-test', 'When you play me, look at the top 3 cards of your Main Deck. You may reveal a unit from among them and draw it. Recycle the rest. Then if you revealed a Bird, Cat, Dog, or Poro, do this: [Buff] a friendly unit.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(bird, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    const ally = mk(furyUnit.id, 0) // a friendly unit to receive the buff
    s.players[0].zones.base.push(ally)
    const u = mk(ivern, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    // Exactly one +1 buff landed on a friendly unit (the Bird reveal triggered it).
    const totalBuffs = [...r.state.players[0].zones.base, ...r.state.battlefields.flatMap((b) => b.units)]
      .filter((x) => x.owner === 0)
      .reduce((a, x) => a + (x.buffs ?? 0), 0)
    expect(totalBuffs).toBe(1)
  })

  it('Ivern - Nurturer: does NOT buff when no Bird/Cat/Dog/Poro is revealed', () => {
    const ivern = injectCard('iv-test2', 'When you play me, look at the top 3 cards of your Main Deck. You may reveal a unit from among them and draw it. Recycle the rest. Then if you revealed a Bird, Cat, Dog, or Poro, do this: [Buff] a friendly unit.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)] // no tribe card
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(ally)
    const u = mk(ivern, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    const totalBuffs = [...r.state.players[0].zones.base, ...r.state.battlefields.flatMap((b) => b.units)]
      .filter((x) => x.owner === 0)
      .reduce((a, x) => a + (x.buffs ?? 0), 0)
    expect(totalBuffs).toBe(0)
  })

  // --- Deck-dig: "banish one of the top N, then play it" ---
  const inPlay = (st: MatchState, owner: PlayerId, cardId: string) =>
    [...st.players[owner].zones.base, ...st.battlefields.flatMap((b) => b.units)].some((u) => u.owner === owner && u.cardId === cardId)

  it('peekBanishPlay: plays the highest-cost unit from the top N for free, recycles the rest', () => {
    const bigUnit = injectCard('bp-big', 'A unit.', { energy: 6 })
    const aSpell = injectCard('bp-spell', 'A spell.', { type: 'spell', energy: 1 })
    const rek = injectCard('bp-rek', 'When you play me, look at the top 2 cards of your Main Deck. You may banish one, then play it. Recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(bigUnit, 0), mk(aSpell, 0), mk(furyUnit.id, 0)]
    const u = mk(rek, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(inPlay(r.state, 0, bigUnit)).toBe(true) // the unit was played
    expect(r.state.players[0].zones.mainDeck.some((c) => c.cardId === bigUnit)).toBe(false)
  })

  it('peekBanishPlay: a discount only frees a unit whose cost is within it (Reinforce/Void Rush)', () => {
    const dear = injectCard('bp-dear', 'A unit.', { energy: 5 })
    const cheap = injectCard('bp-cheap', 'A unit.', { energy: 1 })
    const reinf = injectCard('bp-reinf', 'When you play me, look at the top 2 cards of your Main Deck. You may banish a unit from among them, then play it, reducing its cost by :rb_energy_2:. Recycle the rest.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(dear, 0), mk(cheap, 0)]
    const u = mk(reinf, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(inPlay(r.state, 0, cheap)).toBe(true) // 1-cost is within the 2 discount → free
    expect(inPlay(r.state, 0, dear)).toBe(false) // 5-cost stays in the deck (recycled)
  })

  it('peekBanishPlay (Void Rush): draws the cards it did not banish', () => {
    const cheap = injectCard('vr-cheap', 'A unit.', { energy: 1 })
    const other = injectCard('vr-other', 'A spell.', { type: 'spell', energy: 3 })
    const vr = injectCard('vr-test', 'When you play me, reveal the top 2 cards of your Main Deck. You may banish one, then play it, reducing its cost by :rb_energy_2:. Draw any you didn\'t banish.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(cheap, 0), mk(other, 0)]
    const u = mk(vr, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(inPlay(r.state, 0, cheap)).toBe(true) // played the 1-cost unit
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === other)).toBe(true) // drew the other
  })

  it('peekBanishPlay (Blind Fury): plays a unit off an opponent\'s deck under your control', () => {
    const enemyUnit = injectCard('bf-enemy', 'A unit.', { energy: 4 })
    const bf = injectCard('bf-test', "When you play me, each opponent reveals the top card of their Main Deck. Choose one and banish it, then play it, ignoring its cost. Then recycle the rest.", { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    s.players[1].zones.mainDeck = [mk(enemyUnit, 1)]
    const u = mk(bf, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(inPlay(r.state, 0, enemyUnit)).toBe(true) // the opponent's unit now serves player 0
    expect(r.state.players[1].zones.mainDeck.some((c) => c.cardId === enemyUnit)).toBe(false)
  })

  it("Rek'Sai - Swarm Queen (champion): on attack, plays a unit from the deck to her battlefield", () => {
    const recruit = injectCard('sq-recruit', 'A unit.', { energy: 3 })
    const sqSpell = injectCard('sq-spell', 'A spell.', { type: 'spell', energy: 1 })
    const sq = injectCard('sq-test', 'When I attack, you may reveal the top 2 cards of your Main Deck. You may banish one, then play it. If it is a unit, you may play it here. Recycle the rest.', { type: 'unit', energy: 0, power: {}, might: 6 })
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(recruit, 0), mk(sqSpell, 0)] // recruit is the only unit
    // Stunned weak defender so combat auto-resolves and attackers survive.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('sq-def', 'A unit.', { might: 1 }), 1, { stunned: true, exhausted: true })], controller: 1 }
    const queen = mk(sq, 0)
    s.players[0].zones.base.push(queen)
    let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [queen.iid], toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.battlefields[0].units.some((u) => u.cardId === recruit && u.owner === 0)).toBe(true) // played here
  })

  it('Noxian Drummer: move-to-battlefield plays a Recruit token HERE (not base)', () => {
    const drum = injectCard('noxian-drummer-t', 'When I move to a battlefield, play a 1 :rb_might: Recruit unit token here. (It is also at the battlefield.)', { type: 'unit', energy: 0, power: {}, might: 2 })
    const s = baseState()
    const u = mk(drum, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [u.iid], toBattlefield: 0 })
    const here = r.state.battlefields[0].units.filter((x) => x.cardId === TOKEN_PILE_IDS[0] && x.owner === 0)
    expect(here.length).toBe(1) // recruit landed at the battlefield
    expect(r.state.players[0].zones.base.some((x) => x.cardId === TOKEN_PILE_IDS[0])).toBe(false) // not at base
  })

  it('Corina Veraza: move-to-battlefield plays three Recruit tokens here', () => {
    const cor = injectCard('corina-t', 'When I move to a battlefield, play three 1 :rb_might: Recruit unit tokens here.', { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    const u = mk(cor, 0)
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [u.iid], toBattlefield: 1 })
    const here = r.state.battlefields[1].units.filter((x) => x.cardId === TOKEN_PILE_IDS[0] && x.owner === 0)
    expect(here.length).toBe(3)
  })

  it('parse: "Recruit unit token here" sets recruitsHere', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 'x', name: 'x', type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3 }) as never
    expect(spellEffect(mkCard('Play a 1 :rb_might: Recruit unit token here.')).recruitsHere).toBe(true)
    expect(spellEffect(mkCard('Play four 1 :rb_might: Recruit unit tokens.')).recruitsHere).toBe(false)
  })

  it('Assembly Rig: "Recycle a unit from your trash" counts as a recycle cost', () => {
    const rig = injectCard('assembly-rig-t', ':rb_energy_1::rb_rune_fury:, Recycle a unit from your trash, :rb_exhaust:: Play a 3 :rb_might: Mech unit token to your base.', { type: 'gear', energy: 2, power: {} })
    const ab = unitActivatedAbility(CARD_INDEX[rig] as never)
    expect(ab).not.toBeNull()
    expect(ab!.recycleTrash).toBe(1)
    expect(ab!.exhaust).toBe(true)
  })

  // --- Token statics: Renata (enter ready) & Zilean (doubling) ---
  it('Renata Glasc - Industrialist (champion): your tokens enter ready', () => {
    const maker = injectCard('rec-maker', 'When you play me, play 2 Recruit unit tokens.', { type: 'unit', energy: 0, power: {} })
    const renata = injectCard('renata-ind', 'Your tokens enter ready.', { name: 'Renata Glasc - Industrialist' })
    // With Renata in play → recruits enter ready.
    let s = baseState()
    s.players[0].zones.base.push(mk(renata, 0))
    let u = mk(maker, 0)
    s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    let recruits = r.state.players[0].zones.base.filter((c) => c.cardId === TOKEN_PILE_IDS[0])
    expect(recruits.length).toBe(2)
    expect(recruits.every((c) => !c.exhausted)).toBe(true) // ready
    // Without Renata → recruits enter exhausted (default).
    s = baseState()
    u = mk(maker, 0)
    s.players[0].zones.hand.push(u)
    r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    recruits = r.state.players[0].zones.base.filter((c) => c.cardId === TOKEN_PILE_IDS[0])
    expect(recruits.every((c) => c.exhausted)).toBe(true)
  })

  it('Zilean - Time Mage (champion): doubles a token-unit play once per turn while at a battlefield', () => {
    const maker = injectCard('rec-maker2', 'When you play me, play 1 Recruit unit token.', { type: 'unit', energy: 0, power: {} })
    const zilean = injectCard('zilean-tm', "Once each turn, if you would play a token unit while I'm at a battlefield, you may play that token and an additional copy of it instead.", { name: 'Zilean - Time Mage' })
    const s = baseState()
    s.battlefields[0].units.push(mk(zilean, 0)) // Zilean AT a battlefield
    s.battlefields[0].controller = 0
    const u1 = mk(maker, 0)
    const u2 = mk(maker, 0)
    s.players[0].zones.hand.push(u1, u2)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u1.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.filter((c) => c.cardId === TOKEN_PILE_IDS[0]).length).toBe(2) // 1 → 2
    expect(r.state.players[0].zileanDoubledThisTurn).toBe(true)
    // Second token play this turn is NOT doubled (once each turn).
    r = reduce(r.state, { type: 'PLAY_UNIT', player: 0, iid: u2.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.filter((c) => c.cardId === TOKEN_PILE_IDS[0]).length).toBe(3) // 2 + 1
  })

  it('Zilean - Time Mage: does NOT double while at base (not a battlefield)', () => {
    const maker = injectCard('rec-maker3', 'When you play me, play 1 Recruit unit token.', { type: 'unit', energy: 0, power: {} })
    const zilean = injectCard('zilean-tm2', "Once each turn, if you would play a token unit while I'm at a battlefield, you may play that token and an additional copy of it instead.", { name: 'Zilean - Time Mage' })
    const s = baseState()
    s.players[0].zones.base.push(mk(zilean, 0)) // at base, not a battlefield
    const u = mk(maker, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.filter((c) => c.cardId === TOKEN_PILE_IDS[0]).length).toBe(1) // not doubled
  })

  it('Leona - Zealot (champion): stunned enemy units here have -8 Might (min 1)', () => {
    const leona = 'ogn-079-298'
    if (!CARD_INDEX[leona]) return
    const s = baseState()
    const bigStunned = mk(injectCard('lz-e1', 'A unit.', { might: 10 }), 1, { stunned: true })
    const smallStunned = mk(injectCard('lz-e2', 'A unit.', { might: 6 }), 1, { stunned: true })
    const unstunned = mk(injectCard('lz-e3', 'A unit.', { might: 10 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(leona, 0), bigStunned, smallStunned, unstunned], controller: 0 }
    expect(combatMightAt(s, 0, bigStunned, 'defender')).toBe(2) // 10 - 8
    expect(combatMightAt(s, 0, smallStunned, 'defender')).toBe(1) // 6 - 8, floored at 1
    expect(combatMightAt(s, 0, unstunned, 'defender')).toBe(10) // not stunned → unaffected
  })

  it('Aphelios - Exalted (champion): attaching Equipment cycles Ready/Channel/Buff per turn', () => {
    const aph = injectCard('aph-test', "When you attach an Equipment to me, choose one that hasn't been chosen this turn — Ready 2 runes. Channel 1 rune exhausted. Buff a friendly unit.", { name: 'Aphelios - Exalted', might: 4 })
    const gearId = injectCard('aph-gear', '[Quick-Draw] A gear.', { type: 'gear', energy: 0, power: {} }) // attaches on play
    const s = baseState()
    const aphU = mk(aph, 0)
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(aphU, ally)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0, { exhausted: true }), mk(furyRune.id, 0, { exhausted: true }))
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    const g1 = mk(gearId, 0), g2 = mk(gearId, 0), g3 = mk(gearId, 0)
    s.players[0].zones.hand.push(g1, g2, g3)
    // Mode 0 — Ready 2 runes.
    let r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g1.iid, targetIid: aphU.iid, payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.runePool.every((x) => !x.exhausted)).toBe(true)
    // Mode 1 — Channel 1 rune exhausted (pool grows from the rune deck).
    r = reduce(r.state, { type: 'PLAY_GEAR', player: 0, iid: g2.iid, targetIid: aphU.iid, payment: emptyPayment() })
    expect(r.state.players[0].zones.runePool.length).toBe(3)
    // Mode 2 — Buff a friendly unit.
    r = reduce(r.state, { type: 'PLAY_GEAR', player: 0, iid: g3.iid, targetIid: aphU.iid, payment: emptyPayment() })
    const totalBuffs = r.state.players[0].zones.base.reduce((a, x) => a + (x.buffs ?? 0), 0)
    expect(totalBuffs).toBe(1)
    expect(r.state.players[0].apheliosModesThisTurn).toBe(3)
  })

  // --- Discard mechanic ---
  it('discard: auto-discards the lowest-cost cards from hand', () => {
    const maker = injectCard('disc-maker', 'When you play me, discard 1.', { type: 'unit', energy: 0, power: {} })
    const cheap = injectCard('disc-cheap', 'A unit.', { energy: 1 })
    const dear = injectCard('disc-dear', 'A unit.', { energy: 7 })
    const s = baseState()
    const u = mk(maker, 0)
    s.players[0].zones.hand.push(u, mk(cheap, 0), mk(dear, 0))
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.some((x) => x.cardId === dear)).toBe(true) // kept
    expect(r.state.players[0].zones.trash.some((x) => x.cardId === cheap)).toBe(true) // discarded
  })

  it('discard: "discard N then draw N" discards first, then draws', () => {
    const maker = injectCard('disc-maker2', 'When you play me, discard 2, then draw 2.', { type: 'unit', energy: 0, power: {} })
    const j1 = injectCard('disc-j1', 'A unit.', { energy: 1 })
    const j2 = injectCard('disc-j2', 'A unit.', { energy: 1 })
    const s = baseState()
    const u = mk(maker, 0)
    s.players[0].zones.hand.push(u, mk(j1, 0), mk(j2, 0))
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)]
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.trash.filter((x) => x.cardId === j1 || x.cardId === j2).length).toBe(2) // both discarded
    expect(r.state.players[0].zones.hand.filter((x) => x.cardId === furyUnit.id).length).toBe(2) // drew 2
  })

  it('Jinx - Rebel (champion): readies and gains +1 Might this turn when you discard', () => {
    const jinx = 'ogn-202-298'
    if (!CARD_INDEX[jinx]) return
    const maker = injectCard('disc-maker3', 'When you play me, discard 1.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    const jx = mk(jinx, 0, { exhausted: true })
    s.players[0].zones.base.push(jx)
    const u = mk(maker, 0)
    s.players[0].zones.hand.push(u, mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    const jxAfter = r.state.players[0].zones.base.find((x) => x.iid === jx.iid)
    expect(jxAfter?.exhausted).toBe(false) // readied
    expect(jxAfter?.tempMight).toBe(1) // +1 Might this turn
  })

  // --- Buff/Might sweep: triggered + on-play stragglers ---
  it('Spectral Centaur: +2 Might this turn when another friendly unit dies', () => {
    const sc = injectCard('sc-test', 'When another friendly unit dies, give me +2 :rb_might: this turn.', { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    s.sandbox = true
    const centaur = mk(sc, 0)
    const ally = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(centaur, ally)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: ally.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units.find((u) => u.iid === centaur.iid)?.tempMight).toBe(2)
  })

  it('Thousand-Tailed Watcher: on play gives all enemy units -3 Might this turn (min 1)', () => {
    const watcher = injectCard('ttw-test', 'When you play me, give enemy units -3 :rb_might: this turn, to a minimum of 1 :rb_might:.', { type: 'unit', energy: 0, power: {} })
    const big = mk(injectCard('ttw-e1', 'A unit.', { might: 10 }), 1)
    const small = mk(injectCard('ttw-e2', 'A unit.', { might: 2 }), 1)
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [big, small], controller: 1 }
    const u = mk(watcher, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.battlefields[0].units.find((x) => x.iid === big.iid)?.tempMight).toBe(-3) // 10 → 7
    expect(r.state.battlefields[0].units.find((x) => x.iid === small.iid)?.tempMight).toBe(-1) // 2 → floored at 1
  })

  it('Vanguard Helm: buffs another friendly only when a BUFFED friendly unit dies', () => {
    const helm = injectCard('vh-test', 'When a buffed friendly unit dies, buff another friendly unit. (If it doesn\'t have a buff, it gets a +1 :rb_might: buff.)', { type: 'gear', energy: 0, power: {} })
    // A buffed unit dies → another friendly gets a +1 buff.
    let s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(helm, 0))
    const buffed = mk(furyUnit.id, 0, { buffs: 1 })
    const ally = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(buffed, ally)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: buffed.iid })
    expect(r.state.battlefields[0].units.find((u) => u.iid === ally.iid)?.buffs).toBe(1)
    // An UNbuffed unit dies → no buff (the "buffed" qualifier isn't met).
    s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(helm, 0))
    const plain = mk(furyUnit.id, 0)
    const ally2 = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(plain, ally2)
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: plain.iid })
    expect(r.state.battlefields[0].units.find((u) => u.iid === ally2.iid)?.buffs ?? 0).toBe(0)
  })

  // --- Tag-scoped Might auras ---
  it('Rumble - Scrapper: your Mechs have +1 Might (including itself)', () => {
    const rumble = injectCard('rs-test', 'Your Mechs have +1 :rb_might: (including me).', { name: 'Rumble - Scrapper', might: 4, tags: ['Mech'] })
    const mech = injectCard('rs-mech', 'A unit.', { might: 3, tags: ['Mech'] })
    const nonmech = injectCard('rs-non', 'A unit.', { might: 3, tags: [] })
    const s = baseState()
    const r1 = mk(rumble, 0), m = mk(mech, 0), nm = mk(nonmech, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [r1, m, nm], controller: 0 }
    expect(combatMightAt(s, 0, m, 'attacker')).toBe(4) // 3 + 1
    expect(combatMightAt(s, 0, r1, 'attacker')).toBe(5) // 4 + 1 (including me)
    expect(combatMightAt(s, 0, nm, 'attacker')).toBe(3) // non-Mech unaffected
  })

  it('Captain Farron: other friendly units here have [Assault] (+1 Might attacking) (Gap 7)', () => {
    const farron = injectCard('farron-t', 'Other friendly units here have [Assault]. (+1 :rb_might: while they are attackers.)', { name: 'Captain Farron', might: 4 })
    const ally = injectCard('farron-ally', 'A unit.', { might: 3 })
    const s = baseState()
    const f = mk(farron, 0), a = mk(ally, 0), enemy = mk(ally, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [f, a, enemy], controller: 0 }
    expect(combatMightAt(s, 0, a, 'attacker')).toBe(4) // 3 + 1 (Assault granted)
    expect(combatMightAt(s, 0, a, 'defender')).toBe(3) // Assault only helps attackers
    expect(combatMightAt(s, 0, f, 'attacker')).toBe(4) // self excluded ("other")
    expect(combatMightAt(s, 0, enemy, 'attacker')).toBe(3) // enemy unaffected
  })

  it('Taric - Protector: other friendly units here have [Shield] (+1 Might defending) (Gap 7)', () => {
    const taric = injectCard('taric-t', '[Shield] [Tank] Other friendly units here have [Shield].', { name: 'Taric - Protector', might: 4 })
    const ally = injectCard('taric-ally', 'A unit.', { might: 3 })
    const s = baseState()
    const t = mk(taric, 0), a = mk(ally, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [t, a], controller: 0 }
    expect(combatMightAt(s, 0, a, 'defender')).toBe(4) // 3 + 1 (Shield granted)
    expect(combatMightAt(s, 0, a, 'attacker')).toBe(3) // Shield only helps defenders
  })

  it('Danger Zone: gives your Mechs +1 Might this turn (tag-scoped)', () => {
    const dz = injectCard('dz-test', 'When you play me, give your Mechs +1 :rb_might: this turn.', { type: 'unit', energy: 0, power: {} })
    const mech = mk(injectCard('dz-mech', 'A unit.', { tags: ['Mech'] }), 0)
    const nonmech = mk(injectCard('dz-non', 'A unit.', { tags: [] }), 0)
    const s = baseState()
    s.players[0].zones.base.push(mech, nonmech)
    const u = mk(dz, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.find((x) => x.iid === mech.iid)?.tempMight).toBe(1)
    expect(r.state.players[0].zones.base.find((x) => x.iid === nonmech.iid)?.tempMight ?? 0).toBe(0)
  })

  it('Master Yi - Wuju Master (legend): your units have +1 Might while at 6+ XP', () => {
    const myi = injectCard('myi-test', '[Level 6][>] Your units have +1 :rb_might:.', { name: 'Master Yi - Wuju Master' })
    const unit = injectCard('myi-u', 'A unit.', { might: 3 })
    const s = baseState()
    s.players[0].legend = mk(myi, 0)
    const u = mk(unit, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    s.players[0].xp = 5
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(3) // below 6 XP → no aura
    s.players[0].xp = 6
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(4) // 6+ XP → +1
  })

  // --- Mech subsystem ---
  it('Mech token: "play a 3 Might Mech unit token" creates a tagged Mech', () => {
    const maker = injectCard('mt-maker', 'When you play me, play a 3 :rb_might: Mech unit token to your base.', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    const u = mk(maker, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    const tok = r.state.players[0].zones.base.find((c) => (CARD_INDEX[c.cardId]?.tags ?? []).includes('Mech') && c.cardId !== maker)
    expect(tok).toBeTruthy()
    expect((CARD_INDEX[tok!.cardId] as { might?: number })?.might).toBe(3)
  })

  it('Rumble - Mechanized Menace: your Mechs have [Shield] (+1 while defending)', () => {
    const menace = injectCard('mm-test', 'Your Mechs have [Shield]. (+1 :rb_might: while they\'re defenders.)', { name: 'Rumble - Mechanized Menace' })
    const mech = injectCard('mm-mech', 'A unit.', { might: 3, tags: ['Mech'] })
    const s = baseState()
    const m = mk(mech, 0)
    s.players[0].zones.base.push(mk(menace, 0))
    s.battlefields[0] = { cardId: battlefield.id, units: [m], controller: 0 }
    expect(combatMightAt(s, 0, m, 'defender')).toBe(4) // +1 Shield
    expect(combatMightAt(s, 0, m, 'attacker')).toBe(3) // Shield doesn't apply on attack
  })

  it('Rumble - Hotheaded: your Mechs each have [Assault] (+1 while attacking)', () => {
    const hot = injectCard('hh-test', 'Your Mechs each have [Assault]. (+1 :rb_might: while we\'re attackers.)', { name: 'Rumble - Hotheaded', tags: ['Mech'] })
    const mech = injectCard('hh-mech', 'A unit.', { might: 3, tags: ['Mech'] })
    const s = baseState()
    const m = mk(mech, 0)
    s.players[0].zones.base.push(mk(hot, 0))
    s.battlefields[0] = { cardId: battlefield.id, units: [m], controller: 0 }
    expect(combatMightAt(s, 0, m, 'attacker')).toBe(4) // +1 Assault
    expect(combatMightAt(s, 0, m, 'defender')).toBe(3)
  })

  it('Forecaster: your Mechs have [Vision] — playing a Mech peeks the deck', () => {
    const forecaster = injectCard('fc-test', 'Your Mechs have [Vision]. (When you play us, look at the top card of your Main Deck. You may recycle it.)', { name: 'Forecaster', tags: ['Mech'] })
    const mech = injectCard('fc-mech', 'A unit.', { type: 'unit', energy: 0, power: {}, tags: ['Mech'] })
    const s = baseState()
    s.players[0].zones.base.push(mk(forecaster, 0))
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    const u = mk(mech, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.vision?.player).toBe(0) // Vision peek surfaced
  })

  it('Breakneck Mech: your Mechs have [Ganking] — a Mech can move battlefield-to-battlefield', () => {
    const breakneck = injectCard('bn-test', 'Your Mechs have [Deflect] and [Ganking].', { name: 'Breakneck Mech', tags: ['Mech'] })
    const mech = injectCard('bn-mech', 'A unit.', { might: 3, tags: ['Mech'] })
    // With Breakneck in play → the Mech can gank bf0 → bf1.
    let s = baseState()
    s.players[0].zones.base.push(mk(breakneck, 0))
    const m = mk(mech, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [m], controller: 0 }
    let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [m.iid], toBattlefield: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[1].units.some((x) => x.iid === m.iid)).toBe(true)
    // Without Breakneck → the move is rejected (no Ganking).
    s = baseState()
    const m2 = mk(mech, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [m2], controller: 0 }
    r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [m2.iid], toBattlefield: 1 })
    expect(r.error).toBeTruthy()
  })

  it('Raging Soul: [Assault]/[Ganking] gated on having discarded this turn (Gap 8)', () => {
    const rs = injectCard('raging-soul-t', "If you've discarded a card this turn, I have [Assault] and [Ganking]. (+1 :rb_might: while I'm an attacker.)", { name: 'Raging Soul', might: 4 })
    const s = baseState()
    const u = mk(rs, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    // Not discarded → no Assault bonus.
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(4)
    // Discarded this turn → +1 Might attacking.
    s.players[0].discardedThisTurn = true
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(5)
    // Ganking gated likewise: with the discard, it can move bf-to-bf.
    let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [u.iid], toBattlefield: 1 })
    expect(r.error).toBeFalsy()
    // Without the discard → the bf-to-bf move is rejected.
    const s2 = baseState()
    const u2 = mk(rs, 0)
    s2.battlefields[0] = { cardId: battlefield.id, units: [u2], controller: 0 }
    r = reduce(s2, { type: 'MOVE_UNITS', player: 0, iids: [u2.iid], toBattlefield: 1 })
    expect(r.error).toBeTruthy()
  })

  it('Ancient Warmonger: [Assault] equal to the number of enemy units here (Gap 8)', () => {
    const aw = injectCard('ancient-warmonger-t', "I have [Assault] equal to the number of enemy units here. (+1 :rb_might: while I'm an attacker for each instance of Assault.)", { name: 'Ancient Warmonger', might: 4 })
    const grunt = injectCard('aw-grunt', 'A unit.', { might: 1 })
    const s = baseState()
    const u = mk(aw, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u, mk(grunt, 1), mk(grunt, 1)], controller: 0 }
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(6) // 4 + 2 enemies
    // No enemies here → no Assault.
    const s2 = baseState()
    const u2 = mk(aw, 0)
    s2.battlefields[0] = { cardId: battlefield.id, units: [u2], controller: 0 }
    expect(combatMightAt(s2, 0, u2, 'attacker')).toBe(4)
  })

  it('Bubble Bot: readies another friendly Mech when played', () => {
    const bot = injectCard('bb-test', 'When you play me, ready another friendly Mech.', { name: 'Bubble Bot', type: 'unit', energy: 0, power: {}, tags: ['Mech'] })
    const otherMech = injectCard('bb-mech', 'A unit.', { tags: ['Mech'] })
    const s = baseState()
    const exhaustedMech = mk(otherMech, 0, { exhausted: true })
    s.players[0].zones.base.push(exhaustedMech)
    const u = mk(bot, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.find((x) => x.iid === exhaustedMech.iid)?.exhausted).toBe(false)
  })

  it('Rumble - Hotheaded: on conquer, recycles a spare unit to play a stronger Mech from trash', () => {
    const hot = injectCard('hh2-test', 'When I conquer, you may recycle another friendly unit to play a Mech from your trash. Reduce its Energy cost by the Might of the unit you recycled.', { name: 'Rumble - Hotheaded', type: 'unit', energy: 0, power: {}, might: 4, tags: ['Mech'] })
    const trashMech = injectCard('hh2-mech', 'A unit.', { energy: 3, power: {}, might: 5, tags: ['Mech'] })
    const spare = injectCard('hh2-spare', 'A unit.', { energy: 3, power: {}, might: 3 })
    const s = baseState()
    const rumble = mk(hot, 0)
    const spareU = mk(spare, 0)
    s.players[0].zones.base.push(rumble, spareU)
    s.players[0].zones.trash.push(mk(trashMech, 0))
    // Move Rumble onto an empty battlefield → conquers it → conquer trigger fires.
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [rumble.iid], toBattlefield: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === trashMech)).toBe(false) // Mech left trash
    expect(r.state.players[0].zones.base.some((c) => c.cardId === trashMech)).toBe(true) // played to base
    expect(r.state.players[0].zones.mainDeck.some((c) => c.cardId === spare)).toBe(true) // spare recycled
  })

  // --- Gap 1: conditional enter-ready ---
  const playReady = (s: MatchState, u: EngineCard) => {
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    return r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted
  }

  it('enter-ready guard: "if you control another <Tag>" (Direwing / Breakneck Mech)', () => {
    const dire = injectCard('cr-dire', 'I enter ready if you control another Dragon.', { type: 'unit', energy: 0, power: {}, tags: ['Dragon'] })
    const dragon = injectCard('cr-dragon', 'A unit.', { tags: ['Dragon'] })
    let s = baseState()
    s.players[0].zones.base.push(mk(dragon, 0))
    expect(playReady(s, mk(dire, 0))).toBe(false) // another Dragon → ready
    s = baseState()
    expect(playReady(s, mk(dire, 0))).toBe(true) // no other Dragon → exhausted
  })

  it('enter-ready guard: "if a unit died this turn" (Towering Pairofant)', () => {
    const tow = injectCard('cr-tow', 'If a unit died this turn, I enter ready.', { type: 'unit', energy: 0, power: {} })
    let s = baseState()
    s.unitDiedThisTurn = true
    expect(playReady(s, mk(tow, 0))).toBe(false) // a death occurred → ready
    s = baseState()
    expect(playReady(s, mk(tow, 0))).toBe(true) // none → exhausted
  })

  it('enter-ready guard: "if you have two or fewer cards in your hand" (Dunebreaker)', () => {
    const dune = injectCard('cr-dune', 'If you have two or fewer cards in your hand, I enter ready.', { type: 'unit', energy: 0, power: {} })
    let s = baseState()
    s.players[0].zones.hand.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0)) // after playing Dunebreaker → 2 left
    expect(playReady(s, mk(dune, 0))).toBe(false)
    s = baseState()
    s.players[0].zones.hand.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0)) // → 3 left
    expect(playReady(s, mk(dune, 0))).toBe(true)
  })

  it('enter-ready guard: "if an opponent controls a battlefield" (Vayne - Hunter)', () => {
    const vayne = injectCard('cr-vayne', 'If an opponent controls a battlefield, I enter ready.', { type: 'unit', energy: 0, power: {} })
    let s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 1)], controller: 1 }
    expect(playReady(s, mk(vayne, 0))).toBe(false) // opponent holds a bf → ready
    s = baseState()
    expect(playReady(s, mk(vayne, 0))).toBe(true) // no opponent bf → exhausted
  })

  it('enter-ready: unconditional "I enter ready" still always enters ready (no regression)', () => {
    const plain = injectCard('cr-plain', 'I enter ready.', { type: 'unit', energy: 0, power: {} })
    expect(playReady(baseState(), mk(plain, 0))).toBe(false)
  })

  // --- Gap 2: tribe/tag counting & conditions ---
  it('Poro Herder: buffs self + draws only if you control a Poro', () => {
    const ph = injectCard('ph-test', 'When you play me, if you control a Poro, buff me and draw 1.', { type: 'unit', energy: 0, power: {} })
    const poro = injectCard('ph-poro', 'A unit.', { tags: ['Poro'] })
    let s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.players[0].zones.base.push(mk(poro, 0))
    let u = mk(ph, 0)
    s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.buffs).toBe(1)
    expect(r.state.players[0].zones.hand.length).toBe(1)
    s = baseState() // no Poro
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    u = mk(ph, 0)
    s.players[0].zones.hand.push(u)
    r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.buffs ?? 0).toBe(0)
    expect(r.state.players[0].zones.hand.length).toBe(0)
  })

  it('Friendship: gives a unit +1 Might per distinct tribe tag among your units', () => {
    const fr = injectCard('fr-test', 'Choose a unit. Give it +1 :rb_might: this turn for each of the following tags among your units — Bird, Cat, Dog, and Poro.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('fr-bird', 'A unit.', { tags: ['Bird'] }), 0), mk(injectCard('fr-cat', 'A unit.', { tags: ['Cat'] }), 0))
    const target = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(target)
    const sp = mk(fr, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [target.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.find((x) => x.iid === target.iid)?.tempMight).toBe(2) // 2 distinct tribes
  })

  it('Flurry of Feathers: plays four Bird tokens', () => {
    const fl = injectCard('fl-test', 'When you play me, play four 1 :rb_might: Bird unit tokens with [Deflect].', { type: 'unit', energy: 0, power: {} })
    const s = baseState()
    const u = mk(fl, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.players[0].zones.base.filter((c) => c.cardId === 'tok-bird').length).toBe(4)
  })

  it('Unsung Hero: Deathknell draws 2 only if it was Mighty (5+ Might)', () => {
    const mighty = injectCard('uh-m', '[Deathknell] — If I was [Mighty], draw 2.', { might: 5 })
    const weak = injectCard('uh-w', '[Deathknell] — If I was [Mighty], draw 2.', { might: 3 })
    let s = baseState()
    s.sandbox = true
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    let u = mk(mighty, 0)
    s.battlefields[0].units.push(u)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.state.players[0].zones.hand.length).toBe(2) // was Mighty → drew 2
    s = baseState()
    s.sandbox = true
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    u = mk(weak, 0)
    s.battlefields[0].units.push(u)
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.state.players[0].zones.hand.length).toBe(0) // not Mighty → no draw
  })

  it('Lonely / Loyal Poro: Deathknell gated on dying alone vs not alone', () => {
    const lonely = injectCard('lonely-test', '[Deathknell] — If I died alone, draw 1.', {})
    const loyal = injectCard('loyal-test', '[Deathknell] — If I didn\'t die alone, draw 1.', {})
    // Lonely, alone → draws.
    let s = baseState()
    s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    let u = mk(lonely, 0)
    s.battlefields[0].units.push(u)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.state.players[0].zones.hand.length).toBe(1)
    // Lonely, with an ally here → no draw.
    s = baseState()
    s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    u = mk(lonely, 0)
    s.battlefields[0].units.push(u, mk(furyUnit.id, 0))
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.state.players[0].zones.hand.length).toBe(0)
    // Loyal, with an ally here → draws.
    s = baseState()
    s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    u = mk(loyal, 0)
    s.battlefields[0].units.push(u, mk(furyUnit.id, 0))
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.state.players[0].zones.hand.length).toBe(1)
  })

  it('Ivern - Friend to All: conquer scores 1 only with all 4 tribe tags', () => {
    const iv = injectCard('iv-fta', 'When I conquer, score 1 point if your units have all of the following tags among them — Bird, Cat, Dog, and Poro.', { type: 'unit', energy: 0, power: {}, might: 3 })
    const tribes = ['Bird', 'Cat', 'Dog', 'Poro'].map((t) => injectCard('iv-' + t, 'A unit.', { tags: [t] }))
    const run = (withAll: boolean) => {
      const s = baseState()
      for (const t of withAll ? tribes : tribes.slice(0, 3)) s.players[0].zones.base.push(mk(t, 0))
      const ivern = mk(iv, 0)
      s.players[0].zones.base.push(ivern)
      s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null } // empty → conquer
      return reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [ivern.iid], toBattlefield: 0 }).state.players[0].points
    }
    expect(run(true) - run(false)).toBe(1) // the all-4-tags score adds exactly 1
  })

  // --- Gap 3: effectiveCostOf cost-reduction shapes ---
  it('Herald of Scales: your Dragons cost 2 less (minimum 1)', () => {
    const herald = injectCard('hs-test', "Your Dragons' Energy costs are reduced by :rb_energy_2:, to a minimum of :rb_energy_1:.", { tags: ['Mount Targon'] })
    const d4 = injectCard('hs-d4', 'A unit.', { energy: 4, tags: ['Dragon'] })
    const d2 = injectCard('hs-d2', 'A unit.', { energy: 2, tags: ['Dragon'] })
    const nd = injectCard('hs-nd', 'A unit.', { energy: 4, tags: [] })
    const s = baseState()
    s.players[0].zones.base.push(mk(herald, 0))
    expect(effectiveCostOf(s, 0, CARD_INDEX[d4]).energy).toBe(2) // 4 - 2
    expect(effectiveCostOf(s, 0, CARD_INDEX[d2]).energy).toBe(1) // 2 - 2, floored at 1
    expect(effectiveCostOf(s, 0, CARD_INDEX[nd]).energy).toBe(4) // non-Dragon unaffected
  })

  it('Undying Loyalty: costs 2 less if a tribe unit is in your trash', () => {
    const ul = injectCard('ul-test', 'This costs :rb_energy_2: less if you choose a Bird, Cat, Dog, or Poro. Play a unit with cost no more than :rb_energy_2: from your trash, ignoring its cost.', { type: 'spell', energy: 2, power: {} })
    let s = baseState()
    s.players[0].zones.trash.push(mk(injectCard('ul-bird', 'A unit.', { tags: ['Bird'] }), 0))
    expect(effectiveCostOf(s, 0, CARD_INDEX[ul]).energy).toBe(0) // 2 - 2
    s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[ul]).energy).toBe(2) // no tribe unit in trash
  })

  it('Daisy!: cost reduced by 1 per distinct tribe tag among your units', () => {
    const daisy = injectCard('dz-daisy', 'I enter ready. Reduce my cost by :rb_energy_1: for each of the following tags among your units — Bird, Cat, Dog, and Poro.', { energy: 9 })
    let s = baseState()
    s.players[0].zones.base.push(mk(injectCard('dz-b', 'A unit.', { tags: ['Bird'] }), 0), mk(injectCard('dz-c', 'A unit.', { tags: ['Cat'] }), 0))
    expect(effectiveCostOf(s, 0, CARD_INDEX[daisy]).energy).toBe(7) // 9 - 2
    s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[daisy]).energy).toBe(9)
  })

  it('Smite: a unit killed by the damage is banished instead of trashed', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) => ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    expect(spellEffect(mkCard('Deal 3 to a unit at a battlefield. If it would die this turn, banish it instead.')).banishOnDeath).toBe(true)
    const smite = injectCard('smite-test', 'Deal 3 to a unit at a battlefield. If it would die this turn, banish it instead.', { type: 'spell', energy: 0, power: {} })
    const targetId = injectCard('smite-target', 'A unit.', { might: 2 })
    const s = baseState()
    const enemy = mk(targetId, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const sp = mk(smite, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.some((x) => x.iid === enemy.iid)).toBe(false)
    expect(r.state.players[1].banished.some((x) => x.iid === enemy.iid)).toBe(true)
    expect(r.state.players[1].zones.trash.some((x) => x.iid === enemy.iid)).toBe(false)
  })

  it('Karthus - Eternal: a Deathknell fires an additional time (draw 1 → draw 2)', () => {
    const karthus = injectCard('karthus-test', 'Your [Deathknell] effects trigger an additional time.', { might: 5 })
    const sentry = injectCard('sentry-test', '[Deathknell] — Draw 1. (When I die, get the effect.)', { might: 1 })
    const s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(karthus, 0))
    const sentryU = mk(sentry, 0)
    s.battlefields[0].units.push(sentryU)
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: sentryU.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(2) // Deathknell doubled
  })

  it('Karthus - Eternal: its static "[Deathknell]" reference is not its own Deathknell', async () => {
    const { parseKeywords } = await import('./keywords')
    const { parseTriggers } = await import('./triggers')
    const karthus = CARD_INDEX['ogn-236-298']
    if (!karthus) return // dataset lacks Karthus - Eternal
    // The "Your [Deathknell] effects …" reference must not flag Karthus himself.
    expect(parseKeywords(karthus).deathknell).toBe(false)
    expect(parseTriggers(karthus).some((t) => t.event === 'death')).toBe(false)
    // Karthus dying produces no spurious "Deathknell …" log line.
    const s = baseState()
    s.sandbox = true
    const k = mk(karthus.id, 0)
    s.battlefields[0].units.push(k)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: k.iid })
    expect(r.state.log.some((l) => /Deathknell/i.test(l.text))).toBe(false)
  })

  it('Karthus doubling targets only its controller\'s Deathknells, not an enemy\'s', () => {
    const karthus = injectCard('karthus-scope', 'Your [Deathknell] effects trigger an additional time.', { might: 5 })
    const sentry = injectCard('sentry-scope', '[Deathknell] — Draw 1. (When I die, get the effect.)', { might: 1 })
    const s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(karthus, 0)) // P0 has Karthus
    const enemySentry = mk(sentry, 1) // an ENEMY Deathknell unit
    s.battlefields[0].units.push(enemySentry)
    for (let i = 0; i < 4; i++) s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: enemySentry.iid })
    expect(r.state.players[1].zones.hand.length).toBe(1) // not doubled by my Karthus
  })

  it('Karthus absent: the same Deathknell fires once (draw 1)', () => {
    const sentry = injectCard('sentry-test2', '[Deathknell] — Draw 1. (When I die, get the effect.)', { might: 1 })
    const s = baseState()
    s.sandbox = true
    const sentryU = mk(sentry, 0)
    s.battlefields[0].units.push(sentryU)
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: sentryU.iid })
    expect(r.state.players[0].zones.hand.length).toBe(1)
  })

  it('Sivir - Battle Mistress: readies when an enemy unit dies', () => {
    const sivir = injectCard('sivir-test', 'When one or more enemy units die, ready me.', { type: 'legend' })
    const s = baseState()
    s.sandbox = true
    s.players[0].legend = mk(sivir, 0, { exhausted: true })
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(enemy)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: enemy.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].legend?.exhausted).toBe(false) // readied
  })

  it('Pyke - Returned: makes a Gold token on an enemy death, only while at a battlefield', () => {
    if (!GOLD_TOKEN_ID) return // dataset has no Gold token
    const pyke = injectCard('pyke-test', "Once each turn, when an enemy unit dies while I'm at a battlefield, play a Gold gear token exhausted.", { might: 4 })
    const goldCount = (st: MatchState) => st.players[0].zones.base.filter((u) => u.cardId === GOLD_TOKEN_ID).length
    // Pyke at a battlefield → token created.
    let s = baseState()
    s.sandbox = true
    s.battlefields[0].units.push(mk(pyke, 0))
    let enemy = mk(furyUnit.id, 1)
    s.battlefields[1].units.push(enemy)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: enemy.iid })
    expect(goldCount(r.state)).toBe(1)
    // Pyke in base (not at a battlefield) → no token.
    s = baseState()
    s.sandbox = true
    s.players[0].zones.base.push(mk(pyke, 0))
    enemy = mk(furyUnit.id, 1)
    s.battlefields[1].units.push(enemy)
    r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: enemy.iid })
    expect(goldCount(r.state)).toBe(0)
  })

  it('auto-parses named token creation (Sand Soldier / Bird / Mech)', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) =>
      ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    const sand = spellEffect(mkCard('Play a 2 :rb_might: Sand Soldier unit token.')).namedToken
    expect(sand).toEqual({ name: 'sand soldier', count: 1, exhausted: true, temporary: false, here: false, opponent: false })
    const bird = spellEffect(mkCard('Play three Bird unit tokens.')).namedToken
    expect(bird).toEqual({ name: 'bird', count: 3, exhausted: true, temporary: false, here: false, opponent: false })
    const mech = spellEffect(mkCard('Play a ready 3 :rb_might: Mech unit token.')).namedToken
    expect(mech).toEqual({ name: 'mech', count: 1, exhausted: false, temporary: false, here: false, opponent: false })
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

  it('HIDE places a [Hidden] card from hand facedown at a controlled battlefield, recycling a rune', () => {
    const hid = injectCard('d-hidden', '[Hidden]', { type: 'spell', energy: 1, power: {} })
    const s = baseState()
    s.battlefields[0].controller = 0
    const hu = mk(hid, 0)
    s.players[0].zones.hand.push(hu) // hidden from HAND now
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hu.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].facedown?.iid).toBe(hu.iid) // in the Facedown slot, not units
    expect(r.state.battlefields[0].facedown?.facedown).toBe(true)
    expect(r.state.battlefields[0].units.some((u) => u.iid === hu.iid)).toBe(false)
    expect(r.state.players[0].zones.hand.some((u) => u.iid === hu.iid)).toBe(false)
    expect(r.state.players[0].zones.runeDeck.some((c) => c.iid === rune.iid)).toBe(true)
  })

  it('rejects HIDE for a non-Hidden card', () => {
    const s = baseState()
    s.battlefields[0].controller = 0
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(u)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: u.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeDefined()
  })

  it('REVEAL plays a facedown unit into play (next turn); not the turn it was hidden', () => {
    const hid = injectCard('d-hidden-unit', '[Hidden]', { type: 'unit', might: 3, energy: 0, power: {} })
    const s = baseState()
    s.turn = 5
    const u = mk(hid, 0, { facedown: true, hiddenTurn: 5 })
    s.battlefields[0].facedown = u
    // Same turn → can't reveal.
    expect(reduce(s, { type: 'REVEAL', player: 0, iid: u.iid }).error).toBeTruthy()
    // A later turn → reveal plays it faceup into the battlefield.
    s.turn = 6
    const r = reduce(s, { type: 'REVEAL', player: 0, iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].facedown).toBeNull()
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid && !x.facedown)).toBe(true)
  })

  it('Teemo - Swift Scout: hide pays 1 Energy (rune exhausted & kept), not recycled', () => {
    const hid = injectCard('d-hidden-teemo', '[Hidden]', { type: 'spell', energy: 1, power: {} })
    const s = baseState()
    s.battlefields[0].controller = 0
    s.players[0].legend = mk('ogn-263-298', 0) // Teemo - Swift Scout
    const hu = mk(hid, 0)
    s.players[0].zones.hand.push(hu)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hu.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeFalsy()
    // Rune stays in the pool (exhausted), not recycled to the rune deck.
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === rune.iid)?.exhausted).toBe(true)
    expect(r.state.players[0].zones.runeDeck.some((x) => x.iid === rune.iid)).toBe(false)
    expect(r.state.battlefields[0].facedown?.iid).toBe(hu.iid)
  })

  it('removes an unsupported facedown card at begin turn (owner no longer controls)', () => {
    const hid = injectCard('d-hidden2', '[Hidden]', { type: 'spell', energy: 1, power: {} })
    const s = baseState()
    s.activePlayer = 0
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    // p0 has a facedown card here, but p1 controls the battlefield (2 units).
    s.battlefields[0].facedown = mk(hid, 0, { facedown: true, hiddenTurn: 0 })
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    s.battlefields[0].units.push(mk(furyUnit.id, 1, { exhausted: true }))
    const after = beginTurn(s)
    expect(after.battlefields[0].facedown).toBeNull()
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
  it('PLAY_GEAR: normal gear lands on base unattached; only attach-on-play gear equips from hand', () => {
    const normal = injectCard('f-gear', '+1 Might', { type: 'gear' })
    const qd = injectCard('f-gear-qd', '[Quick-Draw] +1 Might', { type: 'gear' })
    const s = baseState()
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    const gN = mk(normal, 0), gQ = mk(qd, 0)
    s.players[0].zones.hand.push(gN, gQ)
    // Normal gear ignores the target and goes to base UNATTACHED (no cost bypass);
    // attaching it requires a separate ATTACH that pays the [Equip] cost.
    let r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: gN.iid, payment: emptyPayment(), targetIid: u.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => x.iid === gN.iid && x.attached.length === 0)).toBe(true)
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.attached.length).toBe(0)
    // [Quick-Draw] gear DOES attach to the chosen unit on play.
    r = reduce(r.state, { type: 'PLAY_GEAR', player: 0, iid: gQ.iid, payment: emptyPayment(), targetIid: u.iid })
    expect(r.error).toBeUndefined()
    const eq = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(eq?.attached.some((a) => a.startsWith(`${qd}|`))).toBe(true)
  })

  it('Forge of the Future: gear on-play creates a Recruit token (Gap 10)', () => {
    const gear = injectCard('forge-future-t', 'When you play this, play a 1 :rb_might: Recruit unit token at your base.Kill this: Recycle up to 4 cards from trashes.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.filter((x) => x.cardId === TOKEN_PILE_IDS[0] && x.owner === 0).length).toBe(1)
  })

  it("Shurelya's Requiem: gear on-play readies all your units (Gap 10)", () => {
    const gear = injectCard('shurelya-t', '[Equip] :rb_rune_rainbow:. When you play this, ready your units.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const u1 = mk(furyUnit.id, 0, { exhausted: true })
    const u2 = mk(furyUnit.id, 0, { exhausted: true })
    s.players[0].zones.base.push(u1, u2)
    const g = mk(gear, 0)
    s.players[0].zones.hand.push(g)
    const r = reduce(s, { type: 'PLAY_GEAR', player: 0, iid: g.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.filter((x) => (x.iid === u1.iid || x.iid === u2.iid) && !x.exhausted).length).toBe(2)
  })

  it('Edge of Night: reveal from facedown auto-attaches to a friendly unit here (Gap 10)', () => {
    const gear = injectCard('edge-of-night-t', '[Hidden] When you play this from face down, attach it to a unit you control (here). [Equip] :rb_rune_chaos:.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.turn = 5
    const host = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [host], controller: 0 }
    const g = mk(gear, 0, { facedown: true, hiddenTurn: 4 })
    s.battlefields[0].facedown = g
    const r = reduce(s, { type: 'REVEAL', player: 0, iid: g.iid })
    expect(r.error).toBeFalsy()
    const h = r.state.battlefields[0].units.find((x) => x.iid === host.iid)
    expect(h?.attached.some((a) => a.startsWith(`${gear}|`))).toBe(true)
    expect(r.state.players[0].zones.base.some((x) => x.iid === g.iid)).toBe(false) // not unattached at base
  })

  it('Gutter Palace: "Discard 1, exhaust" activated ability — discard cost gated & paid (Gap 10)', () => {
    const gear = injectCard('gutter-palace-t', 'Discard 1, :rb_exhaust:: Play a 1 :rb_might: Bird unit token with [Deflect].', { type: 'gear', energy: 0, power: {} })
    const ab = unitActivatedAbility(CARD_INDEX[gear] as never)
    expect(ab?.discard).toBe(1)
    const s = baseState()
    const g = mk(gear, 0)
    s.players[0].zones.base.push(g)
    // Empty hand → can't pay the discard cost.
    expect(canActivateUnit(s, 0, g.iid)).toBeNull()
    // With a card in hand → activates, discards it, plays a Bird token.
    s.players[0].zones.hand.push(mk(furyUnit.id, 0))
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: g.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(0)
    expect(r.state.players[0].zones.base.some((x) => x.cardId === TOKEN_BY_NAME['bird'] && x.owner === 0)).toBe(true)
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

  it('parses a "when you stun an enemy unit" trigger', async () => {
    const { parseTriggers } = await import('./triggers')
    const card = { id: 'stun-trig-card', name: 'S', type: 'unit', domains: [], rarity: 'common', set: 'X', number: 1, text: 'When you stun an enemy unit, ready me and give me +1 :rb_might: this turn.', energy: 0, power: {}, might: 3 } as never
    expect(parseTriggers(card).some((t) => t.event === 'stun')).toBe(true)
  })

  // Helper: play a 0-cost stun spell on an enemy and resolve the chain.
  function stunEnemy(s: MatchState, spellText: string, enemyIid: string) {
    const spellId = injectCard(`stun-sp-${n++}`, spellText, { type: 'spell', energy: 0, power: {} })
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemyIid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    return reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
  }

  it('Eclipse Herald: readies + gains +1 Might when you stun an enemy unit', () => {
    const eclipse = injectCard('eclipse-test', 'When you stun an enemy unit, ready me and give me +1 :rb_might: this turn.', { might: 3 })
    const s = baseState()
    const herald = mk(eclipse, 0, { exhausted: true })
    s.players[0].zones.base.push(herald)
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const r = stunEnemy(s, 'Stun an enemy unit.', enemy.iid)
    const h = r.state.players[0].zones.base.find((x) => x.iid === herald.iid)
    expect(h?.exhausted).toBe(false) // readied
    expect(h?.tempMight).toBe(1) // +1 Might this turn
  })

  it('Leona - Radiant Dawn: buffs a friendly unit when you stun an enemy', () => {
    const leona = injectCard('leona-rd-test', 'When you stun one or more enemy units, buff a friendly unit.', { type: 'legend' })
    const s = baseState()
    s.players[0].legend = mk(leona, 0)
    const ally = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(ally)
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const r = stunEnemy(s, 'Stun an enemy unit.', enemy.iid)
    expect(r.state.players[0].zones.base.find((x) => x.iid === ally.iid)?.buffs).toBe(1)
  })

  it('Existential Dread: stuns a unit, or bounces it to hand if already stunned', () => {
    const text = "[Stun] an attacking enemy unit. If it's already stunned, return it to its owner's hand instead."
    // Fresh enemy → stunned (not bounced).
    let s = baseState()
    const fresh = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [fresh], controller: 1 }
    let r = stunEnemy(s, text, fresh.iid)
    expect(r.state.battlefields[0].units.find((u) => u.iid === fresh.iid)?.stunned).toBe(true)
    // Already-stunned enemy → returned to its owner's hand instead.
    s = baseState()
    const already = mk(furyUnit.id, 1, { stunned: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [already], controller: 1 }
    r = stunEnemy(s, text, already.iid)
    expect(r.state.battlefields[0].units.some((u) => u.iid === already.iid)).toBe(false)
    expect(r.state.players[1].zones.hand.some((x) => x.iid === already.iid)).toBe(true)
  })

  it('Monch: costs 2 less when an opponent controls a stunned unit', () => {
    const id = injectCard('monch-test', 'If an opponent controls a stunned unit, I cost :rb_energy_2: less and enter ready.', { energy: 3, power: {} })
    const s = baseState()
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(3) // no stunned enemy
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 1, { stunned: true })], controller: 1 }
    expect(effectiveCostOf(s, 0, CARD_INDEX[id]).energy).toBe(1) // −2
  })

  it('parses move-to-base: scope from text, not mis-tagged on token-spawn', async () => {
    const { spellEffect } = await import('./effects')
    const mkCard = (text: string) => ({ id: 't', name: 'T', type: 'spell', domains: [], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {} }) as never
    const fof = spellEffect(mkCard('Move a unit from a battlefield to its base.'))
    expect(fof.moveToBase).toBe(true)
    expect(fof.battlefieldOnly).toBe(true)
    expect(fof.targetScope).toBe('any')
    expect(spellEffect(mkCard('Move an enemy unit from a battlefield to its base.')).targetScope).toBe('enemy')
    // "play a … token to your base" has no "move" → must NOT be a move-to-base.
    expect(spellEffect(mkCard('Play a 3 :rb_might: Mech unit token to your base.')).moveToBase).toBe(false)
  })

  it('Fight or Flight: moves a chosen battlefield unit to its owner base (exhausted)', () => {
    const spellId = injectCard('fof-test', 'Move a unit from a battlefield to its base.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    // It's a targeted spell.
    expect(getLegalTargets(s, CARD_INDEX[spellId], 0)).toContain(enemy.iid)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(false)
    expect(r.state.players[1].zones.base.some((u) => u.iid === enemy.iid && u.exhausted)).toBe(true)
  })

  it('Charm: moves an enemy unit to a chosen battlefield (destination via pendingChoice)', () => {
    const charm = injectCard('charm-test', 'Move an enemy unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const sp = mk(charm, 0)
    s.players[0].zones.hand.push(sp)
    expect(getLegalTargets(s, CARD_INDEX[charm], 0)).toContain(enemy.iid)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // A destination choice (battlefields other than the current one) is pending.
    expect(r.state.pendingChoice?.kind).toBe('moveToBf')
    expect(r.state.pendingChoice?.options.every((o) => o.iid.startsWith('bf:') && o.iid !== 'bf:0')).toBe(true)
    const dest = r.state.pendingChoice!.options[0].iid
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: dest })
    const destIdx = parseInt(dest.slice(3), 10)
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(false)
    expect(r.state.battlefields[destIdx].units.some((u) => u.iid === enemy.iid)).toBe(true)
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

describe('champion suite — state-aware Might & conditional ready', () => {
  it('Draven - Showboat: Might increased by your points', () => {
    const id = 'ogn-028-298'
    if (!CARD_INDEX[id]) return
    const base = (CARD_INDEX[id] as { might: number }).might
    const s = baseState()
    const d = mk(id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [d], controller: 0 }
    expect(combatMightAt(s, 0, d, 'attacker')).toBe(base)
    s.players[0].points = 3
    expect(combatMightAt(s, 0, d, 'attacker')).toBe(base + 3)
  })

  it('Dr. Mundo - Expert: Might increased by cards in your trash', () => {
    const id = 'ogn-109-298'
    if (!CARD_INDEX[id]) return
    const base = (CARD_INDEX[id] as { might: number }).might
    const s = baseState()
    const m = mk(id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [m], controller: 0 }
    expect(combatMightAt(s, 0, m, 'attacker')).toBe(base)
    s.players[0].zones.trash.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    expect(combatMightAt(s, 0, m, 'attacker')).toBe(base + 2)
  })

  it('Garen - Commander: other friendly units here get +1 Might (not himself)', () => {
    const id = 'ogs-013-024'
    if (!CARD_INDEX[id]) return
    const ally = mk(injectCard('garen-ally', 'A unit.', { might: 2 }), 0)
    const enemy = mk(injectCard('garen-enemy', 'A unit.', { might: 2 }), 1)
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(id, 0), ally, enemy], controller: 0 }
    expect(combatMightAt(s, 0, ally, 'attacker')).toBe(3) // 2 + 1 from Garen
    expect(combatMightAt(s, 0, enemy, 'defender')).toBe(2) // enemy unaffected
  })

  it('Fiora - Peerless: doubles her Might when one-on-one', () => {
    const id = 'sfd-110-221'
    if (!CARD_INDEX[id]) return
    const base = (CARD_INDEX[id] as { might: number }).might
    const s = baseState()
    const f = mk(id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [f, mk(furyUnit.id, 1)], controller: null }
    expect(combatMightAt(s, 0, f, 'attacker')).toBe(base * 2) // 1v1 → doubled
    s.battlefields[0].units.push(mk(furyUnit.id, 1)) // a 2nd enemy → not 1v1
    expect(combatMightAt(s, 0, f, 'attacker')).toBe(base)
  })

  it('Leona - Zealot: enters ready only when an opponent is within 3 of the Victory Score', () => {
    // 0-cost stand-in with Leona's exact conditional-ready text (the real card has
    // an Energy/Power cost; the gating logic is what's under test, verbatim).
    const id = injectCard('leona-ready', "If an opponent's score is within 3 points of the Victory Score, I enter ready.", { type: 'unit', energy: 0, power: {}, might: 4 })
    const play = (oppPoints: number) => {
      const s = baseState()
      s.pointsToWin = 8
      s.players[1].points = oppPoints
      const u = mk(id, 0)
      s.players[0].zones.hand.push(u)
      const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
      expect(r.error).toBeFalsy()
      return r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted
    }
    expect(play(0)).toBe(true) // opponent far from winning → enters exhausted
    expect(play(6)).toBe(false) // opponent at 6/8 (within 3) → enters ready
  })
})

describe('buffs & Might — application + parser coverage', () => {
  it('[Buff] bracket form parses as a buff action (incl. "buff it")', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('[Buff] a friendly unit.').buff).toBe(1)
    expect(parseEffectText('Ready it and [Buff] it.').buff).toBe(1) // Nami - Headstrong
    expect(parseEffectText('Buffed units have [Deflect].').buff).toBe(0) // adjective, not an action
  })

  it('area buff parses with scope; Peak Guardian is self + here', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('Buff all friendly units.').buffAll).toBe('all')
    expect(parseEffectText('[Buff] all units here.').buffAll).toBe('here')
    const peak = parseEffectText('Buff me. Then, if I am at a battlefield, buff all other friendly units there.')
    expect(peak.buffSelf).toBe(true)
    expect(peak.buffAll).toBe('here')
  })

  it('exclude-self on "other"; adjective allowed between determiner and noun', async () => {
    const { parseEffectText } = await import('./effects')
    const kink = parseEffectText('Buff up to two other friendly units.')
    expect(kink.buff).toBe(2)
    expect(kink.buffExcludesSelf).toBe(true)
    expect(parseEffectText('Buff an exhausted friendly unit.').buff).toBe(1)
  })

  it('Sett - Brawler: cost-gated "Spend my buff: Give me +4 this turn" not auto-applied', async () => {
    const { parseEffectText } = await import('./effects')
    const e = parseEffectText("When I'm played, buff me. Spend my buff: Give me +4 :rb_might: this turn.")
    expect(e.buffSelf).toBe(true)
    expect(e.tempMightSelf).toBe(0)
  })

  it('spendBuff detection broadened (its/my/additional cost)', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('Spend its buff to ready it.').spendBuff).toBe(true)
    expect(parseEffectText('You may spend a buff as an additional cost.').spendBuff).toBe(true)
  })

  it('temporary +Might phrasings parse (it / your other units / each)', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('Give it +1 :rb_might: this turn.').tempMight).toBe(1)
    expect(parseEffectText('Give your other units +2 :rb_might: this turn.').tempMightAll).toBe(2)
    const each = parseEffectText('Give two friendly units each +2 :rb_might: this turn.')
    expect(each.tempMight).toBe(2)
    expect(each.targetCount).toBe(2)
  })

  it('[Buff] on-play buffs a friendly unit and respects the 1-buff cap', () => {
    const id = injectCard('buff-onplay', 'When you play me, [Buff] a friendly unit.', { type: 'unit', energy: 0, power: {}, might: 1 })
    const s = baseState()
    const ally = mk(injectCard('buff-ally', 'A unit.', { might: 4 }), 0, { buffs: 0 })
    s.players[0].zones.base.push(ally)
    const u = mk(id, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === ally.iid)?.buffs).toBe(1)
  })

  it('Draven - Showboat reflected in mightBreakdownAt', async () => {
    const { mightBreakdownAt } = await import('./engine')
    const id = 'ogn-028-298'
    if (!CARD_INDEX[id]) return
    const s = baseState()
    const d = mk(id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [d], controller: 0 }
    s.players[0].points = 4
    const bd = mightBreakdownAt(s, 0, d)!
    expect(bd.effective).toBe(bd.base + 4)
    expect(bd.mods).toBe(4)
  })
})

describe('champion suite — HIGH batch (Annie ×2, Sona, Jinx)', () => {
  it('Annie - Fiery: your spell deals +1 bonus damage', () => {
    const annie = 'ogs-001-024'
    if (!CARD_INDEX[annie]) return
    const spellId = injectCard('annie-dmg', 'Deal 2 to a unit.', { type: 'spell', energy: 0, power: {} })
    const targetId = injectCard('annie-tgt', 'A unit.', { might: 10 })
    const cast = (withAnnie: boolean) => {
      const s = baseState()
      if (withAnnie) s.players[0].zones.base.push(mk(annie, 0))
      const enemy = mk(targetId, 1)
      s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
      const sp = mk(spellId, 0)
      s.players[0].zones.hand.push(sp)
      let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
      return r.state.battlefields[0].units.find((u) => u.iid === enemy.iid)?.damage
    }
    expect(cast(false)).toBe(2)
    expect(cast(true)).toBe(3) // +1 Bonus Damage
  })

  it('readyRunes: "ready up to N (friendly) runes" parses', async () => {
    const { parseEffectText } = await import('./effects')
    expect(parseEffectText('Ready up to 4 friendly runes.').readyRunes).toBe(4)
    expect(parseEffectText('At the end of your turn, ready up to 2 runes.').readyRunes).toBe(2)
  })

  it('Sona - Harmonious: EOT readies up to 4 runes only while at a battlefield', () => {
    const sona = 'ogn-073-298'
    if (!CARD_INDEX[sona]) return
    const run = (atBf: boolean) => {
      const s = baseState()
      if (atBf) s.battlefields[0].units.push(mk(sona, 0))
      else s.players[0].zones.base.push(mk(sona, 0))
      for (let i = 0; i < 5; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0, { exhausted: true }))
      const r = reduce(s, { type: 'END_TURN', player: 0 })
      return r.state.players[0].zones.runePool.filter((x) => x.exhausted).length
    }
    expect(run(true)).toBe(1) // 5 − 4 readied
    expect(run(false)).toBe(5) // in base → not at a battlefield → none readied
  })

  it('Annie - Dark Child (legend): EOT readies up to 2 runes', () => {
    const annie = 'ogs-017-024'
    if (!CARD_INDEX[annie]) return
    const s = baseState()
    s.players[0].legend = mk(annie, 0)
    for (let i = 0; i < 5; i++) s.players[0].zones.runePool.push(mk(furyRune.id, 0, { exhausted: true }))
    const r = reduce(s, { type: 'END_TURN', player: 0 })
    expect(r.state.players[0].zones.runePool.filter((x) => x.exhausted).length).toBe(3) // 5 − 2
  })

  it('Jinx - Rebel: recognized as a "when you discard" trigger (ready + +1 Might)', async () => {
    const { parseTriggers } = await import('./triggers')
    const jinx = CARD_INDEX['ogn-202-298']
    if (!jinx) return
    const d = parseTriggers(jinx).find((t) => t.event === 'discard')
    expect(d).toBeTruthy()
    expect(d!.effect.readySelf).toBe(true)
    expect(d!.effect.tempMightSelf).toBe(1)
  })
})

describe('Ivern - Green Father (legend conquer/hold → Brush token)', () => {
  const IVERN_TEXT = 'When you conquer or hold, you may exhaust me to replace that battlefield with a Brush battlefield token.'
  const BRUSH_ID = 'unl-t03-219'

  it('conquer: ready Ivern exhausts and replaces the conquered battlefield with Brush; tribe unit +1 (P4)', () => {
    const ivern = injectCard('ivern-gf-t', IVERN_TEXT, { name: 'Ivern - Green Father', type: 'legend', tags: ['Ivern'] })
    const birdId = injectCard('ivern-bird', 'A unit.', { type: 'unit', might: 2, energy: 0, power: {}, tags: ['Bird'] })
    const s = baseState()
    s.players[0].legend = mk(ivern, 0)
    const bird = mk(birdId, 0)
    s.players[0].zones.base.push(bird)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: bird.iid, toBattlefield: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].cardId).toBe(BRUSH_ID)
    expect(r.state.players[0].legend?.exhausted).toBe(true)
    const birdUnit = r.state.battlefields[0].units.find((u) => u.iid === bird.iid)!
    expect(combatMightAt(r.state, 0, birdUnit, 'defender')).toBe(3) // base 2 + Brush +1
  })

  it('conquer: exhausted Ivern → no swap (P4)', () => {
    const ivern = injectCard('ivern-gf-t2', IVERN_TEXT, { name: 'Ivern - Green Father', type: 'legend', tags: ['Ivern'] })
    const birdId = injectCard('ivern-bird2', 'A unit.', { type: 'unit', might: 2, energy: 0, power: {}, tags: ['Bird'] })
    const s = baseState()
    s.players[0].legend = mk(ivern, 0, { exhausted: true })
    const bird = mk(birdId, 0)
    s.players[0].zones.base.push(bird)
    const orig = s.battlefields[0].cardId
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: bird.iid, toBattlefield: 0 })
    expect(r.state.battlefields[0].cardId).toBe(orig)
  })

  it('hold: ready Ivern replaces a held battlefield with Brush (P4)', () => {
    const ivern = injectCard('ivern-gf-t3', IVERN_TEXT, { name: 'Ivern - Green Father', type: 'legend', tags: ['Ivern'] })
    const birdId = injectCard('ivern-bird3', 'A unit.', { type: 'unit', might: 2, energy: 0, power: {}, tags: ['Bird'] })
    const s = baseState()
    s.activePlayer = 0
    s.players[0].legend = mk(ivern, 0)
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(birdId, 0)], controller: 0 }
    const after = beginTurn(s)
    expect(after.battlefields[0].cardId).toBe(BRUSH_ID)
    expect(after.players[0].legend?.exhausted).toBe(true)
  })
})

describe('Playtest Pass 1 fixes', () => {
  it('First Mate: "ready another unit" excludes itself from the ready choice', () => {
    const fm = injectCard('first-mate-t', 'When you play me, ready another unit.', { name: 'First Mate', type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    const other = mk(furyUnit.id, 0, { exhausted: true })
    s.players[0].zones.base.push(other)
    const f = mk(fm, 0)
    s.players[0].zones.hand.push(f)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: f.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.readyChoice?.excludeIid).toBe(f.iid)
    expect(reduce(r.state, { type: 'READY_UNIT', player: 0, iid: f.iid }).error).toBeTruthy() // can't ready itself
    r = reduce(r.state, { type: 'READY_UNIT', player: 0, iid: other.iid })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === other.iid)?.exhausted).toBe(false)
  })

  it('Amateur Recital: move-to-base offers only your own units', () => {
    const s = baseState()
    s.activePlayer = 0
    s.players[0].zones.mainDeck = [mk(furyUnit.id, 0)]
    s.players[0].zones.runeDeck = [mk(furyRune.id, 0)]
    const mine = mk(furyUnit.id, 0), enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: 'unl-207-219', units: [mine, mk(furyUnit.id, 0), enemy], controller: 0 } // p0 controls (2 vs 1)
    const after = beginTurn(s)
    const pc = after.pendingChoice
    expect(pc?.kind).toBe('moveAnyToBase')
    expect(pc?.options.some((o) => o.iid === enemy.iid)).toBe(false) // enemy not offered
    expect(pc?.options.some((o) => o.iid === mine.iid)).toBe(true)
  })

  it('Bouncing an equipped unit detaches its gear to base exactly once (no double-detach)', () => {
    const spell = injectCard('bounce-t', "Return a unit to its owner's hand.", { type: 'spell', energy: 0, power: {} })
    const gear = injectCard('bounce-gear', 'A gear.', { type: 'gear', energy: 0, power: {} })
    const g = mk(gear, 0)
    const u = mk(furyUnit.id, 0, { attached: [`${gear}|${g.iid}`] })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const sp = mk(spell, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [u.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.filter((x) => x.cardId === gear).length).toBe(1) // gear in base exactly once
    expect(r.state.players[0].zones.hand.some((x) => x.cardId === furyUnit.id)).toBe(true) // unit returned to hand
  })
})

describe('Playtest Pass 2 — gear triggers', () => {
  it('Mask of Foresight: gives +1 Might to a lone attacker even while ATTACHED', () => {
    const mask = injectCard('mask-t', 'When a friendly unit attacks or defends alone, give it +1 :rb_might: this turn.', { type: 'gear', energy: 0, power: {} })
    const vanilla = injectCard('mask-unit', 'A unit.', { might: 3 })
    const g = mk(mask, 0)
    const u = mk(vanilla, 0, { attached: [`${mask}|${g.iid}`] })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 } // alone
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(4) // 3 + 1 (Mask, alone) — works while attached
    s.battlefields[0].units.push(mk(vanilla, 0)) // no longer alone
    expect(combatMightAt(s, 0, u, 'attacker')).toBe(3) // Mask only applies when alone
  })
})

describe('Playtest Pass 2 — combat/conquer detection', () => {
  it('H: conquer is awarded when the defender is bounced mid-showdown', () => {
    const bounce = injectCard('h-bounce', "[Action] Return a unit to its owner's hand.", { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const atk = mk(injectCard('h-atk', 'A unit.', { might: 5 }), 0)
    s.players[0].zones.base.push(atk)
    const def = mk(injectCard('h-def', 'A unit.', { might: 1 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [def], controller: 1 }
    s.players[0].zones.hand.push(mk(bounce, 0))
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: atk.iid, toBattlefield: 0 })
    expect(r.state.phase).toBe('showdown')
    r = reduce(r.state, { type: 'PASS', player: 1 }) // defender passes → p0 priority
    const sp = r.state.players[0].zones.hand.find((c) => c.cardId === bounce)!
    r = reduce(r.state, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [def.iid], payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.some((u) => u.iid === def.iid)).toBe(false) // defender bounced
    // resolve the now one-sided showdown
    for (let i = 0; i < 4 && r.state.phase === 'showdown'; i++) r = reduce(r.state, { type: 'PASS', player: r.state.showdown!.priority })
    expect(r.state.players[0].points).toBeGreaterThan(0) // p0 conquered despite no combat damage
    expect(r.state.battlefields[0].controller).toBe(0)
  })

  it('G: an effect-move (Charm) into a contested battlefield opens a showdown', () => {
    const charm = injectCard('charm-t', 'Move an enemy unit to a battlefield.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 } // p0 holds bf0
    const enemy = mk(injectCard('charm-enemy', 'A unit.', { might: 2 }), 1)
    s.players[1].zones.base.push(enemy)
    s.players[0].zones.hand.push(mk(charm, 0))
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: s.players[0].zones.hand[0].iid, targets: [enemy.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.pendingChoice?.kind).toBe('moveToBf')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'bf:0' })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.some((u) => u.iid === enemy.iid)).toBe(true) // pulled in
    expect(r.state.phase).toBe('showdown') // combat initiated
  })
})

describe('Playtest Pass 2 — optional additional cost (you may pay X to play me)', () => {
  // Clockwork Keeper template: pay 1 rune → draw 1; skip → no draw, no rune spent.
  const TEXT = 'You may pay :rb_rune_fury: as an additional cost to play me. When you play me, if you paid the additional cost, draw 1.'
  function setup() {
    const keeper = injectCard('opt-keeper', TEXT, { type: 'unit', energy: 0, power: {}, might: 3 })
    const s = baseState()
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0)) // cards to draw
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune) // a fury rune to pay the optional cost
    const u = mk(keeper, 0)
    s.players[0].zones.hand.push(u)
    return { s, u, rune }
  }

  it('pays the rune and grants the bonus when opted in', () => {
    const { s, u, rune } = setup()
    const hand0 = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [rune.iid] }, payAdditionalCost: true })
    expect(r.error).toBeUndefined()
    // played (−1 from hand) then drew 1 (+1) → net same count, and a rune was recycled
    expect(r.state.players[0].zones.hand.length).toBe(hand0)
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === rune.iid)).toBe(false) // rune spent
  })

  it('skips the cost and the bonus by default (no free draw)', () => {
    const { s, u, rune } = setup()
    const hand0 = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] } }) // no opt-in
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(hand0 - 1) // played, did NOT draw
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === rune.iid)).toBe(true) // rune NOT spent
  })
})

describe('Playtest Pass 2 — play a unit straight to a battlefield', () => {
  it('places a "play me to a battlefield" unit at the chosen battlefield', () => {
    const blitz = injectCard('ptb-blitz', 'When you play me to a battlefield, deal 1 to an enemy unit.', { type: 'unit', energy: 0, power: {}, might: 4 })
    const s = baseState()
    const u = mk(blitz, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] }, toBattlefield: 1 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.some((x) => x.iid === u.iid)).toBe(true) // at bf1
    expect(r.state.players[0].zones.base.some((x) => x.iid === u.iid)).toBe(false) // not in base
  })

  it('opens a showdown when played into a contested battlefield', () => {
    const blitz = injectCard('ptb-blitz2', 'When you play me to a battlefield, deal 1 to an enemy unit.', { type: 'unit', energy: 0, power: {}, might: 4 })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('ptb-def', 'A unit.', { type: 'unit', might: 2 }), 1)], controller: 1 }
    const u = mk(blitz, 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] }, toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.phase).toBe('showdown') // becomes present → contested → showdown
  })

  it('ignores toBattlefield for a vanilla unit (still enters base)', () => {
    const s = baseState()
    const u = mk(injectCard('ptb-vanilla', 'A unit.', { type: 'unit', energy: 0, power: {}, might: 4 }), 0)
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [] }, toBattlefield: 1 })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.some((x) => x.iid === u.iid)).toBe(true) // base, not bf1
  })
})

describe('Playtest Pass 2 — equip an unattached gear from base (ATTACH)', () => {
  it('attaches a base gear to a unit and grants its static Might bonus', () => {
    const sword = injectCard('atc-sword', '[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) I have +2 :rb_might:.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const u = mk(injectCard('atc-unit', 'A unit.', { type: 'unit', might: 3 }), 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const g = mk(sword, 0)
    s.players[0].zones.base.push(g)
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // a ready fury rune for the [Equip] cost
    const r = reduce(s, { type: 'ATTACH', player: 0, unitIid: u.iid, gearIid: g.iid })
    expect(r.error).toBeUndefined()
    const unit = r.state.battlefields[0].units.find((x) => x.iid === u.iid)!
    expect(unit.attached.some((a) => a.split('|')[1] === g.iid)).toBe(true) // now attached
    expect(r.state.players[0].zones.base.some((x) => x.iid === g.iid)).toBe(false) // left base
    expect(r.state.players[0].zones.runePool.length).toBe(0) // the fury rune was recycled to pay [Equip]
    expect(combatMightAt(r.state, 0, unit, 'attacker')).toBe(5) // 3 base + 2 gear
  })

  it('rejects attaching to another player\'s unit', () => {
    const sword = injectCard('atc-sword2', 'Attach this to a unit you control. I have +1 :rb_might:.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const enemy = mk(injectCard('atc-enemy', 'A unit.', { type: 'unit', might: 2 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const g = mk(sword, 0)
    s.players[0].zones.base.push(g)
    const r = reduce(s, { type: 'ATTACH', player: 0, unitIid: enemy.iid, gearIid: g.iid })
    expect(r.error).toBeTruthy()
  })
})

describe('Playtest Pass 2 — opponent-play triggers (Vex - Apathetic)', () => {
  it('stuns and freezes a unit an opponent plays while Vex is at a battlefield', () => {
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk('unl-150-219', 1)], controller: 1 } // p1 holds Vex here
    const dude = mk(injectCard('vex-target', 'A unit.', { type: 'unit', energy: 0, power: {}, might: 4 }), 0)
    s.players[0].zones.hand.push(dude)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: dude.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.error).toBeUndefined()
    const played = r.state.players[0].zones.base.find((u) => u.iid === dude.iid)!
    expect(played.stunned).toBe(true) // Vex auto-stunned the just-played unit
    played.exhausted = false // ready it so the freeze (not the entered-exhausted state) is what blocks the move
    const mv = reduce(r.state, { type: 'MOVE_UNIT', player: 0, iid: dude.iid, toBattlefield: 1 })
    expect(mv.error).toMatch(/can't move/) // and it can't move this turn
  })

  it('does NOT fire while Vex is only at base', () => {
    const s = baseState()
    s.players[1].zones.base.push(mk('unl-150-219', 1)) // Vex at base, not a battlefield
    const dude = mk(injectCard('vex-target2', 'A unit.', { type: 'unit', energy: 0, power: {}, might: 4 }), 0)
    s.players[0].zones.hand.push(dude)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: dude.iid, payment: { exhaust: [], recycle: [] } })
    const played = r.state.players[0].zones.base.find((u) => u.iid === dude.iid)!
    expect(played.stunned).toBeFalsy()
  })
})

describe('Manual override — fail-safe ops', () => {
  it('rejects OVERRIDE when sandbox is off', () => {
    const s = baseState()
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'points', amount: 1 })
    expect(r.error).toBeTruthy()
  })

  it('adjusts points / xp / energy for the target player', () => {
    const s = baseState(); s.sandbox = true
    const p0 = s.players[0].points
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'points', amount: 3 })
    expect(r.state.players[0].points).toBe(p0 + 3)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'energy', amount: 2 })
    expect(r.state.players[0].pool?.energy).toBe(2)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'power', domain: 'fury', amount: 1 })
    expect(r.state.players[0].pool?.power.fury).toBe(1)
  })

  it('draws N cards', () => {
    const s = baseState(); s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const h0 = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'draw', amount: 2 })
    expect(r.state.players[0].zones.hand.length).toBe(h0 + 2)
  })

  it('adds/heals damage on a unit', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'damage', iid: u.iid, amount: 2 })
    expect(r.state.battlefields[0].units[0].damage).toBe(2)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'damage', iid: u.iid, amount: -5 })
    expect(r.state.battlefields[0].units[0].damage).toBe(0) // clamped, heal
  })

  it('spawns a fresh card into a zone', () => {
    const s = baseState(); s.sandbox = true
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'spawn', cardId: furyUnit.id, toZone: 'hand' })
    expect(r.state.players[0].zones.hand.some((c) => c.cardId === furyUnit.id)).toBe(true)
  })

  it('clears a stuck showdown', () => {
    const s = baseState(); s.sandbox = true; s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: 'x' } as MatchState['showdown']
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'clearShowdown' })
    expect(r.state.phase).toBe('action')
    expect(r.state.showdown).toBeNull()
  })
})

describe('Manual override — legend/champion + deck-bottom moves', () => {
  it('moves a unit into the legend slot, then to deck bottom', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(u)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)) // an existing top card
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'move', iid: u.iid, toZone: 'legend' })
    expect(r.state.players[0].legend?.iid).toBe(u.iid)
    expect(r.state.players[0].zones.base.some((c) => c.iid === u.iid)).toBe(false)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'move', iid: u.iid, toZone: 'mainDeck', bottom: true })
    expect(r.state.players[0].legend).toBeNull()
    const deck = r.state.players[0].zones.mainDeck
    expect(deck[deck.length - 1].iid).toBe(u.iid) // landed on the bottom
  })
})

describe('Manual override — grant flags / setDamage / readyAll', () => {
  it('grants instance keywords/flags', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'assault', amount: 2 })
    expect(r.state.battlefields[0].units[0].grantAssault).toBe(2)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'temporary' })
    expect(r.state.battlefields[0].units[0].temporary).toBe(true)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'grant', iid: u.iid, flag: 'token' })
    expect(r.state.battlefields[0].units[0].token).toBe(true)
  })

  it('setDamage clears damage; readyAll readies every unit', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0, { damage: 3, exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const b = mk(furyUnit.id, 0, { exhausted: true })
    s.players[0].zones.base.push(b)
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'setDamage', iid: u.iid, value: 0 })
    expect(r.state.battlefields[0].units[0].damage).toBe(0)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'readyAll' })
    expect(r.state.battlefields[0].units[0].exhausted).toBe(false)
    expect(r.state.players[0].zones.base.find((c) => c.iid === b.iid)?.exhausted).toBe(false)
  })

  it('setController sets a battlefield controller and survives the recompute', () => {
    const s = baseState(); s.sandbox = true
    // A unit owned by P0 sits here, so the majority recompute would pick P0…
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 0)], controller: 0 }
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'setController', toBattlefield: 0, value: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].controller).toBe(1) // …but the manual set wins
    const cleared = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'setController', toBattlefield: 0, value: -1 })
    expect(cleared.state.battlefields[0].controller).toBeNull()
  })

  it('clearTurnState resets a player’s stuck per-turn flags', () => {
    const s = baseState(); s.sandbox = true
    s.players[0].cardsPlayedThisTurn = 3
    s.players[0].playedEquipmentThisTurn = true
    s.players[0].xpGainedThisTurn = true
    s.players[0].azirSwappedThisTurn = true
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'clearTurnState' })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].cardsPlayedThisTurn).toBe(0)
    expect(r.state.players[0].playedEquipmentThisTurn).toBe(false)
    expect(r.state.players[0].xpGainedThisTurn).toBe(false)
    expect(r.state.players[0].azirSwappedThisTurn).toBe(false)
  })

  it('triggerEnterPlay re-fires a unit’s own enter effect', () => {
    const s = baseState(); s.sandbox = true
    const id = injectCard('enter-draw', 'When you play me, draw a card.', { might: 2 })
    const u = mk(id, 0)
    s.players[0].zones.base.push(u)
    s.players[0].zones.mainDeck.push(mk(furyRune.id, 0), mk(furyRune.id, 0))
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'triggerEnterPlay', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('ACTIVATE_UNIT resolves "[Add] <resource>" rune-ramp abilities', () => {
    const s = baseState()
    const gid = injectCard('seal-add-test', ':rb_exhaust:: [Add] :rb_rune_fury:.', { type: 'gear', energy: 0, power: {} })
    const g = mk(gid, 0)
    s.players[0].zones.base.push(g)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: g.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].pool?.power.fury).toBe(1)
    expect(r.state.players[0].zones.base.find((x) => x.iid === g.iid)?.exhausted).toBe(true)
  })

  it('ACTIVATE_UNIT resolves a targeted activated [Stun]', () => {
    const s = baseState()
    const src = mk(injectCard('act-stun', ':rb_exhaust:: [Stun] an enemy unit.', { might: 3 }), 0)
    s.players[0].zones.base.push(src)
    const enemy = mk(furyUnit.id, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid, targets: [enemy.iid] })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].units[0].stunned).toBe(true)
  })

  it('ACTIVATE_UNIT resolves untargeted "channel N rune exhausted"', () => {
    const s = baseState()
    const src = mk(injectCard('act-che', ':rb_exhaust:: Channel 1 rune exhausted.', { might: 3 }), 0)
    s.players[0].zones.base.push(src)
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: src.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.runePool.length).toBe(1)
    expect(r.state.players[0].zones.runePool[0].exhausted).toBe(true)
  })

  it('marker cycles and clears', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    let r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'marker', iid: u.iid })
    expect(r.state.battlefields[0].units[0].marker).toBe(1)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'marker', iid: u.iid })
    expect(r.state.battlefields[0].units[0].marker).toBe(2)
    r = reduce(r.state, { type: 'OVERRIDE', player: 0, op: 'marker', iid: u.iid, value: -1 })
    expect(r.state.battlefields[0].units[0].marker).toBeUndefined()
  })

  it('channelExhausted channels runes entered exhausted', () => {
    const s = baseState(); s.sandbox = true
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0), mk(furyRune.id, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'channelExhausted', amount: 1 })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.runePool.length).toBe(1)
    expect(r.state.players[0].zones.runePool[0].exhausted).toBe(true)
  })

  it('setTempMight sets an exact temp Might', () => {
    const s = baseState(); s.sandbox = true
    const u = mk(furyUnit.id, 0, { tempMight: 1 })
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'setTempMight', iid: u.iid, value: 4 })
    expect(r.state.battlefields[0].units[0].tempMight).toBe(4)
  })

  it('sacrifice kills through a death-shield (plain kill would not)', () => {
    const base = baseState(); base.sandbox = true
    const mkShielded = () => mk(furyUnit.id, 0, { deathShield: true })
    // kill: the death-shield recalls/heals it instead of dying → still alive on board or base
    const sa = baseState(); sa.sandbox = true
    const ua = mkShielded()
    sa.battlefields[0] = { cardId: battlefield.id, units: [ua], controller: 0 }
    const killed = reduce(sa, { type: 'OVERRIDE', player: 0, op: 'kill', iid: ua.iid })
    expect(killed.state.players[0].zones.trash.some((c) => c.iid === ua.iid)).toBe(false)
    // sacrifice: bypasses the shield → it actually dies (in trash, off the battlefield)
    const sb = baseState(); sb.sandbox = true
    const ub = mkShielded()
    sb.battlefields[0] = { cardId: battlefield.id, units: [ub], controller: 0 }
    const sac = reduce(sb, { type: 'OVERRIDE', player: 0, op: 'sacrifice', iid: ub.iid })
    expect(sac.state.battlefields[0].units.some((c) => c.iid === ub.iid)).toBe(false)
    expect(sac.state.players[0].zones.trash.some((c) => c.iid === ub.iid)).toBe(true)
    void base
  })

  it('tutorShuffle fetches a deck card to hand and shrinks the deck', () => {
    const s = baseState(); s.sandbox = true
    const target = mk(furyUnit.id, 0)
    s.players[0].zones.mainDeck.push(mk(furyRune.id, 0), target, mk(furyRune.id, 0))
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'tutorShuffle', iid: target.iid, toZone: 'hand' })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.some((c) => c.iid === target.iid)).toBe(true)
    expect(r.state.players[0].zones.mainDeck.length).toBe(2)
  })

  it('move with value inserts at an index in the deck (X from top)', () => {
    const s = baseState(); s.sandbox = true
    s.players[0].zones.mainDeck.push(mk(furyRune.id, 0), mk(furyRune.id, 0), mk(furyRune.id, 0))
    const card = mk(furyUnit.id, 0)
    s.players[0].zones.hand.push(card)
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'move', iid: card.iid, toZone: 'mainDeck', value: 1 })
    expect(r.state.players[0].zones.mainDeck[1].iid).toBe(card.iid)
  })

  it('revealFacedown → owner hand; removeFacedown → trash', () => {
    const s1 = baseState(); s1.sandbox = true
    const fd1 = mk(furyUnit.id, 0, { facedown: true })
    s1.battlefields[0] = { cardId: battlefield.id, units: [], controller: null, facedown: fd1 }
    const rev = reduce(s1, { type: 'OVERRIDE', player: 0, op: 'revealFacedown', iid: fd1.iid })
    expect(rev.state.battlefields[0].facedown).toBeNull()
    expect(rev.state.players[0].zones.hand.some((c) => c.iid === fd1.iid)).toBe(true)
    const s2 = baseState(); s2.sandbox = true
    const fd2 = mk(furyUnit.id, 0, { facedown: true })
    s2.battlefields[0] = { cardId: battlefield.id, units: [], controller: null, facedown: fd2 }
    const rem = reduce(s2, { type: 'OVERRIDE', player: 0, op: 'removeFacedown', iid: fd2.iid })
    expect(rem.state.battlefields[0].facedown).toBeNull()
    expect(rem.state.players[0].zones.trash.some((c) => c.iid === fd2.iid)).toBe(true)
  })

  it('bulkMove moves a whole zone; swapZone swaps zones between players', () => {
    const s = baseState(); s.sandbox = true
    s.players[0].zones.hand.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0))
    const bulk = reduce(s, { type: 'OVERRIDE', player: 0, op: 'bulkMove', fromZone: 'hand', toZone: 'mainDeck' })
    expect(bulk.state.players[0].zones.hand.length).toBe(0)
    expect(bulk.state.players[0].zones.mainDeck.length).toBe(2)
    const s2 = baseState(); s2.sandbox = true
    const a = mk(furyUnit.id, 0); const b = mk(furyUnit.id, 1)
    s2.players[0].zones.hand.push(a); s2.players[1].zones.hand.push(b)
    const swap = reduce(s2, { type: 'OVERRIDE', player: 0, op: 'swapZone', fromZone: 'hand', targetPlayer: 1 })
    expect(swap.state.players[0].zones.hand.some((c) => c.iid === b.iid)).toBe(true)
    expect(swap.state.players[1].zones.hand.some((c) => c.iid === a.iid)).toBe(true)
  })
})

describe('A1 trigger events — buff & targeted self-triggers', () => {
  it('buff: "When you buff me, ready me" readies the buffed unit', () => {
    const id = injectCard('a1-buff-ready', 'When you buff me, ready me.')
    const s = baseState()
    const u = mk(id, 0, { exhausted: true })
    s.players[0].zones.base.push(u)
    const r = reduce(s, { type: 'BUFF_UNIT', player: 0, iid: u.iid })
    expect(r.error).toBeUndefined()
    const after = r.state.players[0].zones.base.find((x) => x.iid === u.iid)
    expect(after?.buffs).toBe(1)
    expect(after?.exhausted).toBe(false) // the buff trigger readied it
  })

  it('targeted: choosing your own unit with a spell fires its reaction (Jae-style draw)', () => {
    const targetId = injectCard('a1-targeted-draw', 'When you choose me with a spell, draw 1.')
    const spellId = injectCard('a1-target-spell', 'Give a unit +1 :rb_might: this turn.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const tu = mk(targetId, 0)
    s.players[0].zones.base.push(tu)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0)) // draw fuel
    const sp = mk(spellId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [tu.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.mainDeck.length).toBe(1) // drew 1 of 2 via the targeted trigger
    expect(r.state.players[0].zones.base.find((x) => x.iid === tu.iid)?.tempMight).toBe(1)
  })
})

describe('A1 trigger events — globalDefend, killWithSpell, once-per-turn', () => {
  it('once-per-turn: "The first time a friendly unit dies each turn" draws only once', () => {
    const wraithId = injectCard('a1-wraith', 'The first time a friendly unit dies each turn, draw 1.')
    const killId = injectCard('a1-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.players[1].zones.base.push(mk(wraithId, 1), mk(furyUnit.id, 1), mk(furyUnit.id, 1))
    for (let i = 0; i < 3; i++) s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1)) // draw fuel
    const victims = s.players[1].zones.base.filter((c) => c.cardId === furyUnit.id)
    const sp1 = mk(killId, 0)
    const sp2 = mk(killId, 0)
    s.players[0].zones.hand.push(sp1, sp2)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp1.iid, targets: [victims[0].iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[1].zones.mainDeck.length).toBe(2) // first friendly death → drew 1
    r = reduce(r.state, { type: 'PLAY_SPELL', player: 0, iid: sp2.iid, targets: [victims[1].iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[1].zones.mainDeck.length).toBe(2) // second death same turn → gated, no draw
  })

  it('killWithSpell: a spell-kill plays Immortal Phoenix from the caster trash', () => {
    const killId = injectCard('a1-kill2', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.players[1].zones.base.push(victim)
    s.players[0].zones.trash.push(mk('ogn-037-298', 0)) // Immortal Phoenix in caster's trash
    s.players[0].zones.runePool.push(mk(furyRune.id, 0), mk(furyRune.id, 0)) // pay 1 Energy + 1 Fury
    const sp = mk(killId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [victim.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.base.some((c) => c.cardId === 'ogn-037-298')).toBe(true)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === 'ogn-037-298')).toBe(false)
  })

  it('parses Lucian - Merciless (conquer once-per-turn) and Loyal Pup (defend→move me)', () => {
    const lucian = parseTriggers({ id: 'a1-lucian', text: 'The first time I conquer each turn, ready me.' } as never)
    expect(lucian.some((a) => a.event === 'conquer' && a.scope === 'self' && a.oncePerTurn === true && a.effect.readySelf)).toBe(true)
    const pup = parseTriggers({ id: 'a1-pup', text: 'When you defend at a battlefield, you may move me there.' } as never)
    expect(pup.some((a) => a.event === 'defend' && a.scope === 'global' && a.effect.moveSourceToBf)).toBe(true)
  })
})

describe('A1.5 follow-up cards — first-move / first-win-combat self triggers', () => {
  it('Miss Fortune - Captain: first move each turn parses to once-per-turn ready-another', () => {
    const mf = parseTriggers({ id: 'a15-mf', text: "The first time I move each turn, you may ready something else that's exhausted." } as never)
    expect(mf.some((a) => a.event === 'move' && a.scope === 'self' && a.oncePerTurn === true && a.effect.readyUnits === 1 && a.effect.readyExcludesSelf === true)).toBe(true)
  })

  it('Draven - Audacious: first win-combat each turn parses to once-per-turn score 1', () => {
    const draven = parseTriggers({ id: 'a15-draven', text: 'The first time I win a combat each turn, you score 1 point.' } as never)
    expect(draven.some((a) => a.event === 'winCombat' && a.scope === 'self' && a.oncePerTurn === true && a.effect.score === 1)).toBe(true)
  })

  it('The Dreaming Tree: choosing your unit here with a spell draws once per turn', () => {
    const dtId = injectCard('a15-dt', 'When a player chooses a friendly unit here with a spell for the first time each turn, they draw 1.', { type: 'battlefield', name: 'The Dreaming Tree' })
    const spellId = injectCard('a15-dt-spell', 'Give a unit +1 :rb_might: this turn.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    s.battlefields[0] = { cardId: dtId, units: [], controller: 0 }
    const myUnit = mk(furyUnit.id, 0)
    s.battlefields[0].units.push(myUnit)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0), mk(furyUnit.id, 0)) // draw fuel
    const sp1 = mk(spellId, 0)
    const sp2 = mk(spellId, 0)
    s.players[0].zones.hand.push(sp1, sp2)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp1.iid, targets: [myUnit.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.mainDeck.length).toBe(1) // first choose-here → drew 1
    r = reduce(r.state, { type: 'PLAY_SPELL', player: 0, iid: sp2.iid, targets: [myUnit.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.mainDeck.length).toBe(1) // gated — no second draw same turn
  })

  it('Shard of Undoing: a friendly Beginning-Phase death prompts each opponent to MANUALLY kill a unit', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk('unl-174-219', 0)) // Shard of Undoing gear in base
    s.battlefields[0].units.push(mk(furyUnit.id, 0, { temporary: true, enteredTurn: 1 } as Partial<EngineCard>)) // friendly Temporary expires
    const weak = mk(injectCard('a15-weak', 'A unit.', { might: 1 }), 1)
    const strong = mk(injectCard('a15-strong', 'A unit.', { might: 9 }), 1)
    s.battlefields[1].units.push(weak, strong)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const after = beginTurn(s)
    // The opponent (player 1) is prompted to choose which of their units to kill.
    expect(after.pendingChoice?.kind).toBe('shardKill')
    expect(after.pendingChoice?.player).toBe(1)
    expect(after.pendingChoice?.options.map((o) => o.iid).sort()).toEqual([weak.iid, strong.iid].sort())
    // Player 1 chooses the STRONG unit (proves it's manual, not auto-weakest).
    const r = reduce(after, { type: 'RESOLVE_CHOICE', player: 1, iid: strong.iid })
    const p1 = [...r.state.players[1].zones.base, ...r.state.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === 1)
    expect(p1.some((u) => u.iid === strong.iid)).toBe(false) // the chosen unit died
    expect(p1.some((u) => u.iid === weak.iid)).toBe(true) // the weak unit survived
    expect(r.state.pendingChoice).toBeUndefined() // queue drained, Beginning Phase resumed
  })
})

describe('A2 — Baron Nashor aura + targeting immunity', () => {
  it('Baron Nashor: other friendly units get +2 Might (Baron itself excluded)', () => {
    const s = baseState()
    const baron = mk(injectCard('a2-baron', 'Other friendly units have +2 :rb_might:.', { name: 'Baron Nashor', might: 12 }), 0)
    const ally = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [baron, ally], controller: 0 }
    const base = (furyUnit as Extract<typeof furyUnit, { type: 'unit' }>).might
    expect(combatMightAt(s, 0, ally, 'attacker')).toBe(base + 2)
    expect(combatMightAt(s, 0, baron, 'attacker')).toBe(12)
  })

  it('targetingImmune: an enemy spell cannot choose an immune unit, but a normal one is fine', () => {
    const s = baseState()
    const immune = mk(injectCard('a2-immune', "I can't be chosen by enemy spells and abilities.", { might: 5 }), 1)
    const normal = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(immune, normal)
    const spell = CARD_INDEX[injectCard('a2-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })]
    const legal = getLegalTargets(s, spell, 0)
    expect(legal.includes(immune.iid)).toBe(false) // enemy immune unit excluded
    expect(legal.includes(normal.iid)).toBe(true) // enemy normal unit targetable
  })

  it('Elder Dragon: any of your damage is lethal to enemy units', () => {
    const dragon = injectCard('a2-dragon', 'Any amount of your damage is enough to kill enemy units.', { name: 'Elder Dragon', might: 10 })
    const spellId = injectCard('a2-ping1', 'Deal 1 to a unit.', { type: 'spell', energy: 0, power: {} })
    const dies = (withDragon: boolean): boolean => {
      const s = baseState()
      if (withDragon) s.players[0].zones.base.push(mk(dragon, 0))
      const enemy = mk(injectCard('a2-tough', 'A unit.', { might: 9 }), 1)
      s.battlefields[0].units.push(enemy)
      const sp = mk(spellId, 0)
      s.players[0].zones.hand.push(sp)
      let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [enemy.iid], payment: emptyPayment() })
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
      r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
      return !r.state.battlefields.flatMap((b) => b.units).some((u) => u.iid === enemy.iid)
    }
    expect(dies(true)).toBe(true) // with Elder Dragon, 1 damage kills a 9-Might unit
    expect(dies(false)).toBe(false) // without, it survives
  })

  it('Elder Dragon on-play: deals 1 (lethal) to the strongest enemy at each location', () => {
    const dragonId = injectCard('a2-dragon2', 'Any amount of your damage is enough to kill enemy units. When you play me, choose up to one enemy unit at each location. Deal 1 to them.', { name: 'Elder Dragon', might: 10, energy: 0, power: {} })
    const s = baseState()
    const enemy = mk(injectCard('a2-eb', 'A unit.', { might: 7 }), 1)
    s.battlefields[0].units.push(enemy)
    const dragon = mk(dragonId, 0)
    s.players[0].zones.hand.push(dragon)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: dragon.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields.flatMap((b) => b.units).some((u) => u.iid === enemy.iid)).toBe(false)
  })

  it('Volibear - Furious: on attack, deals 5 split among enemy units here', () => {
    const voli = injectCard('a2-voli', 'When I attack, deal 5 damage split among any number of enemy units here.', { name: 'Volibear - Furious', might: 9 })
    const s = baseState()
    const w1 = mk(injectCard('a2-vw1', 'A unit.', { might: 2 }), 1, { exhausted: true })
    const w2 = mk(injectCard('a2-vw2', 'A unit.', { might: 2 }), 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [w1, w2], controller: 1 }
    const attacker = mk(voli, 0, { stunned: true } as Partial<EngineCard>) // stunned → no combat dmg, isolates the split
    s.players[0].zones.base.push(attacker)
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    const enemyIids = r.state.battlefields[0].units.filter((u) => u.owner === 1).map((u) => u.iid)
    expect(enemyIids).not.toContain(w1.iid) // killed by the split
    expect(enemyIids).not.toContain(w2.iid)
  })

  it('Sivir - Ambitious: on conquer with 5+ excess, deals that much to the strongest enemy', () => {
    const sivir = injectCard('a2-sivir', 'When I conquer after an attack, if you assigned 5 or more excess damage to enemy units, you may deal that much to an enemy unit.', { name: 'Sivir - Ambitious', might: 7 })
    const s = baseState()
    const weakDef = mk(injectCard('a2-wd', 'A unit.', { might: 1 }), 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [weakDef], controller: 1 }
    const bigElsewhere = mk(injectCard('a2-big2', 'A unit.', { might: 4 }), 1)
    s.battlefields[1].units.push(bigElsewhere)
    const attacker = mk(sivir, 0)
    s.players[0].zones.base.push(attacker)
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.battlefields.flatMap((b) => b.units).some((u) => u.iid === bigElsewhere.iid)).toBe(false) // dealt 6 excess → killed
  })
})

describe('Baron Nashor / Baron Pit', () => {
  it('Baron Nashor: on play, adds Baron Pit to the board and enters it', () => {
    const baronId = injectCard('a2-baron-np', "As you play me, add the Baron Pit battlefield token to the board if it's not there already. If you do, I enter there.", { name: 'Baron Nashor', might: 12, energy: 0, power: {} })
    const s = baseState()
    const baron = mk(baronId, 0)
    s.players[0].zones.hand.push(baron)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: baron.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    const pitBf = r.state.battlefields.find((b) => b.cardId === 'unl-t01-219')
    expect(pitBf).toBeTruthy()
    expect(pitBf!.units.some((u) => u.iid === baron.iid)).toBe(true) // Baron entered Baron Pit
  })

  it('Elder Dragon: combat damage is lethal even to a higher-Might enemy', () => {
    const dragonId = injectCard('a2-ed-combat', 'Any amount of your damage is enough to kill enemy units.', { name: 'Elder Dragon', might: 10 })
    const s = baseState()
    const bigDef = mk(injectCard('a2-bigdef', 'A unit.', { might: 12 }), 1, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [bigDef], controller: 1 }
    const dragon = mk(dragonId, 0)
    s.players[0].zones.base.push(dragon)
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: dragon.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // 10 Might would not normally kill a 12-Might defender; Elder Dragon makes it lethal.
    expect(r.state.battlefields.flatMap((b) => b.units).some((u) => u.iid === bigDef.iid)).toBe(false)
  })

  it('Baron Pit: a non-Ganking unit can move there from another battlefield', () => {
    const pitId = injectCard('a2-pit', 'Units can move here from anywhere.', { type: 'battlefield', name: 'Baron Pit' })
    const s = baseState()
    const u = mk(furyUnit.id, 0) // no Ganking
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    s.battlefields[1] = { cardId: pitId, units: [], controller: null }
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 1 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[1].units.some((x) => x.iid === u.iid)).toBe(true)
  })
})

describe('A3 — movement restrictions (Minotaur Reckoner / Determined Sentry)', () => {
  it('Minotaur Reckoner: no unit can retreat to base while it is in play', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('a3-mino', "Units can't move to base.", { might: 5 }), 0))
    const u = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const r = reduce(s, { type: 'RETREAT', player: 0, iid: u.iid })
    expect(r.error).toBeTruthy()
    expect(r.state.battlefields[0].units.some((x) => x.iid === u.iid)).toBe(true) // stayed on the battlefield
  })

  it('Determined Sentry: cannot retreat, but a normal unit can', () => {
    const s = baseState()
    const sentry = mk(injectCard('a3-sentry', "I can't move to base.", { might: 4 }), 0)
    const normal = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [sentry, normal], controller: 0 }
    expect(reduce(s, { type: 'RETREAT', player: 0, iid: sentry.iid }).error).toBeTruthy()
    const r2 = reduce(s, { type: 'RETREAT', player: 0, iid: normal.iid })
    expect(r2.error).toBeUndefined()
    expect(r2.state.players[0].zones.base.some((x) => x.iid === normal.iid)).toBe(true)
  })

  it('Maduli the Gatekeeper: not readied by Awaken (stays exhausted; others ready)', () => {
    const s = baseState()
    const maduli = mk(injectCard('a3-maduli', "I can't be readied.", { might: 6 }), 0, { exhausted: true })
    const normal = mk(furyUnit.id, 0, { exhausted: true })
    s.battlefields[0] = { cardId: battlefield.id, units: [maduli, normal], controller: 0 }
    s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const after = beginTurn(s)
    const bf = after.battlefields[0]
    expect(bf.units.find((u) => u.iid === maduli.iid)?.exhausted).toBe(true) // skipped by Awaken
    expect(bf.units.find((u) => u.iid === normal.iid)?.exhausted).toBe(false) // readied normally
  })

  it('Mageseeker Warden: an opponent can only play units to their base (no spells, no play-to-bf)', () => {
    const s = baseState()
    const warden = mk(injectCard('a3-warden', "While I'm at a battlefield, opponents can only play units to their base.", { name: 'Mageseeker Warden', might: 4 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [warden], controller: 1 }
    const spell = mk(injectCard('a3-w-spell', 'Deal 1 to a unit.', { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(spell)
    expect(reduce(s, { type: 'PLAY_SPELL', player: 0, iid: spell.iid, targets: [warden.iid], payment: emptyPayment() }).error).toBeTruthy() // spell blocked
    const unit = mk(injectCard('a3-w-unit', 'A unit.'), 0) // free unit (energy 0)
    s.players[0].zones.hand.push(unit)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: unit.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined() // unit to base allowed
    expect(r.state.players[0].zones.base.some((u) => u.iid === unit.iid)).toBe(true)
  })

  it('Sneaky Deckhand: plays only to an OPEN battlefield', () => {
    const id = injectCard('a3-sneaky', 'You may play me to an open battlefield.')
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(furyUnit.id, 1, { exhausted: true })], controller: 1 }
    s.battlefields[1] = { cardId: battlefield.id, units: [], controller: null }
    const u1 = mk(id, 0)
    const u2 = mk(id, 0)
    s.players[0].zones.hand.push(u1, u2)
    expect(reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u1.iid, payment: emptyPayment(), toBattlefield: 0 }).error).toBeTruthy() // occupied → blocked
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u2.iid, payment: emptyPayment(), toBattlefield: 1 })
    expect(r.error).toBeUndefined() // open → ok
    expect(r.state.battlefields[1].units.some((x) => x.iid === u2.iid)).toBe(true)
  })

  it('Dauntless Vanguard: plays only to an OCCUPIED ENEMY battlefield', () => {
    const id = injectCard('a3-dauntless', 'You may play me to an occupied enemy battlefield.')
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    s.battlefields[1] = { cardId: battlefield.id, units: [mk(furyUnit.id, 1, { exhausted: true })], controller: 1 }
    const u1 = mk(id, 0)
    const u2 = mk(id, 0)
    s.players[0].zones.hand.push(u1, u2)
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    expect(reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u1.iid, payment: emptyPayment(), toBattlefield: 0 }).error).toBeTruthy() // empty → blocked
    expect(reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u2.iid, payment: emptyPayment(), toBattlefield: 1 }).error).toBeUndefined() // enemy-occupied → ok
  })

  it('Perched Grimwyrm: plays only to a battlefield you conquered this turn', () => {
    const id = injectCard('a3-grimwyrm', "Play me only to a battlefield you conquered this turn. (You can't play me anywhere else.)")
    const s = baseState()
    s.players[0].conqueredThisTurn = [1]
    const u1 = mk(id, 0)
    const u2 = mk(id, 0)
    s.players[0].zones.hand.push(u1, u2)
    expect(reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u1.iid, payment: emptyPayment(), toBattlefield: 0 }).error).toBeTruthy() // not conquered → blocked
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u2.iid, payment: emptyPayment(), toBattlefield: 1 })
    expect(r.error).toBeUndefined() // conquered bf 1 → ok
    expect(r.state.battlefields[1].units.some((x) => x.iid === u2.iid)).toBe(true)
  })

  it('Magma Wurm: other friendly units enter ready', () => {
    const s = baseState()
    s.players[0].zones.base.push(mk(injectCard('a3-magma', 'Other friendly units enter ready.', { might: 8 }), 0))
    const u = mk(injectCard('a3-mw-unit', 'A unit.'), 0) // free unit
    s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.base.find((x) => x.iid === u.iid)?.exhausted).toBe(false) // entered ready
  })

  it('Blitzcrank - Impassive: on play to a battlefield, pulls an enemy unit there', () => {
    const id = injectCard('a3-blitz', 'When you play me to a battlefield, you may move an enemy unit to here.', { name: 'Blitzcrank - Impassive', might: 6 })
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [], controller: null }
    const enemy = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[1] = { cardId: battlefield.id, units: [enemy], controller: 1 }
    const blitz = mk(id, 0)
    s.players[0].zones.hand.push(blitz)
    s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: blitz.iid, payment: emptyPayment(), toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    expect(r.state.battlefields[0].units.some((x) => x.iid === enemy.iid)).toBe(true) // pulled to Blitzcrank's battlefield
  })
})
