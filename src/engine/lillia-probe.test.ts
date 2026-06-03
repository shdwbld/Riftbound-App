import { describe, it, expect } from 'vitest'
import { reduce, beginTurn, combatMight, combatMightAt } from './engine'
import { autoPayForCard } from './autopay'
import { spellEffect } from './effects'
import { parseKeywords } from './keywords'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'
import { CARDS, getCard } from '../data/cards'

// Real Lillia-deck cards by name (so we test the shipped data, not stubs).
const card = (name: string) => CARDS.find((c) => c.name === name)!
const runeOf = (d: string) =>
  CARDS.find((c) => c.type === 'rune' && (c as { produces: string[] }).produces.includes(d))!.id

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `p${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
}
function emptyZones(): Record<ZoneId, EngineCard[]> {
  return { mainDeck: [], runeDeck: [], hand: [], base: [], runePool: [], trash: [] }
}
function player(id: PlayerId): PlayerState {
  return {
    id, name: `P${id + 1}`, legend: null, champion: null, tokenPile: [],
    points: 0, xp: 0, banished: [], pool: { energy: 0, power: {} },
    zones: emptyZones(), mulliganed: true,
  }
}
function giveRunes(p: PlayerState, domains: string[]) {
  for (const d of (domains.length ? domains : ['fury'])) for (let i = 0; i < 10; i++) p.zones.runePool.push(mk(runeOf(d), p.id))
}
const bf = CARDS.find((c) => c.type === 'battlefield')!
function state2(): MatchState {
  const ps = [player(0), player(1)]
  // A few deck cards so a fresh turn's Draw step doesn't burn a player out.
  for (const p of ps) for (let i = 0; i < 5; i++) p.zones.mainDeck.push(mk(bf.id, p.id))
  return {
    players: ps,
    activePlayer: 0, firstPlayer: 0, phase: 'action', turn: 3,
    battlefields: [
      { cardId: bf.id, units: [], controller: null },
      { cardId: bf.id, units: [], controller: null },
      { cardId: bf.id, units: [], controller: null },
    ],
    pointsToWin: 8, winner: null, showdown: null, chain: [], priority: null, passes: 0, log: [], seq: 0,
  }
}

/** Play a unit from hand for player 0, paying its cost. Returns the new state. */
function playUnit(s: MatchState, c: { id: string; domains: string[] }): MatchState {
  giveRunes(s.players[0], c.domains)
  const inst = mk(c.id, 0)
  s.players[0].zones.hand.push(inst)
  const pay = autoPayForCard(s.players[0], getCard(c.id)!)!
  const r = reduce(s, { type: 'PLAY_UNIT', player: 0, iid: inst.iid, payment: pay })
  expect(r.error, `play ${c.id}`).toBeUndefined()
  return r.state
}
const isSpriteToken = (u: EngineCard) => {
  const d = getCard(u.cardId)
  return d?.supertype === 'token' && !!d.name?.startsWith('Sprite')
}
function spritesOnBoard(s: MatchState, owner: PlayerId): number {
  let total = s.players[owner].zones.base.filter(isSpriteToken).length
  for (const b of s.battlefields) total += b.units.filter((u) => u.owner === owner && isSpriteToken(u)).length
  return total
}
function spritesAtBase(s: MatchState, owner: PlayerId): number {
  return s.players[owner].zones.base.filter(isSpriteToken).length
}

// ---------------------------------------------------------------------------

describe('Lillia deck — token generation', () => {
  it('Sprite Queen creates a Sprite token on play', () => {
    const s = playUnit(state2(), card('Sprite Queen') as never)
    expect(spritesOnBoard(s, 0)).toBeGreaterThanOrEqual(1)
  })

  it('Sprite Burst creates two Sprites; Sprite Call creates one', () => {
    expect(spellEffect(getCard(card('Sprite Burst').id)!).namedToken).toMatchObject({ name: 'sprite', count: 2, exhausted: false })
    expect(spellEffect(getCard(card('Sprite Call').id)!).namedToken?.count).toBe(1)
  })

  it('the created Sprite token is Might 3 and [Temporary]', () => {
    const s = playUnit(state2(), card('Sprite Queen') as never)
    const sprite = s.players[0].zones.base.find(isSpriteToken)
    expect(sprite).toBeTruthy()
    const def = getCard(sprite!.cardId)!
    expect(def.type === 'unit' && def.might).toBe(3)
    expect(parseKeywords(def).temporary).toBe(true)
    expect(def.supertype).toBe('token') // so Lillia / Soul Shepherd synergies see it
  })

  it('[Temporary] Sprites die at the start of the controller\'s next Beginning Phase', () => {
    let s = state2()
    const SPRITE = card('Sprite (274) // Buff')?.id ?? 'ogn-274-298'
    s.players[0].zones.base.push(mk(SPRITE, 0, { enteredTurn: 1 })) // a Sprite from a past turn
    expect(spritesOnBoard(s, 0)).toBe(1)
    s.activePlayer = 0
    s = beginTurn(s) // Temporary cleanup runs at the owner's Beginning Phase
    expect(spritesOnBoard(s, 0)).toBe(0)
  })
})

describe('Lillia deck — token synergies', () => {
  it('Soul Shepherd gives token units +1 Might', () => {
    const s = state2()
    s.players[0].zones.base.push(mk(card('Soul Shepherd').id, 0))
    const SPRITE = card('Sprite (274) // Buff')?.id ?? 'ogn-274-298'
    const sprite = mk(SPRITE, 0)
    s.battlefields[0].units.push(sprite)
    const base = (getCard(SPRITE) as { might: number }).might // 3
    // Without the aura a Sprite fights at 3; Soul Shepherd makes it 4.
    expect(combatMight(sprite, 'attacker')).toBe(base) // stateless preview: no aura
    expect(combatMightAt(s, 0, sprite, 'attacker')).toBe(base + 1) // state-aware: +1
  })

  it('Lillia - Protector of Dreams gains +1 Might when you play a token unit', () => {
    let s = state2()
    const lil = mk(card('Lillia - Protector of Dreams').id, 0)
    s.players[0].zones.base.push(lil)
    s = playUnit(s, card('Sprite Queen') as never)
    const after = s.players[0].zones.base.find((u) => u.iid === lil.iid)!
    expect(after.tempMight ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('Lillia deck — placement of "here"/"there" tokens', () => {
  it('Lillia - Fae Fawn: moving from base leaves the Sprite at the origin (base)', () => {
    let s = state2()
    const fawn = mk(card('Lillia - Fae Fawn').id, 0)
    s.players[0].zones.base.push(fawn)
    const r = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [fawn.iid], toBattlefield: 0 })
    expect(r.error).toBeUndefined()
    s = r.state
    // The move trigger fires and the Sprite lands at the location moved FROM
    // ("there"). For a Base→battlefield move that origin is the player's base.
    expect(spritesAtBase(s, 0)).toBe(1)
    expect(s.battlefields.some((b) => b.units.some(isSpriteToken))).toBe(false)
  })

  it('Trevor Snoozebottom: holding plays a Sprite at the held battlefield ("here")', () => {
    let s = state2()
    // Trevor holds battlefield 0 at the start of the turn.
    s.battlefields[0].units.push(mk(card('Trevor Snoozebottom').id, 0))
    s.battlefields[0].controller = 0
    s.activePlayer = 0
    s.turn += 2
    s = beginTurn(s)
    // The "When I hold" trigger fires and places the Sprite at the held BF.
    expect(spritesOnBoard(s, 0)).toBeGreaterThanOrEqual(1)
    expect(s.battlefields[0].units.some(isSpriteToken)).toBe(true)
    expect(spritesAtBase(s, 0)).toBe(0)
  })
})

describe('Lillia deck — support cards', () => {
  it('Scuttle Crab draws a card when played', () => {
    const s0 = state2()
    s0.players[0].zones.mainDeck.push(mk(card('Gustwalker').id, 0))
    const handBefore = s0.players[0].zones.hand.length
    const s = playUnit(s0, card('Scuttle Crab') as never)
    // +1 from the draw effect (hand had the played card removed, then +1 drawn).
    expect(s.players[0].zones.hand.length).toBe(handBefore + 1)
  })

  it('Ravenbloom Student gains +1 Might when you play a spell', () => {
    let s = state2()
    const rb = mk(card('Ravenbloom Student').id, 0)
    s.players[0].zones.base.push(rb)
    const spell = card('Sprite Call')
    giveRunes(s.players[0], spell.domains)
    const inst = mk(spell.id, 0)
    s.players[0].zones.hand.push(inst)
    const pay = autoPayForCard(s.players[0], getCard(spell.id)!)!
    const r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: inst.iid, payment: pay })
    expect(r.error).toBeUndefined()
    const after = r.state.players[0].zones.base.find((u) => u.iid === rb.iid)!
    expect(after.tempMight ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('Lilting Lullaby is a Reaction counter spell', () => {
    const def = getCard(card('Lilting Lullaby').id)!
    expect(parseKeywords(def).reaction).toBe(true)
  })
})
