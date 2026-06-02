import {
  type Card,
  DOMAIN_META,
  isUnit,
  isSpell,
  isGear,
  totalPower,
} from '../types/cards'

function DomainStripe({ card }: { card: Card }) {
  const colors =
    card.domains.length > 0
      ? card.domains.map((d) => DOMAIN_META[d].color)
      : ['#555']
  return (
    <div
      className="h-1.5 w-full"
      style={{
        background:
          colors.length === 1
            ? colors[0]
            : `linear-gradient(90deg, ${colors.join(', ')})`,
      }}
    />
  )
}

function CostBadge({ card }: { card: Card }) {
  if (!(isUnit(card) || isSpell(card) || isGear(card))) return null
  const power = totalPower(card.power)
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-amber-300">
        {card.energy}E
      </span>
      {Object.entries(card.power).map(([d, n]) =>
        n ? (
          <span
            key={d}
            className="rounded px-1.5 py-0.5 font-mono"
            style={{
              background: `${DOMAIN_META[d as keyof typeof DOMAIN_META].color}33`,
              color: DOMAIN_META[d as keyof typeof DOMAIN_META].color,
            }}
          >
            {n}
            {DOMAIN_META[d as keyof typeof DOMAIN_META].glyph}
          </span>
        ) : null,
      )}
      {power === 0 && card.energy === 0 && (
        <span className="text-white/40">free</span>
      )}
    </div>
  )
}

export default function CardTile({ card }: { card: Card }) {
  return (
    <div className="group overflow-hidden rounded-lg border border-white/10 bg-[#15151f] transition hover:border-white/25 hover:bg-[#1a1a26]">
      <DomainStripe card={card} />
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{card.name}</div>
            <div className="text-[11px] uppercase tracking-wide text-white/40">
              {card.type}
            </div>
          </div>
          {isUnit(card) && (
            <span className="shrink-0 rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-xs text-rose-300">
              {card.might}⚔
            </span>
          )}
        </div>
        <CostBadge card={card} />
        {card.text && (
          <p className="line-clamp-3 text-xs leading-snug text-white/60">
            {card.text}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-1 pt-1">
          {card.tags?.map((t) => (
            <span
              key={t}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
