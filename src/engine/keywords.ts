import type { Card, Domain } from '../types/cards'
import { getCard } from '../data/cards'

export interface KeywordCost {
  energy: number
  power: Partial<Record<Domain, number>>
}

// ---------------------------------------------------------------------------
// Keyword parsing. Riftbound prints keywords in the card text as [Keyword] or
// [Keyword N] (e.g. "[Tank]", "[Shield 1]", "[Assault 2]"). We parse them once
// per card into a structured shape the engine can act on. This auto-derives
// keyword behavior for the whole card pool without per-card data entry.
// ---------------------------------------------------------------------------

export interface Keywords {
  /** Must be assigned lethal damage before other (non-Tank) units. */
  tank: boolean
  /** +X Might while defending. */
  shield: number
  /** +X Might while attacking. */
  assault: number
  /** "When I die" trigger. */
  deathknell: boolean
  /** Enters ready instead of exhausted (with its extra cost). */
  accelerate: boolean
  /** May be played to a battlefield you contest; Reaction speed. */
  ambush: boolean
  /** Costs X more to be targeted by enemy spells/abilities. */
  deflect: number
  /** May move battlefield-to-battlefield. */
  ganking: boolean
  /** Can be placed facedown at a controlled battlefield. */
  hidden: boolean
  /** Grants X XP on conquer/hold. */
  hunt: number
  /** Bonus if you've already played another card this turn. */
  legion: boolean
  /** Buff active while you have >= N XP. */
  level: number
  /** Reaction-speed gear that attaches on play. */
  quickDraw: boolean
  /** Reaction speed (closed-state plays). */
  reaction: boolean
  /** Action speed (open-state plays during showdowns). */
  action: boolean
  /** Look at / filter the top of your deck when played. */
  vision: boolean
  /** Predict: look at the top of your Main Deck; you may recycle it (same look
   *  as Vision, reached from different triggers). */
  predict: boolean
  /** Auto-attach an equipment on entry. */
  weaponmaster: boolean
  /** Doesn't participate as a normal frontline combatant. */
  backline: boolean
  /** Killed at the start of the controller's next turn. */
  temporary: boolean
  /** Gear with an attach activation. */
  equip: boolean
  /** Spell with an optional additional cost to resolve its effect again. */
  repeat: boolean
}

const EMPTY: Keywords = {
  tank: false,
  shield: 0,
  assault: 0,
  deathknell: false,
  accelerate: false,
  ambush: false,
  deflect: 0,
  ganking: false,
  hidden: false,
  hunt: 0,
  legion: false,
  level: 0,
  quickDraw: false,
  reaction: false,
  action: false,
  vision: false,
  predict: false,
  weaponmaster: false,
  backline: false,
  temporary: false,
  equip: false,
  repeat: false,
}

const cache = new Map<string, Keywords>()
const TOKEN = /\[([A-Za-z][A-Za-z'-]*)\s*(\d+|X)?\]/g

/** Apply a single keyword token to a Keywords accumulator. */
function applyKeywordToken(kw: Keywords, name: string, num: number): void {
  switch (name) {
    case 'tank': kw.tank = true; break
    case 'shield': kw.shield = Math.max(kw.shield, num || 1); break
    case 'assault': kw.assault = Math.max(kw.assault, num || 1); break
    case 'deathknell': kw.deathknell = true; break
    case 'accelerate': kw.accelerate = true; break
    case 'ambush': kw.ambush = true; break
    case 'deflect': kw.deflect = Math.max(kw.deflect, num || 1); break
    case 'ganking': kw.ganking = true; break
    case 'hidden': kw.hidden = true; break
    case 'hunt': kw.hunt = Math.max(kw.hunt, num || 1); break
    case 'legion': kw.legion = true; break
    case 'level': kw.level = Math.max(kw.level, num || 1); break
    case 'quick-draw': kw.quickDraw = true; break
    case 'reaction': kw.reaction = true; break
    case 'action': kw.action = true; break
    case 'vision': kw.vision = true; break
    case 'predict': kw.predict = true; break
    case 'weaponmaster': kw.weaponmaster = true; break
    case 'backline': kw.backline = true; break
    case 'temporary': kw.temporary = true; break
    case 'equip': kw.equip = true; break
    case 'repeat': kw.repeat = true; break
  }
}

export function parseKeywords(card: Card | undefined): Keywords {
  if (!card) return EMPTY
  const hit = cache.get(card.id)
  if (hit) return hit

  const kw: Keywords = { ...EMPTY }
  const text = card.text ?? ''
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text))) {
    const num = m[2] === 'X' ? 1 : m[2] ? parseInt(m[2], 10) : 0
    applyKeywordToken(kw, m[1].toLowerCase(), num)
  }
  // [Temporary] that's GRANTED to a token this card creates ("… token with
  // [Temporary]") or to another unit ("give it [Temporary]" / "units … have
  // [Temporary]") is not a keyword on THIS card. Without this, every Sprite-maker
  // (Sprite Queen, Trevor, Lillia - Fae Fawn) would flag itself Temporary and
  // self-destruct at its controller's next Beginning Phase.
  if (kw.temporary && !/(?:^|[.)]\s*)\[temporary\]/i.test(text)) {
    const ungranted = text.replace(/\b(?:with|give (?:it|them)|have)\s+\[temporary\]/gi, '')
    if (!/\[temporary\]/i.test(ungranted)) kw.temporary = false
  }
  // "[Deathknell]" REFERENCED as a noun in a static ability ("Your [Deathknell]
  // effects trigger an additional time" — Karthus - Eternal) is not a Deathknell
  // on THIS card. A real Deathknell ability reads "[Deathknell] — <effect>" or
  // "[Deathknell][>] <effect>". Without this, Karthus mis-fires a junk death
  // trigger (and the doubler would even double its own junk).
  if (kw.deathknell) {
    const referenced = text.replace(/\byour\s+\[deathknell\]\s+effects/gi, '')
    if (!/\[deathknell\]/i.test(referenced)) kw.deathknell = false
  }
  // [Assault]/[Shield] GRANTED to other units ("Other friendly units here have
  // [Assault]" — Captain Farron; "… have [Shield]" — Taric - Protector) is not a
  // keyword on THIS card. Strip it when every occurrence sits inside a grant
  // clause. (Taric keeps its own leading [Shield]; only the granted copy is cut.)
  for (const kwName of ['assault', 'shield'] as const) {
    if (!kw[kwName]) continue
    const ungranted = text.replace(new RegExp(`\\b(?:units[^.\\[]*?have|give (?:it|them))\\s+\\[${kwName}[^\\]]*\\]`, 'gi'), '')
    if (!new RegExp(`\\[${kwName}[^\\]]*\\]`, 'i').test(ungranted)) kw[kwName] = 0
  }
  cache.set(card.id, kw)
  return kw
}

