import { describe, it, expect } from 'vitest'
import { validateDeck, isOnIdentity } from './deckValidation'
import { CARDS, ALL_CARDS } from '../data/cards'
import { emptyDeck, type Deck } from '../types/deck'

const legend = CARDS.find((c) => c.type === 'legend')!
const identity = legend.type === 'legend' ? legend.identity : []
const onIdentityPlayables = CARDS.filter(
  (c) =>
    (c.type === 'unit' || c.type === 'spell' || c.type === 'gear') &&
    c.supertype !== 'token' &&
    isOnIdentity(c, identity),
)

function deckOf(main: Record<string, number>, extra: Partial<Deck> = {}): Deck {
  return { ...emptyDeck('t', 'T'), legendId: legend.id, main, ...extra }
}
const has = (d: Deck, re: RegExp) => validateDeck(d).issues.some((i) => re.test(i.message))

describe('deck validation (Core Rules §103–110)', () => {
  it('flags a main deck under 40 as needing at least 40', () => {
    if (!onIdentityPlayables[0]) return
    expect(has(deckOf({ [onIdentityPlayables[0].id]: 3 }), /at least 40/i)).toBe(true)
  })

  it('accepts a main deck of 40+ (no size-floor error)', () => {
    if (onIdentityPlayables.length < 14) return
    const main: Record<string, number> = {}
    for (const c of onIdentityPlayables.slice(0, 15)) main[c.id] = 3 // 45 cards
    expect(has(deckOf(main), /at least 40/i)).toBe(false)
  })

  it('caps copies by NAME across printings (not per id)', () => {
    const base = CARDS.find(
      (c) =>
        (c.type === 'unit' || c.type === 'spell') &&
        ALL_CARDS.some((a) => a.id !== c.id && a.name === c.name),
    )
    if (!base) return
    const alt = ALL_CARDS.find((a) => a.name === base.name && a.id !== base.id)!
    // 2 + 2 = 4 copies of the same NAME → illegal.
    expect(has(deckOf({ [base.id]: 2, [alt.id]: 2 }), /max 3.*named/i)).toBe(true)
  })

  it('requires a Chosen Champion unit in the deck', () => {
    const nonChampion = onIdentityPlayables.find((c) => c.supertype !== 'champion')
    if (!nonChampion) return
    expect(has(deckOf({ [nonChampion.id]: 3 }), /chosen champion/i)).toBe(true)
  })
})
