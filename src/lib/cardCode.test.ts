import { describe, it, expect } from 'vitest'
import { CARDS, getCard, resolveCardCode } from '../data/cards'
import { cardCode } from '../types/cards'
import { parseDeck } from './deckStorage'

const sample = CARDS[0]

describe('card codes', () => {
  it('cardCode is the full uppercase official code derived from id', () => {
    expect(cardCode(sample)).toBe(sample.id.toUpperCase())
    expect(cardCode(sample)).toMatch(/^[A-Z]+-/) // SET-…
  })

  it('getCard resolves the official UPPERCASE code as well as the lowercase id', () => {
    const upper = sample.id.toUpperCase()
    expect(getCard(upper)).toBe(getCard(sample.id))
    expect(getCard(upper)?.id).toBe(sample.id)
  })

  it('importing a decklist with uppercase codes yields canonical lowercase ids', () => {
    const a = CARDS.find((c) => c.type === 'unit')!
    const text = `Name: Test\n# Main\n3 ${a.id.toUpperCase()}\n`
    const deck = parseDeck(text, 'test')
    expect(deck.main[a.id]).toBe(3) // stored lowercase → resolvable
    expect(getCard(Object.keys(deck.main)[0])).toBeTruthy()
  })

  it('resolveCardCode accepts short SET-number codes (no set total)', () => {
    expect(resolveCardCode('OGN-210')).toBe('ogn-210-298')
    expect(resolveCardCode('ogs-023')).toBe('ogs-023-024')
    expect(resolveCardCode('OGN-210-298')).toBe('ogn-210-298') // full code too
    expect(resolveCardCode('zzz-999')).toBeUndefined()
  })

  it('imports the sectioned/bracket format (Legend/Champion/MainDeck/Runes/Battlefields/Sideboard)', () => {
    const text = `Legend:
1 Jhin, Virtuoso [UNL-181]

Champion:
1 Jhin, Murderous Artist [UNL-022]

MainDeck:
3 Disintegrate [OGN-005]
1 Jhin, Murderous Artist [UNL-022]
3 Sharkling [UNL-006]

Battlefields:
1 Forgotten Library [UNL-211]
1 Rockfall Path [SFD-216]
1 Vilemaw's Lair [OGN-295]

Runes:
7 Fury Rune [OGN-007]
5 Mind Rune [OGN-089]

Sideboard:
2 Falling Comet [OGN-085]`
    const deck = parseDeck(text, 'jhin')
    expect(deck.legendId).toBe('unl-181-219')
    expect(deck.championId).toBe('unl-022-219')
    // champion is kept in the deck (Champion section + MainDeck copy) so setup
    // can set it aside.
    expect(deck.main['unl-022-219']).toBe(2)
    expect(deck.main['ogn-005-298']).toBe(3)
    expect(deck.runes['ogn-007-298']).toBe(7)
    expect(deck.runes['ogn-089-298']).toBe(5)
    expect(deck.battlefields).toHaveLength(3)
    expect(deck.battlefields).toContain('sfd-216-221')
    // sideboard is stored separately (not in the main deck).
    expect(deck.main['ogn-085-298']).toBeUndefined()
    expect(deck.sideboard['ogn-085-298']).toBe(2)
  })

  it('resolves a decklist line by NAME when the code is absent', () => {
    const deck = parseDeck('# Main\n3 Daring Poro\n', 'byname')
    expect(deck.main['ogn-210-298']).toBe(3)
  })

  it('imports the flat "<count> <name> (SET-NUM)" format, classifying by type', () => {
    const text = [
      '1 Garen - Might of Demacia - Starter (OGS-023)',
      '6 Body Rune (OGN-126)',
      '1 Trifarian War Camp (OGN-294)',
      '3 Daring Poro (OGN-210)',
      '2 Garen - Rugged (OGS-007)',
    ].join('\n')
    const deck = parseDeck(text, 'flat')
    expect(deck.legendId).toBe('ogs-023-024')
    expect(deck.runes['ogn-126-298']).toBe(6)
    expect(deck.battlefields).toContain('ogn-294-298')
    expect(deck.main['ogn-210-298']).toBe(3)
    expect(deck.main['ogs-007-024']).toBe(2)
  })
})
