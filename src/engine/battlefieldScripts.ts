import type { MatchState, EngineCard } from './types'
import { getCard } from '../data/cards'
import { parseKeywords } from './keywords'

// ---------------------------------------------------------------------------
// Per-battlefield scripts. Battlefield abilities are all bespoke, so rather than
// fit them to a uniform parser we script each one against typed hooks the engine
// calls at the right moments. Keyed by the battlefield's base name (art variants
// share behavior). Batch 1 covers the static rules + restrictions; later batches
// add trigger events and the costed/keyword mechanics.
// ---------------------------------------------------------------------------

// Engine primitives the script hooks can call (the engine binds these to the
// state being mutated, so battlefield logic stays declarative in this file).
export interface BfApi {
  /** Recycle one of the player's runes (ready first) to the rune deck bottom. */
  recycleRune(player: number): void
  /** Ready (un-exhaust) up to N of the player's runes. */
  readyRunes(player: number, n: number): void
  /** Reveal the top Main Deck card: a spell goes to hand, else it's recycled. */
  revealTopSpellElseRecycle(player: number): void
  /** Give +N Might this turn to one of the player's units at this battlefield. */
  tempMightToUnitHere(player: number, bfIndex: number, n: number): void
  /** Spend N Energy (pool first, then exhaust ready runes). Returns false (and
   *  spends nothing) if the player can't afford it. */
  payEnergy(player: number, n: number): boolean
  /** Spend N Power by recycling N ready runes of any domain. */
  payPowerAny(player: number, n: number): boolean
  draw(player: number, n: number): void
  /** Mill the top N cards of the player's Main Deck to the trash. */
  millTop(player: number, n: number): void
  /** Draw 1 for each OTHER battlefield the player controls. */
  drawPerOtherControlledBF(player: number, bfIndex: number): void
  /** Ready (un-exhaust) the player's legend. */
  readyLegend(player: number): void
  /** Create a Gold gear token on the player's base (exhausted). */
  playGoldToken(player: number): void
  /** Spend a buff from one of the player's buffed units here. Returns success. */
  spendBuffHere(player: number, bfIndex: number): boolean
  /** Whether the player has a Mighty (≥5 Might) unit here. */
  hasMightyHere(player: number, bfIndex: number): boolean
  /** Add N points to the player. */
  score(player: number, n: number): void
  /** Predict: let the player look at their top Main Deck card and may recycle it. */
  predict(player: number): void
  /** Ready (un-exhaust) one of the player's exhausted gear. Returns success. */
  readyGear(player: number): boolean
  log(text: string): void
}

export interface BattlefieldScript {
  /** Units here can't move to their base (Vilemaw's Lair). */
  noMoveToBase?: boolean
  /** Units can't be played at this battlefield (Rockfall Path). */
  noPlayHere?: boolean
  /** Units here may move battlefield-to-battlefield (Windswept Hillock → Ganking). */
  grantsGanking?: boolean
  /** The controller can't score this battlefield until their Nth turn (Forgotten Monument). */
  scoreFromTurn?: number
  /** The controller wins immediately if they hold ≥N units here (The Grand Plaza). */
  winOnUnitsHere?: number
  /** Deal N damage to every unit here at the start of each player's turn (Frozen Fortress). */
  beginningDamageHere?: number
  /** Spells/abilities deal +N Bonus Damage to units here (Void Gate). */
  bonusSpellDamageHere?: number
  /** Combat Might delta for a unit here (role + whether it fights alone). */
  mightHere?: (unit: EngineCard, role: 'attacker' | 'defender' | null, alone: boolean) => number
  /** Combat Shield granted to a unit here while defending (e.g. Temporary units,
   *  Fortified Position). */
  shieldHere?: (unit: EngineCard) => number

