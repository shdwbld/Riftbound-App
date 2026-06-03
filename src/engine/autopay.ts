import { getCard } from '../data/cards'
import type { Card, Domain } from '../types/cards'
import type { PlayerState, Payment, ResolvedCost, EngineCard } from './types'

// ---------------------------------------------------------------------------
// Auto-pay: pick a valid Payment from a player's ready rune pool for a given
// cost. Powers the "play" buttons (no manual rune-tapping) and affordability
// checks. Returns null if the cost can't be met.
// ---------------------------------------------------------------------------

export function costOf(card: Card): ResolvedCost {
  if (card.type === 'unit' || card.type === 'spell' || card.type === 'gear')
    return { energy: card.energy, power: card.power }
  return { energy: 0, power: {} }
}

/** Sum two costs (e.g. a card's base cost + an optional Accelerate cost). */
export function addCost(a: ResolvedCost, b: { energy: number; power: Partial<Record<Domain, number>> }): ResolvedCost {
  const power: Partial<Record<Domain, number>> = { ...a.power }
  for (const [d, n] of Object.entries(b.power) as [Domain, number][])
    power[d] = (power[d] ?? 0) + (n ?? 0)
  return { energy: a.energy + b.energy, power }
}

/** Does a cost require any payment at all? */
export function costIsFree(cost: ResolvedCost): boolean {
  return cost.energy <= 0 && Object.values(cost.power).every((n) => (n ?? 0) <= 0)
}

function produces(rune: EngineCard): Domain[] {
  const d = getCard(rune.cardId)
  return d?.type === 'rune' ? d.produces : []
}

/** Greedy auto-pay. Pool resources (Energy + colored Power) are spent first,
 *  then colored power is matched from runes (most-constrained first), then
 *  energy is taken from whatever ready runes remain. */
export function autoPay(player: PlayerState, cost: ResolvedCost): Payment | null {
  const pool = player.pool ?? { energy: 0, power: {} }
  const ready = player.zones.runePool.filter((r) => !r.exhausted)
  const used = new Set<string>()

  // Spend pooled colored power first, per domain.
  const poolPower: Partial<Record<Domain, number>> = {}
  const recycle: string[] = []
  for (const [domain, count] of Object.entries(cost.power) as [Domain, number][]) {
    let need = count ?? 0
    const fromPool = Math.min(need, pool.power[domain] ?? 0)
    if (fromPool > 0) {
      poolPower[domain] = fromPool
      need -= fromPool
    }
    // Cover the rest with runes (prefer a mono-domain rune before a wild rune).
    for (let i = 0; i < need; i++) {
      const candidates = ready
        .filter((r) => !used.has(r.iid) && produces(r).includes(domain))
        .sort((a, b) => produces(a).length - produces(b).length)
      const pick = candidates[0]
      if (!pick) return null
      used.add(pick.iid)
      recycle.push(pick.iid)
    }
  }

  // Spend pooled energy, then exhaust ready runes for the remainder.
  const poolEnergy = Math.min(cost.energy, pool.energy ?? 0)
  const energyFromRunes = cost.energy - poolEnergy
  const exhaust: string[] = []
  // A single rune can be exhausted for Energy AND recycled for Power (an
  // already-exhausted rune is still recyclable) — e.g. one Calm rune pays
  // Defy's 1 Energy + 1 Calm. So reuse recycled runes for the exhaust first,
  // then cover any remaining energy from other ready runes.
  for (const iid of recycle) {
    if (exhaust.length >= energyFromRunes) break
    exhaust.push(iid)
  }
  const remaining = ready.filter((r) => !used.has(r.iid))
  if (exhaust.length + remaining.length < energyFromRunes) return null
  for (let i = 0; exhaust.length < energyFromRunes && i < remaining.length; i++)
    exhaust.push(remaining[i].iid)

  const payment: Payment = { exhaust, recycle }
  if (poolEnergy > 0) payment.poolEnergy = poolEnergy
  if (Object.keys(poolPower).length > 0) payment.poolPower = poolPower
  return payment
}

export function autoPayForCard(player: PlayerState, card: Card): Payment | null {
  return autoPay(player, costOf(card))
}

export function canAfford(player: PlayerState, card: Card): boolean {
  return autoPayForCard(player, card) !== null
}
