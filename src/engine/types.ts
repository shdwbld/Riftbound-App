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

/** A manual-override operation (sandbox mode). Unit ops act on `iid`; resource
 *  ops (draw / channel) act on the acting player; `move` relocates the card at
 *  `iid` to `toBattlefield` or `toZone` (drag-and-drop / "Move to…" menu). */
export type OverrideOp =
  | 'stun' | 'unstun' | 'ready' | 'exhaust' | 'buff' | 'unbuff'
  | 'mightUp' | 'mightDown' | 'kill' | 'banish' | 'trash' | 'toBase'
  | 'draw' | 'channel' | 'move'
  // Manual fail-safe ops (sandbox). Player-scoped use `action.player` as target.
  | 'points' | 'xp' | 'energy' | 'power' | 'shuffle' | 'mill' | 'damage' | 'spawn'
  | 'setDamage' | 'grant' | 'readyAll' | 'marker'
  | 'channelExhausted' | 'setTempMight' | 'sacrifice' | 'tutorShuffle'
  | 'killGear' | 'bounceGear'
  | 'revealFacedown' | 'removeFacedown' | 'bulkMove' | 'swapZone'
  // Advanced game-state overrides (can break a game — that's the point).
  | 'setActive' | 'setTurn' | 'setPointsToWin' | 'setWinner' | 'setPhase'
  | 'clearChain' | 'clearShowdown' | 'setController' | 'triggerEnterPlay' | 'clearTurnState'
  | 'recomputeControllers'
  // Restore a battlefield whose identity was replaced by a token (Brush / Baron
  // Pit) back to its original card (uses `action.toBattlefield`).
  | 'revertBf'

/** A destination zone for a sandbox `move` override (a player zone, the
 *  banishment pile, the legend/champion slot, or — with `toBattlefield` set — a
 *  battlefield). */
