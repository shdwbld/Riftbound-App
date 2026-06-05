import type { Card } from '../types/cards'
import generated from './cards.generated.json'
import extra from './extraCards.json'

// ---------------------------------------------------------------------------
// Card data — REAL dataset.
//
// `cards.generated.json` is produced by `scripts/ingest-cards.mjs`, which pulls
// the full card list from the Riftcodex API and normalizes it into our `Card`
// shape. Artwork URLs are hot-linked from the official Riot CDN (never copied).
//
// Re-generate after a new set releases:  node scripts/ingest-cards.mjs
// ---------------------------------------------------------------------------

/** Rules-text patches for cards whose ingested text is incomplete — the Riftcodex
 *  API occasionally stores only an [Equip] cost line and drops the equipped-unit
 *  bonus. Keyed by card id; the value REPLACES the card's `text`. Re-applied after
 *  every ingest (so `node scripts/ingest-cards.mjs` won't lose the fix). */
const TEXT_PATCHES: Record<string, string> = {
  // Last Rites — ingest captured only the [Equip] cost; restore the conquer/hold
  // bonus so its full-cost play-from-trash resolves (see playfrom-research.md).
  'sfd-150-221':
    '[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash (Pay the cost: Attach this to a unit you control.) When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)',
}

const applyPatches = (cards: Card[]): Card[] =>
  cards.map((c) => (TEXT_PATCHES[c.id] ? { ...c, text: TEXT_PATCHES[c.id] } : c))

/** Every card, including alternate-art reprints, plus supplemental cards missing
 *  from the ingested dataset (see extraCards.json). */
export const ALL_CARDS = [
  ...applyPatches(generated as unknown as Card[]),
  ...(extra as unknown as Card[]),
]

/** Playable set with alternate-art reprints removed (one entry per card). */
export const CARDS: Card[] = ALL_CARDS.filter((c) => !c.alternateArt)

/** Back-compat alias used by early UI. */
export const SEED_CARDS = CARDS

/** Fast lookup by id, across all printings. */
export const CARD_INDEX: Record<string, Card> = Object.fromEntries(
  ALL_CARDS.map((c) => [c.id, c]),
)

export function getCard(id: string): Card | undefined {
  // Ids are stored lowercase; accept the official UPPERCASE code too (so a code
  // copied from the card detail / pasted into the importer resolves).
  return CARD_INDEX[id] ?? CARD_INDEX[id.toLowerCase()]
}

/** Short "SET-number" code (zero-padded, lowercase) → preferred (non-alt) id.
 *  Lets a short collector code like "OGN-215" or "OGS-023" resolve, the way
 *  other sites print them (without the set-total suffix). */
const SHORT_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  const key = (c: Card) => `${c.set}-${String(c.number).padStart(3, '0')}`.toLowerCase()
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[key(c)]) idx[key(c)] = c.id
  for (const c of ALL_CARDS) if (!idx[key(c)]) idx[key(c)] = c.id // fill gaps with alt printings
  return idx
})()

/** Collector index keyed by the id minus its trailing "-<setTotal>" — captures
 *  exact printings other short codes can't: alt-art (`unl-087a`), promo
 *  (`ogn-058-p`), special numbering (`sfd-t03`). */
const COLL_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  const key = (c: Card) => c.id.replace(/-\d+$/, '')
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[key(c)]) idx[key(c)] = c.id
  for (const c of ALL_CARDS) if (!idx[key(c)]) idx[key(c)] = c.id
  return idx
})()

/**
 * Resolve any collector code to a canonical card id. Accepts:
 *  - a full id / official code: "ogn-210-298" or "OGN-210-298"
 *  - a short "SET-number" code: "OGN-215", "ogs-023" (no set-total)
 *  - a code with a wrong/missing total (matched by SET-number prefix)
 * Returns undefined if nothing matches.
 */
export function resolveCardCode(raw: string): string | undefined {
  const code = raw.trim().toLowerCase()
  if (CARD_INDEX[code]) return code
  if (COLL_INDEX[code]) return COLL_INDEX[code]
  if (SHORT_INDEX[code]) return SHORT_INDEX[code]
  const m = code.match(/^([a-z]+)-(\d+)/)
  if (m) {
    const short = `${m[1]}-${m[2].padStart(3, '0')}`
    if (SHORT_INDEX[short]) return SHORT_INDEX[short]
  }
  return undefined
}

/** Card name → preferred (non-alt) id, matched loosely (case/punctuation/spacing
 *  insensitive) so "Garen - Might of Demacia - Starter" finds "Garen - Might of
 *  Demacia (Starter)". Lets a decklist that prints names resolve. */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const NAME_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[normName(c.name)]) idx[normName(c.name)] = c.id
  for (const c of ALL_CARDS) if (!idx[normName(c.name)]) idx[normName(c.name)] = c.id
  return idx
})()

export function resolveCardName(name: string): string | undefined {
  return NAME_INDEX[normName(name)]
}

/** Resolve a deck-line reference to a card id: try its code first, then its
 *  name. Accepts full/short codes and loose names. */
export function resolveCardRef(code: string | undefined, name: string | undefined): string | undefined {
  return (code ? resolveCardCode(code) : undefined) ?? (name ? resolveCardName(name) : undefined)
}
