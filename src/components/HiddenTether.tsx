import { useLayoutEffect, useState } from 'react'

// A faint glowing line from a hovered Hidden (face-down) card to each unit that is
// currently holding its battlefield — visualizing the "if you lose this tile, the
// trap is destroyed" tether. Pure overlay: measures live [data-iid] rects so it
// aligns through the board's fit-to-viewport transform. Renders nothing when idle.
export default function HiddenTether({ sourceIid, targetIids }: { sourceIid: string | null; targetIids: string[] }) {
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([])
  const key = targetIids.join(',')
  useLayoutEffect(() => {
    if (!sourceIid) { setLines([]); return }
    const src = document.querySelector(`[data-iid="${CSS.escape(sourceIid)}"]`) as HTMLElement | null
    if (!src) { setLines([]); return }
    const a = src.getBoundingClientRect()
    const sx = a.left + a.width / 2
    const sy = a.top + a.height / 2
    const out: { x1: number; y1: number; x2: number; y2: number }[] = []
    for (const t of targetIids) {
      if (t === sourceIid) continue
      const n = document.querySelector(`[data-iid="${CSS.escape(t)}"]`) as HTMLElement | null
      if (!n) continue
      const b = n.getBoundingClientRect()
      out.push({ x1: sx, y1: sy, x2: b.left + b.width / 2, y2: b.top + b.height / 2 })
    }
    setLines(out)
  }, [sourceIid, key])
  if (!sourceIid || !lines.length) return null
  return (
    <svg className="pointer-events-none fixed inset-0 z-[55] h-full w-full" aria-hidden>
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="rgba(251,191,36,0.75)" strokeWidth={2} strokeLinecap="round" strokeDasharray="6 5"
          className="hidden-tether"
        />
      ))}
    </svg>
  )
}
