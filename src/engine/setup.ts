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
  /** Victory Score for a 3-4 player free-for-all (FFA3/FFA4). Per Core Rules
   *  v1.2 §462+ this is 8 — only 2v2 (Magma Chamber, team mode, not implemented)
   *  uses 11. */
  pointsToWinMultiplayer: 8,
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
// The Gold gear token (sacrifice for 1 Power of any domain). Created by many
// cards ("play a Gold gear token") and available in every token pile.
const GOLD = CARDS.find(
  (c) => c.supertype === 'token' && c.type === 'gear' && /^gold\b/i.test(c.name),
)
export const GOLD_TOKEN_ID = GOLD?.id ?? null
export const TOKEN_PILE_IDS = [RECRUIT?.id, GOLD?.id].filter((x): x is string => !!x)

/** Map a token's base name (lowercased, art/suffix stripped) → its card id, so
 *  effects that read "play a … Sprite/Sand Soldier/Bird/Mech token" can resolve
 *  which token card to create. Built from every token card in the data set. */
export const TOKEN_BY_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const c of CARDS) {
    if (c.supertype !== 'token') continue
    const base = c.name.split(/\s*\(|\s*\/\//)[0].trim().toLowerCase()
    if (base && !(base in m)) m[base] = c.id
  }
  return m
})()

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
  /** Interactive setup: defer the champion pull + opening draw to finalizeSetup
   *  (so the champion is chosen first, then the hand is drawn after the roll). */
  interactive = false,
): PlayerState {
  const main = shuffle(expand(deck.main, id), rng)
  const runeDeck = shuffle(expand(deck.runes, id), rng)

  // Chosen Champion: pull one champion unit out of the deck into the Champion
  // Zone. Prefer the player's declared `championId`; otherwise auto-pick the
  // first champion unit matching the legend's champion tag.
  let champion: EngineCard | null = null
  if (!interactive) {
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
          ((card.tags ?? []).some((t: string) => t.includes(champ)) || card.name.includes(champ))
        )
      })
    }
    if (idx >= 0) champion = main.splice(idx, 1)[0]
  }

  // Interactive setup draws the opening hand later (in finalizeSetup).
  const hand = interactive ? [] : main.splice(0, RULES.openingHand)
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
    xp: 0,
    banished: [],
    pool: { energy: 0, power: {} },
    zones,
    mulliganed: false,
  }
}

export interface MatchOptions {
  names?: string[]
  firstPlayer?: PlayerId
  pointsToWin?: number
  rng?: () => number
  /** Start in the interactive pre-game setup (roll → first → champion →
   *  battlefield → mulligan) instead of jumping straight to the mulligan. */
  interactiveSetup?: boolean
}

/** A champion's name without any "(Alternate Art)"-style parenthetical. */
function baseChampionName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** The distinct champions (by base name) actually present in a player's deck —
 *  the legal Chosen-Champion options. Each base name yields one cardId (the
 *  declared printing first). The opening hand isn't drawn yet, so every champion
 *  is still in the main deck. */
export function deckChampions(deck: Deck, player: PlayerState): string[] {
  const inMain = player.zones.mainDeck.map((c) => c.cardId).filter((id) => getCard(id)?.supertype === 'champion')
  // The declared champion is always a legal option (even if it's set aside, not
  // literally in the shuffled main list). Prefer it as the base-name rep.
  const candidates = deck.championId ? [deck.championId, ...inMain] : inMain
  // Only champions of the SAME character as the chosen Legend may go to the
  // Champion Zone (Teemo legend → Teemo champions only). The character is the
  // name before " - " / "," / "(" — same split as championName().
  const legendChar = championName(deck.legendId)
  const charOf = (name: string) => name.split(/\s+[-–,(]/)[0].trim()
  const byBase = new Map<string, string>()
  for (const id of candidates) {
    const c = getCard(id)
    if (!c) continue
    if (legendChar && charOf(c.name) !== legendChar) continue
    const key = baseChampionName(c.name)
    if (!byBase.has(key)) byBase.set(key, id)
  }
  return [...byBase.values()]
}

/** Distinct-ART printings of a champion (by base name) the player may choose.
 *  Reprints with identical art/stats across sets are collapsed to one option, so
 *  the picker only appears when there's a genuine alt-art choice. The currently
 *  chosen printing is the representative of its art and comes first. */
export function championVariants(championId: string | null | undefined): string[] {
  if (!championId) return []
  const c = getCard(championId)
  if (!c) return [championId]
  const base = baseChampionName(c.name)
  const all = CARDS.filter((x) => x.supertype === 'champion' && baseChampionName(x.name) === base)
  const byArt = new Map<string, string>()
  for (const x of [c, ...all.filter((x) => x.id !== championId)]) {
    const key = x.imageUrl ?? x.id // group reprints that share artwork
    if (!byArt.has(key)) byArt.set(key, x.id)
  }
  return [...byArt.values()]
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
    buildPlayer(d, i, names[i] ?? `Player ${i + 1}`, rng, !!opts.interactiveSetup),
  )
  // Each player brings 3 battlefields and places one (Bo1: a random pick). In a
  // 4-player game the player taking the first turn removes theirs, so the
  // Battlefield Count is 3 (Core Rules v1.2 §465–466). 1v1 → 2, FFA3 → 3.
  const contributors = decks
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => !(n === 4 && i === firstPlayer))
  const bfIds = contributors
    .map(({ d }) =>
      d.battlefields.length
        ? d.battlefields[Math.floor(rng() * d.battlefields.length)]
        : undefined,
    )
    .filter((x): x is string => !!x)
    .slice(0, n === 4 ? 3 : n)

  const base: MatchState = {
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
    chain: [],
    priority: null,
    passes: 0,
    log: [{ turn: 1, player: null, text: `Match created (${n} players).` }],
    seq: 0,
  }

  if (!opts.interactiveSetup) return base

  // Interactive setup: defer battlefields + offer champion/battlefield choices.
  // Champion options come ONLY from the cards in the player's own deck (the
  // distinct champions present), deduped by base name. The declared champion
  // (or the auto-pick) comes first.
  const championOptions = base.players.map((p, i) => deckChampions(decks[i], p))
  const championPick = championOptions.map((o) => (o.length <= 1 ? (o[0] ?? null) : null))
  const battlefieldOptions = decks.map((d) => [...new Set(d.battlefields)])
  const battlefieldPick = battlefieldOptions.map((o) => (o.length <= 1 ? (o[0] ?? null) : null))
  return {
    ...base,
    phase: 'setup',
    battlefields: [], // chosen during setup, built at finalize
    setup: {
      step: 'roll',
      rolls: null,
      winner: null,
      championOptions,
      championPick,
      battlefieldOptions,
      battlefieldPick,
      ready: base.players.map(() => false),
    },
    log: [{ turn: 1, player: null, text: `Match created (${n} players) — roll for turn order.` }],
  }
}
