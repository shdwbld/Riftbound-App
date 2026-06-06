import {
  type Card,
  DOMAIN_META,
  isUnit,
  isSpell,
  isGear,
  totalPower,
  cardCode,
} from '../types/cards'
import { keywordLabels, keywordDef } from '../engine/keywords'
import CardText, { DomainIcon } from './CardText'

export default function CardDetailModal({
  card,
  onClose,
}: {
  card: Card
  onClose: () => void
}) {
  const costed = isUnit(card) || isSpell(card) || isGear(card)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-2xl border border-white/10 bg-[#12121a] p-4 sm:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`mx-auto shrink-0 ${card.type === 'battlefield' ? 'w-full sm:w-80' : 'w-48 sm:w-56'}`}>
          {card.imageUrl ? (
            <img
              src={card.imageUrl}
              alt={card.name}
              className="w-full rounded-xl"
              style={{ aspectRatio: card.type === 'battlefield' ? '1039/744' : '744/1039', objectFit: 'cover' }}
            />
          ) : (
            <div
              className="flex w-full items-center justify-center rounded-xl bg-[#0a1e33] p-4 text-center text-sm"
              style={{ aspectRatio: card.type === 'battlefield' ? '1039/744' : '744/1039' }}
            >
              {card.name}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-xl font-bold">{card.name}</h3>
              <p className="text-xs uppercase tracking-wide text-white/40">
                {card.type} · {cardCode(card)} · {card.rarity}
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded px-2 py-1 text-white/40 hover:bg-white/5 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {card.domains.length === 0 && (
              <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-white/50">
                Colorless
              </span>
            )}
            {card.domains.map((d) => (
              <span
                key={d}
                className="rounded px-2 py-0.5 text-xs"
                style={{
                  background: `${DOMAIN_META[d].color}33`,
                  color: DOMAIN_META[d].color,
                }}
              >
                <DomainIcon domain={d} /> {DOMAIN_META[d].label}
              </span>
            ))}
          </div>

          {costed && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-amber-300">
                {card.energy} Energy
              </span>
              {totalPower(card.power) > 0 &&
                Object.entries(card.power).map(([d, n]) =>
                  n ? (
                    <span
                      key={d}
                      className="rounded px-2 py-0.5 font-mono"
                      style={{
                        background: `${DOMAIN_META[d as keyof typeof DOMAIN_META]?.color ?? '#888'}33`,
                        color: DOMAIN_META[d as keyof typeof DOMAIN_META]?.color ?? '#aaa',
                      }}
                    >
                      {n} <DomainIcon domain={d} />{' '}
                      {DOMAIN_META[d as keyof typeof DOMAIN_META]?.label ?? 'Power'}
                    </span>
                  ) : null,
                )}
              {isUnit(card) && (
                <span className="rounded bg-rose-500/20 px-2 py-0.5 font-mono text-rose-300">
                  {card.might} Might
                </span>
              )}
            </div>
          )}

          {keywordLabels(card).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {keywordLabels(card).map((k) => {
                const d = keywordDef(k)
                return (
                  <span
                    key={k}
                    title={d}
                    className={`rounded bg-sky-600/90 px-2 py-0.5 text-xs font-semibold text-white shadow-sm ${
                      d ? 'cursor-help' : ''
                    }`}
                  >
                    {k}
                  </span>
                )
              })}
            </div>
          )}
          {card.text && (
            <p className="whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-sm leading-relaxed text-white/80">
              <CardText text={card.text} />
            </p>
          )}
          {card.flavor && (
            <p className="text-sm italic text-white/45">
              <CardText text={card.flavor} />
            </p>
          )}

          {card.tags && card.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {card.tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-white/5 px-2 py-0.5 text-xs text-white/50"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {card.artist && (
            <p className="text-xs text-white/30">Illustration: {card.artist}</p>
          )}
        </div>
      </div>
    </div>
  )
}
