import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getCard } from '../data/cards'
import type { Action, PlayerId } from '../engine/types'
import type { SearchSource } from './CardSearchOverlay'
import MenuIcon, { type IconKey } from './MenuIcon'
import { annularSectorPath, polarToCartesian, splitIcon, wedgeAngles } from '../lib/radialGeometry'

// Colour + icon coding for branch (sub-slice) items, inferred from the label so the
// player reads intent at a glance: destructive=red, exhaust/stun=amber, buff/heal=green,
// move/bounce=sky, reveal/hide=violet, control=fuchsia, resources=yellow.
function itemStyle(label: string, fallback: IconKey): { icon: IconKey; color: string; ring: string } {
  const t = label.toLowerCase()
  const mk = (icon: IconKey, color: string, ring: string) => ({ icon, color, ring })
  if (/\b(kill|destroy|banish|sacrifice|remove|trash)\b/.test(t)) return mk('kill', 'text-rose-400', 'border-rose-400/50')
  if (/recycle/.test(t)) return mk('recycle', 'text-orange-400', 'border-orange-400/50')
  if (/exhaust/.test(t)) return mk('stun', 'text-amber-300', 'border-amber-300/50')
  if (/stun/.test(t)) return mk('stun', 'text-amber-300', 'border-amber-300/50')
  if (/\b(ready|wake|unexhaust)\b/.test(t)) return mk('check', 'text-emerald-400', 'border-emerald-400/50')
  if (/(buff|\+\s*might|heal|\bmighty\b|shield|tank|deflect)/.test(t)) return mk('buff', 'text-emerald-400', 'border-emerald-400/50')
  if (/(-\s*might|damage|wound)/.test(t)) return mk('bolt', 'text-rose-300', 'border-rose-300/50')
  if (/(bounce|to hand|return)/.test(t)) return mk('back', 'text-sky-300', 'border-sky-300/50')
  if (/\bmove\b/.test(t)) return mk('move', 'text-sky-300', 'border-sky-300/50')
  if (/reveal/.test(t)) return mk('eye', 'text-violet-300', 'border-violet-300/50')
  if (/(hide|face\s*down|hidden)/.test(t)) return mk('eyeOff', 'text-violet-300', 'border-violet-300/50')
  if (/(draw|channel|deck)/.test(t)) return mk('layers', 'text-sky-300', 'border-sky-300/50')
  if (/(equip|attach|gear)/.test(t)) return mk('equip', 'text-amber-200', 'border-amber-200/50')
  if (/detach/.test(t)) return mk('detach', 'text-amber-200', 'border-amber-200/50')
  if (/(gold|power|coin|rune|energy)/.test(t)) return mk('coin', 'text-yellow-300', 'border-yellow-300/50')
  if (/(control|conquer)/.test(t)) return mk('control', 'text-fuchsia-300', 'border-fuchsia-300/50')
  if (/owner/.test(t)) return mk('control', 'text-fuchsia-300', 'border-fuchsia-300/50')
  if (/(search|tutor|find)/.test(t)) return mk('search', 'text-sky-300', 'border-sky-300/50')
  return mk(fallback, 'text-white/85', 'border-white/25')
}

// Shared menu data model (the MatchBoard builders produce these).
export type MenuItem = {
  label: string
  action?: Action
  activateIid?: string
  attachGearIid?: string
  moveGearIid?: { gearIid: string; fromUnitIid: string; owner: PlayerId }
  stepper?: { title: string; make: (n: number) => Action }
  openSearch?: { source: SearchSource; owner: PlayerId }
  /** Enter board move-targeting mode instead of dispatching (Move). */
  boardMove?: { iid: string; owner: PlayerId; name: string }
}
/** A single stat the Modify panel can adjust (toggle-chip + a − [value] + stepper). */
export interface ModifyStat { key: string; label: string; icon?: IconKey; current?: number; make: (n: number) => Action }
/** `direct` groups skip the branch list — clicking the wedge runs its first item. */
export type MenuGroup = { label: string; items: MenuItem[]; modify?: ModifyStat[]; direct?: boolean }
/** What sits in the donut's hollow center (the menu's target). */
export interface RadialCenter { cardId?: string; faceDown?: boolean; label?: string; iconKey?: IconKey }

