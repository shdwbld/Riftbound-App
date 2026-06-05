import { describe, it, expect, beforeEach } from 'vitest'
import { exportDeck, parseDeck, cloneIntoLibrary } from './deckStorage'
import { emptyDeck, type Deck } from '../types/deck'
import { CARDS } from '../data/cards'

// cloneIntoLibrary persists via localStorage; provide a minimal in-memory mock
// for the node test environment.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
})

const legend = CARDS.find((c) => c.type === 'legend')!
const champ = CARDS.find((c) => c.type === 'unit' && c.supertype === 'champion')
const other = CARDS.find((c) => c.type === 'unit' && c.supertype !== 'champion')!

describe('deckStorage export/import round-trip', () => {
  it('preserves the Chosen Champion without inflating its copy count', () => {
    if (!champ) return
    const deck: Deck = { ...emptyDeck('t', 'Round Trip'), legendId: legend.id, championId: champ.id, main: { [champ.id]: 1, [other.id]: 3 } }
    const round = parseDeck(exportDeck(deck), 't2')
    expect(round.championId).toBe(champ.id)
    expect(round.main[champ.id]).toBe(1) // not 2 — no double-count
    expect(round.main[other.id]).toBe(3)
    expect(round.legendId).toBe(legend.id)
  })

  it('cloneIntoLibrary tolerates a payload missing fields (no crash)', () => {
    expect(() => cloneIntoLibrary({ name: 'x', legendId: null })).not.toThrow()
    const d = cloneIntoLibrary({ name: 'x', legendId: null, main: {} })
    expect(d.battlefields).toEqual([])
    expect(d.runes).toEqual({})
    expect(d.sideboard).toEqual({})
  })
})
