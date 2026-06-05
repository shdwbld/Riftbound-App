import { getSupabase, supabaseEnabled } from '../net/supabase'

// Card-spec / coverage sheet persistence: per-card structured "intended use" +
// a verification status, stored in `card_specs` (supabase/migrations/0003).
// No-op-safe when Supabase is off (the page falls back to read-only).

export type SpecStatus = 'works' | 'unsure' | 'broken' | 'untested'

export interface SpecAbility {
  target?: string
  cost?: string
  rune?: string
  additionalCost?: string
  effect?: string
  secondary?: string
  conditions?: string
}

export interface CardSpec {
  primary: SpecAbility & { trigger?: string }
  actives: SpecAbility[]
  passives: SpecAbility[]
  comments: string
}

export interface CardSpecRow {
  card_id: string
  name: string | null
  spec: CardSpec | null
  status: SpecStatus
  updated_at: string
}

export const cardSpecsEnabled = supabaseEnabled

export const emptySpec = (): CardSpec => ({ primary: {}, actives: [], passives: [], comments: '' })

/** Load all specs into a Map keyed by card_id. Empty when Supabase is off. */
export async function listCardSpecs(): Promise<Map<string, CardSpecRow>> {
  if (!supabaseEnabled) return new Map()
  const sb = getSupabase()
  const { data, error } = await sb.from('card_specs').select('*')
  if (error) throw new Error(error.message)
  const m = new Map<string, CardSpecRow>()
  for (const r of (data ?? []) as CardSpecRow[]) m.set(r.card_id, r)
  return m
}

/** Insert-or-update a card's spec + status (last-write-wins). */
export async function upsertCardSpec(row: { card_id: string; name: string; spec: CardSpec; status: SpecStatus }, nowIso: string): Promise<void> {
  if (!supabaseEnabled) throw new Error('Supabase not configured.')
  const sb = getSupabase()
  const { error } = await sb.from('card_specs').upsert({ ...row, updated_at: nowIso }, { onConflict: 'card_id' })
  if (error) throw new Error(error.message)
}