interface Wedge { key: string; label: string; iconKey: IconKey; items: MenuItem[]; direct: boolean; modify?: ModifyStat[] }

// Broad-wedge bucketing for the large sandbox tree: several groups collapse into a
// few wedges so the donut stays readable (≤6).
const GROUP_WEDGE: Record<string, { key: string; label: string; icon: IconKey }> = {
  'Might & damage': { key: 'modify', label: 'Modify', icon: 'modify' },
  'Move to…': { key: 'move', label: 'Move', icon: 'move' },
  'Control battlefield': { key: 'control', label: 'Control', icon: 'control' },
  Owner: { key: 'control', label: 'Control', icon: 'control' },
  Remove: { key: 'destroy', label: 'Destroy', icon: 'kill' },
  Gear: { key: 'destroy', label: 'Destroy', icon: 'gear' },
  'Attached gear': { key: 'destroy', label: 'Destroy', icon: 'gear' },
  'Hidden card': { key: 'destroy', label: 'Destroy', icon: 'hidden' },
}

function buildWedges(items: MenuItem[], groups?: MenuGroup[], statuses?: MenuItem[]): Wedge[] {
  const sandbox = (groups && groups.length) || (statuses && statuses.length)
  if (!sandbox) {
    // Flat menu (normal play / zones / bf): each item is its own click-to-run wedge.
    return items.map((it, i) => {
      const { iconKey, title } = splitIcon(it.label)
      return { key: `i${i}`, label: title, iconKey, items: [it], direct: true }
    })
  }
  const wedges: Wedge[] = []
  if (items.length) wedges.push({ key: 'actions', label: 'Actions', iconKey: 'actions', items, direct: false })
  if (statuses?.length) wedges.push({ key: 'status', label: 'Status', iconKey: 'status', items: statuses, direct: false })
  const order: string[] = []
  const map = new Map<string, Wedge>()
  for (const g of groups ?? []) {
    const b = GROUP_WEDGE[g.label]
    const key = b?.key ?? g.label
    let w = map.get(key)
    if (!w) { w = { key, label: b?.label ?? g.label, iconKey: b?.icon ?? 'dot', items: [], direct: false }; map.set(key, w); order.push(key) }
    w.items.push(...g.items)
    if (g.modify) w.modify = g.modify
    if (g.direct) w.direct = true
  }
  for (const k of order) wedges.push(map.get(k)!)
  return wedges
}

const BRANCH_W = 220 // fixed popup width
const STEP_W = 176
const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)))

/** The Modify panel: pick a stat with the toggle chips, then dial the net change
 *  with − [value] + (type a number too). Applies via the same onStepperConfirm path. */
