import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { parseKeywords } from './keywords'
import { autoPayForCard } from './autopay'
import { CARDS } from '../data/cards'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'

// ---------------------------------------------------------------------------
// Tests the interactions from docs/TIMING-REFERENCE.md against the engine.
// Implemented scenarios assert real behavior; unimplemented ones are `it.todo`
// so the suite documents exactly what the timing engine does and doesn't cover
// (see docs/TIMING-AUDIT.md).
// ---------------------------------------------------------------------------

let n = 0
const mk = (cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard => ({
  iid: `tm${n++}`,
  cardId,
  owner,
  exhausted: false,
  damage: 0,
  attached: [],
  ...o,
})
const emptyZones = (): Record<ZoneId, EngineCard[]> => ({
  mainDeck: [],
  runeDeck: [],
  hand: [],
  base: [],
  runePool: [],
  trash: [],
})
const player = (id: PlayerId): PlayerState => ({
  id,
  name: `P${id + 1}`,
  legend: null,
  champion: null,
  tokenPile: [],
  points: 0,
  zones: emptyZones(),
  mulliganed: true,
})

const bf = CARDS.find((c) => c.type === 'battlefield')!
function baseState(): MatchState {
  return {
    players: [player(0), player(1)],
    activePlayer: 0,
    firstPlayer: 0,
    phase: 'action',
    turn: 3,
    battlefields: [
      { cardId: bf.id, units: [], controller: null },
      { cardId: bf.id, units: [], controller: null },
    ],
    pointsToWin: 8,
    winner: null,
    showdown: null,
    log: [],
    seq: 0,
  }
}

const vanilla = CARDS.find(
  (c) =>
    c.type === 'unit' &&
    !c.alternateArt &&
    (c as { might: number }).might >= 2 &&
    Object.values(parseKeywords(c)).every((v) => !v),
)!
const shieldUnit = CARDS.find(
  (c) => c.type === 'unit' && !c.alternateArt && parseKeywords(c).shield > 0,
)
const deathknellUnit = CARDS.find(
  (c) => c.type === 'unit' && !c.alternateArt && parseKeywords(c).deathknell,
)
const runeOf = (d: string) =>
  CARDS.find((c) => c.type === 'rune' && (c as { produces: string[] }).produces.includes(d))!.id
const legionUnit = CARDS.find(
  (c) =>
    c.type === 'unit' &&
    !c.alternateArt &&
    parseKeywords(c).legion &&
    /recruit unit token/i.test(c.text ?? ''),
)

describe('timing: implemented interactions', () => {
  it('T5 — cannot reinforce an active showdown', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(vanilla.id, 1, { exhausted: true }))
    const a1 = mk(vanilla.id, 0)
    const a2 = mk(vanilla.id, 0)
    s.players[0].zones.base.push(a1, a2)
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: a1.iid, toBattlefield: 0 })
    expect(r.state.phase).toBe('showdown')
    // Second move during the open showdown must be rejected.
    const r2 = reduce(r.state, { type: 'MOVE_UNIT', player: 0, iid: a2.iid, toBattlefield: 0 })
    expect(r2.error).toBeDefined()
  })

  it('T6 — Shield raises a defender\'s effective Might (survives a lethal-looking hit)', () => {
    if (!shieldUnit) return
    const sm = (shieldUnit as { might: number }).might
    const s = baseState()
    // Defender = shield unit (might sm + shield). Attacker tuned to exactly sm.
    s.battlefields[0].units.push(mk(shieldUnit.id, 1, { exhausted: true }))
    const attacker = mk(vanilla.id, 0, {
      tempMight: sm - (vanilla as { might: number }).might,
    })
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // The shielded defender should still be on the battlefield.
    expect(r.state.battlefields[0].units.some((u) => u.cardId === shieldUnit.id)).toBe(true)
  })

  it('T9 — Deathknell fires when a unit is killed in combat', () => {
    if (!deathknellUnit) return
    const dm = (deathknellUnit as { might: number }).might
    const s = baseState()
    s.battlefields[0].units.push(mk(deathknellUnit.id, 1, { exhausted: true }))
    const attacker = mk(vanilla.id, 0, {
      tempMight: dm - (vanilla as { might: number }).might,
    })
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.players[1].zones.trash.some((u) => u.cardId === deathknellUnit.id)).toBe(true)
    expect(r.state.log.some((l) => /deathknell/i.test(l.text))).toBe(true)
  })

  it('T7 — Stun makes a unit deal 0 combat damage', () => {
    const s = baseState()
    // Stunned defender deals 0; attacker (might = defender might) survives & wins.
    s.battlefields[0].units.push(mk(vanilla.id, 1, { exhausted: true, stunned: true }))
    const attacker = mk(vanilla.id, 0)
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // Attacker took 0 damage, killed the stunned defender, and conquered.
    expect(r.state.battlefields[0].units.some((u) => u.iid === attacker.iid)).toBe(true)
    expect(r.state.battlefields[0].controller).toBe(0)
  })

  it('T8 — no conquer → surviving attacker is Recalled to base', () => {
    const s = baseState()
    s.battlefields[0].units.push(mk(vanilla.id, 1, { exhausted: true }))
    // Attacker deals 0 (stunned) but survives (big buffs) → both live → recall.
    const attacker = mk(vanilla.id, 0, { stunned: true, buffs: 10 })
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    expect(r.state.players[0].zones.base.some((u) => u.iid === attacker.iid)).toBe(true)
    expect(r.state.battlefields[0].units.some((u) => u.iid === attacker.iid)).toBe(false)
    expect(r.state.battlefields[0].controller).toBe(1)
  })

  it('T3 — LEGION only fires its effect with a prior card played this turn', () => {
    if (!legionUnit) return
    const card = legionUnit as { id: string; domains: string[] }
    const setup = (priorPlays: number) => {
      const s = baseState()
      const p = s.players[0]
      p.cardsPlayedThisTurn = priorPlays
      const unit = mk(card.id, 0)
      p.zones.hand.push(unit)
      const domains = card.domains.length ? card.domains : ['fury']
      for (const d of domains) for (let i = 0; i < 8; i++) p.zones.runePool.push(mk(runeOf(d), 0))
      const payment = autoPayForCard(p, legionUnit!)
      if (!payment) return null
      return reduce(s, { type: 'PLAY_UNIT', player: 0, iid: unit.iid, payment })
    }
    const off = setup(0)
    const on = setup(1)
    if (!off || !on) return
    const recruits = (st: typeof off) =>
      st!.state.players[0].zones.base.filter((u) => u.cardId !== card.id).length
    expect(recruits(on)).toBeGreaterThan(recruits(off))
  })

  it('T15 — Conquer scores immediately when taking an empty battlefield', () => {
    const s = baseState()
    const u = mk(vanilla.id, 0)
    s.players[0].zones.base.push(u)
    const before = s.players[0].points
    const r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    expect(r.state.players[0].points).toBe(before + 1)
    expect(r.state.battlefields[0].controller).toBe(0)
  })
})

describe('timing: not yet implemented (documented gaps)', () => {
  it.todo('T1 — Counter beats the spell it answers (needs a LIFO Chain)')
  it.todo('T2 — played-but-countered still fires global triggers')
  it.todo('T4 — cost checks read base cost despite reductions')
  it.todo('T10 — simultaneous triggers: turn player orders first')
  it.todo('T11 — Attack/Defend triggers fire once per combat')
  it.todo('T12 — "Nth time" trigger fires once on a simultaneous spike')
  it.todo('T13 — null target makes a dependent effect fizzle cleanly')
  it.todo('T14 — Add resolves instantly and cannot be reacted to')
})
