import { describe, it, expect } from 'vitest'
import { sampleHand, computeStats } from './deckStats'
import { emptyDeck, type Deck } from '../types/deck'
import { CARDS } from '../data/cards'

const champ = CARDS.find((c) => c.type === 'unit' && c.supertype === 'champion')
const other = CARDS.find((c) => c.type === 'unit' && c.supertype !== 'champion')!

describe('deckStats excludes the set-aside Chosen Champion', () => {
  it('sampleHand never draws the champion', () => {
    if (!champ) return
    const deck: Deck = { ...emptyDeck('t', 'T'), championId: champ.id, main: { [champ.id]: 1, [other.id]: 40 } }
    for (let i = 0; i < 20; i++) {
      const hand = sampleHand(deck, 5)
      expect(hand.every((c) => c.id !== champ.id)).toBe(true)
    }
  })

  it('computeStats keeps the champion in mainTotal but out of the cost curve', () => {
    if (!champ) return
    const deck: Deck = { ...emptyDeck('t', 'T'), championId: champ.id, main: { [champ.id]: 1, [other.id]: 3 } }
    const stats = computeStats(deck)
    expect(stats.mainTotal).toBe(4) // champion still part of the 40
    // the curve total counts only drawable playables (3 copies of `other`, champion excluded)
    const curveTotal = stats.curve.reduce((a, b) => a + b, 0)
    expect(curveTotal).toBe(3)
  })
})