export type OverrideZone = ZoneId | 'banished' | 'legend' | 'champion'

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
  /** This unit can't move for the rest of the turn whose number this holds
   *  (Vex - Apathetic: "They can't move it this turn."). Compared to `turn`. */
  cantMoveTurn?: number
  /** Turn number this card entered play (for Temporary expiry). */
  enteredTurn?: number
  /** Facedown (Hidden keyword) — not yet revealed. */
  facedown?: boolean
  /** Turn this card was hidden facedown (you can't reveal it the same turn). */
  hiddenTurn?: number
  /** A one-shot "the next time it would die this turn, heal/exhaust/recall it
   *  instead" shield (Highlander, Tactical Retreat). Consumed on the next death. */
  deathShield?: boolean
  /** A one-shot "if it would die this turn, banish it instead" replacement
   *  (Smite). Banished instead of trashed; the death is replaced (no Deathknell). */
  banishShield?: boolean
  /** Stamped when this unit is killed by a spell during resolution — lets
   *  "when you kill a unit with a spell" triggers fire (Immortal Phoenix). */
  killedBySpell?: boolean
  /** State names active at the last refreshStates pass — for becomes-<state>
   *  transition detection. */
  stateSnapshot?: string[]
  /** The battlefield index this unit was at when it died, stamped just before
   *  removal so location-scoped death triggers ("deal N to all units at my
   *  battlefield" — Kog'Maw - Caustic) can resolve after the unit is gone. */
  diedAtBf?: number
  /** This instance is a token (ceases to exist instead of going to the Trash),
   *  even if its `cardId` points at a normal card — e.g. a Reflection copy. */
  token?: boolean
  /** This instance has [Temporary] granted to it (killed at the start of its
   *  controller's Beginning Phase), independent of its card's keywords. */
  temporary?: boolean
  /** [Assault N] granted to this unit THIS TURN (Square Up, Vault Breaker, Lord
   *  Broadmane). Cleared at end of turn. Adds to combat Might while attacking. */
  grantAssault?: number
  /** [Ganking] granted to this unit THIS TURN (Vault Breaker). Lets it move
   *  battlefield-to-battlefield. Cleared at end of turn. */
  grantGanking?: boolean
  /** [Shield N] granted to this unit THIS TURN (Chakram Dancer, Block). Cleared at
   *  end of turn. Adds +N to combat Might while defending. */
  grantShield?: number
  /** [Tank] granted to this unit THIS TURN (Yuumi - Magical Cat, Block). Cleared at
   *  end of turn. Makes this unit take combat damage first. */
  grantTank?: boolean
  /** [Deflect N] granted to this unit THIS TURN (Kato the Arm copies his keywords).
   *  Cleared at end of turn. Adds N to the cost enemies pay to target it. */
  grantDeflect?: number
  /** A manual sandbox status marker (1–4 = colored dot) the players add as a
   *  visual reminder; 0/undefined = none. Cosmetic only — no engine behavior. */
  marker?: number
  /** For token instances: a stable per-owner, per-cardId ordinal (#1, #2, …)
   *  assigned at creation, monotonic and NEVER reused (if #2 dies, the next new
   *  one is #5, not #2). Lets identical-named tokens (Sand Soldiers) be told apart
   *  in pickers / targeting / damage assignment. Sourced from PlayerState.tokenSeq. */
  tokenNo?: number
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
  /** Which champion-splash skin this player picked for their playmat backdrop
   *  (skins.json id, e.g. 'original'|'coven'); synced so opponents see it too. */
  playmatId?: string
  /** Token cards this player can generate (e.g. Recruit) — a separate pile
   *  that is never drawn from. Tokens are created onto the board by effects. */
  tokenPile: string[]
  /** Monotonic high-water counter per token cardId for the display ordinal
   *  (EngineCard.tokenNo). Only ever increases, so a number is never reused even
   *  after that token dies. Keyed by cardId. */
  tokenSeq?: Record<string, number>
  /** Main-deck cards this player has played this turn (drives LEGION). */
  cardsPlayedThisTurn?: number
  /** Whether this player has played an Equipment this turn (gates Azir -
   *  Emperor of the Sands' Sand Soldier ability). Cleared at turn start. */
  playedEquipmentThisTurn?: boolean
  /** Whether this player has discarded a card this turn (gates Raging Soul's
   *  conditional [Assault]/[Ganking]). Cleared at turn start. */
  discardedThisTurn?: boolean
  /** Whether this player has gained XP this turn (gates Wily Newtfish's +1 Might
   *  and [Ganking]). Cleared at turn start. */
  xpGainedThisTurn?: boolean
  /** Whether Zilean - Time Mage's once-per-turn token-doubling has fired this turn.
   *  Cleared at turn start. */
  zileanDoubledThisTurn?: boolean
  /** How many of Aphelios - Exalted's three attach-Equipment modes have been chosen
   *  this turn (each mode used once per turn, in order). Cleared at turn start. */
  apheliosModesThisTurn?: number
  /** Whether Azir - Ascendant's location-swap ability has been used this turn.
   *  Cleared at turn start. */
  azirSwappedThisTurn?: boolean
  /** Brynhir Thundersong: set on opponents when she's played ("opponents can't play
   *  cards this turn"); blocks their plays until their next Beginning Phase clears it. */
  cantPlayCardsThisTurn?: boolean
  /** The tag named when The List was played ("As you play this, name a tag"); gates
   *  The List's activated −2 Might to units with that tag. Persists for its lifetime. */
  namedTag?: string
  /** Extra Energy non-token units cost to play this turn (Vaults of Helia). */
  unitCostBump?: number
  /** Points scored from HOLDING battlefields this turn (Needlessly Large Yordle's
   *  per-point cost reduction). Cleared at turn start. */
  holdPointsThisTurn?: number
  /** Energy spent on spells this turn (Prepared Neophyte's 4+ threshold, Jhin -
   *  Meticulous Killer's alt cost). Cleared at turn start. */
  energySpentOnSpellsThisTurn?: number
  /** Whether this player has played any spell this turn (Crescent Guardian's
   *  "if you've played a spell this turn" optional-cost gate — distinct from
   *  energySpentOnSpellsThisTurn since a 0-cost spell still counts). Cleared at turn start. */
  spellPlayedThisTurn?: boolean
  /** Set by Sun Disc ("⟳: The next unit you play this turn enters ready"). The next
   *  unit played enters ready and consumes the flag. Cleared at turn start. */
  nextUnitEntersReadyThisTurn?: boolean
  /** Battlefield indices this player conquered this turn (Perched Grimwyrm's
   *  "play me only to a battlefield you conquered this turn"). Cleared at turn start. */
  conqueredThisTurn?: number[]
  /** Generic once-per-turn trigger gate, keyed by the source card id (Wraith of
   *  Echoes, Lucian - Merciless). Cleared at turn start. */
  oncePerTurnUsed?: Record<string, boolean>
  /** Deferred "pull an enemy here at the start of your next Main Phase" entries
   *  (Iascylla's hold trigger). Each records the destination battlefield and the
   *  turn it was queued; drained at the next Main-Phase start whose turn is later. */
  pendingPullsNextTurn?: { bfIndex: number; queuedTurn: number }[]
  /** Energy discount on the NEXT spell played this turn (Raging Firebrand). Read by
   *  effectiveCostOf; reset to 0 after the next spell is played. */
  nextSpellCostDiscount?: number
  /** Set when a battlefield (The Academy) grants the next spell [Repeat] equal
   *  to its base cost; consumed by the next spell played. */
  grantRepeatNextSpell?: boolean
  points: number
  /** Experience earned (via Hunt on conquer/hold); fuels Level abilities. */
  xp: number
  /** Banishment zone: cards removed from the game (no Deathknell; not the Trash,
   *  so they can't be recycled by Burn Out). Kept separate from `zones`. */
  banished: EngineCard[]
  /** Resource pool: bonus Energy + colored Power (e.g. from "Add" effects) that
   *  sits on top of the runes and is spent first. Empties at end of turn. */
  pool: { energy: number; power: Partial<Record<Domain, number>> }
  zones: Record<ZoneId, EngineCard[]>
  /** Set true once the player has taken their mulligan decision. */
  mulliganed: boolean
  /** Out of the match: conceded or eliminated (e.g. burned out with no Trash in
   *  a 3-4 player game). Skipped in turn/priority rotation; their board presence
   *  is cleared. The match continues until one player remains. */
  out?: boolean
}

