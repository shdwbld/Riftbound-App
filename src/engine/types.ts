import type { Domain } from '../types/cards'

// ---------------------------------------------------------------------------
// Rules-engine state model (authoritative, 2-player).
//
// This is separate from the Phase 3 solo board state. The engine is a pure,
// deterministic reducer: reduce(state, action) -> Result. It enforces the
// STRUCTURAL game (turn phases, resource payment, legal timing/zones, combat,
// conquering, win condition) plus common keywords. Per-card bespoke triggered
// abilities are out of scope for full automation and are surfaced as manual
// prompts / log entries instead.
// ---------------------------------------------------------------------------

/** Seat index, 0-based. 2 players for 1v1; up to 4 for multiplayer. */
export type PlayerId = number

export interface EngineCard {
  iid: string
  cardId: string
  owner: PlayerId
  exhausted: boolean
  damage: number
  /** Gear attached to this unit, stored as "cardId|iid". */
  attached: string[]
  /** Persistent +1 Might "buff" counters on this unit. */
  buffs?: number
  /** Temporary Might modifier that lasts until end of turn (+ or −). */
  tempMight?: number
  /** Stunned: deals no combat damage this turn (still has Might to survive). */
  stunned?: boolean
  /** Turn number this card entered play (for Temporary expiry). */
  enteredTurn?: number
  /** Facedown (Hidden keyword) — not yet revealed. */
  facedown?: boolean
}

export type ZoneId =
  | 'mainDeck'
  | 'runeDeck'
  | 'hand'
  | 'base'
  | 'runePool'
  | 'trash'

export interface PlayerState {
  id: PlayerId
  name: string
  legend: EngineCard | null
  /** The Chosen Champion, set aside and always playable from here. */
  champion: EngineCard | null
  /** Token cards this player can generate (e.g. Recruit) — a separate pile
   *  that is never drawn from. Tokens are created onto the board by effects. */
  tokenPile: string[]
  /** Main-deck cards this player has played this turn (drives LEGION). */
  cardsPlayedThisTurn?: number
  points: number
  zones: Record<ZoneId, EngineCard[]>
  /** Set true once the player has taken their mulligan decision. */
  mulliganed: boolean
}

export interface BattlefieldState {
  cardId: string
  /** Units contesting this battlefield, from either player. */
  units: EngineCard[]
  /** Current controller (most/only units present), or null if empty. */
  controller: PlayerId | null
}

export type Phase =
  | 'mulligan' // both players decide opening hands
  | 'awaken' // transient: ready all
  | 'score' // transient: score held battlefields
  | 'channel' // transient: channel runes
  | 'draw' // transient: draw
  | 'action' // active player acts
  | 'showdown' // combat window open at a battlefield
  | 'gameover'

export interface ShowdownState {
  battlefield: number
  /** Player who must act next in the showdown (priority). */
  priority: PlayerId
  /** Players who have consecutively passed; 2 passes resolves combat. */
  passes: number
  /** The unit whose move opened this showdown. */
  movedUnit: string
}

export interface LogEntry {
  turn: number
  player: PlayerId | null
  text: string
}

/** An item on the Chain (a played spell, or a Counter). Resolves LIFO. */
export interface ChainItem {
  id: string
  kind: 'spell' | 'counter'
  controller: PlayerId
  cardId: string
  /** The played card instance (trashed after the item resolves/is countered). */
  instance: EngineCard
  payment: Payment
  targets?: string[]
  /** For counters: the ChainItem id this counters. */
  countersId?: string
}

export interface MatchState {
  /** 2-4 players, seated by index. */
  players: PlayerState[]
  activePlayer: PlayerId
  /** Who took the first turn (in 1v1 the player going second gets +1 channel T1). */
  firstPlayer: PlayerId
  phase: Phase
  turn: number
  battlefields: BattlefieldState[]
  pointsToWin: number
  winner: PlayerId | null
  showdown: ShowdownState | null
  /** The Chain (LIFO). Non-empty = a Closed State / priority window is open. */
  chain: ChainItem[]
  /** Who currently holds priority while the chain is open (else null). */
  priority: PlayerId | null
  /** Consecutive passes since the chain last changed. */
  passes: number
  log: LogEntry[]
  /** Monotonic action counter (for ordering / netcode). */
  seq: number
}

// --- Actions ---------------------------------------------------------------

/** How a player pays a cost: which ready runes to exhaust (energy) and which
 *  to recycle (power). The engine validates these cover the card's cost. */
export interface Payment {
  /** rune iids to exhaust for 1 energy each */
  exhaust: string[]
  /** rune iids to recycle for 1 power of their domain each */
  recycle: string[]
}

export const emptyPayment = (): Payment => ({ exhaust: [], recycle: [] })

export type Action =
  /** Set aside up to 2 cards (by iid) to the bottom of the deck, redraw that
   *  many. Empty array = keep. */
  | { type: 'MULLIGAN'; player: PlayerId; toBottom: string[] }
  | { type: 'ACTIVATE_LEGEND'; player: PlayerId }
  /** Generate a token (e.g. Recruit) from the token pile onto your Base. */
  | { type: 'CREATE_TOKEN'; player: PlayerId; cardId: string }
  // --- Limited / utility actions (hotkeys & right-click menu) ---
  | { type: 'DRAW'; player: PlayerId }
  | { type: 'BUFF_UNIT'; player: PlayerId; iid: string }
  | { type: 'RECYCLE_RUNE'; player: PlayerId; iid: string }
  | { type: 'TRASH_CARD'; player: PlayerId; iid: string }
  | { type: 'REVEAL_TOP'; player: PlayerId }
  | { type: 'PLAY_UNIT'; player: PlayerId; iid: string; payment: Payment }
  | {
      type: 'PLAY_SPELL'
      player: PlayerId
      iid: string
      payment: Payment
      targets?: string[]
    }
  | {
      type: 'PLAY_GEAR'
      player: PlayerId
      iid: string
      payment: Payment
      targetIid?: string
    }
  | {
      type: 'MOVE_UNIT'
      player: PlayerId
      iid: string
      toBattlefield: number
    }
  /** Move several units together (one showdown) — group standard move. */
  | { type: 'MOVE_UNITS'; player: PlayerId; iids: string[]; toBattlefield: number }
  | { type: 'STUN_UNIT'; player: PlayerId; iid: string }
  | { type: 'RETREAT'; player: PlayerId; iid: string }
  | { type: 'PASS'; player: PlayerId }
  /** Pass priority on the chain; when all players pass, the top item resolves. */
  | { type: 'PASS_PRIORITY'; player: PlayerId }
  /** Play a reaction spell that Counters a chain item (removes it on resolution). */
  | { type: 'COUNTER'; player: PlayerId; iid: string; payment: Payment; targetChainId: string }
  | { type: 'END_TURN'; player: PlayerId }
  | { type: 'CONCEDE'; player: PlayerId }

export interface EngineResult {
  state: MatchState
  /** Set when the action was rejected; state is returned unchanged. */
  error?: string
}

export const ok = (state: MatchState): EngineResult => ({ state })
export const fail = (state: MatchState, error: string): EngineResult => ({
  state,
  error,
})

// --- Cost helpers ----------------------------------------------------------

export interface ResolvedCost {
  energy: number
  power: Partial<Record<Domain, number>>
}
