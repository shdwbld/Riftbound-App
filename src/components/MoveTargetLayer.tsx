import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Board zone-targeting mode for MOVE. Reads the tagged [data-movezone] elements and
// portals a dark scrim + glowing red target overlays over them (plus a Banished pill
// and a 3-band Main Deck). Overlay positions are updated IMPERATIVELY every frame so
// they stay glued to the real zones even when the board scrolls fast. Clicking a
// target dispatches the move.

type Rect = { left: number; top: number; width: number; height: number }
export type MoveDest = { toBattlefield?: number; toZone?: string; bottom?: boolean; value?: number }
interface Desc { key: string; label: string; dest: MoveDest }

const ZONE_LABEL: Record<string, string> = { base: 'Base', legend: 'Legend Zone', champion: 'Champion Zone', trash: 'Trash', mainDeck: 'Main Deck' }

export default function MoveTargetLayer({ name, cardIid, deckCount, onPick, onCancel }: {
  name: string
  cardIid: string
  deckCount: number
  onPick: (d: MoveDest) => void
  onCancel: () => void
}) {
  const [insert, setInsert] = useState<{ rect: Rect; value: number } | null>(null)
  const zoneRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const bandRefs = useRef<(HTMLButtonElement | null)[]>([])
  const glowRef = useRef<HTMLDivElement | null>(null)

  // The set of destinations is fixed for the duration of the mode; only their on-screen
  // rects move (with scroll), so capture the structure once and re-position each frame.
  const descs = useMemo<Desc[]>(() => {
    const out: Desc[] = []
    document.querySelectorAll('[data-movezone]').forEach((n) => {
      const key = n.getAttribute('data-movezone')!
      if (key.startsWith('battlefield-')) {
        const i = parseInt(key.slice('battlefield-'.length), 10)
        out.push({ key, label: `Battlefield ${i + 1}`, dest: { toBattlefield: i } })
      } else if (key === 'mainDeck') {
        out.push({ key, label: 'Main Deck', dest: { toZone: 'mainDeck' } })
      } else {
        out.push({ key, label: ZONE_LABEL[key] ?? key, dest: { toZone: key } })
      }
    })
    return out
  }, [])
  const zones = descs.filter((d) => d.key !== 'mainDeck')
  const deck = descs.find((d) => d.key === 'mainDeck')

  // Imperative per-frame repositioning (no React re-render → no scroll lag).
  useEffect(() => {
    let raf = 0
    const place = (node: HTMLElement, r: DOMRect) => {
      node.style.display = 'block'
      node.style.left = `${r.left}px`
      node.style.top = `${r.top}px`
      node.style.width = `${r.width}px`
      node.style.height = `${r.height}px`
    }
    const tick = () => {
      zoneRefs.current.forEach((node, key) => {
        const r = document.querySelector(`[data-movezone="${key}"]`)?.getBoundingClientRect()
        if (!r || !r.width || !r.height) { node.style.display = 'none'; return }
        place(node, r)
      })
      // Main Deck → three stacked bands.
      const dr = document.querySelector('[data-movezone="mainDeck"]')?.getBoundingClientRect()
      if (dr && dr.width && dr.height && !insert) {
        const bh = dr.height / 3
        bandRefs.current.forEach((b, i) => {
          if (!b) return
          b.style.display = 'block'
          b.style.left = `${dr.left}px`
          b.style.top = `${dr.top + i * bh}px`
          b.style.width = `${dr.width}px`
          b.style.height = `${bh}px`
        })
      } else {
        bandRefs.current.forEach((b) => { if (b) b.style.display = 'none' })
      }
      // Gold glow on the card being moved.
      const cr = document.querySelector(`[data-iid="${CSS.escape(cardIid)}"]`)?.getBoundingClientRect()
      if (glowRef.current) {
        if (cr && cr.width && cr.height) {
          glowRef.current.style.display = 'block'
          glowRef.current.style.left = `${cr.left - 3}px`
          glowRef.current.style.top = `${cr.top - 3}px`
          glowRef.current.style.width = `${cr.width + 6}px`
          glowRef.current.style.height = `${cr.height + 6}px`
        } else glowRef.current.style.display = 'none'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cardIid, insert])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal(
    <div className="fixed inset-0 z-[70]" onContextMenu={(e) => { e.preventDefault(); onCancel() }}>
      {/* Dark scrim — clicking it (off any target) cancels. */}
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onCancel} />

      {/* Floating instruction label. */}
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-sm font-semibold text-white shadow-lg">
        Move <span className="text-amber-300">{name}</span> → select a destination
        <span className="ml-2 text-[11px] font-normal text-white/45">Esc / right-click to cancel</span>
      </div>

      {/* Gold pulsing outline on the card being moved. */}
      <div ref={glowRef} className="move-card-glow pointer-events-none absolute rounded-lg" style={{ display: 'none' }} />

      {/* Simple single-click zone targets. */}
      {zones.map((t) => (
        <button
          key={t.key}
          ref={(el) => { if (el) zoneRefs.current.set(t.key, el); else zoneRefs.current.delete(t.key) }}
          className="move-target absolute rounded-lg"
          style={{ display: 'none' }}
          onClick={(e) => { e.stopPropagation(); onPick(t.dest) }}
        >
          <span className="move-target-tip">{t.label}</span>
        </button>
      ))}

      {/* Main Deck — three clickable bands (top / choose position / bottom). */}
      {deck && (
        <>
          <button ref={(el) => { bandRefs.current[0] = el }} className="move-target absolute" style={{ display: 'none', borderRadius: '0.5rem 0.5rem 0 0' }} onClick={(e) => { e.stopPropagation(); onPick({ toZone: 'mainDeck' }) }}>
            <span className="move-target-tip text-[10px]">Top of deck</span>
          </button>
          <button ref={(el) => { bandRefs.current[1] = el }} className="move-target absolute" style={{ display: 'none' }} onClick={(e) => { e.stopPropagation(); const r = document.querySelector('[data-movezone="mainDeck"]')?.getBoundingClientRect(); if (r) setInsert({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, value: 0 }) }}>
            <span className="move-target-tip text-[10px]">Choose position…</span>
          </button>
          <button ref={(el) => { bandRefs.current[2] = el }} className="move-target absolute" style={{ display: 'none', borderRadius: '0 0 0.5rem 0.5rem' }} onClick={(e) => { e.stopPropagation(); onPick({ toZone: 'mainDeck', bottom: true }) }}>
            <span className="move-target-tip text-[10px]">Bottom of deck</span>
          </button>
        </>
      )}

      {/* Insert-at-position popup over the deck. */}
      {insert && (
        <div
          className="absolute w-44 rounded-xl border border-red-400/50 bg-[#0a1422]/97 p-3 shadow-2xl"
          style={{ left: Math.min(insert.rect.left, window.innerWidth - 184), top: Math.min(insert.rect.top, window.innerHeight - 150) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 text-center text-[11px] text-white/70">Insert at position</div>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setInsert({ ...insert, value: Math.max(0, insert.value - 1) })} className="h-7 w-7 rounded bg-white/10 text-base font-bold hover:bg-white/20">−</button>
            <input type="number" value={insert.value} onChange={(e) => setInsert({ ...insert, value: Math.max(0, parseInt(e.target.value, 10) || 0) })} className="w-14 rounded bg-black/40 px-2 py-1 text-center text-sm font-bold tabular-nums outline-none ring-1 ring-white/15 focus:ring-red-400/60" />
            <button onClick={() => setInsert({ ...insert, value: insert.value + 1 })} className="h-7 w-7 rounded bg-white/10 text-base font-bold hover:bg-white/20">+</button>
          </div>
          <div className="mt-1 text-center text-[10px] text-white/40">from top, {deckCount} cards</div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => onPick({ toZone: 'mainDeck', value: insert.value })} className="flex-1 rounded bg-red-500/30 px-2 py-1 text-xs font-semibold hover:bg-red-500/50">Confirm</button>
            <button onClick={() => setInsert(null)} className="flex-1 rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">Cancel</button>
          </div>
        </div>
      )}

      {/* Banished — no board zone; a pill at the top-right edge. */}
      <button
        className="move-target absolute right-4 top-14 rounded-full px-4 py-2 text-xs font-bold tracking-wide"
        onClick={(e) => { e.stopPropagation(); onPick({ toZone: 'banished' }) }}
        title="Move to Banished"
      >
        BANISHED
      </button>
    </div>,
    document.body,
  )
}
