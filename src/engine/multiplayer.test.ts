import { describe, it, expect } from 'vitest'
import { reduce, pendingAssignment } from './engine'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'
import { CARDS, CARD_INDEX } from '../data/cards'
import { isUnit } from '../types/cards'

// --- fixtures --------------------------------------------------------------

const battlefield = CARDS.find((c) => c.type === 'battlefield')!
const furyUnit = CARDS.find(
  (c) => isUnit(c) && c.domains.length === 1 && c.domains[0] === 'fury',
)!

function injectUnit(id: string, might: number): string {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text: '', energy: 0, power: {}, might,
  } as never
  return id
}
const M5 = injectUnit('mp-might5', 5)
const M2 = injectUnit('mp-might2', 2)

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `m${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
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

/** A 3-player action-phase state with three shared battlefields. Each player
 *  carries a few deck cards so a fresh turn's Draw step doesn't burn them out. */
function state3(): MatchState {
  const ps = [player(0), player(1), player(2)]
  for (const p of ps) for (let i = 0; i < 5; i++) p.zones.mainDeck.push(mk(furyUnit.id, p.id))
  return {
    players: ps,
    activePlayer: 0,
    firstPlayer: 0,
    phase: 'action',
    turn: 3,
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

// --- elimination via concede ----------------------------------------------

describe('3-player concede / elimination', () => {
  it('a non-active concede keeps the game going and clears their board', () => {
    const s = state3()
    s.battlefields[0].units.push(mk(furyUnit.id, 1)) // P2 holds a battlefield
    s.players[1].zones.base.push(mk(furyUnit.id, 1))
    const { state, error } = reduce(s, { type: 'CONCEDE', player: 1 })
    expect(error).toBeUndefined()
    expect(state.winner).toBeNull() // 2 players remain — game continues
    expect(state.players[1].out).toBe(true)
    // Their units left every battlefield and their base is empty.
    expect(state.battlefields[0].units.some((u) => u.owner === 1)).toBe(false)
    expect(state.players[1].zones.base.length).toBe(0)
    expect(state.activePlayer).toBe(0) // P1 was active; unchanged
  })

  it('the active player conceding passes the turn to the next survivor', () => {
    const s = state3()
    const { state, error } = reduce(s, { type: 'CONCEDE', player: 0 })
    expect(error).toBeUndefined()
    expect(state.winner).toBeNull()
    expect(state.players[0].out).toBe(true)
    expect(state.activePlayer).toBe(1) // turn handed to the next living seat
  })

  it('concede down to one player declares that player the winner', () => {
    const s = state3()
    s.players[2].out = true // P3 already gone
    const { state } = reduce(s, { type: 'CONCEDE', player: 0 })
    expect(state.winner).toBe(1) // only P2 left standing
    expect(state.phase).toBe('gameover')
  })

  it('an out player cannot concede again or act', () => {
    const s = state3()
    s.players[1].out = true
    const { error } = reduce(s, { type: 'CONCEDE', player: 1 })
    expect(error).toBeTruthy()
  })

  it('turn rotation skips eliminated players', () => {
    const s = state3()
    s.players[1].out = true
    const { state } = reduce(s, { type: 'END_TURN', player: 0 })
    expect(state.activePlayer).toBe(2) // skips out P2
  })
})

// --- burn out --------------------------------------------------------------

describe('3-player burn out', () => {
  it('burning out with no Trash eliminates that player but continues the game', () => {
    const s = state3()
    // P1 must draw from an empty deck with an empty Trash → burn out, no recycle.
    s.players[0].zones.mainDeck = []
    s.players[0].zones.trash = []
    const { state, error } = reduce(s, { type: 'DRAW', player: 0 })
    expect(error).toBeUndefined()
    expect(state.players[0].out).toBe(true)
    expect(state.winner).toBeNull() // P2 and P3 are still playing
  })
})

// --- showdown participants & invite ---------------------------------------

describe('3-player showdown', () => {
  /** P1 attacks a battlefield held by P3; P2 is uninvolved. */
  function contested(): MatchState {
    const s = state3()
    s.battlefields[0].units.push(mk(M2, 2)) // P3 defends
    s.players[0].zones.base.push(mk(M2, 0)) // P1's attacker waits at base
    return s
  }

  it('opens priority on the defender, not the uninvolved third player', () => {
    const s = contested()
    const atkIid = s.players[0].zones.base[0].iid
    const { state, error } = reduce(s, {
      type: 'MOVE_UNITS', player: 0, iids: [atkIid], toBattlefield: 0,
    })
    expect(error).toBeUndefined()
    expect(state.phase).toBe('showdown')
    expect(state.showdown!.priority).toBe(2) // the defender, never the bystander P2
  })

  it('resolves after only the two combatants pass (bystander excluded)', () => {
    const s = contested()
    const atkIid = s.players[0].zones.base[0].iid
    let st = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atkIid], toBattlefield: 0 }).state
    // Defender (P3) passes, then attacker (P1) passes → combat resolves.
    st = reduce(st, { type: 'PASS', player: 2 }).state
    st = reduce(st, { type: 'PASS', player: 0 }).state
    expect(st.phase).toBe('action')
    expect(st.showdown).toBeNull()
  })

  it('a combatant can invite the bystander, who accepts and joins', () => {
    const s = contested()
    const atkIid = s.players[0].zones.base[0].iid
    let st = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atkIid], toBattlefield: 0 }).state
    // Attacker P1 invites bystander P2.
    const inv = reduce(st, { type: 'INVITE', player: 0, invitee: 1 })
    expect(inv.error).toBeUndefined()
    st = inv.state
    expect(st.showdown!.invite).toEqual({ from: 0, to: 1 })
    expect(st.showdown!.priority).toBe(1) // invitee responds next
    // P2 accepts → becomes a helper with priority.
    const acc = reduce(st, { type: 'INVITE_RESPOND', player: 1, accept: true })
    expect(acc.error).toBeUndefined()
    st = acc.state
    expect(st.showdown!.helpers).toContain(1)
    expect(st.showdown!.priority).toBe(1)
    // Now all three must pass before combat resolves.
    st = reduce(st, { type: 'PASS', player: 1 }).state
    st = reduce(st, { type: 'PASS', player: 2 }).state
    expect(st.showdown).not.toBeNull() // still open — attacker hasn't passed
    st = reduce(st, { type: 'PASS', player: 0 }).state
    expect(st.phase).toBe('action')
  })

  it('a bystander cannot pass in a showdown they were not invited to', () => {
    const s = contested()
    const atkIid = s.players[0].zones.base[0].iid
    const st = reduce(s, { type: 'MOVE_UNITS', player: 0, iids: [atkIid], toBattlefield: 0 }).state
    const r = reduce(st, { type: 'PASS', player: 1 }) // P2 is not a participant
    expect(r.error).toBeTruthy()
  })
})

// --- multi-defender damage assignment -------------------------------------

describe('multi-defender showdown', () => {
  it('lets a defender (not the attacker) assign the pooled counter-damage', () => {
    const s = state3()
    // Attacker P1 fields two 5-might units; two defenders (P2, P3) deal 2 each.
    const a1 = mk(M5, 0)
    const a2 = mk(M5, 0)
    s.battlefields[0].units.push(a1, a2)
    s.battlefields[0].units.push(mk(M2, 1, { exhausted: true }))
    s.battlefields[0].units.push(mk(M2, 2, { exhausted: true }))
    s.phase = 'showdown'
    s.showdown = { battlefield: 0, priority: 0, passes: 0, movedUnit: a1.iid }
    // All three participants pass → combat resolves and pauses for assignment.
    let st = reduce(s, { type: 'PASS', player: 0 }).state
    st = reduce(st, { type: 'PASS', player: 1 }).state
    st = reduce(st, { type: 'PASS', player: 2 }).state
    expect(st.phase).toBe('showdown')
    expect(st.showdown!.assign).toBeTruthy()
    // The attacker (mover) is NOT the one assigning the defenders' damage.
    expect(pendingAssignment(st, 0)).toBeNull()
    // A defending owner holds the pending assignment.
    const aDefenderAssigns = pendingAssignment(st, 1) != null || pendingAssignment(st, 2) != null
    expect(aDefenderAssigns).toBe(true)
  })
})
