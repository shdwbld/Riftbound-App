import { getCard } from '../data/cards'
import type { Card, Domain } from '../types/cards'
import type { PlayerState, Payment, ResolvedCost, EngineCard, MatchState, PlayerId } from './types'

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

/** State-aware cost: applies "I cost X less" self-reductions and battlefield
 *  cost modifiers (Ornn's Forge) on top of the printed cost. Energy-only; colored
 *  Power is left as printed. Reductions never push a cost below 0 (or below an
 *  explicit "to a minimum of" floor). Increases are intentionally NOT applied
 *  here (they could wrongly block plays in this casual sim). */
export function effectiveCostOf(state: MatchState, player: PlayerId, card: Card): ResolvedCost {
  const base = costOf(card)
  const p = state.players[player]
  if (!p) return base
  const t = (card.text ?? '').toLowerCase()
  let energy = base.energy
  let floor = 0

  const controlsTag = (tag: string): boolean =>
    [...p.zones.base, ...state.battlefields.flatMap((b) => b.units)].some(
      (u) => u.owner === player && (getCard(u.cardId)?.tags ?? []).some((x) => x.toLowerCase() === tag),
    )
  const controlsBF = (name: string): boolean =>
    state.battlefields.some((b) => b.controller === player && (getCard(b.cardId)?.name ?? '').toLowerCase().startsWith(name))

  // "I cost N less for each card in your trash" (Rhasa the Sunderer).
  let m = t.match(/cost :rb_energy_(\d+): less for each card in your trash/)
  if (m) energy -= Number(m[1]) * p.zones.trash.length

  // "I cost N less for each card you've played this turn[, to a minimum of M]"
  // (Battering Ram). The minimum is a floor on the resulting cost, not the cut.
  m = t.match(/cost :rb_energy_(\d+): less for each (?:other )?card you'?ve played this turn(?:[^.]*?minimum of :rb_energy_(\d+))?/)
  if (m) {
    energy -= Number(m[1]) * (p.cardsPlayedThisTurn ?? 0)
    if (m[2]) floor = Math.max(floor, Number(m[2]))
  }

  // "This costs N less if you control a <Tag>" (Production Surge → Mech).
  m = t.match(/costs? :rb_energy_(\d+): less if you control an? ([a-z' -]+?)[.)]/)
  if (m && controlsTag(m[2].trim())) energy -= Number(m[1])

  // "If an opponent controls a stunned unit, I cost N less [and enter ready]"
  // (Monch) — conditional on any opponent controlling a stunned unit.
  const monchM = t.match(/if an opponent controls a stunned unit, i cost :rb_energy_(\d+): less/)
  if (monchM) {
    const oppHasStunned = [
      ...state.battlefields.flatMap((b) => b.units),
      ...state.players.flatMap((pl) => pl.zones.base),
    ].some((u) => u.owner !== player && u.stunned)
    if (oppHasStunned) energy -= Number(monchM[1])
  }

  // Flat unconditional "I cost N less" — but not the for-each / conditional /
  // play-from-elsewhere variants handled above (incl. Monch). [Legion] gates it on
  // having already played a card this turn (Noxus Hopeful).
  // Allow optional bracket markers (e.g. the "[>]" activation arrow, stored as
  // "[&gt;]") between a [Level N] tag and "I cost".
  const LVL_COST = /\[level\s*\d+\](?:\[[^\]]*\]|\s)*i cost/
  m = t.match(/i cost :rb_energy_(\d+): less\b/)
  if (m && !monchM && !/less for|less if|less to play from/.test(t) && !LVL_COST.test(t)) {
    const legionGated = /\[legion\]/.test(t)
    if (!legionGated || (p.cardsPlayedThisTurn ?? 0) >= 1) energy -= Number(m[1])
  }

  // Level-gated cost reductions ("[Level N] I cost <cost> less[ instead]" —
  // Master Yi - Unstoppable). Higher tiers REPLACE lower; use the best tier the
  // controller's XP has reached. Reduces Energy and colored Power.
  let powerCut: Partial<Record<Domain, number>> | null = null
  if (LVL_COST.test(t)) {
    const xp = p.xp ?? 0
    let bestLvl = -1
    const reLvl = /\[level\s*(\d+)\](?:\[[^\]]*\]|\s)*i cost ([^.]*?)\s*less/gi
    let lm: RegExpExecArray | null
    while ((lm = reLvl.exec(t))) {
      const lvl = parseInt(lm[1], 10)
      if (lvl > xp || lvl <= bestLvl) continue
      bestLvl = lvl
      const seg = lm[2]
      const eM = seg.match(/:rb_energy_(\d+):/)
      const redP: Partial<Record<Domain, number>> = {}
      for (const rm of seg.matchAll(/:rb_rune_([a-z]+):/gi)) {
        const dd = rm[1].toLowerCase() as Domain
        redP[dd] = (redP[dd] ?? 0) + 1
      }
      energy = base.energy - (eM ? parseInt(eM[1], 10) : 0) // tiers replace, not stack
      powerCut = redP
    }
  }

  // Ornn's Forge: non-token gear you play costs 1 less while you control it.
  if (card.type === 'gear' && card.supertype !== 'token' && controlsBF("ornn's forge")) energy -= 1

  energy = Math.max(floor, Math.max(0, energy))

  // Cost INCREASES (applied after reductions, so they can't be undercut to 0 by
  // a reduction): Vaults of Helia bumps non-token units this turn.
  if (card.type === 'unit' && card.supertype !== 'token') energy += p.unitCostBump ?? 0

  let power = base.power
  if (powerCut) {
    power = { ...base.power }
    for (const [dd, n] of Object.entries(powerCut) as [Domain, number][])
      power[dd] = Math.max(0, (power[dd] ?? 0) - n)
  }
  return { energy, power }
}

/** Auto-pay a card using its state-aware effective cost. */
export function autoPayEff(state: MatchState, player: PlayerId, card: Card): Payment | null {
  return autoPay(state.players[player], effectiveCostOf(state, player, card))
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
