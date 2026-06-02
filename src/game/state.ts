import type { Card } from '../types/cards'
import type { Deck } from '../types/deck'
import { getCard } from '../data/cards'

// ---------------------------------------------------------------------------
// Game state model (single-player / goldfish for Phase 3).
//
// This shape is intentionally engine-friendly: Phase 4's rules engine will
// operate on the same GameState via validated actions, and Phase 5 will sync it
// over the network. For now, the board lets you move cards freely (manual play)
// with no rules enforcement.
// ---------------------------------------------------------------------------

/** A physical card on the table — one instance of a card definition. */
export interface CardInstance {
  iid: string
  cardId: string
  exhausted: boolean
  /** Damage marked on a unit this turn/combat. */
  damage: number
}

export type ZoneId =
  | 'mainDeck'
  | 'runeDeck'
  | 'hand'
  | 'base'
  | 'runePool'
  | 'trash'

export interface BattlefieldSlot {
  /** The battlefield card id (objective). */
  cardId: string
  /** Units currently contesting/holding this battlefield. */
  units: CardInstance[]
  /** Whether the local player currently holds it (manual toggle in Phase 3). */
  held: boolean
}

export interface GameState {
  deckId: string
  deckName: string
  legend: CardInstance | null
  points: number
  turn: number
  zones: Record<ZoneId, CardInstance[]>
  battlefields: BattlefieldSlot[]
  /** Append-only action log for the side panel. */
  log: string[]
}

let iidCounter = 0
function makeIid(cardId: string): string {
  return `${cardId}#${Date.now().toString(36)}${(iidCounter++).toString(36)}`
}

function inst(cardId: string): CardInstance {
  return { iid: makeIid(cardId), cardId, exhausted: false, damage: 0 }
}

/** Fisher–Yates shuffle (browser runtime; Math.random is fine here). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Expand a {cardId: count} pile into instances. */
function expandPile(pile: Record<string, number>): CardInstance[] {
  const out: CardInstance[] = []
  for (const [cardId, n] of Object.entries(pile)) {
    for (let i = 0; i < n; i++) out.push(inst(cardId))
  }
  return out
}

export const OPENING_HAND = 5

/** Build a fresh game from a deck: shuffle, draw opening hand, place battlefields. */
export function setupGame(deck: Deck): GameState {
  const main = shuffle(expandPile(deck.main))
  const runes = shuffle(expandPile(deck.runes))
  const hand = main.splice(0, OPENING_HAND)

  return {
    deckId: deck.id,
    deckName: deck.name,
    legend: deck.legendId ? inst(deck.legendId) : null,
    points: 0,
    turn: 1,
    zones: {
      mainDeck: main,
      runeDeck: runes,
      hand,
      base: [],
      runePool: [],
      trash: [],
    },
    battlefields: deck.battlefields.map((cardId) => ({
      cardId,
      units: [],
      held: false,
    })),
    log: [`Game started · ${deck.name}`],
  }
}

// --- Lookups ---------------------------------------------------------------

export function card(ci: CardInstance): Card | undefined {
  return getCard(ci.cardId)
}

/** Find an instance anywhere on the board, returning where it lives. */
export type Location =
  | { kind: 'zone'; zone: ZoneId }
  | { kind: 'battlefield'; index: number }
  | { kind: 'legend' }

export function locate(
  state: GameState,
  iid: string,
): { instance: CardInstance; location: Location } | null {
  if (state.legend?.iid === iid)
    return { instance: state.legend, location: { kind: 'legend' } }
  for (const zone of Object.keys(state.zones) as ZoneId[]) {
    const found = state.zones[zone].find((c) => c.iid === iid)
    if (found) return { instance: found, location: { kind: 'zone', zone } }
  }
  for (let i = 0; i < state.battlefields.length; i++) {
    const found = state.battlefields[i].units.find((c) => c.iid === iid)
    if (found)
      return { instance: found, location: { kind: 'battlefield', index: i } }
  }
  return null
}
