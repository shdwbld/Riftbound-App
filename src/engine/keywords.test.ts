import { describe, it, expect } from 'vitest'
import { accelerateCost, levelBonus, parseKeywords } from './keywords'
import type { Card } from '../types/cards'

// Unique id per card — parseKeywords caches by card.id, so reusing one id
// would cross-contaminate keyword results between tests.
let uid = 0
const unit = (text: string) =>
  ({ id: `kwtest-${uid++}`, name: 'X', type: 'unit', domains: ['fury'], rarity: 'common', set: 'X', number: 1, text, energy: 5, power: {}, might: 5 }) as Card

describe('levelBonus (keyword completion)', () => {
  const scorch = unit('[Hunt 2][Level 3][>] I have +1 :rb_might: and enter ready. (While you have 3+ XP, get the effect.)')
  it('is inactive below the XP threshold', () => {
    const b = levelBonus(scorch, 2)
    expect(b.active).toBe(false)
    expect(b.might).toBe(0)
    expect(b.threshold).toBe(3)
  })
  it('activates at or above the threshold, parsing +Might and enter-ready', () => {
    const b = levelBonus(scorch, 3)
    expect(b.active).toBe(true)
    expect(b.might).toBe(1)
    expect(b.ready).toBe(true)
  })
  it('returns inert for non-Level cards', () => {
    expect(levelBonus(unit('Plain unit.'), 9).active).toBe(false)
  })
})

describe('accelerateCost (Phase 3)', () => {
  it('parses the Accelerate additional cost (energy + a rune)', () => {
    const c = unit('[Accelerate] (You may pay :rb_energy_1::rb_rune_fury: as an additional cost to have me enter ready.)')
    expect(parseKeywords(c).accelerate).toBe(true)
    const cost = accelerateCost(c)
    expect(cost).not.toBeNull()
    expect(cost!.energy).toBe(1)
    expect(cost!.power.fury).toBe(1)
  })

  it('returns null when the card has no Accelerate keyword', () => {
    expect(accelerateCost(unit('Some other unit text.'))).toBeNull()
  })

  it('parses multi-rune Accelerate costs', () => {
    const c = unit('[Accelerate] (You may pay :rb_energy_2::rb_rune_calm::rb_rune_calm: as an additional cost to have me enter ready.)')
    const cost = accelerateCost(c)
    expect(cost!.energy).toBe(2)
    expect(cost!.power.calm).toBe(2)
  })
})
