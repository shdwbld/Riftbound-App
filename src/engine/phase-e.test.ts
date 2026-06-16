import { describe, it, expect } from 'vitest'
import { reduce, repeatCostFor, optPlayCostFor } from './engine'
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

// ── E10 — Ezreal - Prodigy: optional additional costs cost 1 less ───────────────
describe('E10 — Ezreal - Prodigy optional-cost discount', () => {
  const repeatSpell = injectCard('e10-rep', '[Repeat] :rb_energy_2:. Draw 1.', { type: 'spell', energy: 0, power: {} })
  const optUnit = injectCard('e10-opt', 'You may pay :rb_energy_1: as an additional cost to play me.', { type: 'unit', energy: 0, power: {} })

  it('discounts a [Repeat] cost by 1 Energy while Ezreal - Prodigy is in play', () => {
    if (!CARD_INDEX['sfd-149-221']) return
    const card = CARD_INDEX[repeatSpell]
    const noProdigy = baseState()
    expect(repeatCostFor(noProdigy, 0, card)?.energy).toBe(2) // baseline
    const withProdigy = baseState()
    withProdigy.players[0].zones.base.push(mk('sfd-149-221', 0)) // Ezreal - Prodigy
    expect(repeatCostFor(withProdigy, 0, card)?.energy).toBe(1) // 2 − 1
  })

  it('discounts a "you may pay X as additional cost" by 1 (engine + UI share optPlayCostFor)', () => {
    if (!CARD_INDEX['sfd-149-221']) return
    const card = CARD_INDEX[optUnit]
    const noProdigy = baseState()
    expect(optPlayCostFor(noProdigy, 0, card)?.energy).toBe(1) // baseline
    const withProdigy = baseState()
    withProdigy.players[0].zones.base.push(mk('sfd-149-221', 0))
    expect(optPlayCostFor(withProdigy, 0, card)?.energy).toBe(0) // 1 − 1
  })
})

// ── E11 — Draven - Audacious: dies in combat → an opponent scores ───────────────
describe('E11 — Draven - Audacious combat death', () => {
  const dravText = 'When I die in combat, choose an opponent. They score 1 point.'

  it('dying in combat scores 1 for the opponent (1v1 auto-picks the sole foe)', () => {
    const drav = mk(injectCard('e11-drav', dravText, { name: 'Draven - Audacious', might: 3 }), 0)
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('e11-wall', 'A unit.', { might: 9 }), 1, { exhausted: true })], controller: 1 }
    s.players[0].zones.base.push(drav)
    const r = resolveCombat(s, drav)
    expect(r.state.battlefields[0].units.some((u) => u.iid === drav.iid)).toBe(false) // Draven died (3 vs 9)
    expect(r.state.players[1].points).toBe(1) // the opponent scored
  })

  it('a SPELL kill does NOT trigger the death-score (no diedInCombat stamp)', () => {
    const drav = mk(injectCard('e11-drav2', dravText, { name: 'Draven - Audacious', might: 3 }), 1)
    const s = baseState()
    s.battlefields[0] = { cardId: battlefield.id, units: [drav], controller: 1 }
    const sp = mk(injectCard('e11-kill', 'Kill a unit.', { type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(sp)
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, targets: [drav.iid], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[1].points).toBe(0) // not a combat death → no score
  })
})

// ── E12 — Hidden reveal with no legal target fizzles to trash ────────────────────
describe('E12 — Hidden reveal fizzle', () => {
  it('a revealed [Hidden] "Deal 3 to an enemy unit" with no enemy at its battlefield fizzles to trash', () => {
    const s = baseState()
    s.battlefields[0].controller = 0
    s.battlefields[0].units.push(mk(furyUnit.id, 0)) // P0 holds bf0 — only friendly units here
    s.battlefields[1].units.push(mk(furyUnit.id, 1)) // an enemy elsewhere — irrelevant
    const spellId = injectCard('e12-bolt', '[Hidden] Deal 3 to an enemy unit.', { type: 'spell', energy: 0, power: {} })
    const fd = mk(spellId, 0, { facedown: true, hiddenTurn: 1 } as Partial<EngineCard>)
    ;(s.battlefields[0] as { facedown?: EngineCard }).facedown = fd
    let r = reduce(s, { type: 'REVEAL', player: 0, iid: fd.iid })
    expect(r.error).toBeFalsy()
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.players[0].zones.trash.some((c) => c.iid === fd.iid)).toBe(true) // fizzled to trash
    expect(r.state.log.some((l) => /fizzles/i.test(l.text))).toBe(true)
  })
})

