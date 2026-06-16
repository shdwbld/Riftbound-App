import { useEffect, useMemo, useState } from 'react'
import { CARDS } from '../data/cards'
import {
  type Card,
  type CardType,
  type Domain,
  type Rarity,
  DOMAINS,
  DOMAIN_META,
  isUnit,
  totalCost,
} from '../types/cards'
import CardTile from '../components/CardTile'
import { DomainIcon } from '../components/CardText'
import CardDetailModal from '../components/CardDetailModal'

const TYPES: CardType[] = ['unit', 'spell', 'gear', 'battlefield', 'legend', 'rune']
const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'showcase', 'promo']
const COSTS = [0, 1, 2, 3, 4, 5, 6, 7] as const // 7 == "7+"
const PAGE = 120 // cards rendered per "Load more" step

type SortKey = 'set' | 'name' | 'cost' | 'might'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'set', label: 'Set / number' },
  { key: 'name', label: 'Name' },
  { key: 'cost', label: 'Cost' },
  { key: 'might', label: 'Might' },
]

/** Density → minimum tile width for the auto-fill grid (more columns = denser). */
const DENSITY: { key: string; label: string; min: number }[] = [
  { key: 's', label: 'S', min: 118 },
  { key: 'm', label: 'M', min: 152 },
  { key: 'l', label: 'L', min: 196 },
]

function sortCards(cards: Card[], key: SortKey): Card[] {
  const arr = [...cards]
  switch (key) {
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
    case 'cost':
      return arr.sort((a, b) => totalCost(a) - totalCost(b) || a.name.localeCompare(b.name))
    case 'might':
      return arr.sort(
        (a, b) =>
          (isUnit(b) ? b.might : -1) - (isUnit(a) ? a.might : -1) ||
          a.name.localeCompare(b.name),
      )
    default:
      return arr.sort((a, b) => a.set.localeCompare(b.set) || a.number - b.number)
  }
}

const SETS = [...new Set(CARDS.map((c) => c.set))].sort()

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const n = new Set(set)
  if (n.has(v)) n.delete(v)
  else n.add(v)
  return n
}

