import { useEffect, useMemo, useState } from 'react'
import { CARDS } from '../data/cards'
import type { Card } from '../types/cards'
import CardDetailModal from '../components/CardDetailModal'
import CardSpecEditor from '../components/CardSpecEditor'
import {
  listCardSpecs,
  upsertCardSpec,
  emptySpec,
  cardSpecsEnabled,
  type CardSpec,
  type CardSpecRow,
  type SpecStatus,
} from '../lib/cardSpecs'
import { summarizeSpec, exportAllSpecs } from '../lib/cardIntent'

// The card-spec / coverage sheet: every card (incl. battlefields/legends/runes)
// with a view button, the expanded card view, a structured editable "intended
// use", and a verification status — persisted to Supabase, editable by anyone.

const STATUS_OPTS: { v: SpecStatus; label: string }[] = [
  { v: 'untested', label: '· Untested' },
  { v: 'works', label: '✅ Works' },
  { v: 'unsure', label: '❔ Unsure' },
  { v: 'broken', label: '❌ Broken' },
]
const STATUS_LABEL: Record<SpecStatus, string> = { untested: '· Untested', works: '✅ Works', unsure: '❔ Unsure', broken: '❌ Broken' }
const TYPES = ['all', 'unit', 'spell', 'gear', 'battlefield', 'legend', 'rune'] as const

const bare = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, '')

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function CardSpecPage() {
  const [specs, setSpecs] = useState<Map<string, CardSpecRow>>(new Map())
  const [q, setQ] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number]>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | SpecStatus>('all')
  const [inspect, setInspect] = useState<Card | null>(null)
  const [editing, setEditing] = useState<Card | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    listCardSpecs().then(setSpecs).catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  const statusOf = (id: string): SpecStatus => specs.get(id)?.status ?? 'untested'

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return CARDS.filter((c) => {
      if (type !== 'all' && c.type !== type) return false
      if (statusFilter !== 'all' && statusOf(c.id) !== statusFilter) return false
      if (needle && !(`${c.name} ${c.text ?? ''}`.toLowerCase().includes(needle))) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type, statusFilter, specs])

  const counts = useMemo(() => {
    const c: Record<SpecStatus, number> = { works: 0, unsure: 0, broken: 0, untested: 0 }
    for (const card of CARDS) c[statusOf(card.id)]++
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs])

  const save = async (card: Card, patch: { spec?: CardSpec; status?: SpecStatus }) => {
    const existing = specs.get(card.id)
    const spec = patch.spec ?? existing?.spec ?? emptySpec()
    const status = patch.status ?? existing?.status ?? 'untested'
    const nowIso = new Date().toISOString()
    const next = new Map(specs)
    next.set(card.id, { card_id: card.id, name: card.name, spec, status, updated_at: nowIso })
    setSpecs(next) // optimistic
    try {
      await upsertCardSpec({ card_id: card.id, name: card.name, spec, status }, nowIso)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const total = CARDS.length
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">📋 Card spec sheet</h1>
        <span className="text-xs text-white/40">{total} cards</span>
        <button onClick={() => download('card-specs.json', exportAllSpecs(specs, CARDS))} className="ml-auto rounded bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20">Export specs</button>
      </div>

      {/* Coverage summary */}
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="rounded-lg bg-emerald-500/15 px-3 py-1 text-emerald-200">✅ {counts.works} works ({pct(counts.works)}%)</span>
        <span className="rounded-lg bg-amber-500/15 px-3 py-1 text-amber-200">❔ {counts.unsure} unsure</span>
        <span className="rounded-lg bg-rose-500/15 px-3 py-1 text-rose-200">❌ {counts.broken} broken</span>
        <span className="rounded-lg bg-white/10 px-3 py-1 text-white/50">· {counts.untested} untested</span>
      </div>

      {!cardSpecsEnabled && (
        <div className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">Supabase isn't configured — specs are read-only and won't persist.</div>
      )}
      {err && <div className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-200">{err}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by name or text…"
          className="min-w-0 flex-1 rounded bg-black/30 px-3 py-1.5 text-sm outline-none placeholder:text-white/30"
        />
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="rounded bg-black/30 px-2 py-1.5 text-sm">
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | SpecStatus)} className="rounded bg-black/30 px-2 py-1.5 text-sm">
          <option value="all">all statuses</option>
          {STATUS_OPTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <span className="text-xs text-white/30">{filtered.length} shown</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wide text-white/40">
              <th className="w-16 p-2">View</th>
              <th className="p-2">Name</th>
              <th className="w-24 p-2">Type</th>
              <th className="p-2">Intended use</th>
              <th className="w-32 p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const row = specs.get(c.id)
              const summary = summarizeSpec(row?.spec ?? null)
              return (
                <tr key={c.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="p-2">
                    <button onClick={() => setInspect(c)} title="View card" className="block w-10 overflow-hidden rounded border border-white/15 bg-[#1c1c28]" style={{ aspectRatio: '744/1039' }}>
                      {c.imageUrl ? <img src={c.imageUrl} alt={c.name} loading="lazy" className="h-full w-full object-cover" /> : <span className="text-[7px] text-white/50">{bare(c.name)}</span>}
                    </button>
                  </td>
                  <td className="p-2">
                    <button onClick={() => setInspect(c)} className="text-left font-semibold text-white/85 hover:text-amber-200">{bare(c.name)}</button>
                  </td>
                  <td className="p-2 text-xs text-white/50">{c.type}</td>
                  <td className="p-2">
                    <button onClick={() => setEditing(c)} className="text-left text-xs text-white/70 hover:text-amber-200">
                      {summary ? <span>{summary} <span className="text-white/30">· edit</span></span> : <span className="text-amber-300/80">＋ Add intended use</span>}
                    </button>
                  </td>
                  <td className="p-2">
                    <select
                      value={statusOf(c.id)}
                      onChange={(e) => save(c, { status: e.target.value as SpecStatus })}
                      disabled={!cardSpecsEnabled}
                      className="rounded bg-black/30 px-1.5 py-1 text-xs"
                    >
                      {STATUS_OPTS.map((s) => <option key={s.v} value={s.v}>{STATUS_LABEL[s.v]}</option>)}
                    </select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
      {editing && (
        <CardSpecEditor
          card={editing}
          initial={specs.get(editing.id)?.spec ?? null}
          onSave={(spec) => save(editing, { spec })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
