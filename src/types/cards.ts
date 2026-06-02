// ---------------------------------------------------------------------------
// Riftbound core card data model
//
// Based on the publicly documented rules of Riftbound (Origins, 2025):
//  - Cards belong to one or more of six Domains (colors).
//  - Resources are Energy (paid by Exhausting runes) and Power (paid by
//    Recycling runes of a matching domain).
//  - Card types: Unit, Spell, Gear, Battlefield, Legend (champion), Rune.
//
// Domain identities here are our best mapping of the public color wheel and
// are easy to adjust as we ingest official card data in Phase 2.
// ---------------------------------------------------------------------------

/** The six domains (colors) of Runeterra in Riftbound. */
export type Domain =
  | 'fury' // red — aggression, direct damage
  | 'calm' // green — value, growth, recovery
  | 'mind' // blue — control, card advantage
  | 'body' // orange — combat, physicality
  | 'chaos' // purple — disruption, risk/reward
  | 'order' // yellow — structure, tempo

export const DOMAINS: Domain[] = ['fury', 'calm', 'mind', 'body', 'chaos', 'order']

export const DOMAIN_META: Record<
  Domain,
  { label: string; color: string; glyph: string }
> = {
  fury: { label: 'Fury', color: '#e2433b', glyph: '🔥' },
  calm: { label: 'Calm', color: '#3fae6e', glyph: '🌿' },
  mind: { label: 'Mind', color: '#3f87d6', glyph: '💧' },
  body: { label: 'Body', color: '#e08a36', glyph: '⚒️' },
  chaos: { label: 'Chaos', color: '#9a55d4', glyph: '🌀' },
  order: { label: 'Order', color: '#d8c23f', glyph: '⚖️' },
}

export type CardType = 'unit' | 'spell' | 'gear' | 'battlefield' | 'legend' | 'rune'

export type Rarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'showcase'
  | 'promo'

/**
 * Power cost broken down by domain. Energy is the generic cost paid by
 * exhausting any runes; power is the colored cost paid by recycling runes of
 * the matching domain. e.g. { fury: 1 } means "recycle 1 Fury rune".
 */
export type PowerCost = Partial<Record<Domain, number>>

export interface CardBase {
  /** Stable unique id, e.g. "OGN-042". */
  id: string
  name: string
  type: CardType
  /** Domains this card belongs to (most cards: one; some: multiple). */
  domains: Domain[]
  rarity: Rarity
  /** Set code, e.g. "OGN" for Origins. */
  set: string
  /** Collector number within the set. */
  number: number
  /** Rules text (keywords + abilities), kept as authored text for now. */
  text?: string
  /** Flavor text. */
  flavor?: string
  /** Keyword tags for filtering/search, e.g. ["Tank", "Noxus"]. */
  tags?: string[]
  /** Optional art URL (hot-linked from official CDN; never re-hosted). */
  imageUrl?: string
  /** Illustrator credit, when known. */
  artist?: string
  /** True for alternate-art / showcase reprints of a base card. */
  alternateArt?: boolean
  /** Source's canonical id, e.g. "ogn-060-298" — used to dedupe reprints. */
  sourceId?: string
}

/** A creature that fights for battlefields. */
export interface UnitCard extends CardBase {
  type: 'unit'
  energy: number
  power: PowerCost
  /** Combat strength. */
  might: number
}

/** A one-shot effect. */
export interface SpellCard extends CardBase {
  type: 'spell'
  energy: number
  power: PowerCost
  /** Some spells are "Action" (any time) vs "Sorcery" (your turn only). */
  speed: 'action' | 'sorcery'
}

/** Equipment / persistent attachments. */
export interface GearCard extends CardBase {
  type: 'gear'
  energy: number
  power: PowerCost
}

/** Objective locations worth points. */
export interface BattlefieldCard extends CardBase {
  type: 'battlefield'
}

/** A champion's Legend card — the deck's identity. */
export interface LegendCard extends CardBase {
  type: 'legend'
  /** Domains the legend grants access to for deckbuilding. */
  identity: Domain[]
}

/** A rune — channeled for resources. */
export interface RuneCard extends CardBase {
  type: 'rune'
  /** Most runes produce their own domain; some are flexible. */
  produces: Domain[]
}

export type Card =
  | UnitCard
  | SpellCard
  | GearCard
  | BattlefieldCard
  | LegendCard
  | RuneCard

// --- Narrowing helpers -----------------------------------------------------

export const isUnit = (c: Card): c is UnitCard => c.type === 'unit'
export const isSpell = (c: Card): c is SpellCard => c.type === 'spell'
export const isGear = (c: Card): c is GearCard => c.type === 'gear'
export const isBattlefield = (c: Card): c is BattlefieldCard =>
  c.type === 'battlefield'
export const isLegend = (c: Card): c is LegendCard => c.type === 'legend'
export const isRune = (c: Card): c is RuneCard => c.type === 'rune'

/** Total power pips across all domains (for sorting / curve display). */
export function totalPower(power: PowerCost): number {
  return Object.values(power).reduce((sum, n) => sum + (n ?? 0), 0)
}

/** Combined resource cost (energy + colored power) — the card's "mana value". */
export function totalCost(card: Card): number {
  if (isUnit(card) || isSpell(card) || isGear(card)) {
    return card.energy + totalPower(card.power)
  }
  return 0
}
