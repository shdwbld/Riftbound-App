import { type Card, type Domain, DOMAINS, totalCost, isUnit, isSpell, isGear } from '../types/cards'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'

export const CURVE_MAX = 7 // last bucket is "7+"

export interface DeckStats {
  /** Energy+power cost histogram for main-deck cards; index 0..CURVE_MAX. */
  curve: number[]
  /** Main-deck card counts by type. */
  typeCounts: Record<string, number>
  /** Main+rune card copies that touch each domain. */
  domainCounts: Record<Domain, number>
  /** Copies of colorless cards. */
  colorless: number
  mainTotal: number
}

export function computeStats(deck: Deck): DeckStats {
  const curve = new Array(CURVE_MAX + 1).fill(0)
  const typeCounts: Record<string, number> = {}
  const domainCounts = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<
    Domain,
    number
  >
  let colorless = 0
  let mainTotal = 0

  const tally = (card: Card, copies: number) => {
    if (card.domains.length === 0) colorless += copies
    for (const d of card.domains) domainCounts[d] += copies
  }

  for (const [id, copies] of Object.entries(deck.main)) {
    const card = getCard(id)
    if (!card) continue
    mainTotal += copies
    typeCounts[card.type] = (typeCounts[card.type] ?? 0) + copies
    if (isUnit(card) || isSpell(card) || isGear(card)) {
      const bucket = Math.min(totalCost(card), CURVE_MAX)
      curve[bucket] += copies
    }
    tally(card, copies)
  }
  for (const [id, copies] of Object.entries(deck.runes)) {
    const card = getCard(id)
    if (card) tally(card, copies)
  }

  return { curve, typeCounts, domainCounts, colorless, mainTotal }
}

/** Draw a random opening hand from the main deck (for quick testing). */
export function sampleHand(deck: Deck, n = 5): Card[] {
  const pool: Card[] = []
  for (const [id, copies] of Object.entries(deck.main)) {
    const card = getCard(id)
    if (!card) continue
    for (let i = 0; i < copies; i++) pool.push(card)
  }
  // Fisher–Yates partial shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}
