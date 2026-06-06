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
import { getDeck, saveDeck, duplicateDeck } from '../lib/deckStorage'
import { exportDeck } from '../lib/deckStorage'
import { validateDeck, isOnIdentity } from '../lib/deckValidation'
import { computeStats, sampleHand, CURVE_MAX } from '../lib/deckStats'
import { DomainIcon } from '../components/CardText'
import CardPreview from '../components/CardPreview'

const POOL_TYPES: (CardType | 'all')[] = [
  'all',
  'unit',
  'spell',
  'gear',
  'battlefield',
  'rune',
]
const POOL_CAP = 80

/** A basic rune that produces the given domain (prefer the 'basic' supertype). */
function basicRuneId(domain: Domain): string | undefined {
  const runes = CARDS.filter((c) => c.type === 'rune' && c.produces.includes(domain) && !c.alternateArt)
  return (runes.find((c) => c.supertype === 'basic') ?? runes[0])?.id
}

export default function DeckBuilderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [deck, setDeck] = useState<Deck | null>(() => getDeck(id) ?? null)
  const [pickingLegend, setPickingLegend] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [sample, setSample] = useState<Card[] | null>(null)
  // Deck panel display: compact list vs a card-image grid grouped by type.
  const [deckView, setDeckView] = useState<'list' | 'grid'>('list')
  // Pool clicks add units/spells/gear to this pile.
  const [addTarget, setAddTarget] = useState<'main' | 'sideboard'>('main')

  // pool filters
  const [query, setQuery] = useState('')
  const [poolType, setPoolType] = useState<CardType | 'all'>('all')
  const [poolDomain, setPoolDomain] = useState<Domain | 'all'>('all')
  const [onIdentityOnly, setOnIdentityOnly] = useState(true)

  // Persist on every change.
  useEffect(() => {
    if (deck) saveDeck(deck)
  }, [deck])

  // Clear a stale Chosen Champion if it's no longer a champion unit in the deck.
  useEffect(() => {
    if (!deck?.championId) return
    const c = getCard(deck.championId)
    if (!c || !deck.main[deck.championId] || c.supertype !== 'champion')
      setDeck((d) => (d ? { ...d, championId: null } : d))
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

  // Eligible Chosen Champions: champion-supertype units currently in the main deck.
  const eligibleChampions = Object.keys(deck.main)
    .map((id) => getCard(id))
    .filter((c): c is NonNullable<typeof c> => !!c && c.type === 'unit' && c.supertype === 'champion')

  const update = (patch: Partial<Deck>) => setDeck((d) => (d ? { ...d, ...patch } : d))

  const setCount = (pile: 'main' | 'runes' | 'sideboard', cardId: string, next: number) => {
    // Main/sideboard: max 3 copies per card. Rune deck: basic runes aren't
    // subject to the 3-copy limit, so cap only at the rune-deck size.
    const cap = pile === 'runes' ? DECK_RULES.runeDeckSize : DECK_RULES.maxCopiesPerCard
    setDeck((d) => {
      if (!d) return d
      const copy = { ...d[pile] }
      if (next <= 0) delete copy[cardId]
      else copy[cardId] = Math.min(next, cap)
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
    const pile = card.type === 'rune' ? 'runes' : addTarget
    setCount(pile, card.id, (deck[pile][card.id] ?? 0) + 1)
  }

  const clone = () => {
    const copy = duplicateDeck(deck.id)
    if (copy) navigate(`/decks/${copy.id}/edit`)
  }

  // One-click: fill the 12-rune deck with basic runes for the legend's domains,
  // split as evenly as possible (remainder to the first domain).
  const fillRunes = () => {
    const ids = v.identity
    if (!ids.length) return
    const per = Math.floor(DECK_RULES.runeDeckSize / ids.length)
    const runes: Record<string, number> = {}
    let total = 0
    for (const d of ids) {
      const rid = basicRuneId(d)
      if (rid) {
        runes[rid] = (runes[rid] ?? 0) + per
        total += per
      }
    }
    const firstRid = basicRuneId(ids[0])
    if (total < DECK_RULES.runeDeckSize && firstRid)
      runes[firstRid] = (runes[firstRid] ?? 0) + (DECK_RULES.runeDeckSize - total)
    update({ runes })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link to={`/decks/${deck.id}`} title="Deck overview" className="text-white/40 hover:text-white">
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
          <button
            onClick={() => navigate('/play', { state: { deckId: deck.id } })}
            disabled={pileSize(deck.main) === 0}
            title={pileSize(deck.main) === 0 ? 'Add some cards first' : 'Goldfish this deck'}
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
            <div className="ml-auto flex items-center gap-1 text-xs text-white/60">
              <span>Add to:</span>
              {(['main', 'sideboard'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setAddTarget(t)}
                  className={`rounded px-2 py-1 font-medium capitalize transition ${
                    addTarget === t ? 'bg-indigo-500/30 text-white' : 'text-white/50 hover:bg-white/5'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
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
                  <DomainIcon domain={d} />
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
          {/* List / grid view toggle for the deck contents */}
          <div className="flex items-center justify-end gap-1 text-xs">
            <span className="mr-auto text-white/40">View</span>
            {(['list', 'grid'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setDeckView(m)}
                className={`rounded px-2 py-1 font-medium capitalize transition ${
                  deckView === m ? 'bg-indigo-500/30 text-white' : 'text-white/50 hover:bg-white/5'
                }`}
              >
                {m === 'list' ? '☰ List' : '▦ Grid'}
              </button>
            ))}
          </div>
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

          {/* Chosen Champion */}
          <Section title="Chosen Champion">
            {eligibleChampions.length === 0 ? (
              <p className="text-xs text-white/40">
                Add a champion unit (matching your legend) to your deck to choose
                one. It's set aside in the Champion Zone at game start.
              </p>
            ) : (
              <>
                <select
                  value={deck.championId ?? ''}
                  onChange={(e) => update({ championId: e.target.value || null })}
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
                >
                  <option value="">Auto (first match)</option>
                  {eligibleChampions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {deck.championId && getCard(deck.championId) && (
                  <div className="mt-2 flex items-center gap-2">
                    {getCard(deck.championId)!.imageUrl && (
                      <img
                        src={getCard(deck.championId)!.imageUrl}
                        alt=""
                        className="h-12 w-[34px] rounded object-cover"
                      />
                    )}
                    <span className="text-xs text-white/60">
                      Set aside in the Champion Zone
                    </span>
                  </div>
                )}
              </>
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

          {/* Main deck — grouped by type (list or card-image grid) */}
          <Section title={`Main Deck · ${pileSize(deck.main)}/40`}>
            {pileSize(deck.main) === 0 ? (
              <p className="text-xs text-white/40">Empty.</p>
            ) : deckView === 'grid' ? (
              (['unit', 'spell', 'gear'] as const).map((t) => {
                const sub = Object.fromEntries(
                  Object.entries(deck.main).filter(([id]) => getCard(id)?.type === t),
                )
                if (Object.keys(sub).length === 0) return null
                return (
                  <DeckGridGroup
                    key={t}
                    label={`${t}s`}
                    pile={sub}
                    cap={DECK_RULES.maxCopiesPerCard}
                    onInc={(id) => setCount('main', id, (deck.main[id] ?? 0) + 1)}
                    onDec={(id) => setCount('main', id, (deck.main[id] ?? 0) - 1)}
                  />
                )
              })
            ) : (
              (['unit', 'spell', 'gear'] as const).map((t) => {
                const sub = Object.fromEntries(
                  Object.entries(deck.main).filter(([id]) => getCard(id)?.type === t),
                )
                if (Object.keys(sub).length === 0) return null
                return (
                  <div key={t} className="mb-2 last:mb-0">
                    <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/35">
                      {t}s · {pileSize(sub)}
                    </div>
                    <PileList
                      pile={sub}
                      cap={DECK_RULES.maxCopiesPerCard}
                      onInc={(id) => setCount('main', id, (deck.main[id] ?? 0) + 1)}
                      onDec={(id) => setCount('main', id, (deck.main[id] ?? 0) - 1)}
                    />
                  </div>
                )
              })
            )}
          </Section>

          {/* Runes */}
          <Section title={`Rune Deck · ${pileSize(deck.runes)}/12`}>
            {v.identity.length > 0 && (
              <button
                onClick={fillRunes}
                className="mb-2 w-full rounded border border-white/15 py-1 text-xs font-medium text-white/80 hover:bg-white/5"
              >
                ⚡ Auto-fill 12 runes ({v.identity.map((d) => DOMAIN_META[d].label).join(' / ')})
              </button>
            )}
            {deckView === 'grid' && pileSize(deck.runes) > 0 ? (
              <DeckGridGroup
                label="runes"
                pile={deck.runes}
                cap={DECK_RULES.runeDeckSize}
                onInc={(id) => setCount('runes', id, (deck.runes[id] ?? 0) + 1)}
                onDec={(id) => setCount('runes', id, (deck.runes[id] ?? 0) - 1)}
              />
            ) : (
              <PileList
                pile={deck.runes}
                cap={DECK_RULES.runeDeckSize}
                onInc={(id) => setCount('runes', id, (deck.runes[id] ?? 0) + 1)}
                onDec={(id) => setCount('runes', id, (deck.runes[id] ?? 0) - 1)}
              />
            )}
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

          {/* Sideboard */}
          <Section title={`Sideboard · ${pileSize(deck.sideboard)}`}>
            {pileSize(deck.sideboard) === 0 ? (
              <p className="text-xs text-white/40">
                Toggle “Add to: Sideboard” above, then click cards to add them here.
              </p>
            ) : (
              <PileList
                pile={deck.sideboard}
                cap={DECK_RULES.maxCopiesPerCard}
                onInc={(id) => setCount('sideboard', id, (deck.sideboard[id] ?? 0) + 1)}
                onDec={(id) => setCount('sideboard', id, (deck.sideboard[id] ?? 0) - 1)}
              />
            )}
          </Section>

          {/* Stats */}
          <Section title="Stats">
            <StatsPanel deck={deck} />
            <button
              onClick={() => setSample(sampleHand(deck))}
              disabled={pileSize(deck.main) === 0}
              className="mt-3 w-full rounded-lg border border-white/15 py-1.5 text-xs font-medium text-white/80 hover:bg-white/5 disabled:opacity-40"
            >
              🎴 Draw sample hand
            </button>
          </Section>
        </aside>
      </div>

      {pickingLegend && (
        <LegendPicker
          onPick={(c) => addCard(c)}
          onClose={() => setPickingLegend(false)}
        />
      )}

      {sample && (
        <SampleHandModal
          cards={sample}
          onRedraw={() => setSample(sampleHand(deck))}
          onClose={() => setSample(null)}
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
  cap,
}: {
  pile: Record<string, number>
  onInc: (id: string) => void
  onDec: (id: string) => void
  /** Per-card copy cap — disables "+" once reached. */
  cap?: number
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
              disabled={cap != null && n >= cap}
              title={cap != null && n >= cap ? `Max ${cap}` : undefined}
              className="h-5 w-5 rounded bg-white/5 text-white/60 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              +
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A type-group of the deck shown as card-image thumbnails (hover to expand,
 *  click a card to add one, − to remove one). */
function DeckGridGroup({
  label,
  pile,
  cap,
  onInc,
  onDec,
}: {
  label: string
  pile: Record<string, number>
  cap?: number
  onInc: (id: string) => void
  onDec: (id: string) => void
}) {
  const entries = Object.entries(pile)
    .map(([id, n]) => ({ card: getCard(id), id, n }))
    .filter((e) => e.card)
    .sort(
      (a, b) =>
        totalCost(a.card!) - totalCost(b.card!) || a.card!.name.localeCompare(b.card!.name),
    )
  if (entries.length === 0) return null
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-white/35">
        {label} · {entries.reduce((s, e) => s + e.n, 0)}
      </div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
        {entries.map(({ card, id, n }) => (
          <CardPreview key={id} cardId={id} delay={260}>
            <div className="group relative overflow-hidden rounded-md border border-white/10 bg-[#15151f]">
              <button
                onClick={() => onInc(id)}
                disabled={cap != null && n >= cap}
                title={cap != null && n >= cap ? `Max ${cap}` : 'Add one'}
                className="block w-full disabled:cursor-not-allowed"
              >
                {card!.imageUrl ? (
                  <img src={card!.imageUrl} alt={card!.name} loading="lazy" className="aspect-[744/1039] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[744/1039] items-center justify-center p-1 text-center text-[9px] text-white/60">{card!.name}</div>
                )}
              </button>
              <span className="pointer-events-none absolute right-1 top-1 rounded bg-indigo-500 px-1.5 py-0.5 text-[10px] font-bold">×{n}</span>
              <button
                onClick={() => onDec(id)}
                title="Remove one"
                className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-xs font-bold text-white/80 opacity-0 transition hover:bg-rose-600 group-hover:opacity-100"
              >
                −
              </button>
            </div>
          </CardPreview>
        ))}
      </div>
    </div>
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
      if (c.supertype === 'token') return false // tokens are generated, not decked
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
                : (deck.main[c.id] ?? 0) + (deck.sideboard[c.id] ?? 0) // main + sideboard total
          return (
            <CardPreview key={c.id} cardId={c.id} delay={260}>
              <button
                onClick={() => onAdd(c)}
                className="group relative block w-full overflow-hidden rounded-lg border border-white/10 bg-[#15151f] text-left transition hover:border-indigo-400/50"
              >
                {c.imageUrl ? (
                  <img
                    src={c.imageUrl}
                    alt={c.name}
                    loading="lazy"
                    className={`w-full ${c.type === 'battlefield' ? 'aspect-[1039/744] object-contain' : 'aspect-[744/1039] object-cover'}`}
                  />
                ) : (
                  <div className={`flex items-center justify-center p-2 text-center text-[11px] text-white/60 ${c.type === 'battlefield' ? 'aspect-[1039/744]' : 'aspect-[744/1039]'}`}>
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
            </CardPreview>
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

function StatsPanel({ deck }: { deck: Deck }) {
  const stats = computeStats(deck)
  const peak = Math.max(1, ...stats.curve)
  return (
    <div className="space-y-3">
      {/* Mana curve */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] text-white/40">
          <span>Energy curve</span>
          <span>avg cost {stats.avgCost.toFixed(1)}</span>
        </div>
        <div className="flex items-end gap-1" style={{ height: 56 }}>
          {stats.curve.map((n, cost) => (
            <div key={cost} className="flex flex-1 flex-col items-center gap-0.5">
              <div className="w-full rounded-t bg-indigo-500/70" style={{ height: `${(n / peak) * 44}px` }} title={`${n} card(s)`} />
              <span className="text-[9px] text-white/40">
                {cost === CURVE_MAX ? `${cost}+` : cost}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Domain distribution */}
      <div>
        <div className="mb-1 text-[10px] text-white/40">Domain pips</div>
        <div className="flex gap-1">
          {DOMAINS.map((d) => {
            const n = stats.domainCounts[d]
            return n ? (
              <span
                key={d}
                className="rounded px-1.5 py-0.5 text-[10px] font-mono"
                style={{ background: `${DOMAIN_META[d].color}33`, color: DOMAIN_META[d].color }}
                title={DOMAIN_META[d].label}
              >
                <DomainIcon domain={d} />
                {n}
              </span>
            ) : null
          })}
          {stats.colorless > 0 && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-white/50">
              ◇{stats.colorless}
            </span>
          )}
        </div>
      </div>

      {/* Type breakdown */}
      <div className="flex flex-wrap gap-1 text-[10px] text-white/50">
        {Object.entries(stats.typeCounts).map(([t, n]) => (
          <span key={t} className="rounded bg-white/5 px-1.5 py-0.5 capitalize">
            {n} {t}
          </span>
        ))}
      </div>
    </div>
  )
}

function SampleHandModal({
  cards,
  onRedraw,
  onClose,
}: {
  cards: Card[]
  onRedraw: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#12121a] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold">Sample opening hand</h3>
          <div className="flex gap-2">
            <button
              onClick={onRedraw}
              className="rounded bg-indigo-500 px-3 py-1 text-xs font-semibold hover:bg-indigo-400"
            >
              ↻ Redraw
            </button>
            <button onClick={onClose} className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/5">
              Close
            </button>
          </div>
        </div>
        <div className="grid grid-cols-5 gap-2">
          {cards.map((c, i) => (
            <div key={i} className="overflow-hidden rounded-lg border border-white/10">
              {c.imageUrl ? (
                <img src={c.imageUrl} alt={c.name} className="aspect-[744/1039] w-full object-cover" />
              ) : (
                <div className="flex aspect-[744/1039] items-center justify-center p-1 text-center text-[10px]">
                  {c.name}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
