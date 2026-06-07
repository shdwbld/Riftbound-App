import { useEffect, useRef, useState } from 'react'
import { getCard } from '../data/cards'

// Non-blocking move-back-to-base / recall flourish. For each recalled (or bounced)
// card it floats a copy where the unit WAS (a source rect captured at click time,
// when available) or where it now LIVES, pulses a blue ring (~6s), then spins,
// lifts, and flies to the card's real board home ([data-iid]) over ~2s before
// vanishing — the engine already moved the real card, so this is purely cosmetic
// and per-client. A centered "Skip animation" button ends it immediately for
// anyone who clicks it. Honors the settings → Recall animation toggle (gated by
// the caller). Multiple units animate simultaneously.

export interface RecallItem {
  iid: string
  cardId: string
  /** Viewport rect of the card BEFORE it moved (captured at click); null = start
   *  at the card's current board home (engine-driven recalls / bounces). */
  srcRect?: { left: number; top: number; width: number; height: number } | null
}

const PULSE_MS = 6000
const FLY_MS = 2000

export default function RecallAnimation({ seq, items, onDone }: { seq: number; items: RecallItem[]; onDone: () => void }) {
  const [phase, setPhase] = useState<'hidden' | 'pulse' | 'fly'>('hidden')
  const [seenSeq, setSeenSeq] = useState(-1)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const homeRectRef = useRef<(DOMRect | null)[]>([])
  const finished = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const finish = () => {
    if (finished.current) return
    finished.current = true
    setPhase('hidden')
    onDoneRef.current()
  }

  // Run the fly: each floating card animates from its current spot to its real
  // board home; if it has no distinct home (start ≈ home) it spins + lands in place.
  const startFly = () => {
    setPhase('fly')
    items.forEach((_, i) => {
      const el = cardRefs.current[i]
      if (!el) return
      const a = el.getBoundingClientRect()
      const home = homeRectRef.current[i]
      if (home && (home.width || home.height) && Math.hypot(home.left - a.left, home.top - a.top) > 8) {
        const dx = home.left + home.width / 2 - (a.left + a.width / 2)
        const dy = home.top + home.height / 2 - (a.top + a.height / 2)
        const scale = Math.max(0.05, home.width / a.width)
        el.animate(
          [
            { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 18}px) scale(${(1 + scale) / 2}) rotate(200deg)`, opacity: 1, offset: 0.55 },
            { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(360deg)`, opacity: 0 },
          ],
          { duration: FLY_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
        )
      } else {
        el.classList.add('recall-land')
      }
    })
    window.setTimeout(finish, FLY_MS)
  }

  useEffect(() => {
    if (!items.length || seq < 0 || seq === seenSeq) return
    setSeenSeq(seq)
    finished.current = false
    // Snapshot each card's real board home NOW (the engine already placed it there).
    homeRectRef.current = items.map((it) => {
      const node = document.querySelector(`[data-iid="${CSS.escape(it.iid)}"]`) as HTMLElement | null
      return node ? node.getBoundingClientRect() : null
    })
    setPhase('pulse')
    const t1 = window.setTimeout(startFly, PULSE_MS)
    return () => window.clearTimeout(t1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  if (phase === 'hidden' || !items.length) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[61]">
      {items.map((it, i) => {
        const card = getCard(it.cardId)
        // Start position: the captured source rect, else the card's current home.
        const start = it.srcRect ?? homeRectRef.current[i]
        if (!card || !start) return null
        return (
          <div
            key={`${it.iid}-${i}`}
            ref={(el) => { cardRefs.current[i] = el }}
            className={`fixed overflow-hidden rounded-lg shadow-2xl ${phase === 'pulse' ? 'recall-pulse' : ''}`}
            style={{ left: start.left, top: start.top, width: start.width, height: start.height, willChange: 'transform, opacity' }}
          >
            {card.imageUrl ? (
              <img src={card.imageUrl} alt={card.name} className="block h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-[#0a1e33] text-center text-[8px] text-white/80">{card.name}</div>
            )}
          </div>
        )
      })}
      {/* Centered, dismissible-by-anyone skip control. */}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
        <button
          onClick={finish}
          className="pointer-events-auto rounded-full border border-sky-300/40 bg-black/70 px-4 py-1.5 text-xs font-semibold text-sky-100 shadow-lg backdrop-blur hover:bg-black/85"
        >
          ⏭ Skip animation
        </button>
      </div>
    </div>
  )
}
