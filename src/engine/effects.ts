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

export type TargetScope = 'enemy' | 'friendly' | 'any' | null

export interface ParsedEffect {
  draw: number
  channel: number
  /** Damage to each chosen target unit, if the text calls for it. */
  damage: number
  /** Number of Recruit unit tokens to create. */
  recruits: number
  /** Number of Gold gear tokens to create. */
  goldTokens: number
  /** Number of your units to ready (un-exhaust) — the player chooses which. */
  readyUnits: number
  /** +1 Might buff counters to apply (e.g. "gains +1 Might"). */
  buff: number
  /** Units to outright kill (no damage roll). */
  kill: number
  /** Signed Might-this-turn applied to each chosen target (e.g. Stupefy −1). */
  tempMight: number
  /** Signed Might-this-turn applied to the SOURCE (e.g. "give me +1 this turn"). */
  tempMightSelf: number
  /** Extra cards drawn if a chosen target dies during this resolution. */
  drawOnKill: number
  /** Who the targeted part may hit. */
  targetScope: TargetScope
  /** How many units the targeted part affects (0 = no target). */
  targetCount: number
  /** A target must be on a battlefield (not at base). */
  battlefieldOnly: boolean
  /** True when there's text we couldn't auto-resolve. */
  manual: boolean
}

const EMPTY_EFFECT = (): ParsedEffect => ({
  draw: 0,
  channel: 0,
  damage: 0,
  recruits: 0,
  goldTokens: 0,
  readyUnits: 0,
  buff: 0,
  kill: 0,
  tempMight: 0,
  tempMightSelf: 0,
  drawOnKill: 0,
  targetScope: null,
  targetCount: 0,
  battlefieldOnly: false,
  manual: false,
})

/** The part of an effect that requires choosing target unit(s). */
export function hasTargetedPart(e: ParsedEffect): boolean {
  return e.damage > 0 || e.kill > 0 || e.tempMight !== 0
}
/** The part of an effect that resolves with no target (draw/channel/etc.). */
export function hasUntargetedPart(e: ParsedEffect): boolean {
  return e.draw > 0 || e.channel > 0 || e.recruits > 0 || e.goldTokens > 0 || e.readyUnits > 0 || e.buff > 0 || e.tempMightSelf !== 0
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

/** The Might symbol token or the literal word. */
const MIGHT = '(?::rb_might:|might)'

function parse(text: string): ParsedEffect {
  const t = text.toLowerCase()
  const eff = EMPTY_EFFECT()
  let hit = false

  // Conditional draw on a kill ("if this kills it … draw 1"); detected first so
  // its "draw N" isn't also counted as an unconditional draw.
  const dokM = t.match(new RegExp(`if (?:this kills it|it (?:dies|would die))[^.]*?draw ${NUM}`))
  if (dokM) { eff.drawOnKill += num(dokM[1]); hit = true }
  const tNoCond = dokM ? t.replace(dokM[0], ' ') : t

  const drawM = tNoCond.match(new RegExp(`draw ${NUM}`))
  if (drawM) { eff.draw += num(drawM[1]); hit = true }

  const chM = t.match(new RegExp(`channel ${NUM}`))
  if (chM) { eff.channel += num(chM[1]); hit = true }

  const recM = t.match(new RegExp(`play ${NUM}[^.]*?recruit unit tokens?`))
  if (recM) { eff.recruits += num(recM[1]); hit = true }

  // Gold gear tokens: "play a Gold gear token", "play 2 gold gear tokens".
  const goldM = t.match(new RegExp(`play ${NUM}[^.]*?gold gear tokens?`))
  if (goldM) { eff.goldTokens += num(goldM[1]); hit = true }

  // Ready your unit(s): "ready a friendly unit", "ready up to 2 units" — the
  // player chooses which to un-exhaust. ("enters ready" is a different effect.)
  const readyM = t.match(/\bready (?:up to )?(a|an|another|target|one|two|three|\d+)\b[^.]*?\bunits?\b/i)
  if (readyM) {
    const w = readyM[1].toLowerCase()
    eff.readyUnits += /^(a|an|another|target|one)$/.test(w) ? 1 : num(w)
    hit = true
  }

  // Damage to unit(s): "deal 3 to a unit", "deal 6 to each of up to two units".
  const dmgM = t.match(/deal (\d+)(?: damage)?\s+to\b[^.]*?units?/)
  if (dmgM) { eff.damage += parseInt(dmgM[1], 10); hit = true }

  // Outright kill: "kill a unit".
  const killM = t.match(/\bkill (?:a |an |target |another )?unit/)
  if (killM) { eff.kill += 1; hit = true }

  // Signed Might-this-turn to a target unit: "give a unit -1 Might this turn".
  const tmTargetM = t.match(new RegExp(`give (?:a|an|target|another) (?:friendly |enemy )?unit (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmTargetM) {
    const sign = tmTargetM[1] === '-' ? -1 : 1
    eff.tempMight += sign * parseInt(tmTargetM[2], 10)
    hit = true
  }

  // Signed Might-this-turn to self: "give me +1 Might this turn".
  const tmSelfM = t.match(new RegExp(`give me (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmSelfM) {
    const sign = tmSelfM[1] === '-' ? -1 : 1
    eff.tempMightSelf += sign * parseInt(tmSelfM[2], 10)
    hit = true
  }

  // Permanent +Might buff counter ("gains +1 Might"), not "this turn".
  if (!/this turn/.test(t)) {
    const buffM = t.match(new RegExp(`(?:gains?|grant|put) \\+?${NUM} ${MIGHT}`))
    if (buffM) { eff.buff += num(buffM[1]); hit = true }
  }

  // Multi-target count: "each of up to two units" / "up to 2 units".
  const multiM = t.match(new RegExp(`(?:each of )?up to ${NUM} units?`)) || t.match(new RegExp(`each of ${NUM} units?`))

  // Resolve targeting metadata for any targeted part.
  if (hasTargetedPart(eff)) {
    eff.targetCount = multiM ? num(multiM[1]) : 1
    eff.battlefieldOnly = /at a battlefield/.test(t)
    eff.targetScope = /friendly|your unit/.test(t)
      ? 'friendly'
      : /enemy|opposing/.test(t)
        ? 'enemy'
        : eff.tempMight > 0 || eff.buff > 0
          ? 'friendly'
          : 'enemy' // damage / kill / debuff default to enemies
  }

  if (!hit && t.trim().length > 0) eff.manual = true
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

/** True if a spell has a part that targets unit(s) (damage / kill / ±Might). */
export function needsTarget(card: Card): boolean {
  if (card.type !== 'spell') return false
  const e = spellEffect(card)
  return hasTargetedPart(e) && e.targetCount > 0
}

/** On-play effect for a unit/gear — only the unambiguous on-play triggers. */
export function onPlayEffect(card: Card): ParsedEffect {
  const t = (card.text ?? '').toLowerCase()
  if (!ON_PLAY.test(t)) return EMPTY_EFFECT()
  return parse(card.text ?? '')
}
