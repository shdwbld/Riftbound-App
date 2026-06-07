import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Drag-to-play overlay. A hand card lifts off and follows the cursor with velocity-
// based physics tilt; valid drop zones glow (GREEN when override is off = a legal
// play, RED when override is on = "turn off Override first"). Dragging to the top/
// bottom edge auto-pans (scrolls) the board so off-screen battlefields are reachable.
// Dropping on a green zone fires the normal play flow; anything else snaps back.

type Rect = { left: number; top: number; width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const EDGE = 90 // px from top/bottom where auto-pan kicks in
const PAN_SPEED = 16 // px/frame at the very edge

export default function DragPlayLayer({ name, imageUrl, start, origin, zones, active, zoneLabel, onDrop, onCancel }: {
  name: string
  imageUrl?: string
  start: { x: number; y: number }
  origin: Rect
  zones: string[] // candidate zone keys to highlight
  active: boolean // true = playable (green, droppable); false = blocked (red, warns)
  zoneLabel: (key: string) => string
  onDrop: (zoneKey: string) => void
  onCancel: () => void
}) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const pointer = useRef({ x: start.x, y: start.y })
  const vel = useRef({ x: 0, y: 0 })
  const rot = useRef({ x: 0, z: 0 })
  const scale = useRef(1.12)
  const hoverRef = useRef<string | null>(null)
  const done = useRef(false)
  const zoneRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [returning, setReturning] = useState(false)

  // Snap the lifted card back to its hand slot, then unmount.
  const snapBack = () => {
    if (done.current) return
    done.current = true
    setReturning(true)
    const el = cardRef.current
    if (el) {
      el.style.transition = 'transform 360ms cubic-bezier(0.34,1.56,0.64,1)'
      el.style.transform = `translate3d(${origin.left}px, ${origin.top}px, 0) scale(1) rotateX(0deg) rotateZ(0deg)`
    }
    setTimeout(onCancel, 360)
  }

  // Pointer + key tracking. The rAF loop owns the visuals so the card stays smooth.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      vel.current = { x: e.clientX - pointer.current.x, y: e.clientY - pointer.current.y }
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    const onUp = () => {
      if (done.current) return
      const hv = hoverRef.current
      if (active && hv && zones.includes(hv)) { done.current = true; onDrop(hv) }
      else snapBack()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); snapBack() } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let raf = 0
    const w = origin.width
    const h = origin.height
    const tint = active ? '52,211,153' : '220,80,80'
    const tick = () => {
      if (!done.current) {
        const p = pointer.current
        // Edge auto-pan: near the top/bottom edge, scroll the board (window) so the
        // player can reach off-screen zones while still holding the card.
        const vh = window.innerHeight
        if (p.y < EDGE) window.scrollBy(0, -PAN_SPEED * (1 - p.y / EDGE))
        else if (p.y > vh - EDGE) window.scrollBy(0, PAN_SPEED * (1 - (vh - p.y) / EDGE))

        // Which zone is the card's center over? (measured this same frame)
        const cx = p.x
        const cy = p.y - 10
        let hv: string | null = null

        // Re-measure candidate zones and position the overlays IMPERATIVELY each frame
        // (no React re-render → no one-frame lag when scrolling/panning fast).
        zoneRefs.current.forEach((node, key) => {
          const src = document.querySelector(`[data-movezone="${key}"]`)
          const r = src?.getBoundingClientRect()
          if (!r || !r.width || !r.height) { node.style.display = 'none'; return }
          node.style.display = 'block'
          node.style.left = `${r.left}px`
          node.style.top = `${r.top}px`
          node.style.width = `${r.width}px`
          node.style.height = `${r.height}px`
          if (hv == null && cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height) hv = key
        })
        // Apply hover emphasis imperatively too.
        zoneRefs.current.forEach((node, key) => {
          const on = key === hv
          node.style.background = `rgba(${tint},${on ? 0.34 : 0.18})`
          node.style.boxShadow = `inset 0 0 0 2px rgba(${tint},${on ? 0.95 : 0.6})`
          node.style.transform = on ? 'scale(1.02)' : 'scale(1)'
        })
        hoverRef.current = hv

        // Velocity → tilt (decay velocity each frame so it settles when still).
        vel.current.x *= 0.82
        vel.current.y *= 0.82
        const over = active && hv != null
        const targetZ = clamp(vel.current.x * 0.5, -18, 18)
        const targetX = clamp(vel.current.y * 0.3, -10, 10)
        const lerp = over ? 0.35 : 0.14 // settle flatter quickly when landing on a zone
        rot.current.z += (targetZ - rot.current.z) * lerp
        rot.current.x += (targetX - rot.current.x) * lerp
        const targetScale = over ? 1.06 : 1.12
        scale.current += (targetScale - scale.current) * 0.2

        const el = cardRef.current
        if (el) {
          el.style.transform =
            `translate3d(${p.x - w / 2}px, ${p.y - h / 2 - 10}px, 0) ` +
            `scale(${scale.current.toFixed(3)}) rotateX(${rot.current.x.toFixed(2)}deg) rotateZ(${rot.current.z.toFixed(2)}deg)`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tint = active ? '52,211,153' : '220,80,80' // emerald vs red

  return createPortal(
    <div className="fixed inset-0 z-[70]" style={{ perspective: '900px' }}>
      {/* Scrim so the dragged card and the glowing zones pop. */}
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.40)' }} />

      {/* Candidate drop zones — stable nodes; the rAF loop positions them imperatively
          so they stay glued to the board even when scrolling/panning fast. */}
      {zones.map((key) => (
        <div
          key={key}
          ref={(el) => { if (el) zoneRefs.current.set(key, el); else zoneRefs.current.delete(key) }}
          className="absolute rounded-lg"
          style={{
            left: 0, top: 0, width: 0, height: 0, display: 'none',
            background: `rgba(${tint},0.18)`,
            boxShadow: `inset 0 0 0 2px rgba(${tint},0.6)`,
          }}
        >
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold text-white shadow-lg"
            style={{ background: `rgba(${tint},0.92)` }}
          >
            {active ? `Play to ${zoneLabel(key)}` : 'Turn off Override to play'}
          </span>
        </div>
      ))}

      {/* Hint when there is nowhere legal to drop. */}
      {zones.length === 0 && (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-sm font-semibold text-white/80 shadow-lg">
          Can't play <span className="text-amber-300">{name}</span> right now
        </div>
      )}

      {/* The lifted card following the cursor (transform driven imperatively). */}
      <div
        ref={cardRef}
        className="pointer-events-none absolute left-0 top-0 overflow-hidden rounded-lg shadow-2xl"
        style={{
          width: origin.width, height: origin.height,
          transformOrigin: 'center center',
          transformStyle: 'preserve-3d',
          boxShadow: '0 24px 48px rgba(0,0,0,0.65)',
          // Start at the cursor; rAF takes over on the next frame.
          transform: `translate3d(${start.x - origin.width / 2}px, ${start.y - origin.height / 2 - 10}px, 0) scale(1.12)`,
          opacity: returning ? 0.95 : 1,
          willChange: 'transform',
        }}
      >
        {imageUrl
          ? <img src={imageUrl} alt={name} className="h-full w-full object-cover" draggable={false} />
          : <div className="flex h-full w-full items-center justify-center bg-[#16223a] p-2 text-center text-xs font-semibold text-white">{name}</div>}
      </div>
    </div>,
    document.body,
  )
}
