import { getSupabase, supabaseEnabled } from '../net/supabase'

// Card-spec / coverage sheet persistence + the v2 "ability-block grammar" data
// model (card-grammar.md §3-4): a card = identity + an ordered list of ability
// blocks, each block = { kind, trigger?, conditions[], cost?, effects[], target?,
// duration? } over controlled vocabularies (src/lib/cardSpecVocab.ts) that map 1:1
// to the engine + the manual-override catalog. Stored in `card_specs.spec` (jsonb).
// No-op-safe when Supabase is off.

export type SpecStatus = 'works' | 'unsure' | 'broken' | 'untested'
export type AbilityKind = 'keyword' | 'triggered' | 'activated' | 'static' | 'play' | 'modal' | 'replacement'
export type SpecTargetScope = 'none' | 'self' | 'friendly' | 'enemy' | 'any'
export type SpecTargetZone = 'anywhere' | 'battlefield' | 'base' | 'hand' | 'deck' | 'trash'
export type SpecDuration = 'permanent' | 'thisTurn' | 'thisCombat' | 'static'

export interface SpecTarget {
  scope: SpecTargetScope
  count: number
  zone?: SpecTargetZone
  filter?: string
}
export interface SpecCost {
  energy?: number
  power?: Record<string, number> // domain → pips (incl 'wild')
  exhaustSelf?: boolean
  recycleRunes?: number
  recycleTrash?: number
  killThis?: boolean
  discard?: number
  spendBuff?: boolean
  additional?: string
}
export interface SpecCondition {
  kind: string
  value?: number
  tag?: string
}
export interface SpecEffect {
  key: string // ACTION_CATALOG key
  amount?: number // signed for tempMight
  scope?: SpecTargetScope
  count?: number
  zone?: SpecTargetZone
  duration?: SpecDuration
  scaleBy?: string
  sub?: Record<string, string | number | boolean>
  op?: string // executable override op / action (from ACTION_CATALOG)
  note?: string
}
export interface AbilitySpec {
  kind: AbilityKind
  keyword?: string
  keywordN?: number
  trigger?: string
  triggerScope?: 'self' | 'global'
  optional?: boolean
  conditions?: SpecCondition[]
  cost?: SpecCost
  paidBonus?: boolean
  effects?: SpecEffect[]
  target?: SpecTarget
  branches?: { label?: string; effects: SpecEffect[]; target?: SpecTarget }[]
  oncePer?: 'turn' | 'game' | null
  rawText?: string
  status?: SpecStatus
  note?: string
  fromParser?: boolean
}
export interface CardSpec {
  cardType?: string
  produces?: string[]
  abilities: AbilitySpec[]
  comments: string
  prefilled?: boolean
}

export interface CardSpecRow {
  card_id: string
  name: string | null
  spec: CardSpec | null
  status: SpecStatus
  updated_at: string
}

export const cardSpecsEnabled = supabaseEnabled

export const emptySpec = (): CardSpec => ({ abilities: [], comments: '' })

/** Severity order for deriving a card-level status from its abilities. */
const STATUS_RANK: Record<SpecStatus, number> = { broken: 3, unsure: 2, untested: 1, works: 0 }

/** The worst (most concerning) status across a spec's abilities. */
export function derivedStatus(spec: CardSpec | null): SpecStatus {
  const ss = (spec?.abilities ?? []).map((a) => a.status).filter(Boolean) as SpecStatus[]
  if (ss.length === 0) return 'untested'
  return ss.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), 'works' as SpecStatus)
}

/** Upgrade any stored spec (incl. the legacy {primary,actives,passives} shape) to
 *  the v2 ability-block model. Never throws — unknown shapes become comments. */
export function normalizeSpec(raw: unknown): CardSpec {
  if (!raw || typeof raw !== 'object') return emptySpec()
  const r = raw as Record<string, unknown>
  if (Array.isArray(r.abilities)) {
    return {
      cardType: typeof r.cardType === 'string' ? r.cardType : undefined,
      produces: Array.isArray(r.produces) ? (r.produces as string[]) : undefined,
      abilities: r.abilities as AbilitySpec[],
      comments: typeof r.comments === 'string' ? r.comments : '',
      prefilled: !!r.prefilled,
    }
  }
  // Legacy {primary, actives[], passives[]} → best-effort abilities[].
  const abilities: AbilitySpec[] = []
  const legacyToAbility = (a: Record<string, unknown>, kind: AbilityKind): AbilitySpec => {
    const effects: SpecEffect[] = []
    for (const f of ['effect', 'secondary']) {
      const v = a[f]
      if (typeof v === 'string' && v.trim()) effects.push({ key: 'other', note: v })
    }
    const ab: AbilitySpec = { kind, effects }
    if (typeof a.trigger === 'string' && a.trigger) { ab.kind = 'triggered'; ab.trigger = a.trigger }
    if (typeof a.cost === 'string' && a.cost) ab.cost = { additional: a.cost }
    if (typeof a.target === 'string' && a.target) ab.target = { scope: 'any', count: 1, filter: a.target }
    if (typeof a.conditions === 'string' && a.conditions) ab.conditions = [{ kind: 'other', tag: a.conditions }]
    return ab
  }
  if (r.primary && typeof r.primary === 'object') abilities.push(legacyToAbility(r.primary as Record<string, unknown>, 'play'))
  for (const a of (Array.isArray(r.actives) ? r.actives : []) as Record<string, unknown>[]) abilities.push(legacyToAbility(a, 'activated'))
  for (const a of (Array.isArray(r.passives) ? r.passives : []) as Record<string, unknown>[]) abilities.push(legacyToAbility(a, 'static'))
  return { abilities, comments: typeof r.comments === 'string' ? r.comments : '' }
}

/** Load all specs into a Map keyed by card_id (spec normalized to v2). */
export async function listCardSpecs(): Promise<Map<string, CardSpecRow>> {
  if (!supabaseEnabled) return new Map()
  const sb = getSupabase()
  const { data, error } = await sb.from('card_specs').select('*')
  if (error) throw new Error(error.message)
  const m = new Map<string, CardSpecRow>()
  for (const r of (data ?? []) as CardSpecRow[]) m.set(r.card_id, { ...r, spec: normalizeSpec(r.spec) })
  return m
}

/** Insert-or-update a card's spec + status (last-write-wins). */
export async function upsertCardSpec(row: { card_id: string; name: string; spec: CardSpec; status: SpecStatus }, nowIso: string): Promise<void> {
  if (!supabaseEnabled) throw new Error('Supabase not configured.')
  const sb = getSupabase()
  const { error } = await sb.from('card_specs').upsert({ ...row, updated_at: nowIso }, { onConflict: 'card_id' })
  if (error) throw new Error(error.message)
}
