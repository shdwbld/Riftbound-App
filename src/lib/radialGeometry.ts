import type { IconKey } from '../components/MenuIcon'

// Pure geometry for the radial (donut) menu. Angles are in degrees with 0° at the
// TOP, increasing clockwise (the −90° offset makes SVG's +x/+y axes behave that way).

export function polarToCartesian(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

/** SVG path for an annular sector (donut wedge) from `start`→`end` degrees between
 *  inner and outer radius. */
export function annularSectorPath(cx: number, cy: number, rInner: number, rOuter: number, start: number, end: number): string {
  const large = end - start > 180 ? 1 : 0
  const oS = polarToCartesian(cx, cy, rOuter, start)
  const oE = polarToCartesian(cx, cy, rOuter, end)
  const iE = polarToCartesian(cx, cy, rInner, end)
  const iS = polarToCartesian(cx, cy, rInner, start)
  return [
    `M ${oS.x.toFixed(2)} ${oS.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${oE.x.toFixed(2)} ${oE.y.toFixed(2)}`,
    `L ${iE.x.toFixed(2)} ${iE.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${iS.x.toFixed(2)} ${iS.y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

export interface WedgeAngle { start: number; end: number; mid: number }

/** Equal slices across an `arc` (default 220°) centered on `center` (default 0° =
 *  top), leaving the bottom open so nothing clips below the radial. Wedges run
 *  clockwise from center−arc/2 (upper-left) to center+arc/2 (lower-right). */
export function wedgeAngles(n: number, gap = 2.5, arc = 220, center = 0): WedgeAngle[] {
  const slice = arc / Math.max(1, n)
  const g = n > 1 ? gap : 0
  const start0 = center - arc / 2
  const out: WedgeAngle[] = []
  for (let i = 0; i < n; i++) {
    const start = start0 + i * slice + g / 2
    const end = start0 + (i + 1) * slice - g / 2
    out.push({ start, end, mid: (start + end) / 2 })
  }
  return out
}

/** Which side of the donut a wedge's mid-angle sits on (0°=top, 90°=right,
 *  180°=bottom, 270°=left) — used to flip the branch list left/right. */
export function sideOfAngle(mid: number): 'left' | 'right' {
  const m = ((mid % 360) + 360) % 360
  return m < 180 ? 'right' : 'left'
}

// --- icon extraction from existing emoji-prefixed labels ---------------------

const GLYPH_ICON: Record<string, IconKey> = {
  '⊘': 'stun', '⊗': 'kill', '⚡': 'bolt', '♺': 'recycle', '✦': 'buff', '🔓': 'detach',
  '↔': 'swap', '🔗': 'equip', '🪙': 'coin', '👁': 'eye', '🙈': 'eyeOff', '↩': 'back',
  '🗑': 'trash', '🔎': 'search', '🗂': 'layers', '🛠': 'wrench', '♥': 'heart', '◍': 'marker',
  '○': 'circle', '✓': 'check', '→': 'arrowRight', '✨': 'sparkle', '♦': 'coin', '🏴': 'control',
}

/** Split a menu label into its leading glyph (→ an icon key) and the remaining
 *  title text. Lets us keep the existing builder label strings unchanged while
 *  rendering crisp line-icons. Falls back to a neutral dot when no glyph matches. */
export function splitIcon(label: string): { iconKey: IconKey; title: string } {
  const sp = label.indexOf(' ')
  if (sp > 0) {
    const head = label.slice(0, sp)
    // A glyph head has no ASCII letters/digits (e.g. "🪙→", "✓", "↩").
    if (!/[a-z0-9]/i.test(head)) {
      for (const g of Object.keys(GLYPH_ICON)) if (head.includes(g)) return { iconKey: GLYPH_ICON[g], title: label.slice(sp + 1).trim() || label }
      return { iconKey: 'dot', title: label.slice(sp + 1).trim() || label }
    }
  }
  return { iconKey: 'dot', title: label }
}
