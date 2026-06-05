import type { OverrideOp } from '../engine/types'
import { DOMAINS, DOMAIN_META } from '../types/cards'
import { TRIGGER_EVENTS } from '../engine/triggers'
import { KEYWORD_DEFS } from '../engine/keywords'

// Controlled vocabularies for the card-spec "intended use" editor. The whole point:
// keep the form's options in sync with the engine so a spec maps 1:1 to a handler,
// AND ground the action list in the manual-override catalog — the override mode is
// the whole game expressed as atomic, executable ops, so every action here carries
// the ParsedEffect field it maps to (engine translation) AND the override op it can
// be executed by (live "apply in sandbox" + dry-run). This makes the list both
// exhaustive (covers recall/move/marker/zone+trash interactions the text-parser
// doesn't model) and executable.

export type ActionGroup = 'unit' | 'might' | 'player' | 'token' | 'zone' | 'trash'

export interface ActionDef {
  /** Canonical spec effect key. */
  key: string
  label: string
  group: ActionGroup
  /** The `ParsedEffect` field this maps to (engine text-parser), if any. */
  parsedKey?: string
  /** The executable override op (or action type) this maps to, if any. */
  op?: OverrideOp | string
  takesAmount?: boolean
  /** Amount may be negative (e.g. tempMight debuff). */
  signed?: boolean
  takesTarget?: boolean
  /** Named sub-fields this effect needs (rendered inline by EffectRow). */
  sub?: string[]
  hint?: string
}

