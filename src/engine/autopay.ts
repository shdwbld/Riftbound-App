import { getCard } from '../data/cards'
import type { Card, Domain } from '../types/cards'
import type { PlayerState, Payment, ResolvedCost, EngineCard } from './types'

// ---------------------------------------------------------------------------
// Auto-pay: pick a valid Payment from a player's ready rune pool for a given
// cost. Powers the "play" buttons (no manual rune-tapping) and affordability
// checks. Returns null if the cost can't be met.
// ---------------------------------------------------------------------------

function costOf(card: Card): ResolvedCost {
  if (card.type === 'unit' || card.type === 'spell' || card.type === 'gear')
    return { energy: card.energy, power: card.power }
  return { energy: 0, power: {} }
}

function produces(rune: EngineCard): Domain[] {
  const d = getCard(rune.cardId)
  return d?.type === 'rune' ? d.produces : []
}

/** Greedy auto-pay. Power requirements are matched first (most constrained),
 *  then energy is taken from whatever ready runes remain. */
export function autoPay(player: PlayerState, cost: ResolvedCost): Payment | null {
  const ready = player.zones.runePool.filter((r) => !r.exhausted)
  const used = new Set<string>()

  const recycle: string[] = []
  // Pay colored power: assign the most specific runes first.
  for (const [domain, count] of Object.entries(cost.power) as [Domain, number][]) {
    for (let i = 0; i < (count ?? 0); i++) {
      // Prefer a mono-domain rune that exactly matches before a wild rune.
      const candidates = ready
        .filter((r) => !used.has(r.iid) && produces(r).includes(domain))
        .sort((a, b) => produces(a).length - produces(b).length)
      const pick = candidates[0]
      if (!pick) return null
      used.add(pick.iid)
      recycle.push(pick.iid)
    }
  }

  // Pay energy with any remaining ready runes.
  const exhaust: string[] = []
  const remaining = ready.filter((r) => !used.has(r.iid))
  if (remaining.length < cost.energy) return null
  for (let i = 0; i < cost.energy; i++) exhaust.push(remaining[i].iid)

  return { exhaust, recycle }
}

export function autoPayForCard(player: PlayerState, card: Card): Payment | null {
  return autoPay(player, costOf(card))
}

export function canAfford(player: PlayerState, card: Card): boolean {
  return autoPayForCard(player, card) !== null
}
