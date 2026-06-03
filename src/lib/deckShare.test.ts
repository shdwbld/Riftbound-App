import { describe, it, expect } from 'vitest'
import { toSharePayload } from './deckShare'
import { emptyDeck } from '../types/deck'

describe('deckShare', () => {
  it('toSharePayload captures the portable deck fields, deep-copied', () => {
    const d = emptyDeck('x', 'My Deck')
    d.legendId = 'L'
    d.championId = 'C'
    d.main = { a: 2 }
    d.runes = { r: 8 }
    d.battlefields = ['b']
    d.sideboard = { s: 1 }
    const p = toSharePayload(d)
    expect(p).toEqual({
      name: 'My Deck',
      legendId: 'L',
      championId: 'C',
      main: { a: 2 },
      runes: { r: 8 },
      battlefields: ['b'],
      sideboard: { s: 1 },
    })
    // Deep-copied: mutating the payload must not touch the source deck.
    p.main.a = 99
    p.battlefields.push('z')
    expect(d.main.a).toBe(2)
    expect(d.battlefields).toEqual(['b'])
  })
})
