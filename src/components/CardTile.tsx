import { useState } from 'react'
import {
  type Card,
  DOMAIN_META,
  isUnit,
  isSpell,
  isGear,
  totalPower,
  cardCode,
} from '../types/cards'
import CardText, { DomainIcon } from './CardText'

function DomainStripe({ card }: { card: Card }) {
  const colors =
    card.domains.length > 0
      ? card.domains.map((d) => DOMAIN_META[d].color)
      : ['#555']
  return (
    <div
      className="h-1.5 w-full shrink-0"
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
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-amber-300">
        {card.energy}E
      </span>
      {Object.entries(card.power).map(([d, n]) =>
        n ? (
          <span
            key={d}
            className="rounded px-1.5 py-0.5 font-mono"
            style={{
              background: `${DOMAIN_META[d as keyof typeof DOMAIN_META]?.color ?? '#888'}33`,
              color: DOMAIN_META[d as keyof typeof DOMAIN_META]?.color ?? '#aaa',
            }}
          >
            {n}
            <DomainIcon domain={d} />
          </span>
        ) : null,
      )}
      {power === 0 && card.energy === 0 && (
        <span className="text-white/40">free</span>
      )}
    </div>
  )
}

export default function CardTile({
  card,
  onClick,
}: {
  card: Card
  onClick?: () => void
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImage = card.imageUrl && !imgFailed

  return (
    <div
      onClick={onClick}
      data-hover-sfx
      className={`group flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0a1428] transition hover:border-white/25 hover:bg-[#0a1e33] ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      <DomainStripe card={card} />
      {showImage && (
        <div className="relative aspect-[744/1039] w-full overflow-hidden bg-black/40">
          <img
            src={card.imageUrl}
            alt={card.name}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
          />
          {isUnit(card) && (
            <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-xs text-rose-300">
              {card.might}⚔
            </span>
          )}
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{card.name}</div>
            <div className="text-[11px] uppercase tracking-wide text-white/40">
              {card.type} · {cardCode(card)}
            </div>
          </div>
          {!showImage && isUnit(card) && (
            <span className="shrink-0 rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-xs text-rose-300">
              {card.might}⚔
            </span>
          )}
        </div>
        <CostBadge card={card} />
        {!showImage && card.text && (
          <p className="line-clamp-3 text-xs leading-snug text-white/60">
            <CardText text={card.text} />
          </p>
        )}
        {card.tags && card.tags.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1 pt-1">
            {card.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