// ── E13 — [Reaction] [Add] gear activates off-turn / mid-chain ───────────────────
describe('E13 — [Reaction] [Add] off-turn activation', () => {
  it('a [Reaction] [Add] gear adds to the pool on the opponent\'s turn', () => {
    const sealId = injectCard('e13-seal', ':rb_exhaust:: [Reaction] — [Add] :rb_rune_fury:. (Abilities that add resources can\'t be reacted to.)', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.activePlayer = 1 // P1's turn — P0 is off-turn
    const seal = mk(sealId, 0)
    s.players[0].zones.base.push(seal)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: seal.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].pool?.power.fury).toBe(1)
    expect(r.state.players[0].zones.base.find((x) => x.iid === seal.iid)?.exhausted).toBe(true)
  })

  it('a non-[Reaction] gear ability is still blocked off-turn', () => {
    const plainId = injectCard('e13-plain', ':rb_exhaust:: [Add] :rb_rune_fury:.', { type: 'gear', energy: 0, power: {} })
    const s = baseState()
    s.activePlayer = 1
    const plain = mk(plainId, 0)
    s.players[0].zones.base.push(plain)
    const r = reduce(s, { type: 'ACTIVATE_UNIT', player: 0, iid: plain.iid })
    expect(r.error).toBeTruthy() // off-turn, not a [Reaction] → blocked
  })
})

// ── E14 — 2v2 cross-player triggers: a teammate's death watcher fires ────────────
function teamState(): MatchState {
  const tp = (id: PlayerId, team: 0 | 1) => ({ ...player(id), team } as PlayerState)
  const s = baseState()
  s.players = [tp(0, 0), tp(1, 1), tp(2, 0), tp(3, 1)] // seats 0,2 = team 0; 1,3 = team 1
  ;(s as unknown as { teamMode: boolean }).teamMode = true
  s.pointsToWin = 11
  return s
}
describe('E14 — 2v2 cross-player death trigger', () => {
  it("a teammate's global \"when a friendly unit dies\" watcher fires when an ally dies", () => {
    const s = teamState()
    s.sandbox = true
    // Player 0 holds a global death watcher; player 2 (teammate) owns the dying unit.
    s.players[0].zones.base.push(mk(injectCard('e14-watch', 'When a friendly unit dies, draw 1.', { might: 3 }), 0))
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    const ally = mk(injectCard('e14-ally', 'A unit.', { might: 2 }), 2)
    s.battlefields[0].units.push(ally)
    const before = s.players[0].zones.hand.length
    const r = reduce(s, { type: 'OVERRIDE', player: 0, op: 'kill', iid: ally.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.players[0].zones.hand.length).toBe(before + 1) // teammate's death fired P0's watcher
  })
})

// ── E15 — Svellsongur forwards the host's combat (attack/defend) triggers ────────
describe('E15 — Svellsongur combat-trigger forwarding', () => {
  it('copies the host\'s "when I attack, draw 1" so the gear fires it a second time', () => {
    if (!CARD_INDEX['sfd-059-221']) return // Svellsongur
    const hostId = injectCard('e15-host', 'When I attack, draw 1.', { might: 8 })
    const s = baseState()
    const host = mk(hostId, 0, { attached: ['sfd-059-221|svell-1'] }) // Svellsongur attached
    s.players[0].zones.base.push(host)
    for (let i = 0; i < 4; i++) s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0))
    // A weak stunned defender so combat auto-resolves and the host wins.
    s.battlefields[0] = { cardId: battlefield.id, units: [mk(injectCard('e15-def', 'A unit.', { might: 1 }), 1, { exhausted: true, stunned: true })], controller: 1 }
    const before = s.players[0].zones.hand.length
    const r = resolveCombat(s, host)
    expect(r.error).toBeFalsy()
    // Host's "when I attack, draw 1" + the Svellsongur copy = drew 2.
    expect(r.state.players[0].zones.hand.length).toBe(before + 2)
  })
})
