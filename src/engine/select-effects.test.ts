import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { GOLD_TOKEN_ID } from './setup'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'spell', domains: ['order'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const MIGHT = (furyUnit as { might: number }).might

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `e${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
function zones(owner: PlayerId): Record<ZoneId, EngineCard[]> {
  return { mainDeck: Array.from({ length: 8 }, () => mk(furyUnit.id, owner)), runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: zones(id), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [{ cardId: battlefield.id, units: [], controller: null }],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}
const goldCount = (p: PlayerState) => p.zones.base.filter((c) => c.cardId === GOLD_TOKEN_ID).length
const castSpell = (s: MatchState, iid: string, targets: string[]) => {
  let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid, targets, payment: emptyPayment() })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
  return r
}

describe('Deathgrip — select kill + buff (friendly)', () => {
  const DG = injectCard('dg-test', 'Kill a friendly unit. If you do, give +:rb_might: equal to its Might to another friendly unit this turn. Draw 1.')

  it('kills the chosen friendly unit and buffs another by its Might, then draws', () => {
    const s = baseState()
    const a = mk(furyUnit.id, 0); const b = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(a, b)
    const dg = mk(DG, 0); s.players[0].zones.hand.push(dg)
    const r = castSpell(s, dg.iid, [a.iid, b.iid])
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((u) => u.iid === a.iid)).toBe(false) // killed
    expect(r.state.players[0].zones.base.find((u) => u.iid === b.iid)?.tempMight).toBe(MIGHT) // buffed by killed Might
    expect(r.state.players[0].zones.hand.length).toBe(1) // Deathgrip left hand, drew 1
  })

  it('kills with no buff target (only one friendly) and still draws', () => {
    const s = baseState()
    const a = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(a)
    const dg = mk(DG, 0); s.players[0].zones.hand.push(dg)
    const r = castSpell(s, dg.iid, [a.iid]) // only the kill target
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((u) => u.iid === a.iid)).toBe(false)
    expect(r.state.players[0].zones.hand.length).toBe(1) // drew 1
  })
})

describe('Cull the Weak — each player picks their own unit', () => {
  const CULL = injectCard('cull-test', 'Each player kills one of their units.')

  it('prompts the caster then each opponent to kill one of their own', () => {
    const s = baseState()
    const a0 = mk(furyUnit.id, 0); const b0 = mk(furyUnit.id, 0)
    s.players[0].zones.base.push(a0, b0)
    const a1 = mk(furyUnit.id, 1)
    s.players[1].zones.base.push(a1)
    const c = mk(CULL, 0); s.players[0].zones.hand.push(c)
    let r = castSpell(s, c.iid, [])
    expect(r.state.pendingChoice?.kind).toBe('cullKill')
    expect(r.state.pendingChoice?.player).toBe(0) // caster picks first
    // its options are only P0's own units
    expect(r.state.pendingChoice!.options.map((o) => o.iid).sort()).toEqual([a0.iid, b0.iid].sort())
    r = { ...r, state: reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: a0.iid }).state }
    expect(r.state.players[0].zones.base.some((u) => u.iid === a0.iid)).toBe(false) // P0's pick died
    expect(r.state.pendingChoice?.kind).toBe('cullKill')
    expect(r.state.pendingChoice?.player).toBe(1) // now the opponent
    r = { ...r, state: reduce(r.state, { type: 'RESOLVE_CHOICE', player: 1, iid: a1.iid }).state }
    expect(r.state.players[1].zones.base.some((u) => u.iid === a1.iid)).toBe(false)
    expect(r.state.pendingChoice).toBeUndefined()
    expect(r.state.players[0].zones.base.some((u) => u.iid === b0.iid)).toBe(true) // P0's other unit survives
  })
})

describe('Scuttle Crab — reveal an opponent\'s hand (read-only)', () => {
  it('offers a read-only view of a chosen opponent\'s hand on Deathknell', () => {
    const crab = injectCard('crab-test', 'When you play me, draw 1.[Deathknell] Choose an opponent. They reveal their hand. You can look at their facedown cards this turn. Gain 1 XP.', { type: 'unit', might: 1 })
    const s = baseState()
    s.sandbox = true
    s.players[1].zones.hand.push(mk(furyUnit.id, 1), mk(furyUnit.id, 1))
    const u = mk(crab, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [u], controller: 0 }
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: u.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].xp).toBe(1) // Deathknell XP still applies
    expect(r.state.pendingChoice?.kind).toBe('revealView') // read-only peek at the hand
    expect(r.state.pendingChoice?.player).toBe(0)
    expect(r.state.pendingChoice!.options.length).toBe(2) // both of the opponent's cards shown
    const after = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: null }) // close
    expect(after.state.pendingChoice).toBeUndefined()
    expect(after.state.players[1].zones.hand.length).toBe(2) // nothing taken
  })
})

describe('Gold gear token summoners', () => {
  it('Trove Golem: plays four Gold gear tokens', () => {
    const TG = injectCard('tg-test', 'When you play me, play four Gold gear tokens exhausted.', { type: 'unit', might: 3 })
    const s = baseState()
    const u = mk(TG, 0); s.players[0].zones.hand.push(u)
    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() })
    expect(r.error).toBeFalsy()
    expect(goldCount(r.state.players[0])).toBe(4)
  })

  it('Card Sharp: you play 1, an opponent may play 1, you get +1 per opponent who did', () => {
    const CS = injectCard('cs-test', 'When you play me, you and each opponent may play a Gold gear token exhausted. For each opponent who did, you play a Gold gear token exhausted.', { type: 'unit', might: 2 })
    const s = baseState()
    const u = mk(CS, 0); s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() }).state
    expect(goldCount(r.players[0])).toBe(1) // caster's own token
    expect(r.pendingChoice?.kind).toBe('cardSharpGold')
    expect(r.pendingChoice?.player).toBe(1)
    r = reduce(r, { type: 'RESOLVE_CHOICE', player: 1, iid: 'yes' }).state
    expect(goldCount(r.players[1])).toBe(1) // opponent played one
    expect(goldCount(r.players[0])).toBe(2) // caster's bonus token
    expect(r.pendingChoice).toBeUndefined()
  })

  it('USE_GOLD: a ready Gold token cashes for 1 Power of the chosen domain; an exhausted one cannot', () => {
    const s = baseState()
    const ready = mk(GOLD_TOKEN_ID!, 0, { exhausted: false })
    const exhausted = mk(GOLD_TOKEN_ID!, 0, { exhausted: true })
    s.players[0].zones.base.push(ready, exhausted)
    // Exhausted token can't be cracked (it readies next turn).
    const bad = reduce(s, { type: 'USE_GOLD', player: 0, iid: exhausted.iid, domain: 'fury' })
    expect(bad.error).toBeTruthy()
    // Ready token → kill it, +1 Fury Power floats into the pool.
    const r = reduce(s, { type: 'USE_GOLD', player: 0, iid: ready.iid, domain: 'fury' })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].pool.power.fury).toBe(1)
    expect(r.state.players[0].zones.base.some((g) => g.iid === ready.iid)).toBe(false) // ceased to exist
  })

  it('Card Sharp: a declining opponent denies the bonus token', () => {
    const CS = injectCard('cs-test2', 'When you play me, you and each opponent may play a Gold gear token exhausted. For each opponent who did, you play a Gold gear token exhausted.', { type: 'unit', might: 2 })
    const s = baseState()
    const u = mk(CS, 0); s.players[0].zones.hand.push(u)
    let r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: u.iid, payment: emptyPayment() }).state
    r = reduce(r, { type: 'RESOLVE_CHOICE', player: 1, iid: 'no' }).state
    expect(goldCount(r.players[1])).toBe(0)
    expect(goldCount(r.players[0])).toBe(1) // no bonus
  })
})