// The canonical effect catalog = ParsedEffect keys ∪ OverrideOp ops ∪ discard/zone
// interactions, each annotated with its engine-parser key and its executable op.
export const ACTION_CATALOG: ActionDef[] = [
  // --- damage / removal (unit) ---
  { key: 'damage', label: 'Deal damage', group: 'unit', parsedKey: 'damage', op: 'damage', takesAmount: true, takesTarget: true, sub: ['basedOn'] },
  { key: 'setDamage', label: 'Set damage to', group: 'unit', op: 'setDamage', takesAmount: true, takesTarget: true },
  { key: 'kill', label: 'Kill', group: 'unit', parsedKey: 'kill', op: 'kill', takesTarget: true, sub: ['mightMax'] },
  { key: 'sacrifice', label: 'Sacrifice (ignore shields)', group: 'unit', op: 'sacrifice', takesTarget: true },
  { key: 'banish', label: 'Banish', group: 'unit', parsedKey: 'banishOnDeath', op: 'banish', takesTarget: true },
  { key: 'cullEachPlayer', label: 'Each player kills one', group: 'unit', parsedKey: 'cullEachPlayer' },
  { key: 'strikeDown', label: 'Strike down (deal Might, then detach)', group: 'unit', parsedKey: 'strikeDown', takesTarget: true },
  { key: 'stun', label: 'Stun', group: 'unit', parsedKey: 'stun', op: 'stun', takesAmount: true, takesTarget: true, sub: ['ifStunned'] },
  // --- Might (permanent buff vs this-turn) ---
  { key: 'buff', label: 'Buff (permanent +1 Might counter)', group: 'might', parsedKey: 'buff', op: 'buff', takesAmount: true, takesTarget: true, sub: ['scope'] },
  { key: 'unbuff', label: 'Remove buff', group: 'might', op: 'unbuff', takesAmount: true, takesTarget: true },
  { key: 'tempMight', label: 'Might this turn (±)', group: 'might', parsedKey: 'tempMight', op: 'setTempMight', takesAmount: true, signed: true, takesTarget: true, sub: ['scope', 'tag', 'floor'] },
  { key: 'spendBuff', label: 'Spend a buff (cost)', group: 'might', parsedKey: 'spendBuff', op: 'unbuff' },
  // --- ready / exhaust / move ---
  { key: 'ready', label: 'Ready (un-exhaust)', group: 'unit', parsedKey: 'readyUnits', op: 'ready', takesAmount: true, takesTarget: true },
  { key: 'readyAll', label: 'Ready all your units', group: 'unit', parsedKey: 'readyAllUnits', op: 'readyAll' },
  { key: 'exhaust', label: 'Exhaust', group: 'unit', op: 'exhaust', takesTarget: true },
  { key: 'bounce', label: 'Return to hand (Retreat)', group: 'zone', parsedKey: 'bounce', op: 'move', takesTarget: true, sub: ['scope'] },
  { key: 'recall', label: 'Recall to base (exhaust)', group: 'zone', parsedKey: 'moveToBase', op: 'toBase', takesTarget: true },
  { key: 'moveUnit', label: 'Move to a battlefield', group: 'zone', parsedKey: 'moveUnit', op: 'move', takesTarget: true },
  // --- keyword grants (this turn) + manual statuses ---
  { key: 'grantAssault', label: 'Grant [Assault N] (this turn)', group: 'unit', parsedKey: 'grantAssault', op: 'grant', takesAmount: true, takesTarget: true },
  { key: 'grantGanking', label: 'Grant [Ganking] (this turn)', group: 'unit', parsedKey: 'grantGanking', op: 'grant', takesTarget: true },
  { key: 'grantKeyword', label: 'Grant keyword (temporary/shield/…)', group: 'unit', op: 'grant', takesTarget: true, sub: ['keyword'] },
  { key: 'marker', label: 'Set status marker', group: 'unit', op: 'marker', takesTarget: true },
  { key: 'setFacedown', label: 'Set facedown / reveal', group: 'unit', op: 'grant', takesTarget: true },
  { key: 'revealFacedown', label: 'Reveal a hidden card', group: 'zone', op: 'revealFacedown', takesTarget: true },
  { key: 'triggerEnterPlay', label: 'Re-fire enter-play effect', group: 'unit', op: 'triggerEnterPlay', takesTarget: true },
  { key: 'deathShield', label: 'Death-shield (heal/recall instead of dying)', group: 'unit', parsedKey: 'deathShield', op: 'grant', takesTarget: true },
  // --- card flow (player) ---
  { key: 'draw', label: 'Draw', group: 'player', parsedKey: 'draw', op: 'draw', takesAmount: true, sub: ['perBattlefield'] },
  { key: 'discard', label: 'Discard', group: 'player', parsedKey: 'discard', op: 'move', takesAmount: true },
  { key: 'channel', label: 'Channel runes', group: 'player', parsedKey: 'channel', op: 'channel', takesAmount: true },
  { key: 'channelExhausted', label: 'Channel runes (exhausted)', group: 'player', parsedKey: 'channelExhausted', op: 'channelExhausted', takesAmount: true },
  { key: 'readyRunes', label: 'Ready runes', group: 'player', parsedKey: 'readyRunes', op: 'channel', takesAmount: true },
  { key: 'gainXp', label: 'Gain XP', group: 'player', parsedKey: 'gainXp', op: 'xp', takesAmount: true },
  { key: 'score', label: 'Score points', group: 'player', parsedKey: 'score', op: 'points', takesAmount: true },
  { key: 'addEnergy', label: 'Add Energy', group: 'player', op: 'energy', takesAmount: true },
  { key: 'addPower', label: 'Add Power (domain)', group: 'player', op: 'power', takesAmount: true, sub: ['domain'] },
  // --- tokens ---
  { key: 'recruits', label: 'Play Recruit token(s)', group: 'token', parsedKey: 'recruits', op: 'spawn', takesAmount: true, sub: ['here'] },
  { key: 'goldTokens', label: 'Play Gold gear token(s)', group: 'token', parsedKey: 'goldTokens', op: 'spawn', takesAmount: true },
  { key: 'namedToken', label: 'Play named token (Sprite/Sand Soldier/…)', group: 'token', parsedKey: 'namedToken', op: 'spawn', sub: ['name', 'count', 'exhausted', 'temporary', 'here'] },
  { key: 'spawn', label: 'Create any card', group: 'token', op: 'spawn', sub: ['cardId', 'zone'] },
  // --- zone / trash / deck (the "discard pile interactions and such") ---
  { key: 'returnFromTrash', label: 'Return from trash to hand', group: 'trash', parsedKey: 'returnFromTrash', op: 'move', sub: ['type', 'count'] },
  { key: 'playUnitFromTrash', label: 'Play a unit from trash', group: 'trash', parsedKey: 'playUnitFromTrash', op: 'move', sub: ['maxEnergy', 'energyOnly'] },
  { key: 'playSpellFromTrash', label: 'Play a spell from trash', group: 'trash', parsedKey: 'playSpellFromTrash', op: 'move' },
  { key: 'recycleRune', label: 'Recycle a rune', group: 'trash', op: 'RECYCLE_RUNE' },
  { key: 'mill', label: 'Mill (deck → trash)', group: 'trash', op: 'mill', takesAmount: true },
  { key: 'moveToZone', label: 'Move a card to a zone', group: 'zone', op: 'move', takesTarget: true, sub: ['zone', 'position'] },
  { key: 'shuffle', label: 'Shuffle deck', group: 'zone', op: 'shuffle' },
  { key: 'tutorFromDeck', label: 'Search deck → fetch (then shuffle)', group: 'zone', parsedKey: 'revealPlayFromDeck', op: 'tutorShuffle', sub: ['to'] },
  { key: 'peekDraw', label: 'Look at top N → reveal+draw one', group: 'zone', parsedKey: 'peekDraw', sub: ['n', 'type', 'energyMin'] },
  { key: 'peekToHand', label: 'Look at top N → one to hand', group: 'zone', parsedKey: 'peekToHand', sub: ['n'] },
  { key: 'peekBanishPlay', label: 'Reveal top N → banish+play one', group: 'zone', parsedKey: 'peekBanishPlay', sub: ['n', 'from', 'discount', 'here'] },
  { key: 'setController', label: 'Set battlefield controller', group: 'zone', op: 'setController' },
  // --- escape hatch ---
  { key: 'other', label: 'Other / manual (describe in note)', group: 'unit' },
]

