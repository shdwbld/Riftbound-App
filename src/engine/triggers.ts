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
  | 'stun' // you stun one or more enemy units
  | 'enemyDeath' // an enemy unit dies (Pyke - Returned, Sivir - Battle Mistress)
  | 'discard' // you discard one or more cards (Jinx - Rebel)
  | 'recycleRune' // you recycle a rune (Sivir - Battle Mistress)
  | 'recycleCard' // you recycle one or more (non-rune) cards to your Main Deck (Karma - Channeler)
  | 'spendBuff' // you spend a buff (Fae Dragon)
  | 'becomesState' // a unit gains a state (e.g. becomes [Mighty])
  | 'buff' // a unit you control is buffed (Simian Ancestor)
  | 'targeted' // a unit is chosen as a spell/ability target (Jae Medarda, Irelia - Fervent)
  | 'hide' // you hide a card facedown (Katarina - Reckless)
  | 'opponentMove' // an opponent moves a unit to a battlefield (Volibear - Imposing)
  | 'endOfTurn' // "at the end of your turn" (G4 Ending Step — synthesized from endOfTurnEffect, not parsed)

/** Runtime list of all trigger events (mirrors the TriggerEvent union above) —
 *  used by the card-spec editor vocabulary so its options can't drift from the engine. */
export const TRIGGER_EVENTS: TriggerEvent[] = [
  'play', 'conquer', 'hold', 'death', 'startOfTurn', 'attack', 'defend', 'move',
  'winCombat', 'stun', 'enemyDeath', 'discard', 'recycleRune', 'recycleCard', 'spendBuff',
  'becomesState', 'buff', 'targeted', 'hide', 'opponentMove', 'endOfTurn',
]

export interface TriggeredAbility {
  event: TriggerEvent
  /** 'self' = refers to this card ("I"/"this"); 'global' = "when you …". */
  scope: 'self' | 'global'
  /** "you may" — needs a yes/no prompt rather than auto-resolving. */
  optional: boolean
  effect: ParsedEffect
  /** The extracted clause (for manual prompts / logging). */
  text: string
  /** For 'becomesState' triggers: the lowercased state word captured from
   *  'becomes [X]' (e.g. 'mighty'). Undefined for all other trigger types. */
  stateName?: string
  /** "The first time … each turn" — fires at most once per turn per source card
   *  (gated in fireTriggers via PlayerState.oncePerTurnUsed). */
  oncePerTurn?: boolean
}

interface Pattern {
  event: TriggerEvent
  scope: 'self' | 'global'
  re: RegExp
}

