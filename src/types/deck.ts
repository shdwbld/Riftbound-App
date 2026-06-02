import type { Domain } from './cards'

/**
 * A Riftbound deck. A player brings:
 *  - one Champion Legend (the deck identity)
 *  - a Main Deck (units, spells, gear)
 *  - a Rune Deck (resource cards)
 *  - a set of Battlefields (count depends on game mode)
 */
export interface Deck {
  id: string
  name: string
  legendId: string | null
  /** Map of cardId -> copies in the main deck. */
  main: Record<string, number>
  /** Map of runeCardId -> copies in the rune deck. */
  runes: Record<string, number>
  /** Battlefield cardIds chosen for this deck. */
  battlefields: string[]
  updatedAt: number
}

/** Deck construction constraints (1v1 standard; adjust per mode later). */
export const DECK_RULES = {
  mainDeckSize: 40,
  runeDeckSize: 12,
  battlefieldCount: 3,
  maxCopiesPerCard: 3,
}

export interface DeckValidationIssue {
  level: 'error' | 'warning'
  message: string
}

export function emptyDeck(id: string, name: string): Deck {
  return {
    id,
    name,
    legendId: null,
    main: {},
    runes: {},
    battlefields: [],
    updatedAt: 0,
  }
}

/** Total copies in a {cardId: count} pile. */
export function pileSize(pile: Record<string, number>): number {
  return Object.values(pile).reduce((a, b) => a + b, 0)
}

/** Domains a deck is allowed to use, derived from its legend's identity. */
export type DeckIdentity = Domain[]
