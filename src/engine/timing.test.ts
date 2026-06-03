import { describe, it, expect } from 'vitest'
import { reduce } from './engine'
import { parseKeywords } from './keywords'
import { autoPayForCard } from './autopay'
import { needsTarget } from './effects'
import { CARDS, CARD_INDEX } from '../data/cards'

// Inject deterministic synthetic cards (zero-cost so payment is trivial) for the
// triggered-ability scenarios, where relying on the live dataset would be flaky.
function inject(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id,
    name: id,
    type: 'unit',
    domains: ['fury'],
    rarity: 'common',
    set: 'X',
    number: 1,
    text,
    energy: 0,
    power: {},
    might: 3,
    ...extra,
  } as never
  return id
}
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
  xp: 0,
  banished: [],
  pool: { energy: 0, power: {} },
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
    chain: [],
    priority: null,
    passes: 0,
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
const anySpell = CARDS.find((c) => c.type === 'spell' && !c.alternateArt && c.domains.length <= 1)
const reactionSpell = CARDS.find(
  (c) => c.type === 'spell' && !c.alternateArt && parseKeywords(c).reaction,
)
const drawSpell = CARDS.find(
  (c) => c.type === 'spell' && !c.alternateArt && /draw \d|draw a/i.test(c.text ?? ''),
)
function giveRunes(p: { zones: { runePool: EngineCard[] } }, card: { domains: string[] }) {
  const domains = card.domains.length ? card.domains : ['fury']
  for (const d of domains) for (let i = 0; i < 8; i++) p.zones.runePool.push(mk(runeOf(d), 0))
}

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

describe('chain (Batch A)', () => {
  it('a spell goes on the Chain and resolves after all pass (LIFO)', () => {
    if (!anySpell) return
    const s = baseState()
    const sp = mk(anySpell.id, 0)
    s.players[0].zones.hand.push(sp)
    giveRunes(s.players[0], anySpell)
    const pay = autoPayForCard(s.players[0], anySpell)
    if (!pay) return
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, payment: pay })
    expect(r.error).toBeUndefined()
    expect(r.state.chain.length).toBe(1)
    expect(r.state.priority).toBe(1)
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.chain.length).toBe(0)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === anySpell.id)).toBe(true)
  })

  it('T1 — a Counter removes the spell it answers, preventing its effect', () => {
    if (!drawSpell || !reactionSpell) return
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(vanilla.id, 0)] // so a successful draw is observable
    const sp = mk(drawSpell.id, 0)
    s.players[0].zones.hand.push(sp)
    giveRunes(s.players[0], drawSpell)
    const p0pay = autoPayForCard(s.players[0], drawSpell)
    if (!p0pay) return
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, payment: p0pay })
    expect(r.state.chain.length).toBe(1)
    // player 1 counters with a reaction spell
    const cs = mk(reactionSpell.id, 1)
    r.state.players[1].zones.hand.push(cs)
    giveRunes(r.state.players[1] as never, reactionSpell)
    const p1pay = autoPayForCard(r.state.players[1], reactionSpell)
    if (!p1pay) return
    const targetId = r.state.chain[0].id
    r = reduce(r.state, { type: 'COUNTER', player: 1, iid: cs.iid, targetChainId: targetId, payment: p1pay })
    expect(r.error).toBeUndefined()
    expect(r.state.chain.length).toBe(2)
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.chain.length).toBe(0)
    // The draw spell was countered → its draw never happened (deck untouched).
    expect(r.state.players[0].zones.mainDeck.length).toBe(1)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === drawSpell.id)).toBe(true)
  })
})

describe('targeting (Batch B)', () => {
  it('a damage spell resolves onto its chosen target', () => {
    const dmgSpell = CARDS.find((c) => c.type === 'spell' && !c.alternateArt && needsTarget(c))
    if (!dmgSpell) return
    const s = baseState()
    const target = mk(vanilla.id, 1, { exhausted: true })
    s.battlefields[0].units.push(target)
    const sp = mk(dmgSpell.id, 0)
    s.players[0].zones.hand.push(sp)
    giveRunes(s.players[0], dmgSpell)
    const pay = autoPayForCard(s.players[0], dmgSpell)
    if (!pay) return
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, payment: pay, targets: [target.iid] })
    expect(r.state.chain.length).toBe(1)
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    const still = r.state.battlefields[0].units.find((u) => u.iid === target.iid)
    // Either the unit died (removed) or it has marked damage.
    expect(!still || still.damage > 0).toBe(true)
  })
})

