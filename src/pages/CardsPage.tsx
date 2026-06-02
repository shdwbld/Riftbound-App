import { useMemo, useState } from 'react'
import { SEED_CARDS } from '../data/cards'
import {
  DOMAINS,
  DOMAIN_META,
  type CardType,
  type Domain,
} from '../types/cards'
import CardTile from '../components/CardTile'

const TYPES: CardType[] = ['unit', 'spell', 'gear', 'battlefield', 'legend', 'rune']

export default function CardsPage() {
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState<Domain | 'all'>('all')
  const [type, setType] = useState<CardType | 'all'>('all')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return SEED_CARDS.filter((c) => {
      if (domain !== 'all' && !c.domains.includes(domain)) return false
      if (type !== 'all' && c.type !== type) return false
      if (q && !c.name.toLowerCase().includes(q) && !c.text?.toLowerCase().includes(q))
        return false
      return true
    })
  }, [query, domain, type])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Card Database</h2>
          <p className="text-sm text-white/50">
            {results.length} of {SEED_CARDS.length} cards · seed data (placeholder)
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or text…"
          className="w-64 rounded-lg border border-white/10 bg-[#15151f] px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={domain === 'all'} onClick={() => setDomain('all')}>
          All domains
        </FilterChip>
        {DOMAINS.map((d) => (
          <FilterChip key={d} active={domain === d} onClick={() => setDomain(d)}>
            <span style={{ color: DOMAIN_META[d].color }}>
              {DOMAIN_META[d].glyph} {DOMAIN_META[d].label}
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

      {results.length === 0 ? (
        <p className="py-12 text-center text-white/40">No cards match.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {results.map((c) => (
            <CardTile key={c.id} card={c} />
          ))}
        </div>
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
