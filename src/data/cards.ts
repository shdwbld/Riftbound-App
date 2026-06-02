import type { Card } from '../types/cards'
import generated from './cards.generated.json'

// ---------------------------------------------------------------------------
// Card data — REAL dataset.
//
// `cards.generated.json` is produced by `scripts/ingest-cards.mjs`, which pulls
// the full card list from the Riftcodex API and normalizes it into our `Card`
// shape. Artwork URLs are hot-linked from the official Riot CDN (never copied).
//
// Re-generate after a new set releases:  node scripts/ingest-cards.mjs
// ---------------------------------------------------------------------------

/** Every card, including alternate-art reprints. */
export const ALL_CARDS = generated as unknown as Card[]

/** Playable set with alternate-art reprints removed (one entry per card). */
export const CARDS: Card[] = ALL_CARDS.filter((c) => !c.alternateArt)

/** Back-compat alias used by early UI. */
export const SEED_CARDS = CARDS

/** Fast lookup by id, across all printings. */
export const CARD_INDEX: Record<string, Card> = Object.fromEntries(
  ALL_CARDS.map((c) => [c.id, c]),
)

export function getCard(id: string): Card | undefined {
  return CARD_INDEX[id]
}
