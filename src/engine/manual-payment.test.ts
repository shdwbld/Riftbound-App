import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { autoPay } from './autopay'
import { emptyPayment } from './types'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// Phase A of the rules-fidelity campaign: explicit rune payments for queued
// optionalPay / payCost decisions (rule 354.1.a — the player picks WHICH runes
// to exhaust/recycle), powerAny (wildcard Power) validation, and the
// no-payment auto-pick fallback.

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'spell', domains: ['order'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.length === 1 && c.produces.includes('fury'))!
const calmRune = CARDS.find((c) => c.type === 'rune' && c.produces.length === 1 && c.produces.includes('calm'))!

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({ iid: `mp${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o })
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

/** Hand-craft a surfaced payCost/optionalPay choice (what surfaceNextDecision
 *  produces) so the foundation is testable before Phase B/C wire real sites. */
function withPayChoice(
  s: MatchState,
  kind: 'optionalPay' | 'payCost',
  resolvedCost: { energy: number; power: Partial<Record<string, number>>; powerAny?: number },
): MatchState {
  s.pendingChoice = {
    player: 0, kind, bfIndex: -1, prompt: 'Pay the cost.', srcName: 'Test Source',
    options: [{ iid: 'pay', label: 'Pay' }],
    payload: JSON.stringify({ resolvedCost, op: { type: 'channelExhausted', n: 1 } }),
  }
  return s
}

describe('autoPay powerAny (wildcard Power)', () => {
  it('recycles any-domain runes for powerAny after colored matching', () => {
    const p = player(0)
    const fury = mk(furyRune.id, 0)
    const calm = mk(calmRune.id, 0)
    p.zones.runePool.push(fury, calm)
    const pay = autoPay(p, { energy: 0, power: { fury: 1 }, powerAny: 1 })
    expect(pay).not.toBeNull()
    expect(pay!.recycle.sort()).toEqual([fury.iid, calm.iid].sort()) // fury → colored, calm → wildcard
  })

  it('one READY rune can pay 1 Energy + 1 wildcard Power (both roles)', () => {
    const p = player(0)
    const fury = mk(furyRune.id, 0)
    p.zones.runePool.push(fury)
    const pay = autoPay(p, { energy: 1, power: {}, powerAny: 1 })
    expect(pay).not.toBeNull()
    expect(pay!.exhaust).toEqual([fury.iid])
    expect(pay!.recycle).toEqual([fury.iid])
  })

  it('returns null when wildcard slots cannot be covered', () => {
    const p = player(0)
    p.zones.runePool.push(mk(furyRune.id, 0))
    expect(autoPay(p, { energy: 0, power: {}, powerAny: 2 })).toBeNull()
  })
})

describe('payCost — explicit payment via RESOLVE_CHOICE', () => {
  it('valid payment: exhausts/recycles the CHOSEN runes and applies the op', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 1, power: { fury: 1 }, powerAny: 1 })
    const e1 = mk(furyRune.id, 0) // exhaust for energy
    const r1 = mk(furyRune.id, 0) // recycle for the fury slot
    const r2 = mk(calmRune.id, 0) // recycle for the wildcard slot
    s.players[0].zones.runePool.push(e1, r1, r2)
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0)) // for the channelExhausted op
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [e1.iid], recycle: [r1.iid, r2.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.pendingChoice).toBeUndefined()
    const pool = r.state.players[0].zones.runePool
    expect(pool.find((x) => x.iid === e1.iid)?.exhausted).toBe(true) // exhausted, not recycled
    expect(pool.some((x) => x.iid === r1.iid)).toBe(false) // recycled away
    expect(pool.some((x) => x.iid === r2.iid)).toBe(false)
    expect(pool.filter((x) => x.exhausted).length).toBe(2) // e1 + the channeled-exhausted rune (op applied)
  })

  it('invalid payment: the choice STAYS OPEN and nothing is spent', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 1, power: {}, powerAny: 0 })
    const e1 = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(e1)
    // Wrong: recycles instead of exhausting.
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [], recycle: [e1.iid] } })
    expect(r.error).toBeTruthy()
    expect(r.state.pendingChoice?.kind).toBe('payCost') // still pending
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === e1.iid)?.exhausted).toBe(false)
  })

  it('wrong-domain recycle for a colored slot is rejected', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 0, power: { fury: 1 }, powerAny: 0 })
    const c1 = mk(calmRune.id, 0)
    s.players[0].zones.runePool.push(c1)
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [], recycle: [c1.iid] } })
    expect(r.error).toBeTruthy()
    expect(r.state.pendingChoice?.kind).toBe('payCost')
  })

  it('declining a payCost skips the deferred effect', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 1, power: {}, powerAny: 0 })
    s.players[0].zones.runePool.push(mk(furyRune.id, 0))
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: null })
    expect(r.error).toBeFalsy()
    expect(r.state.pendingChoice).toBeUndefined()
    expect(r.state.players[0].zones.runeDeck.length).toBe(1) // op NOT applied (no channel)
    expect(r.state.players[0].zones.runePool.every((x) => !x.exhausted)).toBe(true)
  })

  it('no payment payload → auto-pick fallback pays and applies the op', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 1, power: {}, powerAny: 1 })
    s.players[0].zones.runePool.push(mk(furyRune.id, 0), mk(calmRune.id, 0))
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.error).toBeFalsy()
    // 1 Energy exhausted + 1 rune recycled + 1 channeled-exhausted from the op.
    const p0 = r.state.players[0]
    expect(p0.zones.runePool.length).toBe(2) // 2 remain (one recycled away, one channeled in)
    expect(p0.zones.runeDeck.length).toBe(1) // recycled rune went to the rune deck bottom
  })

  it('auto-pick fallback that cannot afford logs and skips (nothing spent)', () => {
    const s = withPayChoice(baseState(), 'payCost', { energy: 2, power: {}, powerAny: 0 })
    s.players[0].zones.runePool.push(mk(furyRune.id, 0)) // only 1 ready rune
    const r = reduce(s, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.runePool.every((x) => !x.exhausted)).toBe(true)
    expect(r.state.log.some((l) => l.text.includes("couldn't pay"))).toBe(true)
  })
})

describe('Phase B — pre-dispatch explicit payments', () => {
  it('ACTIVATE_UNIT honors the CHOSEN rune (not the auto-pick)', () => {
    const aid = injectCard('mp-act-unit', ':rb_energy_1:: Draw 1.', { type: 'unit', might: 2 })
    const s = baseState()
    const u = mk(aid, 0)
    s.players[0].zones.base.push(u)
    const r1 = mk(furyRune.id, 0)
    const r2 = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(r1, r2)
    const handBefore = s.players[0].zones.hand.length
    // Pay with the SECOND rune explicitly (auto-pay would take the first).
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: u.iid, payment: { exhaust: [r2.iid], recycle: [] } })
    expect(r.error).toBeUndefined()
    expect(r.state.players[0].zones.hand.length).toBe(handBefore + 1) // drew 1
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === r2.iid)?.exhausted).toBe(true)
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === r1.iid)?.exhausted).toBe(false)
  })

  it('ACTIVATE_UNIT rejects an invalid explicit payment (nothing spent)', () => {
    const aid = injectCard('mp-act-unit2', ':rb_energy_1:: Draw 1.', { type: 'unit', might: 2 })
    const s = baseState()
    const u = mk(aid, 0)
    s.players[0].zones.base.push(u)
    const r1 = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(r1)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: u.iid, payment: { exhaust: [], recycle: [r1.iid] } })
    expect(r.error).toBeTruthy()
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === r1.iid)?.exhausted).toBe(false)
    expect(r.state.players[0].zones.hand.length).toBe(0) // no draw
  })

  it('HIDE honors an explicit recycle payment (1 wildcard Power, chosen rune)', () => {
    const hid = mk(injectCard('mp-hid', '[Hidden] A trap.', { type: 'unit', energy: 4, might: 4 }), 0)
    const s = baseState()
    s.battlefields[0].units.push(mk(furyUnit.id, 0))
    s.battlefields[0].controller = 0
    s.players[0].zones.hand.push(hid)
    const r1 = mk(furyRune.id, 0)
    const r2 = mk(calmRune.id, 0)
    s.players[0].zones.runePool.push(r1, r2)
    // Recycle the SECOND (calm) rune explicitly — the legacy path would take r1.
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hid.iid, toBattlefield: 0, runeIid: r1.iid, payment: { exhaust: [], recycle: [r2.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].facedown?.iid).toBe(hid.iid)
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === r2.iid)).toBe(false) // recycled
    expect(r.state.players[0].zones.runeDeck.some((x) => x.iid === r2.iid)).toBe(true)
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === r1.iid)?.exhausted).toBe(false) // untouched
  })

  it('ATTACH validates a rainbow [Equip] cost via powerAny', () => {
    const gid = injectCard('mp-gear-rb', '[Equip] :rb_rune_rainbow:', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const unit = mk(furyUnit.id, 0)
    const gear = mk(gid, 0)
    s.players[0].zones.base.push(unit, gear)
    const r1 = mk(furyRune.id, 0)
    const r2 = mk(calmRune.id, 0)
    s.players[0].zones.runePool.push(r1, r2)
    // Any-domain rune covers the rainbow slot — recycle the calm one explicitly.
    const r = reduce(s, { type: 'ATTACH', player: 0, unitIid: unit.iid, gearIid: gear.iid, payment: { exhaust: [], recycle: [r2.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === unit.iid)?.attached).toContain(`${gid}|${gear.iid}`)
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === r2.iid)).toBe(false) // recycled
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === r1.iid)).toBe(true) // untouched
  })

  it('ATTACH rejects a short rainbow payment', () => {
    const gid = injectCard('mp-gear-rb2', '[Equip] :rb_energy_1::rb_rune_rainbow:', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    const unit = mk(furyUnit.id, 0)
    const gear = mk(gid, 0)
    s.players[0].zones.base.push(unit, gear)
    const r1 = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(r1)
    // Pays the Energy but not the rainbow Power → invalid, nothing attached.
    const r = reduce(s, { type: 'ATTACH', player: 0, unitIid: unit.iid, gearIid: gear.iid, payment: { exhaust: [r1.iid], recycle: [] } })
    expect(r.error).toBeTruthy()
    expect(r.state.players[0].zones.base.find((x) => x.iid === unit.iid)?.attached).toEqual([])
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === r1.iid)?.exhausted).toBe(false)
  })
})

describe('optionalPay — explicit payment end-to-end (real site)', () => {
  it("Ripper's Bay channel: accept with an explicit rune payment", () => {
    const s = baseState()
    s.battlefields[0] = { cardId: 'unl-214-219', units: [mk(furyUnit.id, 0)], controller: 0 } // bf0 IS Ripper's Bay
    const unit = s.battlefields[0].units[0]
    const payRune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(payRune) // NO pool energy — must pay from runes
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0)) // a rune to channel
    const bounce = mk(injectCard('mp-bounce', "Return a unit to its owner's hand.", { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(bounce)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: bounce.iid, targets: [unit.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.pendingChoice?.kind).toBe('optionalPay')
    // The payload now carries a resolvedCost for the rune picker.
    const payload = JSON.parse(r.state.pendingChoice?.payload ?? '{}')
    expect(payload.resolvedCost?.energy).toBe(1)
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [payRune.iid], recycle: [] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === payRune.iid)?.exhausted).toBe(true) // the CHOSEN rune paid
    expect(r.state.players[0].zones.runePool.filter((x) => x.exhausted).length).toBe(2) // + channeled exhausted
  })

  it('Immortal Phoenix: payload carries ⚡1+🔥 resolvedCost; explicit payment plays it without double-paying', () => {
    const killId = injectCard('mp-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.players[1].zones.base.push(victim)
    s.players[0].zones.trash.push(mk('ogn-037-298', 0)) // Immortal Phoenix
    const e1 = mk(furyRune.id, 0) // exhaust for the Energy
    const f1 = mk(furyRune.id, 0) // recycle for the Fury slot
    s.players[0].zones.runePool.push(e1, f1)
    const sp = mk(killId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [victim.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.pendingChoice?.kind).toBe('optionalPay')
    const payload = JSON.parse(r.state.pendingChoice?.payload ?? '{}')
    expect(payload.resolvedCost).toEqual({ energy: 1, power: { fury: 1 } })
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [e1.iid], recycle: [f1.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((c) => c.cardId === 'ogn-037-298')).toBe(true)
    // Exactly the chosen runes were spent — the zero-cost op didn't re-pay.
    const pool = r.state.players[0].zones.runePool
    expect(pool.find((x) => x.iid === e1.iid)?.exhausted).toBe(true)
    expect(pool.some((x) => x.iid === f1.iid)).toBe(false) // recycled away
  })

  it('playUnitFromTrash (The Harrowing pattern): payCost picker pays the PRINTED domain with the chosen rune', () => {
    const sid = injectCard('mp-harrow', 'Play a unit from your trash, ignoring its Energy cost.', { type: 'spell', energy: 0, power: {} })
    const trashUnit = injectCard('mp-harrow-u', 'A unit.', { type: 'unit', might: 3, energy: 5, power: { fury: 1 } })
    const s = baseState()
    const dead = mk(trashUnit, 0)
    s.players[0].zones.trash.push(dead)
    const f1 = mk(furyRune.id, 0)
    const f2 = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(f1, f2)
    const sp = mk(sid, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.pendingChoice?.kind).toBe('payCost')
    // The cost is the unit's PRINTED power (fury), not a wildcard.
    const payload = JSON.parse(r.state.pendingChoice?.payload ?? '{}')
    expect(payload.resolvedCost).toEqual({ energy: 0, power: { fury: 1 } })
    // Pay with the SECOND rune explicitly.
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay', payment: { exhaust: [], recycle: [f2.iid] } })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.base.some((x) => x.iid === dead.iid)).toBe(true)
    expect(r.state.players[0].zones.runePool.some((x) => x.iid === f2.iid)).toBe(false) // recycled
    expect(r.state.players[0].zones.runePool.find((x) => x.iid === f1.iid)?.exhausted).toBe(false) // untouched
  })

  it("Ripper's Bay channel: legacy accept with no payment still auto-pays", () => {
    const s = baseState()
    s.battlefields[0] = { cardId: 'unl-214-219', units: [mk(furyUnit.id, 0)], controller: 0 }
    const unit = s.battlefields[0].units[0]
    s.players[0].pool = { energy: 1, power: {} }
    s.players[0].zones.runeDeck.push(mk(furyRune.id, 0))
    const bounce = mk(injectCard('mp-bounce2', "Return a unit to its owner's hand.", { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(bounce)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: bounce.iid, targets: [unit.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.pendingChoice?.kind).toBe('optionalPay')
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].pool?.energy).toBe(0) // pool spent by the auto-pick
    expect(r.state.players[0].zones.runePool.some((x) => x.exhausted)).toBe(true) // channeled a rune exhausted
  })
})
