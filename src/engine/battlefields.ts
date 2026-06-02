import { getCard } from '../data/cards'
import { type ParsedEffect, parseEffectText } from './effects'

// ---------------------------------------------------------------------------
// Battlefield passives. Battlefields print abilities that trigger on Hold
// (start of your turn while you control it), on Conquer (when you take it), or
// statically change the rules. We auto-resolve the common, unambiguous ones:
//   - "increase the points needed to win the game by N"  → win delta
//   - "when you hold here, draw/channel/play a recruit/buff a unit"
//   - "when you conquer here, draw/channel/..."
// Targeted or bespoke clauses are left for manual play (logged by the engine).
// ---------------------------------------------------------------------------

export interface BattlefieldPassive {
  winDelta: number
  onHold: ParsedEffect | null
  /** Buff a friendly unit here when you hold. */
  buffOnHold: boolean
  onConquer: ParsedEffect | null
  /** Raw text that we recognized a trigger for but couldn't fully resolve. */
  manualHold: boolean
  manualConquer: boolean
}

const cache = new Map<string, BattlefieldPassive>()

function sentences(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, '') // drop reminder text in parens
    .split(/(?<=[.!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function battlefieldPassive(cardId: string): BattlefieldPassive {
  const hit = cache.get(cardId)
  if (hit) return hit
  const card = getCard(cardId)
  const out: BattlefieldPassive = {
    winDelta: 0,
    onHold: null,
    buffOnHold: false,
    onConquer: null,
    manualHold: false,
    manualConquer: false,
  }
  const text = card?.text ?? ''
  for (const raw of sentences(text)) {
    const s = raw.toLowerCase()
    const winM = s.match(/increase the points needed to win.*?by (\d+)/)
    if (winM) out.winDelta += parseInt(winM[1], 10)

    if (s.startsWith('when you hold here')) {
      const e = parseEffectText(raw)
      if (/buff a unit/.test(s)) out.buffOnHold = true
      if (e.draw || e.channel || e.recruits) out.onHold = e
      else if (!/buff a unit/.test(s)) out.manualHold = true
    }
    if (s.startsWith('when you conquer here')) {
      const e = parseEffectText(raw)
      if (e.draw || e.channel || e.recruits) out.onConquer = e
      else out.manualConquer = true
    }
  }
  cache.set(cardId, out)
  return out
}
