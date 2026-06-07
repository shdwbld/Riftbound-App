import { useEffect, useRef, useState } from 'react'
import { getCard } from '../data/cards'
import { audio } from '../lib/audio'

// A premium, NON-BLOCKING card announcement (also used for the turn-start draw
// reveal). Floats 1–2 cards at ~80% of the screen, then — on dismiss — FLIES each
// card to where it actually landed on the board (its real [data-iid] node) over
// 1.5s, then vanishes (the engine already placed the real card there, so this is
// purely cosmetic and per-client — it never waits for other players).
//   • Plays (units/gear) → 10s, "<player> played this", shown to everyone.
//   • Turn-start draw → 1s pause, then a flip+zoom-in (cardFlip SFX), held ~2s.
//   • Equip → 3s "equipped to <unit>" (flies onto the host unit).
// Spells/counters are chain-related and use ChainResponsePopup instead.

const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')
const OUT_MS = 450
const FLY_MS = 1500 // card → its board home, on dismiss

export default function PlayedCardAnnouncement({
  seq,
  cards,
  iids,
  heading,
  sub,
  durationMs,
  flip = false,
  delayMs = 0,
  sfx,
}: {
  seq: number
  cards: string[]
  /** Instance iids of the cards (parallel to `cards`), for the fly-to-home target. */
  iids?: string[]
  heading: string
  sub?: string
  durationMs: number
  /** Flip+zoom entrance (turn-start draw) instead of the float entrance. */
  flip?: boolean
  /** Pause before the announcement appears (the "breath" before a draw). */
  delayMs?: number
  /** SFX to play the moment it appears (e.g. 'cardFlip' for draws). */
  sfx?: 'cardFlip'
}) {
  const [vis, setVis] = useState<'hidden' | 'in' | 'fly'>('hidden')
  const [seenSeq, setSeenSeq] = useState(-1)
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])
  const dismissed = useRef(false)

  // On dismiss, fly each card from its current rect to its real board node, then
  // hide. Uses the Web Animations API so the tween runs from the live position
  // regardless of React's render timing. A card with no on-board home just fades.
  const dismiss = () => {
    if (dismissed.current) return // a manual click and the auto-timeout can race
    dismissed.current = true
    let dur = OUT_MS
    cards.forEach((_, i) => {
      const btn = btnRefs.current[i]
      if (!btn) return
      const iid = iids?.[i]
      const node = iid ? (document.querySelector(`[data-iid="${CSS.escape(iid)}"]`) as HTMLElement | null) : null
      const a = btn.getBoundingClientRect()
      const b = node?.getBoundingClientRect()
      if (b && (b.width || b.height)) {
        const dx = b.left + b.width / 2 - (a.left + a.width / 2)
        const dy = b.top + b.height / 2 - (a.top + a.height / 2)
        const scale = Math.max(0.05, b.width / a.width)
        dur = FLY_MS
        btn.animate(
          [
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
            { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
          ],
          { duration: FLY_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
        )
      } else {
        btn.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OUT_MS, easing: 'ease-out', fill: 'forwards' })
      }
    })
    setVis('fly')
    setTimeout(() => setVis('hidden'), dur)
  }

  useEffect(() => {
    if (!cards.length || seq < 0 || seq === seenSeq) return
    setSeenSeq(seq)
    setVis('hidden')
    dismissed.current = false
    const timers: ReturnType<typeof setTimeout>[] = []
    timers.push(
      setTimeout(() => {
        setVis('in')
        if (sfx) audio.play(sfx)
      }, delayMs),
    )
    // Auto-dismiss = the same fly-home as a manual click.
    timers.push(setTimeout(() => dismiss(), delayMs + durationMs))
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  if (vis === 'hidden' || !cards.length) return null
  const flying = vis === 'fly'
  const w = cards.length > 1 ? 'min(42vw, 44vh)' : 'min(90vw, 57vh)'

  return (
    <div className="pointer-events-none fixed inset-0 z-[62] flex flex-col items-center justify-center gap-4 p-4">
      {/* Click ANYWHERE to dismiss (draw reveals and plays alike) — a full-screen
          catcher behind the content. Removed once the fly-home starts. */}
      {!flying && (
        <div className="pointer-events-auto absolute inset-0" onClick={dismiss} aria-hidden />
      )}
      {!flying && (
        <div className="pointer-events-none rounded-xl bg-black/60 px-6 py-2 text-center backdrop-blur">
          <div className="text-2xl font-extrabold text-white drop-shadow">{heading}</div>
          {sub && <div className="text-sm font-semibold text-white/70">{sub}</div>}
        </div>
      )}

      <div className="flex items-center justify-center gap-4">
        {cards.map((cid, i) => {
          const card = getCard(cid)
          if (!card) return null
          // While flying, the Web Animations API owns transform/opacity — render no
          // entrance animation and don't intercept clicks.
          const animClass = flying ? '' : flip ? 'draw-flip-in' : 'card-announce'
          return (
            <button
              key={`${cid}-${i}`}
              ref={(el) => { btnRefs.current[i] = el }}
              type="button"
              onClick={dismiss}
              title="Click to dismiss"
              className={`${animClass} ${flying ? 'pointer-events-none' : 'pointer-events-auto cursor-pointer'} relative overflow-hidden rounded-3xl border border-white/20 shadow-2xl`}
              style={{ width: w, willChange: 'transform, opacity' }}
            >
              {card.imageUrl ? (
                <img src={card.imageUrl} alt={card.name} className="block w-full" style={{ aspectRatio: '744/1039', objectFit: 'cover' }} />
              ) : (
                <div className="flex w-full items-center justify-center bg-[#0a1e33] p-8 text-center text-2xl" style={{ aspectRatio: '744/1039' }}>
                  {card.name}
                </div>
              )}
              <div className="light-overlay-foil pointer-events-none absolute inset-0" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 text-center">
                <div className="text-base font-bold text-white drop-shadow">{bare(card.name)}</div>
              </div>
            </button>
          )
        })}
      </div>

      {!flying && (
        <>
          <div className="pointer-events-none h-1.5 w-64 overflow-hidden rounded bg-white/10">
            <div className="announcement-drain h-full bg-sky-400/70" style={{ animationDuration: `${durationMs}ms` }} />
          </div>
          <div className="pointer-events-none text-[10px] uppercase tracking-wide text-white/40">click anywhere to dismiss</div>
        </>
      )}
    </div>
  )
}
