import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCard } from '../data/cards'
import { type Card, isUnit } from '../types/cards'
import { keywordLabels, keywordDef } from '../engine/keywords'
import CardText from './CardText'

// Hover-to-zoom. Wraps any board/hand card; after a short delay it shows a
// large, fixed-position preview (full art + rules + keyword tooltips) beside the
// hovered card. Pure CSS/React, coordinate-aware only via the anchor rect so it
// never overflows the viewport. `display: contents` keeps layout untouched.

function PreviewPanel({ card, anchor }: { card: Card; anchor: DOMRect }) {
  const W = 240
  const margin = 12
  // Prefer the right side; flip left if it would overflow.
  const spaceRight = window.innerWidth - anchor.right
  const left =
    spaceRight > W + margin ? anchor.right + margin : Math.max(margin, anchor.left - W - margin)
  // Vertically clamp so the panel stays on screen.
  const approxH = 420
  const top = Math.min(
    Math.max(margin, anchor.top - 40),
    Math.max(margin, window.innerHeight - approxH - margin),
  )
  const labels = keywordLabels(card)
  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] overflow-hidden rounded-xl border border-amber-400/40 bg-[#0d111c] shadow-2xl fx-play"
      style={{ left, top, width: W }}
    >
      {card.imageUrl ? (
        <img
          src={card.imageUrl}
          alt={card.name}
          className="w-full"
          style={{ aspectRatio: '744/1039', objectFit: 'cover' }}
        />
      ) : (
        <div
          className="flex w-full items-center justify-center bg-[#1c1c28] p-4 text-center text-sm"
          style={{ aspectRatio: '744/1039' }}
        >
          {card.name}
        </div>
      )}
      <div className="space-y-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold">{card.name}</span>
          {isUnit(card) && (
            <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-xs text-rose-300">
              {card.might}⚔
            </span>
          )}
        </div>
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {labels.map((k) => {
              const d = keywordDef(k)
              return (
                <span
                  key={k}
                  title={d}
                  className="rounded bg-sky-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
                >
                  {k}
                </span>
              )
            })}
          </div>
        )}
        {card.text && (
          <p className="rounded bg-black/30 p-1.5 text-[11px] leading-snug text-white/80">
            <CardText text={card.text} />
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}

export default function CardPreview({
  cardId,
  children,
  delay = 220,
}: {
  cardId: string
  children: React.ReactNode
  delay?: number
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
      {anchor && <PreviewPanel card={card} anchor={anchor} />}
    </span>
  )
}
