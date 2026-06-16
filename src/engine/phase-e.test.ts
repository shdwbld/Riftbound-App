import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { emptyPayment } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// ── Shared minimal harness (mirrors engine.test.ts) ────────────────────────────
function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}
const furyRune = CARDS.find((c) => c.type === 'rune' && c.produces.includes('fury'))!
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `e${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return {
    id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0,
    banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true,
  }
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)],
    activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0,
    log: [], events: [], rngSeed: 1,
  } as unknown as MatchState
}

const resolveCombat = (s: MatchState, atk: EngineCard, bf = 0) => {
  let r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atk.iid], toBattlefield: bf })
  r = reduce(r.state, { type: 'PASS', player: 1 })
  r = reduce(r.state, { type: 'PASS', player: 0 })
  return r
}

// ── E1 — "I don't deal combat damage" + Vilemaw conditional ─────────────────────
describe('E1 — combat-damage suppression', () => {
  it('Galio - Indefatigable ("I don\'t deal combat damage"): attacker deals 0, defender survives', () => {
    const galio = 'unl-171-219' // might 6
    if (!CARD_INDEX[galio]) return
    const s = baseState()
    const def = mk(injectCard('e1-def', 'A unit.', { might: 3 }), 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [def], controller: 1 }
    const ga = mk(galio, 0)
    s.players[0].zones.base.push(ga)
    const r = resolveCombat(s, ga)
    // Galio (6) deals 0 → the might-3 defender takes 0 and survives (would die without the fix).
    expect(r.state.battlefields[0].units.some((u) => u.iid === def.iid)).toBe(true)
    expect(r.state.battlefields[0].units.find((u) => u.iid === def.iid)?.damage ?? 0).toBe(0)
  })

  it('Vilemaw: an enemy here with less Might deals 0 combat damage (Vilemaw takes no damage)', () => {
    const vile = 'unl-060-219' // might 8, "Enemy units here with less Might than me don't deal combat damage."
    if (!CARD_INDEX[vile]) return
    const s = baseState()
    const vm = mk(vile, 1)
    s.battlefields[0] = { cardId: battlefield.id, units: [vm], controller: 1 }
    const atk = mk(injectCard('e1-atk', 'A unit.', { might: 3 }), 0) // 3 < 8 → suppressed
    s.players[0].zones.base.push(atk)
    const r = resolveCombat(s, atk)
    // Attacker dealt 0 → Vilemaw unharmed; Vilemaw dealt 8 → attacker dead.
    expect(r.state.battlefields[0].units.find((u) => u.iid === vm.iid)?.damage ?? 0).toBe(0)
    expect(r.state.battlefields[0].units.some((u) => u.iid === atk.iid)).toBe(false)
  })
})

// ── E2 — Immortal Phoenix: EVERY copy in trash triggers ─────────────────────────
describe('E2 — Immortal Phoenix multi-copy', () => {
  it('two Phoenixes in trash both offer their pay/decline (was .find() = one)', () => {
    const killId = injectCard('e2-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.players[1].zones.base.push(victim)
    s.players[0].zones.trash.push(mk('ogn-037-298', 0), mk('ogn-037-298', 0)) // two copies
    s.players[0].pool = { energy: 2, power: { fury: 2 } } // afford both
    const sp = mk(killId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [victim.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // First Phoenix prompt is live, the second is queued behind it.
    expect(r.state.pendingChoice?.kind).toBe('optionalPay')
    expect(r.state.pendingDecisions?.length).toBe(1)
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.state.pendingChoice?.kind).toBe('optionalPay') // second surfaced
    r = reduce(r.state, { type: 'RESOLVE_CHOICE', player: 0, iid: 'pay' })
    expect(r.state.players[0].zones.base.filter((c) => c.cardId === 'ogn-037-298').length).toBe(2)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === 'ogn-037-298')).toBe(false)
  })
})

// ── E4 — Hidden cleanup on mid-turn control loss (a spell kill) ──────────────────
describe('E4 — Hidden cleanup on mid-turn control loss', () => {
  it('a kill that empties your battlefield trashes your now-unsupported Hidden card', () => {
    const killId = injectCard('e4-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} })
    const s = baseState()
    const mine = mk(furyUnit.id, 0)
    const hidden = mk(furyUnit.id, 0)
    s.battlefields[0] = { cardId: battlefield.id, units: [mine], controller: 0, facedown: { iid: hidden.iid, cardId: hidden.cardId, owner: 0 } } as never
    const sp = mk(killId, 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [mine.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // The killed unit left bf0 with no controller → the facedown is trashed mid-turn.
    expect((r.state.battlefields[0] as { facedown?: unknown }).facedown ?? null).toBe(null)
    expect(r.state.players[0].zones.trash.some((c) => c.iid === hidden.iid)).toBe(true)
  })
})
