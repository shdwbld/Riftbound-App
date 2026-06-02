import type { Deck } from '../types/deck'
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
  /** Battlefields contested in play (each player brings one in 1v1). */
  battlefieldsInPlay: 2,
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
  for (const [cardId, n] of Object.entries(pile))
    for (let i = 0; i < n; i++) out.push(inst(cardId, owner))
  return out
}

function buildPlayer(
  deck: Deck,
  id: PlayerId,
  name: string,
  rng: () => number,
): PlayerState {
  const main = shuffle(expand(deck.main, id), rng)
  const runeDeck = shuffle(expand(deck.runes, id), rng)
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
    points: 0,
    zones,
    mulliganed: false,
  }
}

export interface MatchOptions {
  names?: [string, string]
  firstPlayer?: PlayerId
  pointsToWin?: number
  rng?: () => number
}

/** Build a fresh 2-player match. Battlefields come from player 0's deck for
 *  now (shared objective row); a draft step can be added later. */
export function createMatch(
  deckA: Deck,
  deckB: Deck,
  opts: MatchOptions = {},
): MatchState {
  const rng = opts.rng ?? Math.random
  const names = opts.names ?? ['Player 1', 'Player 2']
  const firstPlayer = opts.firstPlayer ?? 0
  const players: [PlayerState, PlayerState] = [
    buildPlayer(deckA, 0, names[0], rng),
    buildPlayer(deckB, 1, names[1], rng),
  ]
  // Shared objective row: each player contributes one battlefield (2 in 1v1).
  const bfIds = [
    deckA.battlefields[0],
    deckB.battlefields[0],
    ...deckA.battlefields.slice(1),
    ...deckB.battlefields.slice(1),
  ]
    .filter(Boolean)
    .slice(0, RULES.battlefieldsInPlay)

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
    pointsToWin: opts.pointsToWin ?? RULES.pointsToWin,
    winner: null,
    showdown: null,
    log: [{ turn: 1, player: null, text: 'Match created.' }],
    seq: 0,
  }
}
