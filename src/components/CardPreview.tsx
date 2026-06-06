import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCard } from '../data/cards'
import { type Card, isUnit } from '../types/cards'
import { keywordLabels, keywordDef } from '../engine/keywords'
import CardText from './CardText'

// Hover-to-zoom. Wraps any board/hand card; after a short delay it shows a
// large preview (full art + rules + keyword tooltips). Default mode floats the
// preview beside the hovered card (viewport-clamped so it never overflows).
// `center` mode (used for HAND cards, whose long text is hard to read in a side
// float) instead shows the preview in the middle of the screen and slowly dims
// the background. Pure CSS/React; `display: contents` keeps layout untouched.

function CardFace({ card }: { card: Card }) {
  const labels = keywordLabels(card)
  // Battlefield cards are landscape; everything else is the portrait 744/1039.
  const ratio = card.type === 'battlefield' ? '1039/744' : '744/1039'
  return (
    <>
      {card.imageUrl ? (
        <img src={card.imageUrl} alt={card.name} className="w-full" style={{ aspectRatio: ratio, objectFit: 'cover' }} />
      ) : (
        <div className="flex w-full items-center justify-center bg-[#0a1e33] p-4 text-center text-sm" style={{ aspectRatio: ratio }}>
          {card.name}
        </div>
      )}
      <div className="space-y-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold">{card.name}</span>
          {isUnit(card) && (
            <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-xs text-rose-300">{card.might}⚔</span>
          )}
        </div>
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {labels.map((k) => {
              const d = keywordDef(k)
              return (
                <span key={k} title={d} className="rounded bg-sky-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                  {k}
                </span>
              )
            })}
          </div>
        )}
        {card.text && (
          <p className="rounded bg-black/30 p-1.5 text-[12px] leading-snug text-white/80">
            <CardText text={card.text} />
          </p>
        )}
      </div>
    </>
  )
}

function PreviewPanel({ card, anchor, center }: { card: Card; anchor: DOMRect; center?: boolean }) {
  // Centered mode (hand cards): middle of the screen + a slow background dim so
  // long rules text is fully readable. ~10% larger than the side float.
  if (center) {
    const W = Math.min(Math.floor(window.innerWidth * 0.9), 400)
    return createPortal(
      <>
        <div className="dim-in pointer-events-none fixed inset-0 z-[64] bg-black" style={{ opacity: 0.5 }} />
        <div
          className="fx-play pointer-events-none fixed left-1/2 top-1/2 z-[65] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-amber-400/40 bg-[#0d111c] shadow-2xl"
          style={{ width: W }}
        >
          <CardFace card={card} />
        </div>
      </>,
      document.body,
    )
  }

  const margin = 12
  // Viewport-adaptive width (+10% over the prior size): readable but never wider
  // than ~31vw, with a small floor so it stays usable on narrow screens.
  const W = Math.max(154, Math.min(352, Math.floor(window.innerWidth * 0.308)))
  // Prefer the right side; flip left if it would overflow; else pin to margin.
  const spaceRight = window.innerWidth - anchor.right
  const spaceLeft = anchor.left
  const rawLeft =
    spaceRight >= W + margin
      ? anchor.right + margin
      : spaceLeft >= W + margin
        ? anchor.left - W - margin
        : margin
  // Final clamp so it never overflows the right edge either.
  const left = Math.min(rawLeft, window.innerWidth - W - margin)
  // Vertically clamp so the panel stays on screen. Height is derived from the
  // card aspect ratio (battlefields are landscape) plus the text block below it.
  const imgH = Math.round(W * (card.type === 'battlefield' ? 744 / 1039 : 1039 / 744))
  const approxH = imgH + 110
  const top = Math.min(
    Math.max(margin, anchor.top - 40),
    Math.max(margin, window.innerHeight - approxH - margin),
  )
  return createPortal(
    <div
      className="pointer-events-none fixed z-[65] overflow-hidden rounded-xl border border-amber-400/40 bg-[#0d111c] shadow-2xl fx-play"
      style={{ left, top, width: W }}
    >
      <CardFace card={card} />
    </div>,
    document.body,
  )
}

export default function CardPreview({
  cardId,
  children,
  delay = 220,
  center = false,
}: {
  cardId: string
  children: React.ReactNode
  delay?: number
  /** Show the preview centered in the screen + dim the background (hand cards). */
  center?: boolean
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const card = getCard(cardId)
  if (!card) return <>{children}</>

  const show = () => {
    timer.current = setTimeout(() => {
      const el = ref.current?.firstElementChild ?? ref.current
      if (el) setAnchor(el.getBoundingClientRect())
    }, delay)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setAnchor(null)
  }

  return (
    <span ref={ref} style={{ display: 'contents' }} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {anchor && <PreviewPanel card={card} anchor={anchor} center={center} />}
    </span>
  )
}
