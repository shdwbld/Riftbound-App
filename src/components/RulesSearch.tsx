import { useEffect, useMemo, useRef, useState } from 'react'

// Searchable Core Rules (v1.2). A small bottom-left trigger opens a modal that does
// keyword search over the rulebook JSON (lazy-loaded so it stays out of the main
// bundle). Each hit shows its rule number + text with the query terms highlighted.

type Rule = { id: string; text: string }

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        terms.some((t) => t.toLowerCase() === p.toLowerCase())
          ? <mark key={i} className="rounded bg-amber-400/30 px-0.5 text-amber-100">{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </>
  )
}

export default function RulesSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState<Rule[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Lazy-load the rulebook the first time the panel opens.
  useEffect(() => {
    if (open && !rules) import('../data/rulebook.json').then((m) => setRules(m.default as Rule[]))
  }, [open, rules])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', onKey)
    setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])
  const results = useMemo(() => {
    if (!rules || !terms.length) return []
    const q = query.trim()
    const scored: { r: Rule; s: number }[] = []
    for (const r of rules) {
      const lt = r.text.toLowerCase()
      if (!terms.every((t) => lt.includes(t))) {
        // Allow searching by rule number directly (e.g. "302.1").
        if (!(q && r.id.startsWith(q))) continue
      }
      let s = 0
      if (r.id === q) s += 100
      else if (q && r.id.startsWith(q)) s += 40
      if (lt.startsWith(terms[0])) s += 5
      s += Math.max(0, 20 - r.text.length / 60) // prefer concise rules
      scored.push({ r, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 60).map((x) => x.r)
  }, [rules, terms, query])

  return (
    <>
      {/* Bottom-left trigger. */}
      <button
        onClick={() => setOpen(true)}
        title="Search the Core Rules (v1.2)"
        className="fixed bottom-3 left-3 z-[45] flex items-center gap-1.5 rounded-full border border-white/15 bg-[#0a1428]/90 px-3 py-2 text-xs font-semibold text-white/70 shadow-lg backdrop-blur-sm hover:bg-[#0a1428] hover:text-white"
      >
        📖 Rules
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 p-4 pt-[8vh]" onClick={() => setOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d111c] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-white/10 p-3">
              <span className="text-lg">📖</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the Core Rules — e.g. 'showdown', 'deflect', 'conquer', '302.1'…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-white/30"
              />
              <span className="text-[11px] text-white/30">Core Rules v1.2</span>
              <button onClick={() => setOpen(false)} className="text-white/40 hover:text-white">✕</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {!rules && <div className="p-6 text-center text-sm text-white/40">Loading rulebook…</div>}
              {rules && !terms.length && <div className="p-6 text-center text-sm text-white/40">Type to search {rules.length} rules.</div>}
              {rules && terms.length > 0 && results.length === 0 && <div className="p-6 text-center text-sm text-white/40">No matching rules.</div>}
              <ul className="space-y-2">
                {results.map((r, i) => (
                  <li key={`${r.id}-${i}`} className="rounded-lg bg-white/[0.03] p-2.5">
                    {r.id && <span className="mr-2 rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] text-sky-200">{r.id}</span>}
                    <span className="text-[13px] leading-snug text-white/80"><Highlight text={r.text} terms={terms} /></span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