function ModifyPanel({ stats, onConfirm }: { stats: ModifyStat[]; onConfirm: (make: (n: number) => Action, n: number) => void }) {
  const [active, setActive] = useState(0)
  const [val, setVal] = useState(0)
  const stat = stats[Math.min(active, stats.length - 1)]
  const next = (stat.current ?? 0) + val
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {stats.map((s, i) => (
          <button
            key={s.key}
            onClick={() => { setActive(i); setVal(0) }}
            className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${i === active ? 'bg-sky-500/45 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
          >
            {s.icon && <MenuIcon name={s.icon} size={13} />}
            {s.label} <span className="text-white/40">({s.current ?? 0})</span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-center gap-2">
        <button onClick={() => setVal((v) => v - 1)} className="h-8 w-8 rounded bg-white/10 text-lg font-bold hover:bg-white/20">−</button>
        <input
          type="number"
          value={val}
          onChange={(e) => setVal(parseInt(e.target.value, 10) || 0)}
          className="w-16 rounded bg-black/40 px-2 py-1 text-center text-sm font-bold tabular-nums outline-none ring-1 ring-white/15 focus:ring-sky-400/60"
        />
        <button onClick={() => setVal((v) => v + 1)} className="h-8 w-8 rounded bg-white/10 text-lg font-bold hover:bg-white/20">+</button>
      </div>
      <div className="text-center text-[10px] text-white/50">{stat.label}: {stat.current ?? 0} → <span className="font-semibold text-white/80">{next}</span></div>
      <button
        onClick={() => onConfirm(stat.make, val)}
        disabled={val === 0}
        className="rounded bg-sky-500/30 px-3 py-1.5 text-center text-sm font-semibold hover:bg-sky-500/50 disabled:opacity-40"
      >
        Apply
      </button>
    </div>
  )
}

export default function RadialMenu({
  anchor, items, groups, statuses, center,
  onRun, onStepperConfirm, onSearch, onBoardMove, onClose,
}: {
  /** Where the user right-clicked; the donut opens here, clamped to fit the viewport. */
  anchor?: { x: number; y: number }
  items: MenuItem[]
  groups?: MenuGroup[]
  statuses?: MenuItem[]
  center?: RadialCenter
  onRun: (it: MenuItem) => void
  onStepperConfirm: (make: (n: number) => Action, n: number) => void
  onSearch: (s: { source: SearchSource; owner: PlayerId }) => void
  onBoardMove?: (m: { iid: string; owner: PlayerId; name: string }) => void
  onClose: () => void
}) {
  const wedges = useMemo(() => buildWedges(items, groups, statuses), [items, groups, statuses])
  const angles = useMemo(() => wedgeAngles(wedges.length), [wedges.length])
  const [selected, setSelected] = useState<number | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [stepper, setStepper] = useState<{ title: string; value: number; make: (n: number) => Action } | null>(null)
  const branchRef = useRef<HTMLDivElement | null>(null) // measured to vertically anchor the popup
  const [branchH, setBranchH] = useState(0)
  // Hover-intent: a short grace period bridges the gap from a slice to its popup, so
  // the preview doesn't vanish mid-travel. Hover previews; only a click pins.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined } }
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setHovered(null), 150) }
  useEffect(() => () => cancelClose(), [])
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); if (stepper) setStepper(null); else onClose(); return }
      if (!wedges.length) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setSelected((s) => ((s ?? -1) + 1) % wedges.length) }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setSelected((s) => ((s ?? 0) - 1 + wedges.length) % wedges.length) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wedges.length, stepper, onClose])
  // Measure the popup so it can be vertically anchored precisely (never below radial).
  useLayoutEffect(() => {
    setBranchH(branchRef.current ? branchRef.current.offsetHeight : 0)
  }, [selected, hovered, vp.w, vp.h, stepper])

  // Responsive radii so the donut always fits (even small windows).
  const R_OUTER = Math.max(110, Math.min(196, Math.min(vp.w, vp.h) / 2 - 36))
  const R_INNER = Math.round(R_OUTER * 0.53)
  const R_LABEL = (R_INNER + R_OUTER) / 2
  const pad = 14
  // Open near the cursor, but keep room on BOTH sides for the ~220px popup so it can
  // appear on the angle-based side without overlapping the donut or clipping (falls
  // back to centered on narrow screens). Y clamped to a band.
  const sideRoom = R_OUTER + 16 + BRANCH_W + 8
  const cx = clamp(anchor?.x ?? vp.w / 2, sideRoom, vp.w - sideRoom)
  const cy = clamp(anchor?.y ?? vp.h / 2, R_OUTER + pad, vp.h - R_OUTER - pad)

  const handleItem = (it: MenuItem) => {
    if (it.boardMove) { onBoardMove?.(it.boardMove); return }
    if (it.stepper) { setStepper({ title: it.stepper.title, value: 0, make: it.stepper.make }); return }
    if (it.openSearch) { onSearch(it.openSearch); return }
    onRun(it)
  }
  const clickWedge = (i: number) => {
    const w = wedges[i]
    if (w.direct) handleItem(w.items[0])
    else { setStepper(null); setSelected((s) => (s === i ? null : i)) }
  }

  // Hover PREVIEWS a slice's popup; a CLICK pins it (so it survives the cursor moving
  // away). A pinned (selected) slice always wins over the hover preview.
  const branchIdx = selected != null ? selected : hovered
  const branchWedge = branchIdx != null ? wedges[branchIdx] : null
  const showBranch = !!branchWedge && !branchWedge.direct
  const branchAng = branchIdx != null ? angles[branchIdx] : null
  const branchCentroidY = branchAng ? polarToCartesian(cx, cy, R_LABEL, branchAng.mid).y : cy
  // Popup positioning (per spec):
  //  • HORIZONTAL side from the selected section's center angle: right half (0–180°)
  //    → popup RIGHT; left half (180–360°) → popup LEFT.
  //  • VERTICAL: the popup never extends below the radial's bottom. Top sections
  //    top-align with the radial top; middle sections center on the section's
  //    midpoint; bottom sections anchor their BOTTOM to the radial bottom and grow
  //    upward. Height is capped to the radial span and scrolls if taller.
  const radialTop = cy - R_OUTER
  const radialBottom = cy + R_OUTER
  const maxPopupH = Math.min(2 * R_OUTER, vp.h - 16)
  const branchMid = branchAng ? ((branchAng.mid % 360) + 360) % 360 : 0
  const popupSide: 'left' | 'right' = branchMid < 180 ? 'right' : 'left'
  const popupLeft = clamp(popupSide === 'right' ? cx + R_OUTER + 16 : cx - R_OUTER - 16 - BRANCH_W, 8, vp.w - BRANCH_W - 8)
  const ph = Math.min(branchH || maxPopupH, maxPopupH)
  const seg = !branchAng ? 'middle' : branchCentroidY <= cy - R_OUTER / 3 ? 'top' : branchCentroidY >= cy + R_OUTER / 3 ? 'bottom' : 'middle'
  const popupTop = clamp(seg === 'top' ? radialTop : seg === 'bottom' ? radialBottom - ph : branchCentroidY - ph / 2, radialTop, radialBottom - ph)
  const stepLeft = clamp(popupSide === 'right' ? cx + R_OUTER + 16 : cx - R_OUTER - 16 - STEP_W, 8, vp.w - STEP_W - 8)
  const stepTop = clamp(cy - 70, radialTop, radialBottom - 160)

  const centerCard = center?.cardId ? getCard(center.cardId) : undefined
  // Small thumbnail so the cursor rests over the hole without it dominating.
  const holeSize = Math.min(R_INNER * 2 - 24, 96)

  return createPortal(
    <div className="fixed inset-0 z-[60]" onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      {/* Backdrop: clicking anywhere off the slices dismisses (you must click a slice
          to open/keep its popup). No backdrop-blur — it re-blurs every frame and tanks
          animation framerate. */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Donut wedges. The whole SVG springs in as ONE composited element (per-path
          SVG transforms aren't GPU-composited and stutter). */}
      <svg
        className="absolute inset-0 radial-in"
        width={vp.w}
        height={vp.h}
        style={{ transformOrigin: `${cx}px ${cy}px`, willChange: 'transform, opacity' }}
        role="menu"
        aria-label="Context menu"
      >
        {wedges.map((w, i) => {
          const a = angles[i]
          const on = selected === i || hovered === i
          return (
            <path
              key={w.key}
              d={annularSectorPath(cx, cy, R_INNER, R_OUTER, a.start, a.end)}
              fill={on ? '#2563eb' : '#0c1626'}
              fillOpacity={on ? 0.95 : 0.88}
              stroke="rgba(255,255,255,0.14)"
              strokeWidth={1}
              className="cursor-pointer transition-[fill] duration-100"
              role="menuitem"
              aria-label={w.label}
              onMouseEnter={() => { cancelClose(); setHovered(i) }}
              onMouseLeave={scheduleClose}
              onClick={(e) => { e.stopPropagation(); clickWedge(i) }}
            />
          )
        })}
      </svg>

      {/* Wedge icon + label overlay (non-interactive; clicks fall through to paths). */}
      <div className="pointer-events-none absolute inset-0">
        {wedges.map((w, i) => {
          const p = polarToCartesian(cx, cy, R_LABEL, angles[i].mid)
          const on = selected === i || hovered === i
          return (
            <div
              key={w.key}
              className={`absolute flex w-24 flex-col items-center gap-1 text-center ${on ? 'text-white' : 'text-white/75'}`}
              style={{ left: p.x, top: p.y, transform: 'translate(-50%,-50%)' }}
            >
              <MenuIcon name={w.iconKey} size={20} />
              <span className="text-[10px] font-semibold uppercase leading-tight tracking-wide">{w.label}</span>
            </div>
          )
        })}
      </div>

      {/* Center hole: the menu's target (card thumbnail / zone glyph). */}
      <div
        className="pointer-events-none absolute flex flex-col items-center justify-center text-center"
        style={{ left: cx, top: cy, width: holeSize, height: holeSize, transform: 'translate(-50%,-50%)' }}
      >
        {center?.faceDown ? (
          <img src="/card-back.png" alt="" className="max-h-full max-w-full rounded-lg object-contain opacity-90 shadow-lg" />
        ) : centerCard?.imageUrl ? (
          <img src={centerCard.imageUrl} alt={centerCard.name} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-white/70">
            {center?.iconKey && <MenuIcon name={center.iconKey} size={28} />}
            <span className="text-xs font-semibold">{center?.label ?? ''}</span>
          </div>
        )}
      </div>

      {/* Branch-out list — previews on hover, pins on click. */}
      {showBranch && branchWedge && !stepper && (
        <div
          ref={branchRef}
          className="radial-popup absolute flex flex-col gap-1 overflow-y-auto rounded-xl border border-white/10 bg-[#0a1422]/95 p-2 shadow-2xl"
          style={{
            top: popupTop, left: popupLeft, width: BRANCH_W, maxHeight: maxPopupH,
            transformOrigin: popupSide === 'right' ? 'left center' : 'right center',
            ['--pop-dx' as string]: popupSide === 'right' ? '-12px' : '12px',
            ['--item-dx' as string]: popupSide === 'right' ? '-6px' : '6px',
          } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-white/40">{branchWedge.label}</div>
          {branchWedge.modify ? (
            <ModifyPanel stats={branchWedge.modify} onConfirm={onStepperConfirm} />
          ) : (
            branchWedge.items.map((it, ii) => {
              const { iconKey, title } = splitIcon(it.label)
              const { icon, color, ring } = itemStyle(it.label, iconKey)
              return (
                <button
                  key={it.label}
                  onClick={() => handleItem(it)}
                  className="radial-item flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10"
                  style={{ animationDelay: `${Math.min(ii, 8) * 20}ms` }}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${ring} ${color}`}>
                    <MenuIcon name={icon} size={15} />
                  </span>
                  <span className={`text-xs font-semibold ${color}`}>{title}{it.stepper ? '…' : ''}</span>
                </button>
              )
            })
          )}
        </div>
      )}

      {/* Quantity stepper popover — small, branches down from the donut. */}
      {stepper && (
        <div
          className="radial-popup absolute rounded-xl border border-sky-500/40 bg-[#0a1422]/97 p-3 shadow-2xl"
          style={{ top: stepTop, left: stepLeft, width: STEP_W, transformOrigin: popupSide === 'right' ? 'left center' : 'right center', ['--pop-dx' as string]: popupSide === 'right' ? '-12px' : '12px' } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 text-center text-[11px] text-white/60">{stepper.title}</div>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setStepper({ ...stepper, value: stepper.value - 1 })} className="h-8 w-8 rounded bg-white/10 text-lg font-bold hover:bg-white/20">−</button>
            <span className="w-10 text-center text-lg font-bold tabular-nums">{stepper.value > 0 ? `+${stepper.value}` : stepper.value}</span>
            <button onClick={() => setStepper({ ...stepper, value: stepper.value + 1 })} className="h-8 w-8 rounded bg-white/10 text-lg font-bold hover:bg-white/20">+</button>
          </div>
          <button
            onClick={() => onStepperConfirm(stepper.make, stepper.value)}
            className="mt-3 block w-full rounded bg-sky-500/30 px-3 py-1.5 text-center text-sm font-semibold hover:bg-sky-500/50"
          >
            Confirm
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
