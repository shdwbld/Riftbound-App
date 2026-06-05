import { useEffect, useMemo, useState } from 'react'
import { listBugReports, deleteBugReport, bugCaptureEnabled, type BugReportRow } from '../lib/bugReport'

// Admin review of captured bugs: list → inspect the snapshot (action / events /
// invariants / pre→post summary) → export a runnable vitest fixture that replays
// the captured action.

/** Build a paste-able vitest test that replays a captured {pre_state, action}. */
function toFixture(r: BugReportRow): string | null {
  if (!r.pre_state || !r.action) return null
  const pre = JSON.stringify(r.pre_state, null, 2)
  const act = JSON.stringify(r.action, null, 2)
  const note = (r.note ?? '').replace(/\s+/g, ' ').slice(0, 200)
  return `import { describe, it, expect } from 'vitest'
import { reduce } from '../engine/engine'
import type { MatchState, Action } from '../engine/types'

// Captured bug ${r.id}${note ? ' — ' + note : ''}
const preState = ${pre} as unknown as MatchState
const action = ${act} as unknown as Action

describe('bug ${r.id.slice(0, 8)}', () => {
  it('replays the captured action without an engine error', () => {
    const { error } = reduce(preState, action)
    expect(error).toBeFalsy()
    // TODO: assert the expected post-state / events for this bug.
  })
})
`
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

const sevColor: Record<string, string> = {
  high: 'bg-rose-500/30 text-rose-200',
  med: 'bg-amber-500/30 text-amber-200',
  low: 'bg-white/10 text-white/50',
}

export default function BugReportsPage() {
  const [rows, setRows] = useState<BugReportRow[]>([])
  const [sel, setSel] = useState<BugReportRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = () => {
    setLoading(true)
    setErr(null)
    listBugReports()
      .then((r) => setRows(r))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const fixture = useMemo(() => (sel ? toFixture(sel) : null), [sel])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">🐞 Bug reports</h1>
        <span className="text-xs text-white/40">{rows.length}</span>
        <button onClick={load} className="ml-auto rounded bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20">Refresh</button>
      </div>

      {!bugCaptureEnabled && (
        <div className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">
          Supabase isn't configured — bug reports can't be loaded or saved.
        </div>
      )}
      {err && <div className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">{err}</div>}
      {loading && <div className="text-white/40">Loading…</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* List */}
        <div className="space-y-1">
          {rows.map((r) => (
            <button
              key={r.id}
              onClick={() => { setSel(r); setCopied(false) }}
              className={`block w-full rounded-lg border px-3 py-2 text-left ${sel?.id === r.id ? 'border-amber-400/60 bg-amber-500/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${sevColor[r.severity ?? 'low'] ?? sevColor.low}`}>{r.severity ?? '—'}</span>
                <span className="text-[11px] text-white/40">{r.mode}</span>
                <span className="ml-auto text-[11px] text-white/30">{new Date(r.created_at).toLocaleString()}</span>
              </div>
              <div className="mt-1 truncate text-sm text-white/80">{r.note || <span className="text-white/30">(no note)</span>}</div>
              {(r.invariants?.length ?? 0) > 0 && <div className="mt-0.5 text-[11px] text-rose-300">⚠ {r.invariants!.length} invariant violation(s)</div>}
            </button>
          ))}
          {!loading && rows.length === 0 && <div className="text-white/30">No bug reports yet.</div>}
        </div>

        {/* Detail */}
        {sel && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${sevColor[sel.severity ?? 'low'] ?? sevColor.low}`}>{sel.severity ?? '—'}</span>
              <span className="text-xs text-white/40">{sel.mode} · seq {sel.seq ?? '—'} · {new Date(sel.created_at).toLocaleString()}</span>
              <button
                onClick={async () => { await deleteBugReport(sel.id); setSel(null); load() }}
                className="ml-auto rounded bg-rose-500/20 px-2 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/40"
              >
                Delete
              </button>
            </div>
            <div className="text-sm text-white/80">{sel.note || <span className="text-white/30">(no note)</span>}</div>

            {(sel.invariants?.length ?? 0) > 0 && (
              <div className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-200">
                <div className="font-semibold">⚠ Invariant violations</div>
                <ul className="ml-4 list-disc">{sel.invariants!.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
            )}

            <Section title="Action">
              <pre className="overflow-x-auto text-[11px] text-emerald-200">{JSON.stringify(sel.action, null, 2)}</pre>
            </Section>
            <Section title={`Events (${sel.events?.length ?? 0})`}>
              <div className="text-[11px] text-white/60">{(sel.events ?? []).map((e) => e.kind).join(', ') || '—'}</div>
            </Section>
            <Section title="Post-state summary">
              <div className="text-[11px] text-white/60">
                {sel.post_state ? `turn ${sel.post_state.turn} · ${sel.post_state.phase} · active P${sel.post_state.activePlayer} · points ${sel.post_state.players.map((p) => p.points).join('–')}` : '—'}
              </div>
            </Section>

            <div className="flex flex-wrap gap-2 pt-1">
              {fixture ? (
                <>
                  <button
                    onClick={async () => { await navigator.clipboard.writeText(fixture); setCopied(true) }}
                    className="rounded bg-amber-500/80 px-3 py-1.5 text-sm font-bold text-black hover:bg-amber-400"
                  >
                    {copied ? 'Copied ✓' : 'Copy fixture'}
                  </button>
                  <button
                    onClick={() => download(`bug-${sel.id.slice(0, 8)}.test.ts`, fixture)}
                    className="rounded bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20"
                  >
                    Download .test.ts
                  </button>
                </>
              ) : (
                <span className="text-xs text-white/40">No pre-state/action captured — can't generate a replay fixture.</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-white/40">{title}</div>
      <div className="mt-0.5 max-h-48 overflow-y-auto rounded bg-black/30 p-2">{children}</div>
    </div>
  )
}
