import { useMemo, useState } from 'react'
import { CARDS } from '../data/cards'
import {
  type Card,
  DOMAINS,
  DOMAIN_META,
  type CardType,
  type Domain,
  isUnit,
  totalCost,
} from '../types/cards'
import CardTile from '../components/CardTile'
import { DomainIcon } from '../components/CardText'
import CardDetailModal from '../components/CardDetailModal'

const TYPES: CardType[] = ['unit', 'spell', 'gear', 'battlefield', 'legend', 'rune']
const RENDER_CAP = 120

type SortKey = 'set' | 'name' | 'cost' | 'might'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'set', label: 'Set / number' },
  { key: 'name', label: 'Name' },
  { key: 'cost', label: 'Cost' },
  { key: 'might', label: 'Might' },
]

function sortCards(cards: Card[], key: SortKey): Card[] {
  const arr = [...cards]
  switch (key) {
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
    case 'cost':
      return arr.sort(
        (a, b) => totalCost(a) - totalCost(b) || a.name.localeCompare(b.name),
      )
    case 'might':
      return arr.sort(
        (a, b) =>
          (isUnit(b) ? b.might : -1) - (isUnit(a) ? a.might : -1) ||
          a.name.localeCompare(b.name),
      )
    default:
      return arr.sort(
        (a, b) => a.set.localeCompare(b.set) || a.number - b.number,
      )
  }
}

const SETS = [...new Set(CARDS.map((c) => c.set))].sort()

export default function CardsPage() {
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState<Domain | 'all'>('all')
  const [type, setType] = useState<CardType | 'all'>('all')
  const [set, setSet] = useState<string | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('set')
  const [detail, setDetail] = useState<Card | null>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = CARDS.filter((c) => {
      if (domain !== 'all' && !c.domains.includes(domain)) return false
      if (type !== 'all' && c.type !== type) return false
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
  }, [query, domain, type, set, sort])

  const shown = results.slice(0, RENDER_CAP)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Card Database</h2>
          <p className="text-sm text-white/50">
            {results.length.toLocaleString()} of {CARDS.length.toLocaleString()}{' '}
            cards
            {results.length > RENDER_CAP && ` · showing first ${RENDER_CAP}`}
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={set}
            onChange={(e) => setSet(e.target.value)}
            className="rounded-lg border border-white/10 bg-[#15151f] px-3 py-2 text-sm outline-none focus:border-indigo-400"
          >
            <option value="all">All sets</option>
            {SETS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-white/10 bg-[#15151f] px-3 py-2 text-sm outline-none focus:border-indigo-400"
            title="Sort by"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, text, tag…"
            className="w-56 rounded-lg border border-white/10 bg-[#15151f] px-3 py-2 text-sm outline-none focus:border-indigo-400"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={domain === 'all'} onClick={() => setDomain('all')}>
          All domains
        </FilterChip>
        {DOMAINS.map((d) => (
          <FilterChip key={d} active={domain === d} onClick={() => setDomain(d)}>
            <span style={{ color: DOMAIN_META[d].color }}>
              <DomainIcon domain={d} /> {DOMAIN_META[d].label}
            </span>
          </FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={type === 'all'} onClick={() => setType('all')}>
          All types
        </FilterChip>
        {TYPES.map((t) => (
          <FilterChip key={t} active={type === t} onClick={() => setType(t)}>
            {t}
          </FilterChip>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-12 text-center text-white/40">No cards match.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((c) => (
            <CardTile key={c.id} card={c} onClick={() => setDetail(c)} />
          ))}
        </div>
      )}

      {detail && (
        <CardDetailModal card={detail} onClose={() => setDetail(null)} />
      )}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition ${
        active
          ? 'border-indigo-400/50 bg-indigo-500/20 text-white'
          : 'border-white/10 text-white/60 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  )
}
