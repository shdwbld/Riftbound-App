import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getCard } from '../data/cards'
import { getDeck, duplicateDeck, exportDeck } from '../lib/deckStorage'
import { shareDeck, deckShareEnabled } from '../lib/deckShare'
import { validateDeck } from '../lib/deckValidation'
import { computeStats, CURVE_MAX } from '../lib/deckStats'
import { type Card, DOMAIN_META, DOMAINS, totalCost } from '../types/cards'
import { type Deck, pileSize } from '../types/deck'
import CardText, { DomainIcon } from '../components/CardText'
import CardDetailModal from '../components/CardDetailModal'
import Donut, { type DonutSegment } from '../components/Donut'

const TYPE_COLOR: Record<string, string> = {
  unit: '#6366f1',
  spell: '#d946ef',
  gear: '#f59e0b',
  rune: '#10b981',
  battlefield: '#f43f5e',
  legend: '#a3a3a3',
}

export default function DeckOverviewPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const deck = useMemo(() => getDeck(id), [id])
  const [tab, setTab] = useState<'list' | 'stats'>('list')
  const [exporting, setExporting] = useState(false)
  const [inspect, setInspect] = useState<Card | null>(null)
  const [share, setShare] = useState<{ loading: boolean; code?: string; error?: string } | null>(null)

  if (!deck) {
    return (
      <div className="space-y-3">
        <p className="text-white/60">Deck not found.</p>
        <Link to="/decks" className="text-sky-400 hover:underline">
          ← Back to decks
        </Link>
      </div>
    )
  }

  const legend = deck.legendId ? getCard(deck.legendId) : undefined
  const champion = deck.championId ? getCard(deck.championId) : undefined
  const v = validateDeck(deck)
  const stats = computeStats(deck)

  const counts = stats.typeCounts
  const clone = () => {
    const copy = duplicateDeck(deck.id)
    if (copy) navigate(`/decks/${copy.id}`)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4 rounded-2xl border border-white/10 bg-[#0a1428] p-4">
        {legend?.imageUrl && (
          <img
            src={legend.imageUrl}
            alt={legend.name}
            className="h-32 w-[92px] shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/decks" className="text-white/40 hover:text-white">←</Link>
            <h2 className="truncate text-2xl font-bold">{deck.name}</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                v.isLegal ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
              }`}
            >
              {v.isLegal ? 'legal' : 'draft'}
            </span>
          </div>
          <div className="text-sm text-white/50">{legend ? legend.name : 'No legend'}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {v.identity.map((d) => (
              <span
                key={d}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: `${DOMAIN_META[d].color}33`, color: DOMAIN_META[d].color }}
              >
                <DomainIcon domain={d} /> {DOMAIN_META[d].label}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-white/50">
            <Meta label="Main" value={`${pileSize(deck.main)}/40`} />
            <Meta label="Units" value={counts.unit ?? 0} />
            <Meta label="Spells" value={counts.spell ?? 0} />
            <Meta label="Gear" value={counts.gear ?? 0} />
            <Meta label="Runes" value={`${pileSize(deck.runes)}/12`} />
            <Meta label="Battlefields" value={`${deck.battlefields.length}/3`} />
            <Meta label="Sideboard" value={pileSize(deck.sideboard)} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            onClick={() => navigate('/play', { state: { deckId: deck.id } })}
            disabled={pileSize(deck.main) === 0}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-semibold hover:bg-sky-400 disabled:opacity-40"
          >
            Test ▶
          </button>
          <button
            onClick={() => navigate(`/decks/${deck.id}/edit`)}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Edit
          </button>
          <button
            onClick={clone}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Clone
          </button>
          <button
            onClick={() => setExporting((x) => !x)}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Export
          </button>
          {deckShareEnabled && (
            <button
              onClick={async () => {
                setShare({ loading: true })
                try {
                  const code = await shareDeck(deck)
                  setShare({ loading: false, code })
                } catch (e) {
                  setShare({ loading: false, error: e instanceof Error ? e.message : 'Share failed.' })
                }
              }}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
            >
              🔗 Share
            </button>
          )}
        </div>
      </div>

      {exporting && <ExportPanel text={exportDeck(deck)} onClose={() => setExporting(false)} />}
      {share && (
        <div className="rounded-xl border border-sky-400/30 bg-sky-500/10 p-3 text-sm">
          {share.loading ? (
            <span className="text-white/60">Publishing deck…</span>
          ) : share.error ? (
            <span className="text-rose-300">⚠ {share.error}</span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-white/70">Share code:</span>
              <code className="rounded bg-black/40 px-2 py-1 font-mono text-lg font-bold tracking-widest text-sky-200">{share.code}</code>
              <button
                onClick={() => share.code && navigator.clipboard?.writeText(share.code)}
                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
              >
                Copy
              </button>
              <span className="text-xs text-white/40">Enter this on another device under “Load by code”.</span>
              <button onClick={() => setShare(null)} className="ml-auto rounded px-2 py-1 text-xs text-white/40 hover:bg-white/10">
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {/* Checklist (only when issues) */}
      {v.issues.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-[#0a1428] p-3">
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            {v.issues.map((iss, i) => (
              <li key={i} className={iss.level === 'error' ? 'text-rose-300' : 'text-amber-300/80'}>
                {iss.level === 'error' ? '✕' : '!'} {iss.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1">
        {(['list', 'stats'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition ${
              tab === t ? 'bg-sky-500/20 text-white' : 'text-white/50 hover:bg-white/5'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'list' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Column title="Legend">
            {legend ? <CardRow card={legend} onClick={() => setInspect(legend)} /> : <Empty />}
          </Column>
          <Column title="Champion">
            {champion ? (
              <CardRow card={champion} onClick={() => setInspect(champion)} />
            ) : (
              <p className="text-xs text-white/40">Auto-picked at game start.</p>
            )}
          </Column>
          <Column title={`Battlefields · ${deck.battlefields.length}/3`}>
            <Pile ids={deck.battlefields.map((b) => ({ id: b, n: 1 }))} onInspect={setInspect} />
          </Column>
          <Column title={`Main Deck · ${pileSize(deck.main)}/40`} className="md:col-span-2 xl:col-span-1">
            <GroupedPile pile={deck.main} onInspect={setInspect} />
          </Column>
          <Column title={`Runes · ${pileSize(deck.runes)}/12`}>
            <Pile ids={pileEntries(deck.runes)} onInspect={setInspect} />
          </Column>
          <Column title={`Sideboard · ${pileSize(deck.sideboard)}`}>
            {pileSize(deck.sideboard) === 0 ? <Empty /> : <Pile ids={pileEntries(deck.sideboard)} onInspect={setInspect} />}
          </Column>
        </div>
      ) : (
        <StatsView deck={deck} />
      )}

      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
    </div>
  )
}

// --- list helpers ----------------------------------------------------------

function pileEntries(pile: Record<string, number>): { id: string; n: number }[] {
  return Object.entries(pile)
    .map(([id, n]) => ({ id, n }))
    .filter(({ id }) => getCard(id))
    .sort((a, b) => totalCost(getCard(a.id)!) - totalCost(getCard(b.id)!) || getCard(a.id)!.name.localeCompare(getCard(b.id)!.name))
}

function Pile({ ids, onInspect }: { ids: { id: string; n: number }[]; onInspect: (c: Card) => void }) {
  if (ids.length === 0) return <Empty />
  return (
    <ul className="space-y-1">
      {ids.map(({ id, n }) => {
        const c = getCard(id)
        if (!c) return null
        return <CardRow key={id} card={c} qty={n} onClick={() => onInspect(c)} />
      })}
    </ul>
  )
}

function GroupedPile({ pile, onInspect }: { pile: Record<string, number>; onInspect: (c: Card) => void }) {
  const groups: { label: string; type: string }[] = [
    { label: 'Units', type: 'unit' },
    { label: 'Spells', type: 'spell' },
    { label: 'Gear', type: 'gear' },
  ]
  const entries = pileEntries(pile)
  if (entries.length === 0) return <Empty />
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const rows = entries.filter(({ id }) => getCard(id)!.type === g.type)
        if (rows.length === 0) return null
        const n = rows.reduce((a, r) => a + r.n, 0)
        return (
          <div key={g.type}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
              {g.label} · {n}
            </div>
            <Pile ids={rows} onInspect={onInspect} />
          </div>
        )
      })}
    </div>
  )
}

function CardRow({ card, qty, onClick }: { card: Card; qty?: number; onClick?: () => void }) {
  return (
    <li className="list-none">
      <button
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-lg border border-white/5 bg-black/20 p-1 pr-2 text-left transition hover:border-white/20"
      >
        {card.imageUrl ? (
          <img src={card.imageUrl} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded object-cover" style={{ objectPosition: 'top' }} />
        ) : (
          <span className="h-9 w-9 shrink-0 rounded bg-white/10" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{card.name}</span>
          {card.text && (
            <span className="block truncate text-[10px] text-white/40">
              <CardText text={card.text} />
            </span>
          )}
        </span>
        {qty != null && qty > 1 && (
          <span className="shrink-0 rounded bg-sky-500/30 px-1.5 py-0.5 font-mono text-xs text-sky-200">×{qty}</span>
        )}
      </button>
    </li>
  )
}

function Column({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-[#0a1428] p-3 ${className ?? ''}`}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">{title}</h3>
      {children}
    </div>
  )
}

