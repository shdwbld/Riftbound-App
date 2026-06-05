import { getSupabase, supabaseEnabled } from '../net/supabase'
import type { Action, GameEvent, MatchState } from '../engine/types'

// Bug-capture: snapshot a buggy moment ({pre → action → post → events}) to the
// `bug_reports` Supabase table (supabase/migrations/0002_bug_reports.sql) so it can
// be reproduced and exported as a vitest fixture. No-op-safe when Supabase is off.

export const bugCaptureEnabled = supabaseEnabled

export interface BugReportInput {
  note: string
  severity: 'low' | 'med' | 'high'
  mode: 'hotseat' | 'online'
  seq?: number | null
  preState?: MatchState | null
  action?: Action | null
  postState: MatchState
  events?: GameEvent[] | null
  invariants?: string[] | null
  appVersion?: string | null
}

export interface BugReportRow {
  id: string
  created_at: string
  note: string | null
  severity: string | null
  mode: string | null
  seq: number | null
  pre_state: MatchState | null
  action: Action | null
  post_state: MatchState | null
  events: GameEvent[] | null
  invariants: string[] | null
  app_version: string | null
}

/** File a bug; returns its new id. Throws if Supabase isn't configured. */
export async function submitBugReport(input: BugReportInput): Promise<string> {
  if (!supabaseEnabled) throw new Error('Bug capture needs Supabase to be configured.')
  const sb = getSupabase()
  const { data, error } = await sb
    .from('bug_reports')
    .insert({
      note: input.note,
      severity: input.severity,
      mode: input.mode,
      seq: input.seq ?? null,
      pre_state: input.preState ?? null,
      action: input.action ?? null,
      post_state: input.postState,
      events: input.events ?? null,
      invariants: input.invariants ?? null,
      app_version: input.appVersion ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

/** All reports, newest first (capped). Empty when Supabase is off. */
export async function listBugReports(): Promise<BugReportRow[]> {
  if (!supabaseEnabled) return []
  const sb = getSupabase()
  const { data, error } = await sb
    .from('bug_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return (data ?? []) as BugReportRow[]
}

/** One report by id, or null. */
export async function getBugReport(id: string): Promise<BugReportRow | null> {
  if (!supabaseEnabled) return null
  const sb = getSupabase()
  const { data, error } = await sb.from('bug_reports').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as BugReportRow) ?? null
}

/** Permanently delete a report. */
export async function deleteBugReport(id: string): Promise<void> {
  if (!supabaseEnabled) return
  const sb = getSupabase()
  const { error } = await sb.from('bug_reports').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
