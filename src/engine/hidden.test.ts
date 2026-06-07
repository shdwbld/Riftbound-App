import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import type { MatchState, PlayerState, EngineCard, PlayerId, ZoneId } from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = { id, name: id, type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra } as never
  return id
}
const furyUnit = CARDS.find((c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury')!
const furyRune = CARDS.find((c) => c.type === 'rune' && (c as { produces: string[] }).produces.includes('fury'))!
const battlefield = CARDS.find((c) => c.type === 'battlefield')!
let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `h${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return { id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [], points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} }, zones: emptyZones(), mulliganed: true } as PlayerState
}
function baseState(): MatchState {
  return {
    players: [player(0), player(1)], activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 2,
    battlefields: [
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
      { cardId: battlefield.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  } as MatchState
}

describe('Hidden — hide cost & same-turn lock', () => {
  it('hides for exactly 1 recycled rune (ignoring the printed cost) and cannot be revealed the same turn', () => {
    const s = baseState()
    // P0 controls bf0 (has a unit there).
    s.battlefields[0].units.push(mk(furyUnit.id, 0))
    s.battlefields[0].controller = 0
    // An expensive [Hidden] card in hand + one ready rune.
    const hid = mk(injectCard('hid-unit', '[Hidden] A trap unit.', { name: 'Trap', type: 'unit', energy: 8, power: { fury: 3 }, might: 6 }), 0)
    s.players[0].zones.hand.push(hid)
    const rune = mk(furyRune.id, 0)
    s.players[0].zones.runePool.push(rune)
    const r = reduce(s, { type: 'HIDE', player: 0, iid: hid.iid, toBattlefield: 0, runeIid: rune.iid })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].facedown?.iid).toBe(hid.iid) // placed face-down
    expect(r.state.players[0].zones.hand.some((c) => c.iid === hid.iid)).toBe(false) // left hand
    expect(r.state.players[0].zones.runePool.some((c) => c.iid === rune.iid)).toBe(false) // the 1 rune was recycled
    expect(r.state.players[0].zones.runeDeck.some((c) => c.iid === rune.iid)).toBe(true)
    // Can't reveal the same turn it was hidden.
    const rev = reduce(r.state, { type: 'REVEAL', player: 0, iid: hid.iid })
    expect(rev.error).toBeTruthy()
  })
})

describe('Hidden — revealed spell targets are restricted to the hidden battlefield', () => {
  it('a revealed "Deal 3 to a unit" hits an enemy at its battlefield, not a stronger enemy elsewhere', () => {
    const s = baseState()
    s.battlefields[0].controller = 0
    s.battlefields[0].units.push(mk(furyUnit.id, 0)) // P0 holds bf0
    const weakHere = mk(injectCard('weak-here', 'x', { might: 3 }), 1)
    s.battlefields[0].units.push(weakHere) // enemy at the hidden bf (Might 3 → dies to 3)
    const strongElsewhere = mk(injectCard('strong-elsewhere', 'x', { might: 9 }), 1)
    s.battlefields[1].units.push(strongElsewhere) // stronger enemy at another bf
    // A hidden damage spell sitting face-down at bf0, hidden last turn (revealable).
    const spellId = injectCard('hid-bolt', '[Hidden] Deal 3 to a unit.', { type: 'spell', energy: 0, power: {} })
    s.battlefields[0].facedown = mk(spellId, 0, { facedown: true, hiddenTurn: 1 })
    const fid = s.battlefields[0].facedown.iid
    let r = reduce(s, { type: 'REVEAL', player: 0, iid: fid })
    expect(r.error).toBeFalsy()
    // Reveal opens a chain — it's pending (counterable), not yet resolved.
    expect(r.state.chain.length).toBe(1)
    expect(r.state.battlefields[0].units.some((u) => u.iid === weakHere.iid)).toBe(true)
    // Both players pass priority → the reveal resolves.
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    // The enemy at the hidden battlefield was hit (defeated); the stronger one elsewhere is untouched.
    expect(r.state.battlefields[0].units.some((u) => u.iid === weakHere.iid)).toBe(false)
    expect(r.state.battlefields[1].units.find((u) => u.iid === strongElsewhere.iid)?.damage ?? 0).toBe(0)
  })
})

describe('Hidden — reveal during a showdown resolves immediately', () => {
  it('a revealed unit enters at its battlefield without opening a chain mid-showdown', () => {
    const s = baseState()
    s.battlefields[0].controller = 0
    s.battlefields[0].units.push(mk(furyUnit.id, 0))
    s.battlefields[0].facedown = mk(injectCard('hid-amb', '[Hidden] An ambusher.', { name: 'Ambusher', type: 'unit', energy: 0, power: {}, might: 4 }), 0, { facedown: true, hiddenTurn: 1 })
    const fid = s.battlefields[0].facedown.iid
    s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: s.battlefields[0].units[0].iid } as never
    const r = reduce(s, { type: 'REVEAL', player: 0, iid: fid })
    expect(r.error).toBeFalsy()
    expect(r.state.chain.length).toBe(0) // no chain opened during the showdown
    expect(r.state.battlefields[0].units.some((u) => u.iid === fid)).toBe(true) // entered immediately
    expect(r.state.battlefields[0].facedown).toBeNull()
  })
})

describe('Hidden — lose control trashes the face-down card', () => {
  it('a face-down card on a battlefield its owner no longer controls is trashed at cleanup', () => {
    const s = baseState()
    // bf0 is controlled by P1, but P0 still owns a face-down card there.
    s.battlefields[0].units.push(mk(furyUnit.id, 1))
    s.battlefields[0].controller = 1
    s.battlefields[0].facedown = mk(injectCard('lost-hid', '[Hidden] x', { type: 'spell', energy: 0, power: {} }), 0, { facedown: true, hiddenTurn: 1 })
    const fid = s.battlefields[0].facedown.iid
    // Stock decks so passing the turn doesn't end the game, then end P0's turn → beginTurn cleanup.
    for (let i = 0; i < 4; i++) { s.players[0].zones.mainDeck.push(mk(furyUnit.id, 0)); s.players[1].zones.mainDeck.push(mk(furyUnit.id, 1)) }
    const r = reduce(s, { type: 'END_TURN', player: 0 })
    expect(r.error).toBeFalsy()
    expect(r.state.battlefields[0].facedown).toBeNull() // removed
    expect(r.state.players[0].zones.trash.some((c) => c.iid === fid)).toBe(true) // → owner's trash
  })
})