  // --- Batch 2: trigger events --------------------------------------------
  /** Resolved when you conquer this battlefield (Sigil of the Storm, Targon's Peak). */
  onConquer?: (api: BfApi, player: number, bfIndex: number) => void
  /** Resolved when you hold this battlefield at the start of your turn. */
  onHold?: (api: BfApi, player: number, bfIndex: number) => void
  /** Resolved when you defend here in a showdown (Ravenbloom Conservatory). */
  onDefend?: (api: BfApi, player: number, bfIndex: number) => void
  /** Resolved when the controller plays a spell (Abandoned Hall). `spentEnergy`
   *  is the Energy the controller paid for the spell (Forgotten Library). */
  onSpellPlayed?: (api: BfApi, player: number, bfIndex: number, spentEnergy: number) => void
  /** Mutate a unit as it moves away from here (Back-Alley Bar +1 Might this turn). */
  onMoveFrom?: (unit: EngineCard) => void
}

const baseName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()

const SCRIPTS: Record<string, BattlefieldScript> = {
  // --- Batch 1: static rules + restrictions -------------------------------
  "Vilemaw's Lair": { noMoveToBase: true },
  'Rockfall Path': { noPlayHere: true },
  'Windswept Hillock': { grantsGanking: true },
  'Forgotten Monument': { scoreFromTurn: 3 },
  'The Grand Plaza': { winOnUnitsHere: 7 },
  'Frozen Fortress': { beginningDamageHere: 1 },
  'Void Gate': { bonusSpellDamageHere: 1 },
  'Trifarian War Camp': { mightHere: () => 1 },
  'Forbidding Waste': { mightHere: (_u, role, alone) => (role === 'defender' && alone ? -2 : 0) },
  'Black Flame Altar': { shieldHere: (u) => (parseKeywords(getCard(u.cardId)).temporary ? 1 : 0) },

  // --- Batch 2: trigger events ---------------------------------------------
  'Fortified Position': { shieldHere: () => 2 }, // "a unit gains Shield 2" → defenders here +2
  'Back-Alley Bar': { onMoveFrom: (u) => { u.tempMight = (u.tempMight ?? 0) + 1 } },
  'Sigil of the Storm': { onConquer: (api, p) => api.recycleRune(p) },
  "Targon's Peak": { onConquer: (api, p) => api.readyRunes(p, 2) },
  'Ravenbloom Conservatory': { onDefend: (api, p) => api.revealTopSpellElseRecycle(p) },
  'Abandoned Hall': { onSpellPlayed: (api, p, i) => api.tempMightToUnitHere(p, i, 1) },

  // --- Batch 3a: forced/auto + optional-cost (auto-paid when affordable) ----
  Minefield: { onConquer: (api, p) => api.millTop(p, 2) },
  'Seat of Power': { onConquer: (api, p, i) => api.drawPerOtherControlledBF(p, i) },
  'Hall of Legends': { onConquer: (api, p) => { if (api.payEnergy(p, 1)) api.readyLegend(p) } },
  'Treasure Hoard': { onConquer: (api, p) => { if (api.payEnergy(p, 1)) api.playGoldToken(p) } },
  'Sunken Temple': { onConquer: (api, p, i) => { if (api.hasMightyHere(p, i) && api.payEnergy(p, 1)) api.draw(p, 1) } },
  'Monastery of Hirana': { onConquer: (api, p, i) => { if (api.spendBuffHere(p, i)) api.draw(p, 1) } },
  'Power Nexus': { onHold: (api, p) => { if (api.payPowerAny(p, 4)) api.score(p, 1) } },

  // --- Batch 3b: keyword + targeted/optional events -----------------------
  // Forgotten Library: playing a spell for 4+ Energy lets you Predict.
  'Forgotten Library': { onSpellPlayed: (api, p, _i, spent) => { if (spent >= 4) api.predict(p) } },
  // Veiled Temple: conquering readies a friendly gear (the optional Equipment
  // detach is a player choice and left manual).
  'Veiled Temple': { onConquer: (api, p) => { api.readyGear(p) } },
}

export function bfScript(cardId: string | undefined): BattlefieldScript | undefined {
  if (!cardId) return undefined
  return SCRIPTS[baseName(getCard(cardId)?.name ?? '')]
}

export function bfScriptAt(s: MatchState, i: number): BattlefieldScript | undefined {
  return bfScript(s.battlefields[i]?.cardId)
}

/** The battlefield index a unit is currently at, or -1 if it's at base. */
export function battlefieldOf(s: MatchState, iid: string): number {
  return s.battlefields.findIndex((b) => b.units.some((u) => u.iid === iid))
}
