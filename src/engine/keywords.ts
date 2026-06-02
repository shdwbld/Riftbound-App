import type { Card } from '../types/cards'
import { getCard } from '../data/cards'

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
  /** Auto-attach an equipment on entry. */
  weaponmaster: boolean
  /** Doesn't participate as a normal frontline combatant. */
  backline: boolean
  /** Killed at the start of the controller's next turn. */
  temporary: boolean
  /** Gear with an attach activation. */
  equip: boolean
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
  weaponmaster: false,
  backline: false,
  temporary: false,
  equip: false,
}

const cache = new Map<string, Keywords>()
const TOKEN = /\[([A-Za-z][A-Za-z'-]*)\s*(\d+|X)?\]/g

export function parseKeywords(card: Card | undefined): Keywords {
  if (!card) return EMPTY
  const hit = cache.get(card.id)
  if (hit) return hit

  const kw: Keywords = { ...EMPTY }
  const text = card.text ?? ''
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(text))) {
    const name = m[1].toLowerCase()
    const num = m[2] === 'X' ? 1 : m[2] ? parseInt(m[2], 10) : 0
    switch (name) {
      case 'tank':
        kw.tank = true
        break
      case 'shield':
        kw.shield = Math.max(kw.shield, num || 1)
        break
      case 'assault':
        kw.assault = Math.max(kw.assault, num || 1)
        break
      case 'deathknell':
        kw.deathknell = true
        break
      case 'accelerate':
        kw.accelerate = true
        break
      case 'ambush':
        kw.ambush = true
        break
      case 'deflect':
        kw.deflect = Math.max(kw.deflect, num || 1)
        break
      case 'ganking':
        kw.ganking = true
        break
      case 'hidden':
        kw.hidden = true
        break
      case 'hunt':
        kw.hunt = Math.max(kw.hunt, num || 1)
        break
      case 'legion':
        kw.legion = true
        break
      case 'level':
        kw.level = Math.max(kw.level, num || 1)
        break
      case 'quick-draw':
        kw.quickDraw = true
        break
      case 'reaction':
        kw.reaction = true
        break
      case 'action':
        kw.action = true
        break
      case 'vision':
        kw.vision = true
        break
      case 'weaponmaster':
        kw.weaponmaster = true
        break
      case 'backline':
        kw.backline = true
        break
      case 'temporary':
        kw.temporary = true
        break
      case 'equip':
        kw.equip = true
        break
    }
  }
  cache.set(card.id, kw)
  return kw
}

export function keywordsOf(cardId: string): Keywords {
  return parseKeywords(getCard(cardId))
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
  if (k.weaponmaster) out.push('Weaponmaster')
  if (k.backline) out.push('Backline')
  if (k.temporary) out.push('Temporary')
  if (k.equip) out.push('Equip')
  return out
}