export interface BattlefieldState {
  cardId: string
  /** When the identity was replaced by a token (Brush / Baron Pit), the card id
   *  it had before, so a manual override can revert it back. */
  originalCardId?: string
  /** Units contesting this battlefield, from either player. */
  units: EngineCard[]
  /** Current controller (most/only units present), or null if empty. */
  controller: PlayerId | null
  /** A single [Hidden] card placed facedown here (any card type). It is NOT a
   *  unit — it never fights and isn't in `units`. Revealed = played for 0. Sent
   *  to Trash if its owner loses control of this battlefield. */
  facedown?: EngineCard | null
}

export type Phase =
  | 'setup' // pre-game: roll for turn order, choose first, champion + battlefield
  | 'mulligan' // both players decide opening hands
  | 'awaken' // transient: ready all
  | 'score' // transient: score held battlefields
  | 'channel' // transient: channel runes
  | 'draw' // transient: draw
  | 'action' // active player acts
  | 'showdown' // combat window open at a battlefield
  | 'gameover'

/** One side's damage being assigned across the opposing units (Riftbound: the
 *  dealing player assigns, Tank-first). Auto steps are pre-filled; manual steps
 *  wait for an ASSIGN_DAMAGE action. */
export interface DamageAssignStep {
  /** The player who deals (and assigns) this damage. */
  dealer: PlayerId
  /** Which group RECEIVES the damage. */
  side: 'attackers' | 'defenders'
  /** Receiving unit iids, in Tank-first order. */
  targets: string[]
  /** Total combat damage to assign. */
  amount: number
  /** True when the dealer must choose the split; false = auto-resolved. */
  manual: boolean
  /** Defeated iids: precomputed (auto) or chosen (after ASSIGN_DAMAGE). */
  defeated: string[]
  /** Each receiving unit's effective Might (lethal threshold). */
  hp: Record<string, number>
  /** Tank iids that must be assigned lethal before non-Tanks. */
  tanks: string[]
  /** Iids that "must be assigned combat damage last" — every other target must be
   *  lethal before these take any damage (Caitlyn - Patrolling). */
  assignedLast?: string[]
}

