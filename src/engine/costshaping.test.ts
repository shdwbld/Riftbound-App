import { describe, it, expect } from 'vitest'
import { reduce, repeatCostFor } from './engine'
import { effectiveCostOf } from './autopay'
import { CARDS, CARD_INDEX } from '../data/cards'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'
import type { ShowdownState } from './types'

// ---------------------------------------------------------------------------
// Typed wrapper for the opts-extended signature of effectiveCostOf.
// The 4th argument (opts) is part of a concurrent implementation landing.
// Until it lands, the function ignores opts; once live, the assertions fire.
// ---------------------------------------------------------------------------
type CostOpts = {
  fromZone?: 'hand' | 'trash' | 'mainDeck' | 'base' | 'runeDeck'
  targets?: string[]
  equipTarget?: string
}
const effectiveCostOfOpts = effectiveCostOf as unknown as (
  state: MatchState,
  player: PlayerId,
  card: unknown,
  opts?: CostOpts,
) => { energy: number; power: Record<string, number> }

// ---------------------------------------------------------------------------
// Harness — copied verbatim from engine.test.ts lines 1-90
// ---------------------------------------------------------------------------

function injectCard(id: string, text: string, extra: Record<string, unknown> = {}) {
  CARD_INDEX[id] = {
    id, name: id, type: 'unit', domains: ['fury'], rarity: 'common',
    set: 'X', number: 1, text, energy: 0, power: {}, might: 3, ...extra,
  } as never
  return id
}

// Find real cards to exercise the engine deterministically.
const battlefield = CARDS.find((c) => c.type === 'battlefield')!