describe('triggered abilities (Batch C)', () => {
  it('T2 — a spell countered on the chain still fires "when you play a spell" triggers', () => {
    const watcher = inject('t2-watcher', 'When you play a spell, draw a card.')
    const drawSp = inject('t2-draw', 'Draw a card.', { type: 'spell', might: undefined })
    const counter = inject('t2-counter', '[Reaction] Counter target spell.', { type: 'spell', might: undefined })
    const s = baseState()
    s.players[0].zones.base.push(mk(watcher, 0)) // the global play-trigger source
    s.players[0].zones.mainDeck = [mk(vanilla.id, 0), mk(vanilla.id, 0)] // 2 cards to draw from
    const sp = mk(drawSp, 0)
    s.players[0].zones.hand.push(sp)
    // P0 plays the draw spell → it goes on the chain; the watcher's play-trigger
    // fires immediately (draw 1) → deck 2 → 1.
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, payment: { exhaust: [], recycle: [] } })
    expect(r.state.chain.length).toBe(1)
    expect(r.state.players[0].zones.mainDeck.length).toBe(1)
    // P1 counters it.
    const cs = mk(counter, 1)
    r.state.players[1].zones.hand.push(cs)
    r = reduce(r.state, { type: 'COUNTER', player: 1, iid: cs.iid, targetChainId: r.state.chain[0].id, payment: { exhaust: [], recycle: [] } })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    expect(r.state.chain.length).toBe(0)
    // The spell was countered → its OWN draw never happened, so the deck is still
    // 1 (only the play-trigger drew). T2: play-trigger fired despite the counter.
    expect(r.state.players[0].zones.mainDeck.length).toBe(1)
    expect(r.state.players[0].zones.trash.some((c) => c.cardId === drawSp)).toBe(true)
  })

  it('T10 — simultaneous death triggers resolve turn-player first', () => {
    const a = inject('t10-a', "When I'm defeated, draw a card.", { might: 2 })
    const b = inject('t10-b', "When I'm defeated, draw a card.", { might: 2 })
    const s = baseState() // activePlayer = 0 = turn player
    s.players[0].zones.mainDeck = [mk(vanilla.id, 0)]
    s.players[1].zones.mainDeck = [mk(vanilla.id, 1)]
    s.battlefields[0].units.push(mk(b, 1, { exhausted: true }))
    const attacker = mk(a, 0)
    s.players[0].zones.base.push(attacker)
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: attacker.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 }) // mutual kill (2 vs 2)
    const deaths = r.state.log
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /deathknell/i.test(l.text) && l.player != null)
    const p0 = deaths.find((d) => d.l.player === 0)
    const p1 = deaths.find((d) => d.l.player === 1)
    expect(p0 && p1).toBeTruthy()
    expect(p0!.i).toBeLessThan(p1!.i) // turn player's trigger logged first
  })

  it('T11 — an Attack trigger fires exactly once per combat', () => {
    const atk = inject('t11-atk', 'When I attack, draw a card.', { might: 9 }) // survives
    const s = baseState()
    s.players[0].zones.mainDeck = [mk(vanilla.id, 0), mk(vanilla.id, 0), mk(vanilla.id, 0)]
    s.battlefields[0].units.push(mk(vanilla.id, 1, { exhausted: true })) // weak defender
    const u = mk(atk, 0)
    s.players[0].zones.base.push(u)
    const before = s.players[0].zones.mainDeck.length
    let r = reduce(s, { type: 'MOVE_UNIT', player: 0, iid: u.iid, toBattlefield: 0 })
    r = reduce(r.state, { type: 'PASS', player: 1 })
    r = reduce(r.state, { type: 'PASS', player: 0 })
    // Exactly one card drawn from the single attack trigger.
    expect(before - r.state.players[0].zones.mainDeck.length).toBe(1)
  })

  it('T13 — a damage spell whose target left play fizzles cleanly', async () => {
    const { spellEffect, hasUntargetedPart } = await import('./effects')
    // Pure-damage spell so leaving play truly fizzles (no draw part to resolve).
    const dmg = CARDS.find(
      (c) => c.type === 'spell' && !c.alternateArt && needsTarget(c) && !hasUntargetedPart(spellEffect(c)),
    )
    if (!dmg) return
    const s = baseState()
    const target = mk(vanilla.id, 1, { exhausted: true })
    s.battlefields[0].units.push(target)
    const sp = mk(dmg.id, 0)
    s.players[0].zones.hand.push(sp)
    giveRunes(s.players[0], dmg)
    const pay = autoPayForCard(s.players[0], dmg)
    if (!pay) return
    let r = reduce(s, { type: 'PLAY_SPELL', player: 0, iid: sp.iid, payment: pay, targets: [target.iid] })
    // Remove the target from play while the spell is still on the chain.
    r.state.battlefields[0].units = []
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 1 })
    r = reduce(r.state, { type: 'PASS_PRIORITY', player: 0 })
    expect(r.state.chain.length).toBe(0)
    expect(r.state.log.some((l) => /fizzled/i.test(l.text))).toBe(true)
  })
})

describe('resource pool (Batch E)', () => {
  it('T14 — Add resolves instantly and cannot be reacted to', () => {
    const s = baseState()
    const r = reduce(s, { type: 'ADD', player: 0, energy: 2, power: { fury: 1 } })
    expect(r.error).toBeUndefined()
    // No chain item is created → there is no priority window to react in.
    expect(r.state.chain.length).toBe(0)
    expect(r.state.priority).toBeNull()
    expect(r.state.players[0].pool.energy).toBe(2)
    expect(r.state.players[0].pool.power.fury).toBe(1)
  })
})

describe('timing: not yet implemented (documented gaps)', () => {
  it.todo('T4 — cost checks read base cost despite reductions (needs cost-reduction effects)')
  it.todo('T12 — "Nth time" trigger fires once on a simultaneous spike (needs per-turn counters)')
})
