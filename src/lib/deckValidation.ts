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

  // Sizes. Main deck is "at least 40" (≥40 is legal); the rune deck is exactly
  // 12; a deck provides 3 battlefields (precons sometimes ship fewer → warn).
  if (mainCount < DECK_RULES.mainDeckSize)
    err(`Main deck has ${mainCount} cards — needs at least ${DECK_RULES.mainDeckSize}.`)
  if (runeCount !== DECK_RULES.runeDeckSize)
    err(`Rune deck has ${runeCount}/${DECK_RULES.runeDeckSize} runes (must be exactly ${DECK_RULES.runeDeckSize}).`)
  if (deck.battlefields.length !== DECK_RULES.battlefieldCount)
    (deck.battlefields.length < DECK_RULES.battlefieldCount ? warn : err)(
      `Battlefields: ${deck.battlefields.length}/${DECK_RULES.battlefieldCount}.`,
    )

  // Per-card type placement + identity (and tally copies per NAME).
  const copiesByName = new Map<string, number>()
  for (const [id, count] of Object.entries(deck.main)) {
    const card = getCard(id)
    if (!card) {
      err(`Unknown card in main deck: ${id}`)
      continue
    }
    copiesByName.set(card.name, (copiesByName.get(card.name) ?? 0) + count)
    if (card.supertype === 'token')
      err(`${card.name} is a token — it's generated in play, not decked.`)
    if (card.type === 'rune' || card.type === 'battlefield' || card.type === 'legend')
      err(`${card.name} can't go in the main deck.`)
    if (identity.length && !isOnIdentity(card, identity))
      err(`${card.name} is off-identity for this legend.`)
  }
  // Sideboard cards: legal types + on-identity, and they count toward the
  // per-name copy limit alongside the main deck.
  for (const [id, count] of Object.entries(deck.sideboard)) {
    const card = getCard(id)
    if (!card) {
      err(`Unknown card in sideboard: ${id}`)
      continue
    }
    copiesByName.set(card.name, (copiesByName.get(card.name) ?? 0) + count)
    if (card.supertype === 'token')
      err(`${card.name} is a token — it can't be in the sideboard.`)
    if (card.type === 'rune' || card.type === 'battlefield' || card.type === 'legend')
      err(`${card.name} can't go in the sideboard.`)
    if (identity.length && !isOnIdentity(card, identity))
      err(`${card.name} (sideboard) is off-identity for this legend.`)
  }

  // Copy limit is per NAME across main + sideboard, incl. the champion.
  for (const [name, total] of copiesByName)
    if (total > DECK_RULES.maxCopiesPerCard)
      err(`${name}: ${total} copies (max ${DECK_RULES.maxCopiesPerCard} of a named card).`)

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

  const legendCard = deck.legendId ? getCard(deck.legendId) : undefined
  const champTag = legendCard ? legendCard.name.split(/\s+[-–,(]/)[0].trim() : ''
  const matchesTag = (card: Card) =>
    !champTag || card.name.includes(champTag) || (card.tags ?? []).some((t) => t.includes(champTag))

  // Chosen Champion: a deck must include a champion unit (the Chosen Champion),
  // and it must share the legend's champion tag. (Signature units can't be it.)
  const championUnits = Object.keys(deck.main)
    .map((id) => getCard(id))
    .filter((c): c is Card => !!c && c.type === 'unit' && c.supertype === 'champion')
  const eligibleChampions = championUnits.filter(matchesTag)
  if (legendCard) {
    if (championUnits.length === 0)
      err(`Add a Chosen Champion — a champion unit named for ${champTag || 'your legend'}.`)
    else if (eligibleChampions.length === 0)
      err(`No champion unit matches ${champTag} — your Chosen Champion must share the legend's name.`)
    if (deck.championId) {
      const chosen = getCard(deck.championId)
      if (!chosen || !deck.main[deck.championId])
        err(`Your Chosen Champion isn't in the deck anymore.`)
      else if (chosen.supertype !== 'champion' || !matchesTag(chosen))
        err(`${chosen.name} can't be your Chosen Champion for ${champTag}.`)
    }
  }

  // Signature: at most 3 total, and each must share the legend's champion tag.
  let signatureCount = 0
  for (const [id, count] of Object.entries({ ...deck.main, ...deck.runes })) {
    const card = getCard(id)
    if (card?.supertype === 'signature') {
      signatureCount += count
      if (champTag && !(card.tags ?? []).some((t) => t.includes(champTag)) && !card.name.includes(champTag))
        err(`${card.name} is a Signature card for another champion (not ${champTag}).`)
    }
  }
  if (signatureCount > 3)
    err(`Too many Signature cards: ${signatureCount} (max 3).`)

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
