import type { Deck } from '../types/deck'
import { getCard, CARDS } from '../data/cards'
import { battlefieldPassive } from './battlefields'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type ZoneId,
} from './types'

// Standard 1v1 config, per the official Core Rules (see rules research).
export const RULES = {
  pointsToWin: 8,
  openingHand: 4,
  channelPerTurn: 2,
  /** The player going SECOND channels this many on their first turn (catch-up). */
  channelSecondPlayerFirstTurn: 3,
  drawPerTurn: 1,
  /** Points scored per held battlefield at the start of your turn (Hold). */
  pointsPerBattlefield: 1,
  /** Points for taking control of a battlefield (Conquer). */
  pointsPerConquer: 1,
  /** Points to win a multiplayer (3-4 player) game. */
  pointsToWinMultiplayer: 11,
}

let counter = 0
function makeIid(cardId: string, owner: PlayerId): string {
  return `${owner}:${cardId}#${(counter++).toString(36)}`
}

function inst(cardId: string, owner: PlayerId): EngineCard {
  return {
    iid: makeIid(cardId, owner),
    cardId,
    owner,
    exhausted: false,
    damage: 0,
    attached: [],
  }
}

/** Deterministic-friendly shuffle: pass a rng (defaults to Math.random). */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function expand(pile: Record<string, number>, owner: PlayerId): EngineCard[] {
  const out: EngineCard[] = []
  for (const [cardId, n] of Object.entries(pile)) {
    if (getCard(cardId)?.supertype === 'token') continue // tokens never go in a deck
    for (let i = 0; i < n; i++) out.push(inst(cardId, owner))
  }
  return out
}

// The baseline Recruit token, available to every player's token pile.
const RECRUIT = CARDS.find(
  (c) => c.supertype === 'token' && c.type === 'unit' && (c.tags ?? []).includes('Recruit'),
)
export const TOKEN_PILE_IDS = RECRUIT ? [RECRUIT.id] : []

/** The champion name a Legend builds around (text before " - " / "," / "("). */
function championName(legendId: string | null): string | null {
  if (!legendId) return null
  const l = getCard(legendId)
  if (!l || l.type !== 'legend') return null
  return l.name.split(/\s+[-–,(]/)[0].trim() || null
}

function buildPlayer(
  deck: Deck,
  id: PlayerId,
  name: string,
  rng: () => number,
): PlayerState {
  const main = shuffle(expand(deck.main, id), rng)
  const runeDeck = shuffle(expand(deck.runes, id), rng)

  // Chosen Champion: pull one champion unit out of the deck into the Champion
  // Zone. Prefer the player's declared `championId`; otherwise auto-pick the
  // first champion unit matching the legend's champion tag.
  let champion: EngineCard | null = null
  const champ = championName(deck.legendId)
  let idx = -1
  if (deck.championId) {
    idx = main.findIndex((c) => c.cardId === deck.championId)
  }
  if (idx < 0 && champ) {
    idx = main.findIndex((c) => {
      const card = getCard(c.cardId)
      return (
        card?.type === 'unit' &&
        ((card.tags ?? []).some((t: string) => t.includes(champ)) ||
          card.name.includes(champ))
      )
    })
  }
  if (idx >= 0) champion = main.splice(idx, 1)[0]

  const hand = main.splice(0, RULES.openingHand)
  const zones: Record<ZoneId, EngineCard[]> = {
    mainDeck: main,
    runeDeck,
    hand,
    base: [],
    runePool: [],
    trash: [],
  }
  return {
    id,
    name,
    legend: deck.legendId ? inst(deck.legendId, id) : null,
    champion,
    tokenPile: [...TOKEN_PILE_IDS],
    points: 0,
    zones,
    mulliganed: false,
  }
}

export interface MatchOptions {
  names?: string[]
  firstPlayer?: PlayerId
  pointsToWin?: number
  rng?: () => number
}

/** Build a fresh 2-4 player match. Each player contributes one battlefield to
 *  the shared objective row (so N players → N battlefields in play). */
export function createMatch(decks: Deck[], opts: MatchOptions = {}): MatchState {
  if (decks.length < 2 || decks.length > 4)
    throw new Error('A match needs 2-4 players.')
  const rng = opts.rng ?? Math.random
  const n = decks.length
  const names = opts.names ?? decks.map((_, i) => `Player ${i + 1}`)
  const firstPlayer = opts.firstPlayer ?? 0
  const players: PlayerState[] = decks.map((d, i) =>
    buildPlayer(d, i, names[i] ?? `Player ${i + 1}`, rng),
  )
  // Each player brings one battlefield to the shared row.
  const bfIds = decks
    .map((d) => d.battlefields[0])
    .filter(Boolean)
    .slice(0, n)

  return {
    players,
    activePlayer: firstPlayer,
    firstPlayer,
    phase: 'mulligan',
    turn: 1,
    battlefields: bfIds.map((cardId) => ({
      cardId,
      units: [],
      controller: null,
    })),
    pointsToWin:
      (opts.pointsToWin ?? (n === 2 ? RULES.pointsToWin : RULES.pointsToWinMultiplayer)) +
      // Static battlefield rule-changers (e.g. "increase points to win by 1").
      bfIds.reduce((sum, id) => sum + battlefieldPassive(id).winDelta, 0),
    winner: null,
    showdown: null,
    log: [{ turn: 1, player: null, text: `Match created (${n} players).` }],
    seq: 0,
  }
}
