import { describe, it, expect } from 'vitest'
import { FEATURED_DECKS } from './featuredDecks'
import { getCard } from './cards'

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

describe('featured decks', () => {
  it('ships the starter + featured roster', () => {
    expect(FEATURED_DECKS.length).toBe(10)
    expect(FEATURED_DECKS.filter((d) => d.group === 'Starter Deck').length).toBe(8)
    expect(FEATURED_DECKS.filter((d) => d.group === 'Featured Deck').length).toBe(2)
  })

  it('each deck has a valid legend, champion, and only resolvable cards', () => {
    for (const d of FEATURED_DECKS) {
      expect(getCard(d.legendId)?.type, d.name).toBe('legend')
      if (d.championId) expect(getCard(d.championId)?.supertype, d.name).toBe('champion')
      for (const id of [...Object.keys(d.main), ...Object.keys(d.runes), ...d.battlefields])
        expect(getCard(id), `${d.name}: ${id}`).toBeTruthy()
    }
  })

  it('each deck is exactly 40 main + 12 runes', () => {
    for (const d of FEATURED_DECKS) {
      expect(sum(d.main), `${d.name} main`).toBe(40)
      expect(sum(d.runes), `${d.name} runes`).toBe(12)
    }
  })
})