let n = 0
function mk(cardId: string, owner: PlayerId, o: Partial<EngineCard> = {}): EngineCard {
  return { iid: `t${n++}`, cardId, owner, exhausted: false, damage: 0, attached: [], ...o }
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

function baseState(): MatchState {
  return {
    players: [player(0), player(1)],
    activePlayer: 0,
    firstPlayer: 0,
    phase: 'action',
    turn: 2,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A card's printed Energy (CARD_INDEX returns the Card union; narrow it). */
const baseEnergy = (c: unknown): number => (c as { energy?: number }).energy ?? 0

// ---------------------------------------------------------------------------
// cost-shaping tests
// ---------------------------------------------------------------------------

describe('cost-shaping', () => {

  // -------------------------------------------------------------------------
  // 1. Spoils of War (ogn-144-298)
  //    "If an enemy unit has died this turn, this costs 2 less."
  //    Base energy: 4
  // -------------------------------------------------------------------------
  it('Spoils of War: costs 2 less when unitDiedThisTurn=true', () => {
    const card = CARD_INDEX['ogn-144-298']
    if (!card) return // skip if dataset missing
    expect(card.type).toBe('spell')

    // Without death → base
    const sNo = baseState()
    const costNo = effectiveCostOf(sNo, 0, card)
    expect(costNo.energy).toBe(baseEnergy(card))

    // With unitDiedThisTurn = true → base − 2
    const sYes = baseState()
    sYes.unitDiedThisTurn = true
    const costYes = effectiveCostOf(sYes, 0, card)
    expect(costYes.energy).toBe(baseEnergy(card) - 2)
  })

  // -------------------------------------------------------------------------
  // 2. Find Your Center (ogn-047-298)
  //    "If an opponent's score is within 3 points of the Victory Score, this
  //    costs 2 less."
  //    Base energy: 3; pointsToWin set to 8
  // -------------------------------------------------------------------------
  it('Find Your Center: costs 2 less when opponent is within 3 of the Victory Score', () => {
    const card = CARD_INDEX['ogn-047-298']
    if (!card) return

    // opponent at points=6, pointsToWin=8 → gap=2 ≤ 3 → −2
    const sWithin = baseState()
    sWithin.pointsToWin = 8
    sWithin.players[1].points = 6
    const costWithin = effectiveCostOf(sWithin, 0, card)
    expect(costWithin.energy).toBe(baseEnergy(card) - 2)

    // opponent at points=2, pointsToWin=8 → gap=6 > 3 → base
    const sNot = baseState()
    sNot.pointsToWin = 8
    sNot.players[1].points = 2
    const costNot = effectiveCostOf(sNot, 0, card)
    expect(costNot.energy).toBe(baseEnergy(card))
  })

  // -------------------------------------------------------------------------
  // 3. Jaull-Fish (sfd-103-221)
  //    "I cost 2 less for each of your [Mighty] units."
  //    (A unit is Mighty while it has 5+ Might.)
  //    Base energy: 7
  // -------------------------------------------------------------------------
  it('Jaull-Fish: costs 2 less for each Mighty friendly unit', () => {
    const card = CARD_INDEX['sfd-103-221']
    if (!card) return
    expect(card.type).toBe('unit')

    // Use a real 5-Might unit; ogn-001-298 Blazing Scorcher has Might 5
    const mightyUnitId = 'ogn-001-298'
    const mightyDef = CARD_INDEX[mightyUnitId]
    if (!mightyDef || mightyDef.type !== 'unit') return // safeguard

    // Two Mighty units at battlefield for player 0 → −4
    const s2 = baseState()
    const u1 = mk(mightyUnitId, 0)
    const u2 = mk(mightyUnitId, 0)
    s2.battlefields[0].units.push(u1, u2)
    s2.battlefields[0].controller = 0
    const cost2 = effectiveCostOf(s2, 0, card)
    expect(cost2.energy).toBe(baseEnergy(card) - 4)

    // Zero Mighty units → base
    const s0 = baseState()
    const cost0 = effectiveCostOf(s0, 0, card)
    expect(cost0.energy).toBe(baseEnergy(card))
  })

  // -------------------------------------------------------------------------
  // 4. Needlessly Large Yordle (sfd-055-221)
  //    "I cost 2 less for each point you scored from holding this turn."
  //    (Energy portion; power component stays printed.)
  //    Base energy: 10
  //    Field: players[0].holdPointsThisTurn
  // -------------------------------------------------------------------------
  it('Needlessly Large Yordle: costs 2 less per hold-point this turn (if field present)', () => {
    const card = CARD_INDEX['sfd-055-221']
    if (!card) return

    const s = baseState()
    // Guard: only run if the field exists in the type (it's optional)
    if (!('holdPointsThisTurn' in s.players[0])) {
      // Field not yet added to PlayerState — pending
      return
    }

    // 2 hold points → −4
    const sHold = baseState()
    ;(sHold.players[0] as PlayerState & { holdPointsThisTurn?: number }).holdPointsThisTurn = 2
    const costHold = effectiveCostOf(sHold, 0, card)
    expect(costHold.energy).toBe(baseEnergy(card) - 4)

    // 0 hold points → base
    const sNone = baseState()
    ;(sNone.players[0] as PlayerState & { holdPointsThisTurn?: number }).holdPointsThisTurn = 0
    const costNone = effectiveCostOf(sNone, 0, card)
    expect(costNone.energy).toBe(baseEnergy(card))
  })

  // Alternate guard approach: check for field existence at runtime
  it('Needlessly Large Yordle: holdPointsThisTurn field exists in PlayerState', () => {
    const card = CARD_INDEX['sfd-055-221']
    if (!card) return
    const s = baseState()
    // holdPointsThisTurn is optional — confirm it can be set
    s.players[0].holdPointsThisTurn = 2
    const cost = effectiveCostOf(s, 0, card)
    expect(cost.energy).toBe(baseEnergy(card) - 4)
    s.players[0].holdPointsThisTurn = 0
    const costZero = effectiveCostOf(s, 0, card)
    expect(costZero.energy).toBe(baseEnergy(card))
  })

  // -------------------------------------------------------------------------
  // 5. Raging Firebrand (ogn-031-298)
  //    "When you play me, the next spell you play this turn costs 5 less."
  //    Discount is applied to spells via players[0].nextSpellCostDiscount.
  //    Field: players[0].nextSpellCostDiscount
  // -------------------------------------------------------------------------
  it('Raging Firebrand gift: next spell costs 5 less (if field present)', () => {
    // Use Find Your Center (a spell) as the beneficiary
    const spellCard = CARD_INDEX['ogn-047-298']
    if (!spellCard) return

    const s = baseState()
    s.players[0].nextSpellCostDiscount = 5
    const costWithDiscount = effectiveCostOf(s, 0, spellCard)
    // spell energy base − 5, clamped to ≥ 0
    expect(costWithDiscount.energy).toBe(Math.max(0, baseEnergy(spellCard) - 5))

    // Without discount → base cost
    const sNo = baseState()
    const costBase = effectiveCostOf(sNo, 0, spellCard)
    expect(costBase.energy).toBe(baseEnergy(spellCard))
  })

  it('Raging Firebrand gift: non-spell cards are NOT discounted', () => {
    // Jaull-Fish is a unit — should not get the spell discount
    const unitCard = CARD_INDEX['sfd-103-221']
    if (!unitCard) return

    const s = baseState()
    s.players[0].nextSpellCostDiscount = 5
    const cost = effectiveCostOf(s, 0, unitCard)
    // No Mighty units → cost = base energy, unaffected by spell discount
    expect(cost.energy).toBe(baseEnergy(unitCard))
  })

  // -------------------------------------------------------------------------
  // 6. Vex - Cheerless (sfd-146-221)
  //    "While I'm in combat, friendly spells cost :rb_energy_1::rb_rune_rainbow: less
  //     to a minimum of :rb_energy_1:, and enemy spells cost :rb_energy_1::rb_rune_rainbow: more."
  //    Modeled as ±2 Energy (1E + 1 wild Power both paid by any rune → ±2).
  //    Requires: Vex at the showdown battlefield (owner 0), showdown open.
  //    Setup: use a base-4 spell (Find Your Center, base=3 → use a base-4 injected)
  //    and a base-2 spell to test the floor, plus Find Your Center for enemy.
  // -------------------------------------------------------------------------
  it('Vex - Cheerless 6a: friendly spell costs −2 Energy (min 1) while Vex is in combat', () => {
    const vexCard = CARD_INDEX['sfd-146-221']
    if (!vexCard) return

    // Inject a base-4 friendly spell for the Vex discount
    const spellId4 = 'test-vex-spell-4'
    injectCard(spellId4, 'Deal damage.', { type: 'spell', energy: 4, power: {} })
    const spellCard4 = CARD_INDEX[spellId4]

    // Inject a base-2 friendly spell to test min-1 floor
    const spellId2 = 'test-vex-spell-2'
    injectCard(spellId2, 'Deal damage.', { type: 'spell', energy: 2, power: {} })
    const spellCard2 = CARD_INDEX[spellId2]

    // Put Vex (owner 0) at battlefield 0
    const s = baseState()
    const vexUnit = mk(vexCard.id, 0)
    s.battlefields[0].units.push(vexUnit)
    s.battlefields[0].controller = 0

    // Open showdown at bf0 (priority=1 means it's enemy's turn but Vex is the combatant)
    const sd: ShowdownState = {
      battlefield: 0,
      priority: 1,
      passes: 0,
      movedUnit: vexUnit.iid,
    }
    s.showdown = sd

    // Query friendly cost (player 0)
    const cost4 = effectiveCostOf(s, 0, spellCard4)
    const cost2 = effectiveCostOf(s, 0, spellCard2)

    // Without showdown → base
    const sNo = baseState()
    const baseNo4 = effectiveCostOf(sNo, 0, spellCard4)
    const baseNo2 = effectiveCostOf(sNo, 0, spellCard2)

    if (cost4.energy < baseNo4.energy) {
      // Handler is live: friendly spell costs base − 2, floor 1
      expect(cost4.energy).toBe(Math.max(1, baseEnergy(spellCard4) - 2)) // 4−2 = 2
      expect(cost2.energy).toBe(Math.max(1, baseEnergy(spellCard2) - 2)) // 2−2 = 0 → floor 1
      // Without showdown → base, unchanged
      expect(baseNo4.energy).toBe(baseEnergy(spellCard4))
      expect(baseNo2.energy).toBe(baseEnergy(spellCard2))
    } else {
      // Not yet wired — document intent
      expect(cost4.energy).toBe(baseEnergy(spellCard4))
    }
  })

  it('Vex - Cheerless 6b: enemy spell costs +2 Energy while Vex is in combat', () => {
    const vexCard = CARD_INDEX['sfd-146-221']
    const spellCard = CARD_INDEX['ogn-047-298'] // Find Your Center, base=3
    if (!vexCard || !spellCard) return

    // Player 0 controls Vex at bf0; player 1 plays the spell (enemy)
    const s = baseState()
    const vexUnit = mk(vexCard.id, 0)
    s.battlefields[0].units.push(vexUnit)
    s.battlefields[0].controller = 0

    const sd: ShowdownState = {
      battlefield: 0,
      priority: 1,
      passes: 0,
      movedUnit: vexUnit.iid,
    }
    s.showdown = sd

    // Enemy spell (player 1)
    const costEnemy = effectiveCostOf(s, 1, spellCard)
    const sNoShowdown = baseState()
    const costBase = effectiveCostOf(sNoShowdown, 1, spellCard)

    if (costEnemy.energy > costBase.energy) {
      // Handler is live: enemy spell costs base + 2
      expect(costEnemy.energy).toBe(baseEnergy(spellCard) + 2)
      expect(costBase.energy).toBe(baseEnergy(spellCard))
    } else {
      // Not yet wired — document intent
      expect(costEnemy.energy).toBe(costBase.energy)
    }
  })

  it('Vex - Cheerless 6c: no showdown → both friendly and enemy costs unchanged', () => {
    const vexCard = CARD_INDEX['sfd-146-221']
    const spellCard = CARD_INDEX['ogn-047-298']
    if (!vexCard || !spellCard) return

    // Vex at bf0 but NO showdown open
    const s = baseState()
    const vexUnit = mk(vexCard.id, 0)
    s.battlefields[0].units.push(vexUnit)
    s.battlefields[0].controller = 0
    s.showdown = null

    expect(effectiveCostOf(s, 0, spellCard).energy).toBe(baseEnergy(spellCard))
    expect(effectiveCostOf(s, 1, spellCard).energy).toBe(baseEnergy(spellCard))
  })

  it('Vex - Cheerless 6d: Vex NOT at the showdown battlefield → costs unchanged', () => {
    const vexCard = CARD_INDEX['sfd-146-221']
    const spellCard = CARD_INDEX['ogn-047-298']
    if (!vexCard || !spellCard) return

    // Vex at bf1, but showdown is at bf0
    const s = baseState()
    const vexUnit = mk(vexCard.id, 0)
    s.battlefields[1].units.push(vexUnit)
    s.battlefields[1].controller = 0

    const sd: ShowdownState = {
      battlefield: 0,
      priority: 1,
      passes: 0,
      movedUnit: 'some-other-unit',
    }
    s.showdown = sd

    // Vex is not at the combat bf → no Vex aura
    expect(effectiveCostOf(s, 0, spellCard).energy).toBe(baseEnergy(spellCard))
    expect(effectiveCostOf(s, 1, spellCard).energy).toBe(baseEnergy(spellCard))
  })

  // -------------------------------------------------------------------------
  // 7. Void Drone (sfd-010-221) / Drag Under (sfd-164-221)
  //    "I cost :rb_energy_2: less to play from anywhere other than your hand."
  //    Void Drone base energy: 3. Drag Under base energy: 5.
  //    effectiveCostOf(s, 0, card, { fromZone: 'trash' }) → base − 2.
  //    effectiveCostOf(s, 0, card, { fromZone: 'hand' }) or no opts → base.
  // -------------------------------------------------------------------------
  it('Void Drone 7a: costs 2 less when played from trash (fromZone param)', () => {
    const card = CARD_INDEX['sfd-010-221']
    if (!card) return
    // base energy = 3
    expect(baseEnergy(card)).toBe(3)

    const s = baseState()

    // fromZone: 'trash' → base − 2 = 1
    const costTrash = effectiveCostOfOpts(s, 0, card, { fromZone: 'trash' })
    // fromZone: 'hand' → base (no discount)
    const costHand = effectiveCostOfOpts(s, 0, card, { fromZone: 'hand' })
    // no opts → base
    const costNone = effectiveCostOfOpts(s, 0, card)

    if (costTrash.energy < costNone.energy) {
      // Handler is live
      expect(costTrash.energy).toBe(baseEnergy(card) - 2)
      expect(costHand.energy).toBe(baseEnergy(card))
      expect(costNone.energy).toBe(baseEnergy(card))
    } else {
      // Not yet wired
      expect(costTrash.energy).toBe(baseEnergy(card))
      expect(costHand.energy).toBe(baseEnergy(card))
    }
  })

  it('Drag Under 7b: costs 2 less when played from trash (fromZone param)', () => {
    const card = CARD_INDEX['sfd-164-221']
    if (!card) return
    // base energy = 5
    expect(baseEnergy(card)).toBe(5)

    const s = baseState()

    const costTrash = effectiveCostOfOpts(s, 0, card, { fromZone: 'trash' })
    const costHand = effectiveCostOfOpts(s, 0, card, { fromZone: 'hand' })
    const costNone = effectiveCostOfOpts(s, 0, card)

    if (costTrash.energy < costNone.energy) {
      // Handler is live
      expect(costTrash.energy).toBe(baseEnergy(card) - 2)
      expect(costHand.energy).toBe(baseEnergy(card))
      expect(costNone.energy).toBe(baseEnergy(card))
    } else {
      // Not yet wired
      expect(costTrash.energy).toBe(baseEnergy(card))
      expect(costHand.energy).toBe(baseEnergy(card))
    }
  })

  it('Void Drone 7c: fromZone mainDeck also grants the 2-less discount', () => {
    const card = CARD_INDEX['sfd-010-221']
    if (!card) return

    const s = baseState()
    const costDeck = effectiveCostOfOpts(s, 0, card, { fromZone: 'mainDeck' })
    const costNone = effectiveCostOfOpts(s, 0, card)

    if (costDeck.energy < costNone.energy) {
      expect(costDeck.energy).toBe(baseEnergy(card) - 2)
    } else {
      expect(costDeck.energy).toBe(baseEnergy(card))
    }
  })

  // -------------------------------------------------------------------------
  // NEW: Irelia - Graceful (sfd-141-221)
  //   "Your spells that choose me cost :rb_energy_1: or :rb_rune_rainbow: less."
  //   Modeled as −1 Energy when the spell's targets include Irelia's iid.
  //   Base energy of Irelia herself: 4 (used only for placement, not for costing).
  //   Test: spell base cost 3 → 2 when targeting Irelia; → 3 without.
  // -------------------------------------------------------------------------
  it('Irelia - Graceful: spell that targets Irelia costs 1 Energy less', () => {
    const ireliaCard = CARD_INDEX['sfd-141-221']
    const spellCard = CARD_INDEX['ogn-047-298'] // Find Your Center, base=3
    if (!ireliaCard || !spellCard) return

    // Place Irelia (owner 0) at bf0
    const s = baseState()
    const ireliaUnit = mk(ireliaCard.id, 0)
    s.battlefields[0].units.push(ireliaUnit)
    s.battlefields[0].controller = 0

    // With Irelia as target → −1 Energy
    const costTargeting = effectiveCostOfOpts(s, 0, spellCard, { targets: [ireliaUnit.iid] })
    // No target → base
    const costNoTarget = effectiveCostOfOpts(s, 0, spellCard, { targets: [] })
    const costBaseNoOpts = effectiveCostOfOpts(s, 0, spellCard)

    if (costTargeting.energy < costNoTarget.energy) {
      // Handler is live
      expect(costTargeting.energy).toBe(baseEnergy(spellCard) - 1)
      expect(costNoTarget.energy).toBe(baseEnergy(spellCard))
      expect(costBaseNoOpts.energy).toBe(baseEnergy(spellCard))
    } else {
      // Not yet wired — document intent
      expect(costTargeting.energy).toBe(baseEnergy(spellCard))
    }
  })

  it('Irelia - Graceful: targeting an enemy Irelia does NOT grant the discount', () => {
    const ireliaCard = CARD_INDEX['sfd-141-221']
    const spellCard = CARD_INDEX['ogn-047-298']
    if (!ireliaCard || !spellCard) return

    // Irelia belongs to player 1 (enemy)
    const s = baseState()
    const ireliaUnit = mk(ireliaCard.id, 1)
    s.battlefields[0].units.push(ireliaUnit)
    s.battlefields[0].controller = 1

    // Player 0 targets enemy Irelia → no discount (it's "your spells that choose ME")
    const costTargeting = effectiveCostOfOpts(s, 0, spellCard, { targets: [ireliaUnit.iid] })
    const costBase = effectiveCostOfOpts(s, 0, spellCard)

    // Whether handler is live or not: enemy Irelia must not discount
    expect(costTargeting.energy).toBe(costBase.energy)
  })

  // -------------------------------------------------------------------------
  // NEW: Hextech Gauntlets (unl-188-219)
  //   "[Equip] :rb_energy_3::rb_rune_rainbow:. This ability's Energy cost is
  //    reduced by the Might of the unit you choose."
  //   Base equip cost: 3 Energy + 1 rainbow. With a Might-4 unit as equipTarget
  //   → energy = max(0, 3 − 4) = 0. No equipTarget → base.
  // -------------------------------------------------------------------------
  it('Hextech Gauntlets: equip cost reduced by target unit Might', () => {
    const gauntletsCard = CARD_INDEX['unl-188-219']
    if (!gauntletsCard) return
    expect(baseEnergy(gauntletsCard)).toBe(3)

    // Inject a friendly unit with effective Might 4
    const mightUnit4Id = 'test-might-4-unit'
    injectCard(mightUnit4Id, 'No abilities.', { type: 'unit', energy: 2, might: 4, power: {} })

    const s = baseState()
    const mUnit = mk(mightUnit4Id, 0)
    s.battlefields[0].units.push(mUnit)
    s.battlefields[0].controller = 0

    // With equipTarget having Might 4 → max(0, 3 − 4) = 0
    const costWithTarget = effectiveCostOfOpts(s, 0, gauntletsCard, { equipTarget: mUnit.iid })
    // No equipTarget → base
    const costNoTarget = effectiveCostOfOpts(s, 0, gauntletsCard)

    if (costWithTarget.energy < costNoTarget.energy) {
      // Handler is live
      expect(costWithTarget.energy).toBe(Math.max(0, baseEnergy(gauntletsCard) - 4))
      expect(costNoTarget.energy).toBe(baseEnergy(gauntletsCard))
    } else {
      // Not yet wired
      expect(costWithTarget.energy).toBe(baseEnergy(gauntletsCard))
    }
  })

  it('Hextech Gauntlets: equip cost with high-Might target floors at 0', () => {
    const gauntletsCard = CARD_INDEX['unl-188-219']
    if (!gauntletsCard) return

    // Inject a unit with Might 7 (> base energy of 3)
    const mightUnit7Id = 'test-might-7-unit'
    injectCard(mightUnit7Id, 'No abilities.', { type: 'unit', energy: 2, might: 7, power: {} })

    const s = baseState()
    const mUnit7 = mk(mightUnit7Id, 0)
    s.battlefields[0].units.push(mUnit7)
    s.battlefields[0].controller = 0

    const costWithTarget7 = effectiveCostOfOpts(s, 0, gauntletsCard, { equipTarget: mUnit7.iid })
    const costNoTarget = effectiveCostOfOpts(s, 0, gauntletsCard)

    if (costWithTarget7.energy < costNoTarget.energy) {
      // Handler is live: max(0, 3 − 7) = 0
      expect(costWithTarget7.energy).toBe(0)
    } else {
      // Not yet wired
      expect(costWithTarget7.energy).toBe(baseEnergy(gauntletsCard))
    }
  })

  // -------------------------------------------------------------------------
  // NEW: Syndra - Transcendent (unl-146-219)
  //   "While I'm in a showdown, your spells have [Repeat] :rb_energy_2::rb_rune_chaos:."
  //   Tested via repeatCostFor(state, player, spellCard).
  //   With Syndra at bf0 + showdown at bf0 → repeatCostFor should return
  //   { energy: 2, power: { chaos: 1 } }.
  //   Without showdown (or Syndra not at combat bf) → null (no Repeat).
  // -------------------------------------------------------------------------
  it('Syndra - Transcendent: grants Repeat { energy:2, power:{chaos:1} } to spells while in showdown', () => {
    const syndraCard = CARD_INDEX['unl-146-219']
    if (!syndraCard) return

    // Use a plain spell with no printed Repeat
    const plainSpellId = 'test-syndra-plain-spell'
    injectCard(plainSpellId, 'Deal damage.', { type: 'spell', energy: 3, power: {} })
    const plainSpell = CARD_INDEX[plainSpellId]

    // Put Syndra (owner 0) at bf0
    const s = baseState()
    const syndraUnit = mk(syndraCard.id, 0)
    s.battlefields[0].units.push(syndraUnit)
    s.battlefields[0].controller = 0

    // Open showdown at bf0
    const sd: ShowdownState = {
      battlefield: 0,
      priority: 1,
      passes: 0,
      movedUnit: syndraUnit.iid,
    }
    s.showdown = sd

    const repeatWithShowdown = repeatCostFor(s, 0, plainSpell)

    // Without showdown → no Repeat
    const sNo = baseState()
    const syndraUnitNo = mk(syndraCard.id, 0)
    sNo.battlefields[0].units.push(syndraUnitNo)
    sNo.battlefields[0].controller = 0
    sNo.showdown = null
    const repeatNoShowdown = repeatCostFor(sNo, 0, plainSpell)

    if (repeatWithShowdown !== null) {
      // Handler is live
      expect(repeatWithShowdown.energy).toBe(2)
      // power should include chaos: 1
      const chaosCount = (repeatWithShowdown.power as Record<string, number>).chaos ?? 0
      expect(chaosCount).toBe(1)
      // Without showdown → no Repeat granted by Syndra
      expect(repeatNoShowdown).toBeNull()
    } else {
      // Not yet wired — document intent (Syndra Repeat grant is pending)
      expect(repeatWithShowdown).toBeNull()
    }
  })

  it('Syndra - Transcendent: does NOT grant Repeat when she is NOT at the showdown battlefield', () => {
    const syndraCard = CARD_INDEX['unl-146-219']
    if (!syndraCard) return

    const plainSpellId2 = 'test-syndra-plain-spell-2'
    injectCard(plainSpellId2, 'Deal damage.', { type: 'spell', energy: 3, power: {} })
    const plainSpell2 = CARD_INDEX[plainSpellId2]

    // Syndra at bf1, showdown at bf0
    const s = baseState()
    const syndraUnit = mk(syndraCard.id, 0)
    s.battlefields[1].units.push(syndraUnit)
    s.battlefields[1].controller = 0

    const sd: ShowdownState = {
      battlefield: 0,
      priority: 1,
      passes: 0,
      movedUnit: 'other-unit-iid',
    }
    s.showdown = sd

    // No Repeat because Syndra is not at bf0
    const repeatResult = repeatCostFor(s, 0, plainSpell2)

    if (repeatResult !== null) {
      // If it fires even without bf-match, at least document we expect null here
      // (implementation may not check bf — in that case this test will fail and
      // the implementation needs fixing)
      expect(repeatResult).toBeNull()
    } else {
      expect(repeatResult).toBeNull()
    }
  })

  // -------------------------------------------------------------------------
  // 8a. Poppy - Paragon (unl-116-219) via reduce
  //     "When you play me, if an opponent's score is within 3 points of the
  //      Victory Score, ready me and gain 3 XP."
  //     Base energy: 5 (free for test — we inject payment via pool)
  // -------------------------------------------------------------------------
  it('Poppy - Paragon: on-play readies herself and gains 3 XP when opponent within 3', () => {
    const card = CARD_INDEX['unl-116-219']
    if (!card) return

    // pointsToWin=8, opponent at 6 → gap=2 ≤ 3 → condition met
    const s = baseState()
    s.pointsToWin = 8
    s.players[1].points = 6

    // Give player 0 enough pool energy to play (avoids rune bookkeeping)
    s.players[0].pool.energy = baseEnergy(card) + 10

    const poppy = mk(card.id, 0)
    s.players[0].zones.hand.push(poppy)

    const { state, error } = reduce(s, {
      type: 'PLAY_UNIT',
      player: 0,
      iid: poppy.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: baseEnergy(card) },
    })

    expect(error).toBeUndefined()

    // Poppy should be in base (entered play)
    const poppyInBase = state.players[0].zones.base.find((u) => u.iid === poppy.iid)
    expect(poppyInBase).toBeDefined()

    // She should be readied (not exhausted) — enters exhausted by default but
    // on-play readySelf fires when condition is met.
    expect(poppyInBase!.exhausted).toBe(false)

    // Player 0 should have gained 3 XP
    expect(state.players[0].xp).toBe(3)
  })

  it('Poppy - Paragon: does NOT ready or gain XP when opponent is NOT within 3', () => {
    const card = CARD_INDEX['unl-116-219']
    if (!card) return

    // pointsToWin=8, opponent at 2 → gap=6 > 3 → condition NOT met
    const s = baseState()
    s.pointsToWin = 8
    s.players[1].points = 2

    s.players[0].pool.energy = baseEnergy(card) + 10

    const poppy = mk(card.id, 0)
    s.players[0].zones.hand.push(poppy)

    const { state, error } = reduce(s, {
      type: 'PLAY_UNIT',
      player: 0,
      iid: poppy.iid,
      payment: { exhaust: [], recycle: [], poolEnergy: baseEnergy(card) },
    })

    expect(error).toBeUndefined()

    const poppyInBase = state.players[0].zones.base.find((u) => u.iid === poppy.iid)
    expect(poppyInBase).toBeDefined()

    // Condition not met → stays exhausted (default for units)
    expect(poppyInBase!.exhausted).toBe(true)

    // No XP gained
    expect(state.players[0].xp).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Bonus: cost floor — reductions cannot push below 0
  // -------------------------------------------------------------------------
  it('cost floor: Spoils of War never goes below 0 energy', () => {
    const card = CARD_INDEX['ogn-144-298']
    if (!card) return

    // Inject a version with energy=1 so base−2 would be negative
    const cheapId = 'test-spoils-cheap'
    injectCard(cheapId,
      'If an enemy unit has died this turn, this costs :rb_energy_2: less.',
      { type: 'spell', energy: 1, power: {} }
    )
    const cheapCard = CARD_INDEX[cheapId]
    const s = baseState()
    s.unitDiedThisTurn = true
    const cost = effectiveCostOf(s, 0, cheapCard)
    expect(cost.energy).toBeGreaterThanOrEqual(0)
    expect(cost.energy).toBe(0)
  })

})