// Order matters only for readability; each pattern is tested independently.
const PATTERNS: Pattern[] = [
  // "When one of your units becomes [Mighty]" / "When a unit you control becomes [Mighty]" — global.
  { event: 'becomesState', scope: 'global', re: /when(?:ever)?\s+(?:a|one of your|an?)\s+(?:friendly\s+)?units?\s+(?:you\s+control\s+)?becomes?\s+\[?(\w+)\]?/i },
  // "When I become [Mighty]" / "When this unit becomes [Mighty]" — self.
  { event: 'becomesState', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+becomes?\s+\[?(\w+)\]?/i },
  // NB: the leading `(?<!\()` excludes [Deathknell] REMINDER text "(When I die, …)"
  // — those are handled by the [Deathknell] keyword below; only real (non-paren)
  // "when I die/am defeated" rules text is a self-death trigger here.
  { event: 'death', scope: 'self', re: /(?<!\()when(?:ever)?\s+(?:i['’]?m|i am|i|this(?:\s+unit)?\s+is|this(?:\s+unit)?)\s+(?:dies?|defeated|killed|destroyed)/i },
  // "When another non-Recruit unit you control dies" (Viktor - Leader), "when
  // another friendly unit dies" (Spectral Centaur), "when a buffed friendly unit
  // dies" (Vanguard Helm) — global. "you control" / "friendly" / "buffed" are all
  // optional; the death resolver only fires this for the dying unit's controller,
  // so it's friendly-scoped either way. (Won't match "an enemy unit dies" — that
  // qualifier isn't allowed between the article and "unit".)
  { event: 'death', scope: 'global', re: /when(?:ever)?\s+(?:another\s+|an?\s+)?(?:buffed\s+)?(?:non-recruit\s+)?(?:friendly\s+)?units?\s+(?:you\s+control\s+)?(?:dies|is\s+defeated|are\s+defeated)/i },
  // "When an enemy unit dies" / "When one or more enemy units die" (Pyke -
  // Returned, Sivir - Battle Mistress). Scope 'global' — fired for the controller
  // of the source by the death resolver, off the OTHER players' permanents.
  { event: 'enemyDeath', scope: 'global', re: /when(?:ever)?\s+(?:one or more\s+|an?\s+)?enemy\s+units?\s+(?:dies|die|is\s+defeated|are\s+defeated)/i },
  { event: 'conquer', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+conquers?/i },
  { event: 'conquer', scope: 'global', re: /when(?:ever)?\s+you\s+conquer/i },
  // "When you conquer or hold" (Ivern - Green Father) — also fires a hold trigger
  // (the conquer pattern above already covers the conquer half).
  { event: 'hold', scope: 'global', re: /when(?:ever)?\s+you\s+conquer\s+or\s+holds?/i },
  // "When you hold", "When you or an ally hold", "When an ally holds" (Vex - Gloomist).
  { event: 'hold', scope: 'global', re: /when(?:ever)?\s+(?:you|an? ally)(?:\s+or\s+(?:you|an? ally))?\s+holds?/i },
  // "When I hold" (Trevor Snoozebottom, Dunebreaker, …) — fires for the unit at a
  // held battlefield (the engine already collects self 'hold' triggers). "When I
  // conquer or hold" (Last Rites) also fires hold; its conquer half is matched by
  // the conquer self pattern above.
  { event: 'hold', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+(?:conquers?\s+or\s+)?holds?/i },
  { event: 'startOfTurn', scope: 'global', re: /(?:at\s+the\s+)?(?:start|beginning)\s+of\s+(?:your|the|each)\s+(?:turn|beginning\s+phase)/i },
  { event: 'attack', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+attacks?/i },
  // "When I defend" and "When I attack or defend" (Ahri - Inquisitive) both fire a
  // defend trigger; the attack pattern above already covers the "attack or" prefix.
  { event: 'defend', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+(?:attacks?\s+or\s+)?defends?/i },
  { event: 'winCombat', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+wins?(?:\s+a)?\s+combat/i },
  // "When you win a combat" (Kha'Zix - Voidreaver, Draven - Glorious Executioner).
  { event: 'winCombat', scope: 'global', re: /when(?:ever)?\s+you\s+win(?:\s+a)?\s+combat/i },
  { event: 'move', scope: 'self', re: /when(?:ever)?\s+(?:i|this(?:\s+unit)?)\s+moves?/i },
  { event: 'play', scope: 'global', re: /when(?:ever)?\s+you\s+play\s+(?:a|an|another)\b/i },
  { event: 'play', scope: 'self', re: /when(?:ever)?\s+(?:i['’]?m|i am|you\s+play\s+(?:me|this))/i },
  // "When you stun an enemy unit" / "When you stun one or more enemy units"
  // (Eclipse Herald, Leona - Radiant Dawn, Vex - Mocking). [Stun] keyword markers
  // stored as "[stun]" are stripped by the brackets in the clause; match both.
  { event: 'stun', scope: 'global', re: /when(?:ever)?\s+you\s+\[?stun\]?\s+(?:one or more\s+)?(?:an?\s+)?enemy\s+units?/i },
  // "When you discard one or more cards" (Jinx - Rebel). Effect targets the source.
  { event: 'discard', scope: 'global', re: /when(?:ever)?\s+you\s+discard/i },
  // "When you recycle a rune" (Sivir - Battle Mistress).
  { event: 'recycleRune', scope: 'global', re: /when(?:ever)?\s+you\s+recycle\s+a\s+rune/i },
  // "When you recycle one or more cards (to your Main Deck)" (Karma - Channeler).
  // Runes aren't cards, so this fires only on Main-Deck card recycles.
  { event: 'recycleCard', scope: 'global', re: /when(?:ever)?\s+you\s+recycle\s+(?:one or more\s+)?cards?/i },
  // "When you spend a buff" (Fae Dragon).
  { event: 'spendBuff', scope: 'global', re: /when(?:ever)?\s+you\s+spend\s+a\s+buff/i },
  // "When you buff me, …" (Simian Ancestor) — self.
  { event: 'buff', scope: 'self', re: /when(?:ever)?\s+you\s+buff\s+(?:me|this(?:\s+unit)?)/i },
  // "When you hide a card, …" (Katarina - Reckless: ready me) — global.
  { event: 'hide', scope: 'global', re: /when(?:ever)?\s+you\s+hide\s+a\s+card/i },
  // "When an opponent moves to a battlefield other than mine, …" (Volibear -
  // Imposing: draw 1) — global, fired off the opponent's move-resolution path.
  { event: 'opponentMove', scope: 'global', re: /when(?:ever)?\s+an\s+opponent\s+moves?\s+to\s+a\s+battlefield/i },
  // "When you choose/target me with a spell …" (Jae Medarda), "choose or ready me"
  // (Irelia - Fervent) — self. "me"/"this" must follow choose/target within ~40 chars.
  { event: 'targeted', scope: 'self', re: /when(?:ever)?\s+(?:you|a player)\s+(?:choose|chooses|target|targets)\b[^.]{0,40}?\b(?:me|this(?:\s+unit)?)\b/i },
  // "When you defend at a battlefield, …" (Loyal Pup) — global.
  { event: 'defend', scope: 'global', re: /when(?:ever)?\s+you\s+defend/i },
  // "The first time a friendly unit dies each turn" (Wraith of Echoes) — global death, once/turn.
  { event: 'death', scope: 'global', re: /the first time (?:a|an)\s+(?:friendly\s+)?units?\s+(?:you\s+control\s+)?(?:dies|is\s+defeated)\s+each\s+turn/i },
  // "The first time I conquer each turn" (Lucian - Merciless) — self conquer, once/turn.
  { event: 'conquer', scope: 'self', re: /the first time (?:i|this(?:\s+unit)?)\s+conquers?\s+each\s+turn/i },
  // "The first time I move each turn" (Miss Fortune - Captain) — self move, once/turn.
  { event: 'move', scope: 'self', re: /the first time (?:i|this(?:\s+unit)?)\s+moves?\s+each\s+turn/i },
  // "The first time I win a combat each turn" (Draven - Audacious) — self winCombat, once/turn.
  { event: 'winCombat', scope: 'self', re: /the first time (?:i|this(?:\s+unit)?)\s+wins?(?:\s+a)?\s+combat\s+each\s+turn/i },
]

/** The effect clause following a trigger phrase: from the phrase's end to the
 *  next sentence boundary. */
function clauseAfter(text: string, m: RegExpMatchArray): string {
  const start = (m.index ?? 0) + m[0].length
  const rest = text.slice(start).replace(/^\s*[:,]?\s*/, '')
  let end = rest.search(/[.;]/)
  // Multi-sentence deck-dig effects ("look at the top N … . You may reveal a gear …
  // and draw it. Recycle the rest.") span sentence boundaries — extend through the
  // closing "recycle …" sentence so the whole effect reaches the parser.
  if (end >= 0 && /\b(?:look at|reveal) the top\b/i.test(rest.slice(0, end))) {
    const recM = rest.match(/recycle [^.;]*[.;]/i)
    if (recM) end = (recM.index ?? 0) + recM[0].length - 1
  }
  // Full-cost trash-play ("play a unit from your trash. (You still pay its costs.)")
  // — extend through the closing parenthetical so the parser sees "still pay its
  // costs" and resolves it as a full-cost play, not a free one (Last Rites).
  if (end >= 0 && /\bplay a unit from your trash\b/i.test(rest.slice(0, end))) {
    const stillM = rest.match(/(?:you )?still pay its costs?[.;)]/i)
    if (stillM) end = (stillM.index ?? 0) + stillM[0].length - 1
  }
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
        ...(p.event === 'becomesState' && { stateName: m[1]?.toLowerCase().replace(/[\[\]]/g, '') }),
        oncePerTurn: /the first time\b/i.test(m[0]),
      })
    }
    // [Deathknell] keyword implies a death trigger even without explicit wording.
    // The death effect is the text AFTER the [Deathknell] marker — anything before
    // it (e.g. Scuttle Crab's on-play "draw 1") must not bleed into the death clause.
    if (parseKeywords(card).deathknell && !out.some((a) => a.event === 'death')) {
      const dkIdx = text.search(/\[deathknell\]/i)
      const after = dkIdx >= 0 ? text.slice(dkIdx) : text
      const stripped = after.replace(/\[[^\]]*\]/g, '').trim()
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
  /** The source card's id — lets the resolver dispatch hand-coded champion/legend
   *  handlers even after the source has left play (e.g. a dead unit's Deathknell). */
  sourceCardId?: string
  /** The battlefield the source died at, for location-scoped death triggers. */
  bfIndex?: number
  /** Snapshotted at death: the source died while participating in a showdown —
   *  gates "when I die in combat" (Draven - Audacious). Read from the FiredTrigger
   *  (not the trash) since the trashed copy may predate the combat stamp. */
  diedInCombat?: boolean
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
