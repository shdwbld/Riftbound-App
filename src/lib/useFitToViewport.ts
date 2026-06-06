import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

interface FitOpts {
  /** Smallest scale allowed (floor, so the board never collapses to nothing). */
  min?: number
  /** Largest scale allowed. Default > 1 so the board scales UP to fill the
   *  available width on big screens (set to 1 for shrink-only / always-crisp). */
  max?: number
}

/**
 * Auto-fit a board to the WIDTH of its wrapper, and write the *scaled* height
 * onto `wrapRef` so the page reserves the right amount of room (the board may be
 * taller than the viewport — it scrolls).
 *
 * Natural size is read from the untransformed layout box (`offsetWidth/Height`,
 * which ignore the transform) so applying the scale never feeds back into the
 * measurement. Recomputes on content resize (ResizeObserver on the scaler),
 * window resize (which also fires on browser zoom), and whenever `deps` change
 * — for layout shifts that don't trigger a resize, e.g. a side rail toggling.
 *
 * `scalerRef` should be a FIXED-width element (the board's design width); the
 * hook scales it to the wrapper's width — UP on wide screens to fill the space
 * (bigger cards), DOWN when narrow / zoomed-in — and keeps it horizontally
 * centered. Height is NOT constrained: a tall board scrolls. The fixed/portal
 * overlays (context menus, full-screen announcements) MUST live outside
 * `scalerRef`, since a transformed ancestor re-anchors `position: fixed`
 * descendants.
 */
export function useFitToViewport<S extends HTMLElement, W extends HTMLElement>(
  scalerRef: RefObject<S | null>,
  wrapRef: RefObject<W | null>,
  deps: unknown[] = [],
  { min = 0.5, max = 2.2 }: FitOpts = {},
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
      const availW = wrap.clientWidth
      // Fill the available WIDTH so the board uses the full left-to-right space
      // (more zoomed-in / bigger cards). Height is intentionally NOT constrained —
      // a taller board simply scrolls, which the user prefers over tiny cards.
      let s = availW / natW
      s = Math.max(min, Math.min(max, s))
      // Center the (fixed-width) scaler horizontally at any scale: origin top-left
      // + an explicit translateX, so centering holds even when natW !== availW.
      const offsetX = Math.max(0, (availW - natW * s) / 2)
      scaler.style.transformOrigin = 'top left'
      scaler.style.transform = `translateX(${offsetX}px) scale(${s})`
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
