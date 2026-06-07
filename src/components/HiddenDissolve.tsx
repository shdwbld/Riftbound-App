import { useEffect, useState } from 'react'
import CardBack from './CardBack'

// A quick dissolve where a Hidden (face-down) card used to sit, when it's auto-
// trashed for losing its battlefield. Shows the card-back only (identity stays
// secret even as it's destroyed). Non-blocking; self-clears after the animation.
export interface DissolveItem { iid: string; rect: { left: number; top: number; width: number; height: number } }

export default function HiddenDissolve({ seq, items, onDone }: { seq: number; items: DissolveItem[]; onDone: () => void }) {
  const [show, setShow] = useState(false)
  const [seen, setSeen] = useState(-1)
  useEffect(() => {
    if (!items.length || seq < 0 || seq === seen) return
    setSeen(seq)
    setShow(true)
    const t = setTimeout(() => { setShow(false); onDone() }, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])
  if (!show || !items.length) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden>
      {items.map((it, i) => (
        <div
          key={`${it.iid}-${i}`}
          className="hidden-dissolve fixed flex items-center justify-center"
          style={{ left: it.rect.left, top: it.rect.top, width: it.rect.width, height: it.rect.height }}
        >
          <CardBack size="sm" />
          <span className="absolute -right-1 -top-1 rounded-full bg-amber-500/90 px-1 text-[9px] font-bold text-black shadow">🙈</span>
        </div>
      ))}
    </div>
  )
}
