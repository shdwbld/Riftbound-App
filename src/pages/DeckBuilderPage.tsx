import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { CARDS, getCard } from '../data/cards'
import {
  type Card,
  type CardType,
  type Domain,
  DOMAIN_META,
  DOMAINS,
  isUnit,
  totalCost,
} from '../types/cards'
import { type Deck } from '../types/deck'
import { DECK_RULES, pileSize } from '../types/deck'
import { getDeck, saveDeck } from '../lib/deckStorage'
import { exportDeck } from '../lib/deckStorage'
import { validateDeck, isOnIdentity } from '../lib/deckValidation'

const POOL_TYPES: (CardType | 'all')[] = [
  'all',
  'unit',
  'spell',
  'gear',
  'battlefield',
  'rune',
]
const POOL_CAP = 80

export default function DeckBuilderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [deck, setDeck] = useState<Deck | null>(() => getDeck(id) ?? null)
  const [pickingLegend, setPickingLegend] = useState(false)
  const [exporting, setExporting] = useState(false)

  // pool filters
  const [query, setQuery] = useState('')
  const [poolType, setPoolType] = useState<CardType | 'all'>('all')
  const [poolDomain, setPoolDomain] = useState<Domain | 'all'>('all')
  const [onIdentityOnly, setOnIdentityOnly] = useState(true)

  // Persist on every change.
  useEffect(() => {
    if (deck) saveDeck(deck)
  }, [deck])

  if (!deck) {
    return (
      <div className="space-y-3">
        <p className="text-white/60">Deck not found.</p>
        <Link to="/decks" className="text-indigo-400 hover:underline">
          ← Back to decks
        </Link>
      </div>
    )
  }

  const legend = deck.legendId ? getCard(deck.legendId) : undefined
  const v = validateDeck(deck)

  const update = (patch: Partial<Deck>) => setDeck((d) => (d ? { ...d, ...patch } : d))

  const setCount = (pile: 'main' | 'runes', cardId: string, next: number) => {
    setDeck((d) => {
      if (!d) return d
      const copy = { ...d[pile] }
      if (next <= 0) delete copy[cardId]
      else copy[cardId] = Math.min(next, DECK_RULES.maxCopiesPerCard)
      return { ...d, [pile]: copy }
    })
  }

  const addCard = (card: Card) => {
    if (card.type === 'legend') {
      update({ legendId: card.id })
      setPickingLegend(false)
      return
    }
    if (card.type === 'battlefield') {
      if (deck.battlefields.includes(card.id)) return
      if (deck.battlefields.length >= DECK_RULES.battlefieldCount) return
      update({ battlefields: [...deck.battlefields, card.id] })
      return
    }
    const pile = card.type === 'rune' ? 'runes' : 'main'
    setCount(pile, card.id, (deck[pile][card.id] ?? 0) + 1)
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link to="/decks" className="text-white/40 hover:text-white">
            ←
          </Link>
          <input
            value={deck.name}
            onChange={(e) => update({ name: e.target.value })}
            className="rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-bold outline-none hover:border-white/10 focus:border-indigo-400"
          />
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              v.isLegal
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-amber-500/20 text-amber-300'
            }`}
          >
            {v.isLegal ? 'legal' : 'draft'}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setExporting((x) => !x)}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Export
          </button>
          <button
            onClick={() => navigate('/play')}
            disabled={!v.isLegal}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            Test ▶
          </button>
        </div>
      </div>

      {exporting && (
        <ExportPanel deck={deck} onClose={() => setExporting(false)} />
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* Card pool */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cards…"
              className="w-48 rounded-lg border border-white/10 bg-[#15151f] px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
            />
            <label className="flex items-center gap-1.5 text-xs text-white/60">
              <input
                type="checkbox"
                checked={onIdentityOnly}
                onChange={(e) => setOnIdentityOnly(e.target.checked)}
              />
              On-identity only
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {POOL_TYPES.map((t) => (
              <Chip key={t} active={poolType === t} onClick={() => setPoolType(t)}>
                {t}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={poolDomain === 'all'} onClick={() => setPoolDomain('all')}>
              all
            </Chip>
            {DOMAINS.map((d) => (
              <Chip
                key={d}
                active={poolDomain === d}
                onClick={() => setPoolDomain(d)}
              >
                <span style={{ color: DOMAIN_META[d].color }}>
                  {DOMAIN_META[d].glyph}
                </span>
              </Chip>
            ))}
          </div>

          <CardPool
            query={query}
            poolType={poolType}
            poolDomain={poolDomain}
            onIdentityOnly={onIdentityOnly}
            identity={v.identity}
            onAdd={addCard}
            deck={deck}
          />
        </div>

        {/* Deck panel */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {/* Legend */}
          <Section title="Champion Legend">
            {legend ? (
              <button
                onClick={() => setPickingLegend(true)}
                className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-2 text-left hover:border-white/25"
              >
                {legend.imageUrl && (
                  <img
                    src={legend.imageUrl}
                    alt=""
                    className="h-12 w-12 rounded object-cover"
                  />
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {legend.name}
                  </div>
                  <div className="flex gap-1">
                    {legend.type === 'legend' &&
                      legend.identity.map((d) => (
                        <span
                          key={d}
                          className="rounded px-1 text-[10px]"
                          style={{
                            background: `${DOMAIN_META[d].color}33`,
                            color: DOMAIN_META[d].color,
                          }}
                        >
                          {DOMAIN_META[d].label}
                        </span>
                      ))}
                  </div>
                </div>
              </button>
            ) : (
              <button
                onClick={() => setPickingLegend(true)}
                className="w-full rounded-lg border border-dashed border-white/20 p-3 text-sm text-white/60 hover:bg-white/5"
              >
                + Choose a legend
              </button>
            )}
          </Section>

          {/* Validation */}
          {v.issues.length > 0 && (
            <Section title="Checklist">
              <ul className="space-y-1 text-xs">
                {v.issues.map((iss, i) => (
                  <li
                    key={i}
                    className={
                      iss.level === 'error' ? 'text-rose-300' : 'text-amber-300/80'
                    }
                  >
                    {iss.level === 'error' ? '✕' : '!'} {iss.message}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Main deck */}
          <Section title={`Main Deck · ${pileSize(deck.main)}/40`}>
            <PileList
              pile={deck.main}
              onInc={(id) => setCount('main', id, (deck.main[id] ?? 0) + 1)}
              onDec={(id) => setCount('main', id, (deck.main[id] ?? 0) - 1)}
            />
          </Section>

          {/* Runes */}
          <Section title={`Rune Deck · ${pileSize(deck.runes)}/12`}>
            <PileList
              pile={deck.runes}
              onInc={(id) => setCount('runes', id, (deck.runes[id] ?? 0) + 1)}
              onDec={(id) => setCount('runes', id, (deck.runes[id] ?? 0) - 1)}
            />
          </Section>

          {/* Battlefields */}
          <Section title={`Battlefields · ${deck.battlefields.length}/3`}>
            {deck.battlefields.length === 0 ? (
              <p className="text-xs text-white/40">
                Add 3 battlefields from the pool.
              </p>
            ) : (
              <ul className="space-y-1">
                {deck.battlefields.map((bid) => {
                  const c = getCard(bid)
                  return (
                    <li
                      key={bid}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="truncate">{c?.name ?? bid}</span>
                      <button
                        onClick={() =>
                          update({
                            battlefields: deck.battlefields.filter(
                              (x) => x !== bid,
                            ),
                          })
                        }
                        className="text-white/30 hover:text-rose-300"
                      >
                        ✕
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        </aside>
      </div>

      {pickingLegend && (
        <LegendPicker
          onPick={(c) => addCard(c)}
          onClose={() => setPickingLegend(false)}
        />
      )}
    </div>
  )
}

// --- Subcomponents ---------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#15151f] p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h3>
      {children}
    </div>
  )
}

function Chip({
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
      className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition ${
        active
          ? 'border-indigo-400/50 bg-indigo-500/20 text-white'
          : 'border-white/10 text-white/60 hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  )
}

function PileList({
  pile,
  onInc,
  onDec,
}: {
  pile: Record<string, number>
  onInc: (id: string) => void
  onDec: (id: string) => void
}) {
  const entries = Object.entries(pile)
    .map(([id, n]) => ({ card: getCard(id), id, n }))
    .filter((e) => e.card)
    .sort(
      (a, b) =>
        totalCost(a.card!) - totalCost(b.card!) ||
        a.card!.name.localeCompare(b.card!.name),
    )
  if (entries.length === 0)
    return <p className="text-xs text-white/40">Empty.</p>
  return (
    <ul className="space-y-1">
      {entries.map(({ card, id, n }) => (
        <li key={id} className="flex items-center gap-2 text-sm">
          <span className="flex w-6 shrink-0 items-center justify-center rounded bg-amber-500/15 font-mono text-xs text-amber-300">
            {isUnit(card!) || card!.type === 'spell' || card!.type === 'gear'
              ? totalCost(card!)
              : '–'}
          </span>
          <span className="min-w-0 flex-1 truncate">{card!.name}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => onDec(id)}
              className="h-5 w-5 rounded bg-white/5 text-white/60 hover:bg-white/10"
            >
              −
            </button>
            <span className="w-4 text-center font-mono text-xs">{n}</span>
            <button
              onClick={() => onInc(id)}
              className="h-5 w-5 rounded bg-white/5 text-white/60 hover:bg-white/10"
            >
              +
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function CardPool({
  query,
  poolType,
  poolDomain,
  onIdentityOnly,
  identity,
  onAdd,
  deck,
}: {
  query: string
  poolType: CardType | 'all'
  poolDomain: Domain | 'all'
  onIdentityOnly: boolean
  identity: Domain[]
  onAdd: (card: Card) => void
  deck: Deck
}) {
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CARDS.filter((c) => {
      if (c.type === 'legend') return false // legends picked separately
      if (poolType !== 'all' && c.type !== poolType) return false
      if (poolDomain !== 'all' && !c.domains.includes(poolDomain)) return false
      if (onIdentityOnly && identity.length && !isOnIdentity(c, identity))
        return false
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !c.text?.toLowerCase().includes(q) &&
        !c.tags?.some((t) => t.toLowerCase().includes(q))
      )
        return false
      return true
    })
  }, [query, poolType, poolDomain, onIdentityOnly, identity])

  const shown = results.slice(0, POOL_CAP)

  return (
    <div>
      <p className="mb-2 text-xs text-white/40">
        {results.length} cards{results.length > POOL_CAP && ` · first ${POOL_CAP}`}
      </p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((c) => {
          const count =
            c.type === 'rune'
              ? deck.runes[c.id]
              : c.type === 'battlefield'
                ? deck.battlefields.includes(c.id)
                  ? 1
                  : 0
                : deck.main[c.id]
          return (
            <button
              key={c.id}
              onClick={() => onAdd(c)}
              className="group relative overflow-hidden rounded-lg border border-white/10 bg-[#15151f] text-left transition hover:border-indigo-400/50"
            >
              {c.imageUrl ? (
                <img
                  src={c.imageUrl}
                  alt={c.name}
                  loading="lazy"
                  className="aspect-[744/1039] w-full object-cover"
                />
              ) : (
                <div className="flex aspect-[744/1039] items-center justify-center p-2 text-center text-[11px] text-white/60">
                  {c.name}
                </div>
              )}
              {count ? (
                <span className="absolute right-1 top-1 rounded bg-indigo-500 px-1.5 py-0.5 text-[10px] font-bold">
                  {count}
                </span>
              ) : null}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1.5 py-0.5 text-[10px] opacity-0 transition group-hover:opacity-100">
                + {c.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LegendPicker({
  onPick,
  onClose,
}: {
  onPick: (c: Card) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const legends = useMemo(
    () =>
      CARDS.filter(
        (c) => c.type === 'legend' && c.name.toLowerCase().includes(q.toLowerCase()),
      ),
    [q],
  )
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-white/10 bg-[#12121a] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold">Choose a Champion Legend</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            ✕
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search legends…"
          className="mb-3 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <div className="grid grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-5">
          {legends.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c)}
              className="overflow-hidden rounded-lg border border-white/10 transition hover:border-indigo-400"
            >
              {c.imageUrl && (
                <img
                  src={c.imageUrl}
                  alt={c.name}
                  loading="lazy"
                  className="aspect-[744/1039] w-full object-cover"
                />
              )}
              <div className="truncate px-1 py-1 text-[10px]">{c.name}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExportPanel({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const text = exportDeck(deck)
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-[#15151f] p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/60">Deck code</p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(text)
              setCopied(true)
            }}
            className="rounded bg-indigo-500 px-2 py-1 text-xs font-semibold hover:bg-indigo-400"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/5"
          >
            Close
          </button>
        </div>
      </div>
      <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-white/70">
        {text}
      </pre>
    </div>
  )
}
