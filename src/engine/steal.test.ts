import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { emptyPayment } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// --- minimal local fixtures (mirroring engine.test.ts) ---------------------

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}

const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const bodyRune = CARDS.find((c) => c.type === 'rune' && (c as { produces: string[] }).produces.includes('body'))!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `s${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
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
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

/** Play a 0-cost spell from P0's hand and let the chain resolve (1v1). */
function castSpell(s: MatchState, spellIid: string, targets: string[] = []) {
  let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: spellIid, targets, payment: emptyPayment() })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
  r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
  return r
}

describe('A6 — Possession', () => {
  it('permanently takes control of an enemy unit and recalls it to YOUR base', () => {
    const s = baseState()
    const victim = mk(furyUnit.id, 1)
    s.battlefields[0].units.push(victim) // P1 controls bf0
    const poss = mk(injectCard('poss-test', 'Choose an enemy unit at a battlefield. Take control of it and recall it.', { name: 'Possession', type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(poss)

    const r = castSpell(s, poss.iid, [victim.iid])
    expect(r.error).toBeFalsy()
    // Gone from the battlefield, now in P0's base.
    expect(r.state.battlefields[0].units.some((u) => u.iid === victim.iid)).toBe(false)
    const inBase = r.state.players[0].zones.base.find((u) => u.iid === victim.iid)
    expect(inBase).toBeTruthy()
    expect(inBase!.controlledBy).toBe(0) // controlled by the thief
    expect(inBase!.owner).toBe(1)        // owner stays immutable
    expect(inBase!.exhausted).toBe(true) // recalled exhausted
    expect(r.state.battlefields[0].controller).toBe(null) // bf emptied
  })
})

describe('A6 — Hostile Takeover', () => {
  it('takes control until end of turn, flips battlefield control, then reverts to owner at end of turn', () => {
    const s = baseState()
    const victim = mk(furyUnit.id, 1, { exhausted: true })
    s.battlefields[0].units.push(victim)
    s.battlefields[0].controller = 1
    // Stock both decks so passing the turn to P1 doesn't burn them out / end the game.
    for (let i = 0; i < 6; i++) {
      s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)); s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1))
      s.players[0].zones.runeDeck.push(mk(furyUnit.id, 0)); s.players[1].zones.runeDeck.push(mk(furyUnit.id, 1))
    }
    const ht = mk(injectCard('ht-test', 'Take control of an enemy unit at a battlefield. Ready it. Lose control of that unit and recall it at end of turn.', { name: 'Hostile Takeover', type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(ht)

    const r = castSpell(s, ht.iid, [victim.iid])
    expect(r.error).toBeFalsy()
    const stolen = r.state.battlefields[0].units.find((u) => u.iid === victim.iid)!
    expect(stolen.controlledBy).toBe(0)       // thief controls it
    expect(stolen.stolenUntilEot).toBe(true)  // marked for revert
    expect(stolen.exhausted).toBe(false)      // "Ready it."
    expect(r.state.battlefields[0].controller).toBe(0) // control flipped to the thief

    // Resolve the forced (noncombat) showdown so we can reach END_TURN.
    let r2 = r
    for (let i = 0; i < 6 && r2.state.showdown; i++) {
      r2 = reduce(r2.state, { type: 'PASS', player: r2.state.showdown!.priority ?? 1 })
    }
    // End P0's turn → the steal must revert.
    const end = reduce(r2.state, { type: 'END_TURN', player: 0 })
    const reverted = end.state
    // Back in P1's base, control cleared.
    expect(reverted.battlefields[0].units.some((u) => u.iid === victim.iid)).toBe(false)
    const home = reverted.players[1].zones.base.find((u) => u.iid === victim.iid)
    expect(home).toBeTruthy()
    expect(home!.controlledBy).toBeUndefined()
    expect(home!.stolenUntilEot).toBeUndefined()
  })
})

describe('A6 — Akshan - Mischievous', () => {
  it('steals an enemy gear on play (additional cost) and returns it when Akshan dies', () => {
    const s = baseState()
    // P1 has an unattached non-Equipment gear in base (single option → auto-steal).
    const gear = mk(injectCard('aksh-gear', 'A trinket.', { type: 'gear', energy: 0, power: {} }), 1)
    s.players[1].zones.base.push(gear)
    // Akshan in P0 hand; provide two body runes for the [Body][Body] additional cost.
    const akshan = mk(injectCard('aksh-test', 'You may pay :rb_rune_body::rb_rune_body: as an additional cost to play me. When you play me, if you paid the additional cost, move an enemy gear to your base. You control it until I leave the board. If it\'s an Equipment, attach it to me.', { name: 'Akshan - Mischievous', type: 'unit', energy: 0, power: {}, might: 4, domains: ['body'] }), 0)
    s.players[0].zones.hand.push(akshan)
    const br1 = mk(bodyRune.id, 0)
    const br2 = mk(bodyRune.id, 0)
    s.players[0].zones.runePool.push(br1, br2)

    const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: akshan.iid, payAdditionalCost: true, payment: { exhaust: [], recycle: [br1.iid, br2.iid] } })
    expect(r.error).toBeFalsy()
    // Gear moved to P0's base; registry records the steal.
    expect(r.state.players[1].zones.base.some((c) => c.iid === gear.iid)).toBe(false)
    expect(r.state.players[0].zones.base.some((c) => c.iid === gear.iid)).toBe(true)
    expect((r.state.akshanStolenGears ?? []).some((e) => e.gearIid === gear.iid && e.originalOwner === 1)).toBe(true)

    // Kill Akshan with a damage spell → gear returns to P1.
    const akshanInPlay = r.state.players[0].zones.base.find((u) => u.iid === akshan.iid)!
    const dmg = mk(injectCard('aksh-dmg', 'Deal 99 to a unit.', { type: 'spell', energy: 0, power: {} }), 0)
    r.state.players[0].zones.hand.push(dmg)
    const k = castSpell(r.state, dmg.iid, [akshanInPlay.iid])
    expect(k.error).toBeFalsy()
    expect(k.state.players[0].zones.base.some((c) => c.iid === gear.iid)).toBe(false) // left the thief
    expect(k.state.players[1].zones.base.some((c) => c.iid === gear.iid)).toBe(true)  // back to owner
    expect((k.state.akshanStolenGears ?? []).some((e) => e.gearIid === gear.iid)).toBe(false) // registry cleared
  })
})

describe('A6 — multi-opponent steal pool', () => {
  it('Possession can target a unit from any opponent in a 3-player game', () => {
    const s = baseState(3)
    const p2unit = mk(furyUnit.id, 2)
    s.battlefields[1].units.push(p2unit) // P2 (third player) controls bf1
    const poss = mk(injectCard('poss-3p', 'Choose an enemy unit at a battlefield. Take control of it and recall it.', { name: 'Possession', type: 'spell', energy: 0, power: {} }), 0)
    s.players[0].zones.hand.push(poss)

    // No target passed → single enemy option auto-resolves across all opponents.
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: poss.iid, targets: [], payment: emptyPayment() })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 2 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    const inBase = r.state.players[0].zones.base.find((u) => u.iid === p2unit.iid)
    expect(inBase).toBeTruthy()
    expect(inBase!.controlledBy).toBe(0)
    expect(inBase!.owner).toBe(2)
  })
})
