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
  /** Combat Shield granted to a unit here while defending (e.g. Temporary units). */
  shieldHere?: (unit: EngineCard) => number
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