/** Keywords active for a card given its controller's XP. A keyword token that
 *  appears AFTER a [Level N] marker is gated — it only applies while xp >= N
 *  (e.g. Master Yi - Tempered: "[Level 6] I have [Deflect] and [Ganking]"). The
 *  [Level N] markers themselves and any keywords before the first one always
 *  apply. */
export function keywordsAt(card: Card | undefined, xp: number): Keywords {
  if (!card) return EMPTY
  const text = card.text ?? ''
  if (!/\[level\s*\d+\]/i.test(text)) return parseKeywords(card) // no level gating
  const kw: Keywords = { ...EMPTY }
  let gate = 0
  const re = /\[([A-Za-z][A-Za-z'-]*)\s*(\d+|X)?\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase()
    const num = m[2] === 'X' ? 1 : m[2] ? parseInt(m[2], 10) : 0
    if (name === 'level') {
      gate = num || 1 // subsequent keywords (until the next [Level]) need this XP
      applyKeywordToken(kw, name, num) // record the Level keyword itself
      continue
    }
    if (gate > xp) continue // gated keyword not yet active
    applyKeywordToken(kw, name, num)
  }
  return kw
}

export function keywordsOf(cardId: string): Keywords {
  return parseKeywords(getCard(cardId))
}

/** The continuous bonus a unit's [Level N] grants while its controller has
 *  enough XP. We model the common passive forms: "+X Might" and "enter ready".
 *  (Effect-upgrade Levels on spells — "do Z instead" — are not auto-parsed.) */
export function levelBonus(card: Card | undefined, xp: number): { might: number; ready: boolean; active: boolean; threshold: number } {
  const k = parseKeywords(card)
  if (!card || k.level <= 0) return { might: 0, ready: false, active: false, threshold: 0 }
  const active = xp >= k.level
  if (!active) return { might: 0, ready: false, active: false, threshold: k.level }
  const text = card.text ?? ''
  // Isolate the [Level N] … clause so we don't read the base text's Might.
  const seg = text.slice(text.search(/\[level\s*\d+\]/i))
  const mM = seg.match(/\+(\d+)\s*(?::rb_might:|might)/i)
  return {
    might: mM ? parseInt(mM[1], 10) : 0,
    ready: /enter(?:s)? ready/i.test(seg),
    active: true,
    threshold: k.level,
  }
}

/** The optional Accelerate cost (paid to have a unit enter READY), parsed from
 *  the reminder text, e.g. "[Accelerate] (You may pay :rb_energy_1::rb_rune_fury:
 *  …)". Returns null if the card has no Accelerate keyword / parseable cost. */
export function accelerateCost(card: Card | undefined): KeywordCost | null {
  if (!card || !parseKeywords(card).accelerate) return null
  const text = card.text ?? ''
  // The parenthetical right after the [Accelerate] tag holds the extra cost.
  const m = text.match(/\[accelerate\][^()]*\(([^)]*)\)/i)
  const seg = m ? m[1] : text
  let energy = 0
  const power: Partial<Record<Domain, number>> = {}
  const eM = seg.match(/:rb_energy_(\d+):/)
  if (eM) energy = parseInt(eM[1], 10)
  for (const rm of seg.matchAll(/:rb_rune_([a-z]+):/gi)) {
    const d = rm[1].toLowerCase() as Domain
    power[d] = (power[d] ?? 0) + 1
  }
  if (energy === 0 && Object.keys(power).length === 0) return null
  return { energy, power }
}

/** The optional [Repeat] cost (paid to resolve a spell's effect again), parsed
 *  from the cost tokens between the tag and its reminder text, e.g.
 *  "[Repeat] :rb_energy_2::rb_rune_fury: (You may pay…)". Null if no Repeat. */
export function repeatCost(card: Card | undefined): KeywordCost | null {
  if (!card || !parseKeywords(card).repeat) return null
  const text = card.text ?? ''
  // Read the cost glyphs that sit between [Repeat] and the opening parenthesis.
  const m = text.match(/\[repeat\]([^(]*)/i)
  const seg = m ? m[1] : ''
  let energy = 0
  const power: Partial<Record<Domain, number>> = {}
  const eM = seg.match(/:rb_energy_(\d+):/)
  if (eM) energy = parseInt(eM[1], 10)
  for (const rm of seg.matchAll(/:rb_rune_([a-z]+):/gi)) {
    const d = rm[1].toLowerCase() as Domain
    power[d] = (power[d] ?? 0) + 1
  }
  if (energy === 0 && Object.keys(power).length === 0) return null
  return { energy, power }
}

/** One-line rules definitions for keyword tooltips. Keyed by the bare keyword
 *  name (lowercased, no number) so a label like "Shield 2" still resolves. */
export const KEYWORD_DEFS: Record<string, string> = {
  tank: 'Must be assigned lethal damage before other (non-Tank) defenders.',
  shield: 'Has +X Might while defending in a showdown.',
  assault: 'Has +X Might while attacking in a showdown.',
  deathknell: 'Triggers an effect when it is defeated.',
  accelerate: 'Enters play ready (not exhausted) — can act the turn it arrives.',
  ambush: 'May be played at Reaction speed to a battlefield you contest.',
  deflect: 'Costs enemies X more to target it with spells or abilities.',
  ganking: 'May move directly from one battlefield to another.',
  hidden: 'May be placed facedown at a battlefield you control.',
  hunt: 'Grants X XP when it conquers or holds.',
  legion: 'Gains a bonus if you have already played another card this turn.',
  level: 'Gains a buff while you have at least X XP.',
  'quick-draw': 'Reaction-speed gear that attaches the moment it is played.',
  reaction: 'May be played during a Closed State (in response, on the chain).',
  action: 'May be played during an Open State, such as a showdown.',
  vision: 'Look at / filter the top of your deck when it is played.',
  predict: 'Look at the top card of your Main Deck; you may recycle it.',
  weaponmaster: 'Automatically attaches an equipment when it enters play.',
  backline: 'Does not fight on the frontline (deals/takes no showdown damage).',
  temporary: 'Is defeated at the start of your next turn.',
  equip: 'Gear that attaches to a unit, granting its bonuses.',
  repeat: 'You may pay an additional cost to resolve this spell\'s effect again.',
}

/** Resolve a definition for a keyword chip label (e.g. "Shield 2" → shield). */
export function keywordDef(label: string): string | undefined {
  return KEYWORD_DEFS[label.toLowerCase().replace(/\s*\d+$/, '')]
}

/** Human-readable keyword chips for UI display. */
export function keywordLabels(card: Card | undefined): string[] {
  const k = parseKeywords(card)
  const out: string[] = []
  if (k.tank) out.push('Tank')
  if (k.shield) out.push(`Shield ${k.shield}`)
  if (k.assault) out.push(`Assault ${k.assault}`)
  if (k.deathknell) out.push('Deathknell')
  if (k.accelerate) out.push('Accelerate')
  if (k.ambush) out.push('Ambush')
  if (k.deflect) out.push(`Deflect ${k.deflect}`)
  if (k.ganking) out.push('Ganking')
  if (k.hidden) out.push('Hidden')
  if (k.hunt) out.push(`Hunt ${k.hunt}`)
  if (k.legion) out.push('Legion')
  if (k.level) out.push(`Level ${k.level}`)
  if (k.quickDraw) out.push('Quick-Draw')
  if (k.reaction) out.push('Reaction')
  if (k.action) out.push('Action')
  if (k.vision) out.push('Vision')
  if (k.predict) out.push('Predict')
  if (k.weaponmaster) out.push('Weaponmaster')
  if (k.backline) out.push('Backline')
  if (k.temporary) out.push('Temporary')
  if (k.equip) out.push('Equip')
  if (k.repeat) out.push('Repeat')
  return out
}