export interface ShowdownState {
  battlefield: number
  /** Player who must act next in the showdown (priority). */
  priority: PlayerId
  /** Participants who have consecutively passed; combat resolves once every
   *  participant (combatants + accepted helpers) has passed in a row. */
  passes: number
  /** The unit whose move opened this showdown. */
  movedUnit: string
  /** Who controlled the battlefield when the showdown OPENED (before any mid-
   *  showdown board changes). Used to detect a conquer even when a reaction bounces/
   *  kills the defender (so control flips before combat math runs). */
  priorController?: PlayerId | null
  /** Pending manual damage assignment — combat is paused until filled. */
  assign?: { steps: DamageAssignStep[]; current: number }
  /** A pending invitation: a combatant has asked `to` to join and help, awaiting
   *  their accept/decline. */
  invite?: { from: PlayerId; to: PlayerId }
  /** Non-combatants who accepted an invitation and may now play a helping spell;
   *  they join the priority rotation for the rest of this showdown. */
  helpers?: PlayerId[]
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
  /** [Repeat]: extra times to resolve this spell's effect (paid for on play). */
  repeat?: number
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
  /** A pending Vision decision: the controller peeked their top Main Deck card
   *  and may recycle it (to the bottom) or keep it. */
  vision?: { player: PlayerId; cardId: string }
  /** A pending "ready a unit" choice: the player picks which exhausted unit(s)
   *  to ready, one at a time, until `count` reaches 0. */
  readyChoice?: { player: PlayerId; count: number; excludeIid?: string }
  /** Pending [Weaponmaster] decisions (rule 747): one or more just-played units with
   *  Weaponmaster, each of which may attach an Equipment the player controls IN PLAY
   *  (unattached, or stolen off another friendly unit) for that gear's [Equip] cost
   *  reduced by 1 Power. `unitIids[0]` is the one currently being decided; the queue
   *  drains one at a time (Arise! can spawn several). Optional — each is declinable. */
  weaponmaster?: { player: PlayerId; unitIids: string[] } | null
  /** A pending optional battlefield choice (Reaver's Row, Amateur Recital,
   *  Emperor's Dais): the player picks a unit to act on, or declines. */
  pendingChoice?: {
    player: PlayerId
    kind: 'moveHereToBase' | 'moveAnyToBase' | 'daisReturn' | 'duskRoseSacrifice' | 'leblancCopy' | 'forgePickEquip' | 'forgePickTarget' | 'orbMinusMight' | 'moveToBf' | 'heimerBorrow' | 'discardReplay' | 'trashConquerReturn' | 'becomesStateReady' | 'counterUnlessPay' | 'shardKill' | 'insightfulInvestigator' | 'nameTag' | 'peekToHand'
    bfIndex: number
    prompt: string
    options: { iid: string; label: string }[]
    /** Carries state between multi-step choices (e.g. the Forge equipment iid). */
    payload?: string
    /** Source card name, when the resolver needs card-specific follow-up after a
     *  generic choice (e.g. Dragon's Rage's post-move collision via a moveToBf). */
    srcName?: string
  }
  /** Pre-game setup state (turn-order roll, first-player choice, champion +
   *  battlefield selection). Present only while phase === 'setup'. */
  setup?: SetupState
  /** Whether any unit has died so far this turn (gates conditional enter-ready like
   *  Towering Pairofant / Shadow Watcher). Reset at the start of each turn. */
  unitDiedThisTurn?: boolean
  /** Manual-override / sandbox mode: when on, EITHER player may apply manual
   *  OVERRIDE ops (stun / ready / kill / ±Might / move / …) to ANY card at any
   *  time, to fix or override the engine. Shared (synced) game state. */
  sandbox?: boolean
  /** Cards banished by Ashe - Focused, pending return on the victim's next hold.
   *  `owner` = the Ashe player; `victimId` = the opponent whose hold returns it
   *  (returns even if Ashe has since left the board). */
  asheBanishPending?: { banishedIid: string; owner: PlayerId; victimId: PlayerId }[]
}

