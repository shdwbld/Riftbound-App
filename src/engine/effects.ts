import type { Card } from '../types/cards'

// ---------------------------------------------------------------------------
// Lightweight effect parsing. We can't script all ~1000 bespoke cards, but we
// can auto-resolve the most common, unambiguous patterns from the card text:
//   - "draw N" / "draw a card"
//   - "channel N runes"
//   - "deal N" / "deal N damage to a unit"  (needs a target)
// Everything else is surfaced for manual resolution. Conservative on purpose:
// for non-spell cards we only fire when the text reads as an on-play trigger,
// to avoid misfiring on conditional ("when you play a spell…") text.
// ---------------------------------------------------------------------------

export interface ParsedEffect {
  draw: number
  channel: number
  /** Damage to a single target unit, if the text calls for it. */
  damage: number
  /** Number of Recruit unit tokens to create. */
  recruits: number
  /** True when there's text we couldn't auto-resolve. */
  manual: boolean
}

const WORD_NUM: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
}

function num(token: string): number {
  return WORD_NUM[token.toLowerCase()] ?? (parseInt(token, 10) || 0)
}

const NUM = '(\\d+|a|an|one|two|three|four|five)'

function parse(text: string): ParsedEffect {
  const t = text.toLowerCase()
  const eff: ParsedEffect = { draw: 0, channel: 0, damage: 0, recruits: 0, manual: false }

  const drawM = t.match(new RegExp(`draw ${NUM}`))
  if (drawM) eff.draw += num(drawM[1])

  const chM = t.match(new RegExp(`channel ${NUM}`))
  if (chM) eff.channel += num(chM[1])

  // "deal 2 to a unit" / "deal 2 damage"
  const dmgM = t.match(/deal (\d+) (?:damage )?to (?:a |an |target )?unit/)
  if (dmgM) eff.damage += parseInt(dmgM[1], 10)

  // "play a/two/three/four [1 :might:] Recruit unit token(s)"
  const recM = t.match(new RegExp(`play ${NUM}[^.]*?recruit unit tokens?`))
  if (recM) eff.recruits += num(recM[1])

  if (!drawM && !chM && !dmgM && !recM && t.trim().length > 0) eff.manual = true
  return eff
}

const ON_PLAY = /when (?:i(?:'m| am)? )?(?:played|enter|cast)|when you play (?:me|this)|^play/

/** Effect to apply when a SPELL resolves (its whole text is the effect). */
export function spellEffect(card: Card): ParsedEffect {
  return parse(card.text ?? '')
}

/** Parse an arbitrary effect clause (used by battlefield passives). */
export function parseEffectText(text: string): ParsedEffect {
  return parse(text)
}

/** On-play effect for a unit/gear — only the unambiguous on-play triggers. */
export function onPlayEffect(card: Card): ParsedEffect {
  const t = (card.text ?? '').toLowerCase()
  if (!ON_PLAY.test(t)) return { draw: 0, channel: 0, damage: 0, recruits: 0, manual: false }
  return parse(card.text ?? '')
}
