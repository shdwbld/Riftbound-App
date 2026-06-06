import { getCard } from '../data/cards'
import { pileSize, type Deck } from '../types/deck'
import { DOMAIN_META, DOMAINS, type Card, type Domain } from '../types/cards'

// Visual deck picker building blocks shared by the Match setup, Online lobby, and
// the Decks page: a legend-art banner, a selectable tile, a compact overview, and
// a full picker (scrollable tile grid + overview of the current pick).

const baseName = (n: string) => n.split(' - ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim()
const cleanName = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, '').trim()

export interface DeckMeta {
  legend: Card | undefined
  championName: string
  /** Domains the deck uses (legend identity, falling back to its rune colors). */
  identity: Domain[]
  mainCount: number
  runeCount: number
  /** Rune copies per domain, only domains that appear, in canonical order. */
  runesByDomain: Array<[Domain, number]>
  /** Champion units then signature cards (the deck's signature pieces), up to 5. */
  keyCards: Card[]
}

export function deckMeta(deck: Deck): DeckMeta {
  const legend = deck.legendId ? getCard(deck.legendId) : undefined
  const runeCounts = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<Domain, number>
  for (const [id, copies] of Object.entries(deck.runes)) {
    const c = getCard(id)
    if (c) for (const d of c.domains) runeCounts[d] += copies
  }
  const runesByDomain = DOMAINS.map((d) => [d, runeCounts[d]] as [Domain, number]).filter(([, n]) => n > 0)
  const legendIdentity = legend && legend.type === 'legend' ? legend.identity : []
  const identity = legendIdentity.length ? legendIdentity : runesByDomain.map(([d]) => d)
  const champCard = deck.championId ? getCard(deck.championId) : undefined
  const championName = baseName(legend?.name ?? champCard?.name ?? '')

  const champs: Card[] = []
  const sigs: Card[] = []
  for (const id of Object.keys(deck.main)) {
    const c = getCard(id)
    if (!c) continue
    if (c.supertype === 'champion') champs.push(c)
    else if (c.supertype === 'signature') sigs.push(c)
  }
  return {
    legend,
    championName,
    identity,
    mainCount: pileSize(deck.main),
    runeCount: pileSize(deck.runes),
    runesByDomain,
    keyCards: [...champs, ...sigs].slice(0, 5),
  }
}

/** A colored gradient from a deck's domains, used as the banner fallback. */
function identityGradient(identity: Domain[]): string {
  if (!identity.length) return 'linear-gradient(120deg,#1a2740,#0a1428)'
  if (identity.length === 1) return `linear-gradient(120deg, ${DOMAIN_META[identity[0]].color}, #0a1428)`
  const stops = identity.map((d, i) => `${DOMAIN_META[d].color} ${(i / (identity.length - 1)) * 100}%`)
  return `linear-gradient(120deg, ${stops.join(', ')})`
}

/** Wide 2.26:1 banner crop of the Legend art (object-cover focused on the art);
 *  falls back to a domain-colored gradient when no art is available. */
export function LegendBanner({
  legend,
  identity,
  className = '',
}: {
  legend: Card | undefined
  identity: Domain[]
  className?: string
}) {
  return (
    <div className={`relative aspect-[2.26/1] overflow-hidden ${className}`} style={{ background: identityGradient(identity) }}>
      {legend?.imageUrl && (
        <img
          src={legend.imageUrl}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition: 'center 26%' }}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />
    </div>
  )
}

/** A clickable deck tile: legend banner + name/champion + count badge + domain dots. */
export function DeckTile({
  deck,
  selected,
  dimmed,
  onSelect,
}: {
  deck: Deck
  selected: boolean
  dimmed?: boolean
  onSelect: () => void
}) {
  const m = deckMeta(deck)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative block overflow-hidden rounded-xl border text-left transition ${
        selected ? 'border-amber-300 shadow-[0_0_18px_-4px_rgba(200,155,60,0.7)]' : 'border-white/10 hover:border-white/25'
      }`}
      style={{ transform: selected ? 'scale(1.03)' : undefined, opacity: dimmed && !selected ? 0.7 : 1 }}
    >
      <LegendBanner legend={m.legend} identity={m.identity} />
      <div className="space-y-1 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{deck.name}</div>
            <div className="truncate text-[11px] text-white/50">{m.championName || 'No legend'}</div>
          </div>
          <span className="shrink-0 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-semibold text-white/70">{m.mainCount} cards</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {m.identity.map((d) => (
            <span key={d} className="h-2.5 w-2.5 rounded-full ring-1 ring-black/40" style={{ background: DOMAIN_META[d].color }} title={DOMAIN_META[d].label} />
          ))}
        </div>
      </div>
    </button>
  )
}

/** Compact "what am I picking" preview: full legend card + rune breakdown + key cards. */
export function DeckOverview({ deck }: { deck: Deck }) {
  const m = deckMeta(deck)
  return (
    <div className="flex gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="shrink-0">
        {m.legend?.imageUrl ? (
          <img src={m.legend.imageUrl} alt={m.legend.name} loading="lazy" className="w-24 rounded-lg object-contain" style={{ aspectRatio: '5/7' }} />
        ) : (
          <div className="flex w-24 items-center justify-center rounded-lg bg-white/5 text-center text-[10px] text-white/40" style={{ aspectRatio: '5/7' }}>
            No legend
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5 text-xs">
        <div>
          <div className="truncate text-sm font-bold">{deck.name}</div>
          <div className="truncate text-white/50">{m.legend ? cleanName(m.legend.name) : '—'}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {m.runesByDomain.length ? (
            m.runesByDomain.map(([d, n]) => (
              <span key={d} className="flex items-center gap-1" title={DOMAIN_META[d].label}>
                <span className="h-3 w-3 rounded-full ring-1 ring-black/40" style={{ background: DOMAIN_META[d].color }} />
                <span className="text-white/70">×{n}</span>
              </span>
            ))
          ) : (
            <span className="text-white/40">No runes</span>
          )}
        </div>
        {m.keyCards.length > 0 && (
          <ul className="space-y-0.5 text-white/65">
            {m.keyCards.map((c) => (
              <li key={c.id} className="truncate">
                <span className="text-amber-300/70">{c.supertype === 'champion' ? '★' : '✦'}</span> {cleanName(c.name)}
              </li>
            ))}
          </ul>
        )}
        <div className="text-white/40">
          {m.mainCount} main · {m.runeCount} runes · {deck.battlefields.length} BF
        </div>
      </div>
    </div>
  )
}

/** Full picker: a scrollable grid of deck tiles + a preview of the current pick.
 *  Reused for each Match seat and the Online lobby's "your deck". */
export function DeckPicker({
  label,
  decks,
  value,
  onChange,
  gridClassName = 'max-h-72 grid-cols-2 sm:grid-cols-3',
}: {
  label?: string
  decks: Deck[]
  value: string
  onChange: (id: string) => void
  /** Override the tile grid's columns + max-height (e.g. wider on a full-width page). */
  gridClassName?: string
}) {
  const selected = decks.find((d) => d.id === value)
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-[#0a1428] p-3">
      {label && <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>}
      <div className={`grid gap-2 overflow-y-auto p-1 ${gridClassName}`}>
        {decks.map((d) => (
          <DeckTile key={d.id} deck={d} selected={d.id === value} dimmed={!!value} onSelect={() => onChange(d.id)} />
        ))}
      </div>
      {selected && <DeckOverview deck={selected} />}
    </div>
  )
}
