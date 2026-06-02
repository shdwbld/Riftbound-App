import type { Card, Domain } from '../types/cards'
import { getCard } from '../data/cards'
import {
  type Deck,
  type DeckValidationIssue,
  DECK_RULES,
  pileSize,
} from '../types/deck'

export interface DeckValidation {
  issues: DeckValidationIssue[]
  isLegal: boolean
  mainCount: number
  runeCount: number
  /** Domains the deck is allowed to use (from its legend). */
  identity: Domain[]
}

function legendIdentity(deck: Deck): Domain[] {
  if (!deck.legendId) return []
  const legend = getCard(deck.legendId)
  if (legend && legend.type === 'legend') return legend.identity
  return []
}

/** A card is on-identity if every one of its domains is granted by the legend. */
export function isOnIdentity(card: Card, identity: Domain[]): boolean {
  return card.domains.every((d) => identity.includes(d))
}

export function validateDeck(deck: Deck): DeckValidation {
  const issues: DeckValidationIssue[] = []
  const identity = legendIdentity(deck)
  const mainCount = pileSize(deck.main)
  const runeCount = pileSize(deck.runes)

  const err = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warning', message })

  // Legend
  if (!deck.legendId) {
    err('No champion legend selected.')
  } else {
    const legend = getCard(deck.legendId)
    if (!legend || legend.type !== 'legend') err('Selected legend is invalid.')
  }

  // Sizes
  if (mainCount !== DECK_RULES.mainDeckSize)
    (mainCount < DECK_RULES.mainDeckSize ? warn : err)(
      `Main deck has ${mainCount}/${DECK_RULES.mainDeckSize} cards.`,
    )
  if (runeCount !== DECK_RULES.runeDeckSize)
    (runeCount < DECK_RULES.runeDeckSize ? warn : err)(
      `Rune deck has ${runeCount}/${DECK_RULES.runeDeckSize} runes.`,
    )
  if (deck.battlefields.length !== DECK_RULES.battlefieldCount)
    (deck.battlefields.length < DECK_RULES.battlefieldCount ? warn : err)(
      `Battlefields: ${deck.battlefields.length}/${DECK_RULES.battlefieldCount}.`,
    )

  // Per-card copy limit + type placement + identity
  for (const [id, count] of Object.entries(deck.main)) {
    const card = getCard(id)
    if (!card) {
      err(`Unknown card in main deck: ${id}`)
      continue
    }
    if (count > DECK_RULES.maxCopiesPerCard)
      err(`${card.name}: ${count} copies (max ${DECK_RULES.maxCopiesPerCard}).`)
    if (card.supertype === 'token')
      err(`${card.name} is a token — it's generated in play, not decked.`)
    if (card.type === 'rune' || card.type === 'battlefield' || card.type === 'legend')
      err(`${card.name} can't go in the main deck.`)
    if (identity.length && !isOnIdentity(card, identity))
      err(`${card.name} is off-identity for this legend.`)
  }

  for (const id of Object.keys(deck.runes)) {
    const card = getCard(id)
    if (!card) {
      err(`Unknown rune: ${id}`)
      continue
    }
    if (card.type !== 'rune') err(`${card.name} is not a rune.`)
    if (identity.length && !isOnIdentity(card, identity))
      err(`${card.name} is off-identity for this legend.`)
  }

  // Signature limit: at most 3 Signature cards total across the deck.
  let signatureCount = 0
  for (const [id, count] of Object.entries(deck.main)) {
    if (getCard(id)?.supertype === 'signature') signatureCount += count
  }
  for (const [id, count] of Object.entries(deck.runes)) {
    if (getCard(id)?.supertype === 'signature') signatureCount += count
  }
  if (signatureCount > 3)
    err(`Too many Signature cards: ${signatureCount} (max 3 total).`)

  for (const id of deck.battlefields) {
    const card = getCard(id)
    if (!card) {
      err(`Unknown battlefield: ${id}`)
      continue
    }
    if (card.type !== 'battlefield') err(`${card.name} is not a battlefield.`)
  }

  return {
    issues,
    isLegal: issues.every((i) => i.level !== 'error'),
    mainCount,
    runeCount,
    identity,
  }
}
