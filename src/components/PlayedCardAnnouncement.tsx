import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'

// A premium, NON-BLOCKING card announcement (also used for the begin-turn draw
// reveal). Floats 1–2 cards at ~80% of the screen for the configured lifetime
// with a gentle micro-motion + foil shine, then fades. The board stays usable
// underneath (backdrop is pointer-events-none); clicking a card dismisses early.
// Keyed on `seq` so it fires exactly once per event.
//   • Plays (units/gear) → 10s, "<player> played this", shown to everyone.
//   • Draws → ~3.5s, "You drew", shown only to the drawer (privacy).
// Spells/counters are chain-related and use ChainResponsePopup instead.

const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')

export default function PlayedCardAnnouncement({
  seq,
  cards,
  heading,
  sub,
  durationMs,
}: {
  seq: number
  cards: string[]
  heading: string
  sub?: string
  durationMs: number
}) {
  const [show, setShow] = useState(false)
  const [seenSeq, setSeenSeq] = useState(-1)
  useEffect(() => {
    if (!cards.length || seq < 0 || seq === seenSeq) return
    setSeenSeq(seq)
    setShow(true)
    const t = setTimeout(() => setShow(false), durationMs)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  if (!show || !cards.length) return null
  const w = cards.length > 1 ? 'min(42vw, 44vh)' : 'min(90vw, 57vh)'

  return (
    <div className="pointer-events-none fixed inset-0 z-[54] flex flex-col items-center justify-center gap-4 p-4">
      <div className="rounded-xl bg-black/60 px-6 py-2 text-center backdrop-blur">
        <div className="text-2xl font-extrabold text-white drop-shadow">{heading}</div>
        {sub && <div className="text-sm font-semibold text-white/70">{sub}</div>}
      </div>

      <div className="flex items-center justify-center gap-4">
        {cards.map((cid, i) => {
          const card = getCard(cid)
          if (!card) return null
          return (
            <button
              key={`${cid}-${i}`}
              type="button"
              onClick={() => setShow(false)}
              title="Click to dismiss"
              className="card-announce pointer-events-auto relative cursor-pointer overflow-hidden rounded-3xl border border-white/20 shadow-2xl"
              style={{ width: w }}
            >
              {card.imageUrl ? (
                <img src={card.imageUrl} alt={card.name} className="block w-full" style={{ aspectRatio: '744/1039', objectFit: 'cover' }} />
              ) : (
                <div className="flex w-full items-center justify-center bg-[#1c1c28] p-8 text-center text-2xl" style={{ aspectRatio: '744/1039' }}>
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

      <div className="h-1.5 w-64 overflow-hidden rounded bg-white/10">
        <div className="announcement-drain h-full bg-indigo-400/70" style={{ animationDuration: `${durationMs}ms` }} />
      </div>
      <div className="text-[10px] uppercase tracking-wide text-white/40">click a card to dismiss</div>
    </div>
  )
}