export default function CardsPage() {
  const [query, setQuery] = useState('')
  const [domains, setDomains] = useState<Set<Domain>>(new Set())
  const [types, setTypes] = useState<Set<CardType>>(new Set())
  const [costs, setCosts] = useState<Set<number>>(new Set())
  const [rarities, setRarities] = useState<Set<Rarity>>(new Set())
  const [set, setSet] = useState<string | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('set')
  const [density, setDensity] = useState('m')
  const [limit, setLimit] = useState(PAGE)
  const [detail, setDetail] = useState<Card | null>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = CARDS.filter((c) => {
      if (domains.size && !c.domains.some((d) => domains.has(d))) return false
      if (types.size && !types.has(c.type)) return false
      if (costs.size) {
        const c0 = totalCost(c)
        if (!costs.has(c0 >= 7 ? 7 : c0)) return false
      }
      if (rarities.size && !rarities.has(c.rarity)) return false
      if (set !== 'all' && c.set !== set) return false
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !c.text?.toLowerCase().includes(q) &&
        !c.tags?.some((t) => t.toLowerCase().includes(q))
      )
        return false
      return true
    })
    return sortCards(filtered, sort)
  }, [query, domains, types, costs, rarities, set, sort])

  // Any time the filter set changes, collapse back to the first page.
  useEffect(() => {
    setLimit(PAGE)
  }, [query, domains, types, costs, rarities, set, sort])

  const shown = results.slice(0, limit)
  const activeCount =
    domains.size + types.size + costs.size + rarities.size + (set !== 'all' ? 1 : 0) + (query ? 1 : 0)
  const gridMin = DENSITY.find((d) => d.key === density)?.min ?? 152

  function clearAll() {
    setQuery('')
    setDomains(new Set())
    setTypes(new Set())
    setCosts(new Set())
    setRarities(new Set())
    setSet('all')
  }

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      {/* ---- Filter sidebar ------------------------------------------------ */}
      <aside className="shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-64 lg:overflow-y-auto lg:pr-1">
        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, text, tag…"
              className="w-full rounded-lg border border-white/10 bg-[#0a1428] py-2 pl-9 pr-8 text-sm outline-none transition focus:border-amber-300/60"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-white/40 hover:text-white"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <FacetGroup label="Domain">
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => (
                <FilterChip
                  key={d}
                  active={domains.has(d)}
                  color={DOMAIN_META[d].color}
                  onClick={() => setDomains((s) => toggle(s, d))}
                >
                  <DomainIcon domain={d} /> {DOMAIN_META[d].label}
                </FilterChip>
              ))}
            </div>
          </FacetGroup>

          <FacetGroup label="Type">
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => (
                <FilterChip key={t} active={types.has(t)} onClick={() => setTypes((s) => toggle(s, t))}>
                  {t}
                </FilterChip>
              ))}
            </div>
          </FacetGroup>

          <FacetGroup label="Cost">
            <div className="flex flex-wrap gap-1.5">
              {COSTS.map((c) => (
                <FilterChip key={c} active={costs.has(c)} onClick={() => setCosts((s) => toggle(s, c))}>
                  {c === 7 ? '7+' : c}
                </FilterChip>
              ))}
            </div>
          </FacetGroup>

          <FacetGroup label="Rarity">
            <div className="flex flex-wrap gap-1.5">
              {RARITIES.map((r) => (
                <FilterChip key={r} active={rarities.has(r)} onClick={() => setRarities((s) => toggle(s, r))}>
                  {r}
                </FilterChip>
              ))}
            </div>
          </FacetGroup>

          {SETS.length > 1 && (
            <FacetGroup label="Set">
              <select
                value={set}
                onChange={(e) => setSet(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#0a1428] px-3 py-2 text-sm outline-none focus:border-amber-300/60"
              >
                <option value="all">All sets</option>
                {SETS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FacetGroup>
          )}

          {activeCount > 0 && (
            <button
              onClick={clearAll}
              className="w-full rounded-lg border border-white/10 py-2 text-xs font-medium text-white/60 transition hover:border-rose-400/40 hover:text-rose-300"
            >
              Clear all filters ({activeCount})
            </button>
          )}
        </div>
      </aside>

      {/* ---- Results ------------------------------------------------------- */}
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold">Card Database</h2>
            <p className="text-sm text-white/50">
              {results.length.toLocaleString()} of {CARDS.length.toLocaleString()} cards
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-white/10 bg-[#0a1428] px-3 py-2 text-sm outline-none focus:border-amber-300/60"
              title="Sort by"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  Sort: {s.label}
                </option>
              ))}
            </select>
            <div className="flex overflow-hidden rounded-lg border border-white/10" title="Card size">
              {DENSITY.map((d) => (
                <button
                  key={d.key}
                  onClick={() => setDensity(d.key)}
                  className={`px-2.5 py-2 text-xs font-semibold transition ${
                    density === d.key ? 'bg-amber-300/20 text-amber-200' : 'text-white/50 hover:bg-white/5'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="py-16 text-center text-white/40">No cards match these filters.</p>
        ) : (
          <>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridMin}px, 1fr))` }}
            >
              {shown.map((c) => (
                <CardTile key={c.id} card={c} compact onClick={() => setDetail(c)} />
              ))}
            </div>
            {results.length > limit && (
              <div className="mt-6 flex justify-center">
                <button
                  onClick={() => setLimit((n) => n + PAGE)}
                  className="rounded-lg border border-amber-300/40 bg-amber-300/10 px-5 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-300/20"
                >
                  Load more ({(results.length - limit).toLocaleString()} left)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {detail && <CardDetailModal card={detail} onClose={() => setDetail(null)} large />}
    </div>
  )
}

function FacetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/40">
        {label}
      </div>
      {children}
    </div>
  )
}

function FilterChip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition ${
        active ? 'text-white' : 'border-white/10 text-white/55 hover:bg-white/5'
      }`}
      style={
        active
          ? {
              borderColor: color ? `${color}aa` : 'rgba(200,170,110,0.6)',
              background: color ? `${color}33` : 'rgba(200,170,110,0.18)',
            }
          : undefined
      }
    >
      {children}
    </button>
  )
}