/** Interactive pre-game setup (Core Rules §111–120): roll for turn order, the
 *  winner chooses the First Player, then each player picks their Chosen Champion
 *  (when a variant choice exists) and their Battlefield. */
export interface SetupState {
  /** 'roll' and 'first' stay sequential; once the First Player is chosen the
   *  setup moves to the single concurrent 'select' step where EVERY player, at
   *  once, picks their Champion + Battlefield and takes their mulligan, then
   *  submits Ready (the legacy 'champion'/'battlefield' steps are unused but
   *  kept in the union for back-compat). */
  step: 'roll' | 'first' | 'champion' | 'battlefield' | 'select'
  /** Per-player turn-order roll (highest chooses the First Player). */
  rolls: number[] | null
  /** The highest roller — the only player who may choose the First Player. */
  winner: PlayerId | null
  /** Per-player candidate champion cardIds (length ≤ 1 → no real choice). */
  championOptions: string[][]
  /** Per-player chosen champion (null = not yet chosen). */
  championPick: (string | null)[]
  /** Per-player candidate battlefield cardIds they may contribute. */
  battlefieldOptions: string[][]
  /** Per-player chosen battlefield (null = not yet chosen). */
  battlefieldPick: (string | null)[]
  /** Per-player readiness during the concurrent 'select' step. The match starts
   *  (beginTurn → phase 'action') only once every non-out player is ready. */
  ready?: boolean[]
}

// --- Actions ---------------------------------------------------------------

/** How a player pays a cost: which ready runes to exhaust (energy) and which
 *  to recycle (power). The engine validates these cover the card's cost. */
export interface Payment {
  /** rune iids to exhaust for 1 energy each */
  exhaust: string[]
  /** rune iids to recycle for 1 power of their domain each */
  recycle: string[]
  /** Energy paid from the player's resource pool (spent before runes). */
  poolEnergy?: number
  /** Colored power paid from the resource pool (spent before runes). */
  poolPower?: Partial<Record<Domain, number>>
}

export const emptyPayment = (): Payment => ({ exhaust: [], recycle: [] })

