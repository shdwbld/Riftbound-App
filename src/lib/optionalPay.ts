import type { ResolvedCost } from '../engine/types'

type ChoiceCost = ResolvedCost & { powerAny?: number }

/** "Pay ⚡1 ♺2" button label from a P0 optionalPay pendingChoice payload
 *  (`{ cost: { energy?, powerAny? }, op }`). Shared by MatchPage / OnlinePage. */
export function optionalPayLabel(payload?: string): string {
  const cost = choiceResolvedCost(payload)
  const parts: string[] = []
  if (cost.energy) parts.push(`⚡${cost.energy}`)
  const colored = Object.values(cost.power).reduce((a, b) => a + (b ?? 0), 0)
  if (colored + (cost.powerAny ?? 0) > 0) parts.push(`♺${colored + (cost.powerAny ?? 0)}`)
  return parts.length ? `Pay ${parts.join(' ')}` : 'Pay'
}

/** The full rune cost carried in an optionalPay/payCost pendingChoice payload —
 *  prefers the new `resolvedCost` (real domains) and falls back to the legacy
 *  `{ energy, powerAny }` summary. Feeds the PaymentModal rune picker. */
export function choiceResolvedCost(payload?: string): ChoiceCost {
  try {
    const p = JSON.parse(payload ?? '{}') as { cost?: { energy?: number; powerAny?: number }; resolvedCost?: ChoiceCost }
    if (p.resolvedCost) return p.resolvedCost
    return { energy: p.cost?.energy ?? 0, power: {}, powerAny: p.cost?.powerAny }
  } catch {
    return { energy: 0, power: {} }
  }
}

/** True when the payload's cost needs no runes at all (nothing to pick). */
export function choiceCostFree(payload?: string): boolean {
  const c = choiceResolvedCost(payload)
  return (
    c.energy <= 0 &&
    (c.powerAny ?? 0) <= 0 &&
    (Object.values(c.power) as (number | undefined)[]).every((n) => (n ?? 0) <= 0)
  )
}
