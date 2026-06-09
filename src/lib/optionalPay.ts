/** "Pay ⚡1 ♺2" button label from a P0 optionalPay pendingChoice payload
 *  (`{ cost: { energy?, powerAny? }, op }`). Shared by MatchPage / OnlinePage. */
export function optionalPayLabel(payload?: string): string {
  try {
    const cost = (JSON.parse(payload ?? '{}') as { cost?: { energy?: number; powerAny?: number } }).cost ?? {}
    const parts: string[] = []
    if (cost.energy) parts.push(`⚡${cost.energy}`)
    if (cost.powerAny) parts.push(`♺${cost.powerAny}`)
    return parts.length ? `Pay ${parts.join(' ')}` : 'Pay'
  } catch {
    return 'Pay'
  }
}