export const KINDS = ['keyword', 'triggered', 'activated', 'static', 'play', 'modal', 'replacement'] as const
export const TARGET_SCOPES = ['none', 'self', 'friendly', 'enemy', 'any'] as const
export const TARGET_ZONES = ['anywhere', 'battlefield', 'base', 'hand', 'deck', 'trash'] as const
export const DURATIONS = ['permanent', 'thisTurn', 'thisCombat', 'static'] as const
export const TRIGGER_SCOPES = ['self', 'global'] as const

// Trigger options for the form = engine TriggerEvent union + end-of-turn (handled by
// endOfTurnEffect) + battlefield here-scoped variants.
export const TRIGGER_OPTIONS: string[] = [
  ...TRIGGER_EVENTS,
  'endOfTurn',
  'conquer-here', 'hold-here', 'defend-here', 'unit-moves-from-here',
]

// Condition kinds (card-grammar §3): the 9 engine-wired ones + the high-value gaps.
export const CONDITION_KINDS = [
  'handAtMost', 'handAtLeast', 'unitsHereAtLeast', 'xpAtLeast', 'excessAtLeast',
  'controlsTribe', 'allTribeTags', 'wasMighty', 'diedAlone', 'diedNotAlone',
  'targetHasNoBuff', 'targetMightAtLeast', 'playedCardThisTurn', 'forEach', 'while', 'unless',
] as const

// Cost components (mirror the OverridePanel / activated-ability cost model).
export const COST_KINDS = ['energy', 'power', 'exhaustSelf', 'recycleRunes', 'recycleTrash', 'killThis', 'discard', 'spendBuff'] as const

// Keyword catalog from the engine (label + reminder text + whether it takes an N).
const N_KEYWORDS = new Set(['shield', 'assault', 'deflect', 'hunt', 'level'])
export interface KeywordDef { key: string; label: string; reminder: string; takesN: boolean }
export const KEYWORDS: KeywordDef[] = Object.entries(KEYWORD_DEFS).map(([key, reminder]) => ({
  key,
  label: key.replace(/(^|[\s-])\w/g, (c) => c.toUpperCase()),
  reminder,
  takesN: N_KEYWORDS.has(key),
}))

// Domains (+ wild) for cost power pips and rune produces.
export const DOMAIN_OPTIONS: { v: string; label: string }[] = [
  ...DOMAINS.map((d) => ({ v: d, label: DOMAIN_META[d].label })),
  { v: 'wild', label: 'Wild' },
]

/** Look up an action by key. */
export function actionDef(key: string): ActionDef | undefined {
  return ACTION_CATALOG.find((a) => a.key === key)
}
