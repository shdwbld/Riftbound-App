import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

interface FitOpts {
  /** Smallest scale allowed (floor, so the board never collapses to nothing). */
  min?: number
  /** Largest scale allowed. Keep at 1 for shrink-only (downscaling stays crisp;
   *  upscaling would soften raster card art). */
  max?: number
  /** Gap (px) left below the board before the viewport bottom. */
  bottomGap?: number
}

/**
 * Auto-fit a board to the viewport: scale `scalerRef` so its content fits the
 * space beneath its current top edge, and write the *scaled* height onto
 * `wrapRef` so the page reserves no extra room (no phantom scroll).
 *
 * Natural size is read from the untransformed layout box (`offsetWidth/Height`,
 * which ignore the transform) so applying the scale never feeds back into the
 * measurement. Recomputes on content resize (ResizeObserver on the scaler),
 * window resize (which also fires on browser zoom), and whenever `deps` change
 * — for layout shifts that don't trigger a resize, e.g. a side rail toggling.
 *
 * Shrink-only by default (`max = 1`). The fixed/portal overlays (context menus,
 * full-screen announcements) MUST live outside `scalerRef`, since a transformed
 * ancestor re-anchors `position: fixed` descendants.
 */
export function useFitToViewport<S extends HTMLElement, W extends HTMLElement>(
  scalerRef: RefObject<S | null>,
  wrapRef: RefObject<W | null>,
  deps: unknown[] = [],
  { min = 0.5, max = 1, bottomGap = 12 }: FitOpts = {},
): void {
  useLayoutEffect(() => {
    const scaler = scalerRef.current
    const wrap = wrapRef.current
    if (!scaler || !wrap) return

    let raf = 0
    const compute = () => {
      raf = 0
      const natW = scaler.offsetWidth
      const natH = scaler.offsetHeight
      if (!natW || !natH) return
      const top = wrap.getBoundingClientRect().top
      const availH = window.innerHeight - top - bottomGap
      const availW = wrap.clientWidth
      let s = Math.min(availW / natW, availH / natH)
      s = Math.max(min, Math.min(max, s))
      scaler.style.transformOrigin = 'top center'
      scaler.style.transform = `scale(${s})`
      wrap.style.height = `${natH * s}px`
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }

    compute()
    // Observe the scaler only — its layout (offset) size changes with content;
    // we never mutate it, so this can't loop. We DO mutate wrap.height, so wrap
    // is intentionally not observed.
    const ro = new ResizeObserver(schedule)
    ro.observe(scaler)
    window.addEventListener('resize', schedule)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