const Empty = () => <p className="text-xs text-white/30">Empty.</p>
const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <span className="rounded bg-white/5 px-1.5 py-0.5">
    {label} <b className="text-white/70">{value}</b>
  </span>
)

// --- stats view ------------------------------------------------------------

function StatsView({ deck }: { deck: Deck }) {
  const stats = computeStats(deck)
  const typeSegments: DonutSegment[] = Object.entries(stats.typeCounts).map(([t, n]) => ({
    label: t,
    value: n,
    color: TYPE_COLOR[t] ?? '#888',
  }))
  const domainSegments: DonutSegment[] = [
    ...DOMAINS.map((d) => ({ label: DOMAIN_META[d].label, value: stats.domainCounts[d], color: DOMAIN_META[d].color })),
    { label: 'Colorless', value: stats.colorless, color: '#6b7280' },
  ].filter((s) => s.value > 0)

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
        <CurveBars title={`Energy curve · avg ${stats.avgCost.toFixed(1)}`} data={stats.curve} color="bg-sky-500/70" />
      </div>
      <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
        <CurveBars title="Power curve (pips)" data={stats.powerCurve} color="bg-amber-500/70" />
      </div>
      <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
        <div className="mb-3 text-[10px] uppercase tracking-wide text-white/40">Card types</div>
        <Donut segments={typeSegments} />
      </div>
      <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
        <div className="mb-3 text-[10px] uppercase tracking-wide text-white/40">Domains (main + runes)</div>
        <Donut segments={domainSegments} />
      </div>
    </div>
  )
}

function CurveBars({ title, data, color }: { title: string; data: number[]; color: string }) {
  const peak = Math.max(1, ...data)
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-white/40">{title}</div>
      <div className="flex items-end gap-1.5" style={{ height: 96 }}>
        {data.map((n, cost) => (
          <div key={cost} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[9px] text-white/40">{n || ''}</span>
            <div className={`w-full rounded-t ${color}`} style={{ height: `${(n / peak) * 72}px` }} />
            <span className="text-[9px] text-white/40">{cost === CURVE_MAX ? `${cost}+` : cost}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ExportPanel({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-[#0a1428] p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/60">Deck code</p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(text)
              setCopied(true)
            }}
            className="rounded bg-sky-500 px-2 py-1 text-xs font-semibold hover:bg-sky-400"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/5">
            Close
          </button>
        </div>
      </div>
      <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-white/70">{text}</pre>
    </div>
  )
}
