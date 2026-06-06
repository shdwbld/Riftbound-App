import { useEffect, useRef, useState } from 'react'
import type { GameEvent } from '../engine/types'

// Draws a brief, fading cause→effect arc from the acting card to each unit it
// hits in the same events batch (a played unit's on-enter effect, a unit's
// activated ability). Mounted as a fixed, pointer-events-none sibling OUTSIDE the
// board's scale transform, so getBoundingClientRect()'s post-transform viewport
// coordinates map 1:1 to this SVG's pixel coordinate system.
//
// Source/target are inferred from one batch with no engine change: targets are
// the damaged/defeated iids; the source is the play/counter card if it still has
// a board node (spells resolve to the trash, so spell arcs are skipped for now).

interface Arc {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
}

function nodeCenter(iid: string): { x: number; y: number } | null {
  const el = document.querySelector(`[data-iid="${CSS.escape(iid)}"]`)
  if (!el) return null
  const r = (el as HTMLElement).getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export default function ConnectorArcLayer({
  events,
  seq,
}: {
  events: GameEvent[] | undefined
  seq: number
}) {
  const [arcs, setArcs] = useState<Arc[]>([])
  const idRef = useRef(0)
  const lastSeq = useRef(-1)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    if (seq === lastSeq.current) return
    lastSeq.current = seq
    if (!events?.length) return

    const targetIids = Array.from(
      new Set(events.filter((e) => (e.kind === 'damage' || e.kind === 'defeat') && e.iid).map((e) => e.iid!)),
    )
    if (!targetIids.length) return

    // Prefer a play/counter source; else any non-target event iid with a node.
    const sourceCandidates = [
      ...events.filter((e) => (e.kind === 'play' || e.kind === 'counter') && e.iid).map((e) => e.iid!),
      ...events.filter((e) => e.iid && !targetIids.includes(e.iid!)).map((e) => e.iid!),
    ]

    // Measure after layout settles so post-transform rects are final.
    const raf = requestAnimationFrame(() => {
      let src: { x: number; y: number } | null = null
      for (const iid of sourceCandidates) {
        src = nodeCenter(iid)
        if (src) break
      }
      if (!src) return
      const next: Arc[] = []
      for (const tid of targetIids) {
        const t = nodeCenter(tid)
        if (!t || (t.x === src.x && t.y === src.y)) continue
        const dist = Math.hypot(t.x - src.x, t.y - src.y)
        next.push({
          id: idRef.current++,
          x1: src.x,
          y1: src.y,
          x2: t.x,
          y2: t.y,
          cx: (src.x + t.x) / 2,
          cy: (src.y + t.y) / 2 - Math.min(140, dist * 0.25),
        })
      }
      if (!next.length) return
      setArcs((prev) => [...prev, ...next])
      const ids = new Set(next.map((a) => a.id))
      timers.current.push(setTimeout(() => setArcs((prev) => prev.filter((a) => !ids.has(a.id))), 950))
    })
    return () => cancelAnimationFrame(raf)
  }, [seq, events])

  if (!arcs.length) return null
  return (
    <svg className="pointer-events-none fixed inset-0 z-[65]" width="100%" height="100%" aria-hidden>
      <defs>
        <linearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(125,211,252,0.25)" />
          <stop offset="100%" stopColor="rgba(245,158,11,0.95)" />
        </linearGradient>
      </defs>
      {arcs.map((a) => (
        <g key={a.id}>
          <path
            className="fx-arc"
            d={`M ${a.x1} ${a.y1} Q ${a.cx} ${a.cy} ${a.x2} ${a.y2}`}
            fill="none"
            stroke="url(#arcGrad)"
            strokeWidth={3}
            pathLength={1}
            strokeLinecap="round"
          />
          <circle className="fx-arc-tip" cx={a.x2} cy={a.y2} r={7} fill="rgba(245,158,11,0.9)" />
        </g>
      ))}
    </svg>
  )
}