export type Action =
  /** Set aside up to 2 cards (by iid) to the bottom of the deck, redraw that
   *  many. Empty array = keep. */
  /** Pre-game: record each player's turn-order roll (UI supplies fair d20s). */
  | { type: 'ROLL_TURN_ORDER'; player: PlayerId; rolls: number[] }
  /** The roll winner chooses who takes the first turn. */
  | { type: 'CHOOSE_FIRST'; player: PlayerId; firstPlayer: PlayerId }
  /** A player picks their Chosen Champion variant during setup. */
  | { type: 'CHOOSE_CHAMPION'; player: PlayerId; cardId: string }
  /** A player picks the Battlefield they contribute during setup. */
  | { type: 'CHOOSE_BATTLEFIELD'; player: PlayerId; cardId: string }
  /** Concurrent pre-game submit: record this player's Champion + Battlefield
   *  picks AND their mulligan (toBottom cards sent to the bottom of the main
   *  deck + redraw that many), then mark them Ready. When every non-out player
   *  has submitted, the match starts (beginTurn → phase 'action'). */
  | {
      type: 'SUBMIT_PREGAME'
      player: PlayerId
      championId: string | null
      battlefieldId: string | null
      toBottom: string[]
      /** Chosen playmat-splash skin id (from the picker); persisted on PlayerState. */
      playmatId?: string | null
    }
  | { type: 'MULLIGAN'; player: PlayerId; toBottom: string[] }
  | { type: 'ACTIVATE_LEGEND'; player: PlayerId }
  /** Generate a token (e.g. Recruit) from the token pile onto your Base. */
  | { type: 'CREATE_TOKEN'; player: PlayerId; cardId: string }
  // --- Limited / utility actions (hotkeys & right-click menu) ---
  | { type: 'DRAW'; player: PlayerId }
  /** Add Energy/Power to your pool. Resolves instantly — it cannot be reacted
   *  to (no chain / priority window). */
  | { type: 'ADD'; player: PlayerId; energy?: number; power?: Partial<Record<Domain, number>> }
  | { type: 'BUFF_UNIT'; player: PlayerId; iid: string }
  | { type: 'RECYCLE_RUNE'; player: PlayerId; iid: string }
  | { type: 'TRASH_CARD'; player: PlayerId; iid: string }
  | { type: 'REVEAL_TOP'; player: PlayerId }
  /** Resolve a pending Vision: recycle the peeked top card to the bottom, or keep it. */
  | { type: 'VISION_DECIDE'; player: PlayerId; recycle: boolean }
  /** Ready (un-exhaust) a chosen unit toward a pending "ready a unit" effect. */
  | { type: 'READY_UNIT'; player: PlayerId; iid: string }
  /** Resolve a pending optional battlefield choice — `iid` is the chosen unit,
   *  or null to decline the "you may" effect. */
  | { type: 'RESOLVE_CHOICE'; player: PlayerId; iid: string | null }
  /** Activate a battlefield-granted activated ability on a unit/legend (Gardens
   *  of Becoming, Forge of the Fluft). */
  | { type: 'ACTIVATE_ABILITY'; player: PlayerId; iid: string }
  /** Activate a unit's own printed activated ability ("cost: effect" — Arena
   *  Kingpin, Xerath, Vi - Hotheaded, …). `targets` for effects that need one. */
  | { type: 'ACTIVATE_UNIT'; player: PlayerId; iid: string; targets?: string[] }
  /** Toggle shared manual-override (sandbox) mode for the whole match. */
  | { type: 'SET_SANDBOX'; player: PlayerId; on: boolean }
  /** A manual override op applied in sandbox mode (either player, any card).
   *  `move` uses `toBattlefield` (a battlefield) or `toZone` (a player zone /
   *  banished) to relocate the card at `iid`. */
  | { type: 'OVERRIDE'; player: PlayerId; op: OverrideOp; iid?: string; toBattlefield?: number; toZone?: OverrideZone; /** signed delta for points/xp/energy/draw/channel/mill/damage/might */ amount?: number; /** rune domain for `power`/`spawn` rune */ domain?: Domain; /** card to spawn */ cardId?: string; /** numeric target for setActive/setTurn/setPointsToWin/setWinner (-1 = clear) */ value?: number; /** target phase for setPhase */ phase?: Phase; /** instance flag/keyword for `grant` */ flag?: string; /** move to the BOTTOM of a deck zone instead of the top */ bottom?: boolean; /** source zone for `bulkMove`/`swapZone` */ fromZone?: ZoneId; /** second player for `bulkMove`/`swapZone` */ targetPlayer?: PlayerId }
  | { type: 'PLAY_UNIT'; player: PlayerId; iid: string; payment: Payment; accelerate?: boolean; toBattlefield?: number; /** Opt in to the card's optional "you may pay X as an additional cost to play me" (gates the "if you paid" bonus). */ payAdditionalCost?: boolean }
  | {
      type: 'PLAY_SPELL'
      player: PlayerId
      iid: string
      payment: Payment
      targets?: string[]
      /** [Repeat]: opt in to pay the additional cost to resolve the effect again. */
      repeat?: boolean
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
  /** Assign a paused showdown's combat damage across the opposing units
   *  (Tank-first). `allocations` maps receiving unit iid → damage placed on it. */
  | { type: 'ASSIGN_DAMAGE'; player: PlayerId; allocations: Record<string, number> }
  | { type: 'STUN_UNIT'; player: PlayerId; iid: string }
  /** Detach a piece of gear from a unit (the gear returns to your Base). */
  | { type: 'DETACH'; player: PlayerId; unitIid: string; gearIid: string }
  | { type: 'ATTACH'; player: PlayerId; unitIid: string; gearIid: string; payment?: Payment }
  /** Resolve a pending [Weaponmaster] decision: attach `gearIid` (an Equipment the
   *  player controls in play, possibly stolen off another friendly unit) to
   *  `unitIid`, paying the Equip cost reduced by 1 Power; `gearIid: null` declines. */
  | { type: 'WEAPONMASTER_RESOLVE'; player: PlayerId; unitIid: string; gearIid: string | null; payment?: Payment }
  /** Cash in a Gold gear token: kill it and add 1 Power of the chosen domain. */
  | { type: 'USE_GOLD'; player: PlayerId; iid: string; domain: Domain }
  /** Remove a unit from play to the Banishment zone (no Deathknell). */
  | { type: 'BANISH'; player: PlayerId; iid: string }
  /** Place a [Hidden] card (unit/spell/gear) from your HAND facedown at a
   *  battlefield you control (cost: 1 Wild Power — recycle 1 rune of any domain).
   *  Max one facedown card per battlefield. */
  | { type: 'HIDE'; player: PlayerId; iid: string; toBattlefield: number; runeIid: string }
  /** Reveal your facedown card = play it for 0 (spell resolves, unit enters,
   *  gear attaches). Not on the turn you hid it; Reaction speed thereafter. */
  | { type: 'REVEAL'; player: PlayerId; iid: string }
  | { type: 'RETREAT'; player: PlayerId; iid: string }
  | { type: 'PASS'; player: PlayerId }
  /** Pass priority on the chain; when all players pass, the top item resolves. */
  | { type: 'PASS_PRIORITY'; player: PlayerId }
  /** Play a reaction spell that Counters a chain item (removes it on resolution). */
  | { type: 'COUNTER'; player: PlayerId; iid: string; payment: Payment; targetChainId: string }
  | { type: 'END_TURN'; player: PlayerId }
  | { type: 'CONCEDE'; player: PlayerId }
  /** During a showdown, a combatant invites a non-combatant to join and help.
   *  Either the attacker or a defender may invite. */
  | { type: 'INVITE'; player: PlayerId; invitee: PlayerId }
  /** The invited player accepts (joins as a helper) or declines. */
  | { type: 'INVITE_RESPOND'; player: PlayerId; accept: boolean }

// --- Feedback events -------------------------------------------------------

/** Structured, render-agnostic signals the reducer emits at its mutation sites
 *  so the UI can animate without parsing the log. One reduce() call may emit
 *  several. */
export type GameEventKind =
  | 'damage'
  | 'defeat'
  | 'score'
  | 'draw'
  | 'play'
  | 'move'
  | 'buff'
  | 'stun'
  | 'equip'
  | 'conquer'
  | 'counter'
  | 'channel'
  /** A card's cost was paid: carries how many runes were exhausted / recycled
   *  (for the end-of-turn recap). Emitted alongside the matching 'play' event. */
  | 'payment'

export interface GameEvent {
  kind: GameEventKind
  /** Card instance this event is anchored to (damage/defeat/buff/stun/play/move). */
  iid?: string
  /** Player this event concerns (score/draw/conquer/counter). */
  player?: PlayerId
  /** Magnitude (damage dealt, points scored, cards drawn). */
  amount?: number
  /** Underlying card id, for display. */
  cardId?: string
  /** Runes exhausted to pay (for 'payment' events). */
  exhaust?: number
  /** Runes recycled to pay (for 'payment' events). */
  recycle?: number
  /** A 'move' event that is a retreat off a battlefield (→ recall SFX). */
  retreat?: 'base' | 'hand'
}

export interface EngineResult {
  state: MatchState
  /** Set when the action was rejected; state is returned unchanged. */
  error?: string
  /** Feedback signals emitted while applying this action (for animations). */
  events?: GameEvent[]
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
