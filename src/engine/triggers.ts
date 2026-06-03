import type { Card } from '../types/cards'
import { parseEffectText, type ParsedEffect } from './effects'
import { parseKeywords } from './keywords'

// ---------------------------------------------------------------------------
// Batch C — triggered abilities.
//
// We can't script every bespoke card, but we can recognize the common triggered
// patterns from card text ("When I'm defeated…", "When you conquer…", "At the
// start of your turn…") and extract their effect clause through the same
// lightweight parser the rest of the engine uses. The reducer fires the matching
// event; auto-resolvable effects (draw/channel/recruit/buff) apply, the rest are
// surfaced for manual resolution. Simultaneous triggers are ordered turn-player
// first (rule 4.6 / 10.2).
// ---------------------------------------------------------------------------

export type TriggerEvent =
  | 'play' // a card is played
  | 'conquer' // controller conquers a battlefield
  | 'hold' // start-of-turn battlefield hold
  | 'death' // a unit is defeated (Deathknell)
  | 'startOfTurn'
  | 'attack' // a unit moves into a showdown as the attacker
  | 'defend' // a unit defends in a showdown
  | 'move' // a unit makes a Standard Move
  | 'winCombat' // a unit's side wins a showdown

export interface TriggeredAbility {
  event: TriggerEvent
  /** 'self' = refers to this card ("I"/"this"); 'global' = "when you …". */
  scope: 'self' | 'global'
  /** "you may" — needs a yes/no prompt rather than auto-resolving. */
  optional: boolean
  effect: ParsedEffect
  /** The extracted clause (for manual prompts / logging). */
  text: string
}

interface Pattern {
  event: TriggerEvent
  scope: 'self' | 'global'
  re: RegExp
}

// Order matters only for readability; each pattern is tested independently.
const PATTERNS: Pattern[] = [
  { event: 'death', scope: 'self', re: /when(?:ever)?\s+(?:i['’]?m|i am|this(?:\s+unit)?\s+is|this(?:\s+unit)?)\s+(?:defeated|killed|destroyed|dies)/i },
  { event: 'conquer', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+conquers?/i },
  { event: 'conquer', scope: 'global', re: /when(?:ever)?\s+you\s+conquer/i },
  // "When you hold", "When you or an ally hold", "When an ally holds" (Vex - Gloomist).
  { event: 'hold', scope: 'global', re: /when(?:ever)?\s+(?:you|an? ally)(?:\s+or\s+(?:you|an? ally))?\s+holds?/i },
  { event: 'startOfTurn', scope: 'global', re: /(?:at\s+the\s+)?(?:start|beginning)\s+of\s+(?:your|the|each)\s+(?:turn|beginning\s+phase)/i },
  { event: 'attack', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+attacks?/i },
  { event: 'defend', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+defends?/i },
  { event: 'winCombat', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+wins?(?:\s+a)?\s+combat/i },
  { event: 'move', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+moves?/i },
  { event: 'play', scope: 'global', re: /when(?:ever)?\s+you\s+play\s+(?:a|an|another)\b/i },
  { event: 'play', scope: 'self', re: /when(?:ever)?\s+(?:i['’]?m|i am|you\s+play\s+(?:me|this))/i },
]

/** The effect clause following a trigger phrase: from the phrase's end to the
 *  next sentence boundary. */
function clauseAfter(text: string, m: RegExpMatchArray): string {
  const start = (m.index ?? 0) + m[0].length
  const rest = text.slice(start).replace(/^\s*[:,]?\s*/, '')
  const end = rest.search(/[.;]/)
  return (end >= 0 ? rest.slice(0, end) : rest).trim()
}

const cache = new Map<string, TriggeredAbility[]>()

/** Parse all recognized triggered abilities off a card's text. */
export function parseTriggers(card: Card | undefined): TriggeredAbility[] {
  if (!card) return []
  const hit = cache.get(card.id)
  if (hit) return hit
  const text = card.text ?? ''
  const out: TriggeredAbility[] = []
  if (text) {
    const seen = new Set<string>()
    for (const p of PATTERNS) {
      const m = text.match(p.re)
      if (!m) continue
      const key = `${p.event}:${p.scope}`
      if (seen.has(key)) continue
      seen.add(key)
      const clause = clauseAfter(text, m)
      out.push({
        event: p.event,
        scope: p.scope,
        optional: /\bmay\b/i.test(clause),
        effect: parseEffectText(clause || text),
        text: clause || text,
      })
    }
    // [Deathknell] keyword implies a death trigger even without explicit wording.
    if (parseKeywords(card).deathknell && !out.some((a) => a.event === 'death')) {
      const stripped = text.replace(/\[[^\]]*\]/g, '').trim()
      out.push({ event: 'death', scope: 'self', optional: false, effect: parseEffectText(stripped), text: stripped })
    }
  }
  cache.set(card.id, out)
  return out
}

/** A card's triggered abilities for one event. */
export function triggersFor(card: Card | undefined, event: TriggerEvent): TriggeredAbility[] {
  return parseTriggers(card).filter((a) => a.event === event)
}

/** A fired trigger awaiting resolution, tagged with its controller. */
export interface FiredTrigger {
  player: number
  ability: TriggeredAbility
  /** The unit that owns a 'self' trigger, when applicable. */
  sourceIid?: string
}

/** Order simultaneously-fired triggers: the turn player's resolve first, then
 *  the remaining seats in turn order (rule 4.6). Stable within a seat. */
export function orderTriggers<T extends { player: number }>(
  fired: T[],
  turnPlayer: number,
  seatCount: number,
): T[] {
  const rank = (p: number) => (p - turnPlayer + seatCount) % seatCount
  return fired
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.player) - rank(b.f.player) || a.i - b.i)
    .map((x) => x.f)
}
