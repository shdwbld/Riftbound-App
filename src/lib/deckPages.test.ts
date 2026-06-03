import { describe, it, expect, beforeAll } from 'vitest'
import { exportDeck, parseDeck, duplicateDeck, saveDeck } from './deckStorage'
import { computeStats } from './deckStats'
import { validateDeck } from './deckValidation'
import { CARDS } from '../data/cards'
import { emptyDeck, type Deck } from '../types/deck'

// Minimal localStorage shim so the storage-backed helpers run under node.
beforeAll(() => {
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

const unit = CARDS.find((c) => c.type === 'unit')!
const spell = CARDS.find((c) => c.type === 'spell')!

describe('sideboard, duplicate, power curve', () => {
  it('round-trips the sideboard through export → import', () => {
    const d: Deck = { ...emptyDeck('x', 'X'), main: { [unit.id]: 3 }, sideboard: { [spell.id]: 2 } }
    const text = exportDeck(d)
    expect(text).toMatch(/# Sideboard/)
    const parsed = parseDeck(text, 'y')
    expect(parsed.sideboard[spell.id]).toBe(2)
    expect(parsed.main[unit.id]).toBe(3)
  })

  it('duplicateDeck deep-copies (incl. sideboard) with a fresh id', () => {
    const src = saveDeck({ ...emptyDeck('src', 'Src'), main: { [unit.id]: 2 }, sideboard: { [spell.id]: 1 } })
    const copy = duplicateDeck(src.id)!
    expect(copy.id).not.toBe(src.id)
    expect(copy.name).toMatch(/copy/i)
    expect(copy.main[unit.id]).toBe(2)
    expect(copy.sideboard[spell.id]).toBe(1)
    // Independent piles: mutating the copy doesn't touch the source.
    copy.main[unit.id] = 9
    saveDeck(copy)
    expect(duplicateDeck(src.id)!.main[unit.id]).toBe(2)
  })

  it('computeStats tallies a colored-power curve', () => {
    const powered = CARDS.find(
      (c) =>
        (c.type === 'unit' || c.type === 'spell' || c.type === 'gear') &&
        Object.values(c.power).some((n) => (n ?? 0) > 0),
    )
    if (!powered) return
    const power = Object.values((powered as { power: Record<string, number> }).power).reduce(
      (a, b) => a + (b ?? 0),
      0,
    )
    const d: Deck = { ...emptyDeck('p', 'P'), main: { [powered.id]: 3 } }
    expect(computeStats(d).powerCurve[Math.min(power, 7)]).toBe(3)
  })

  it('enforces the copy limit across main + sideboard (per name)', () => {
    const onId = CARDS.find((c) => c.type === 'unit')!
    const d: Deck = { ...emptyDeck('c', 'C'), main: { [onId.id]: 2 }, sideboard: { [onId.id]: 2 } }
    const msgs = validateDeck(d).issues.map((i) => i.message)
    expect(msgs.some((m) => /max 3.*named/i.test(m))).toBe(true)
  })
})
