import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'

// A premium, NON-BLOCKING "card played" announcement. When a unit, spell, or
// gear is played, its art floats at ~80% of the screen for all players with a
// gentle micro-motion + foil shine, then fades after 10s. The board stays fully
// usable underneath (the backdrop is pointer-events-none); clicking the card
// dismisses it early. Keyed on `seq` so it fires exactly once per play.

const LIFETIME_MS = 10000

export default function PlayedCardAnnouncement({
  seq,
  cardId,
  playerName,
}: {
  seq: number
  cardId: string | null
  playerName: string
}) {
  const [show, setShow] = useState(false)
  const [seenSeq, setSeenSeq] = useState(-1)
  useEffect(() => {
    if (!cardId || seq < 0 || seq === seenSeq) return
    setSeenSeq(seq)
    setShow(true)
    const t = setTimeout(() => setShow(false), LIFETIME_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, cardId])

  if (!show || !cardId) return null
  const card = getCard(cardId)
  if (!card) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[54] flex items-center justify-center p-4">
      <button
        type="button"
        onClick={() => setShow(false)}
        title="Click to dismiss"
        className="card-announce pointer-events-auto relative cursor-pointer overflow-hidden rounded-3xl border border-white/20 shadow-2xl"
        style={{ width: 'min(90vw, 57vh)' }}
      >
        {card.imageUrl ? (
          <img
            src={card.imageUrl}
            alt={card.name}
            className="block w-full"
            style={{ aspectRatio: '744/1039', objectFit: 'cover' }}
          />
        ) : (
          <div
            className="flex w-full items-center justify-center bg-[#1c1c28] p-8 text-center text-2xl"
            style={{ aspectRatio: '744/1039' }}
          >
            {card.name}
          </div>
        )}

        {/* Premium foil sweep on top of the art. */}
        <div className="light-overlay-foil pointer-events-none absolute inset-0" />

        {/* Name + who played it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-5 text-left">
          <div className="text-2xl font-bold text-white drop-shadow">{card.name}</div>
          {playerName && <div className="text-sm font-semibold text-white/70">{playerName} played this</div>}
          <div className="mt-1 text-[10px] uppercase tracking-wide text-white/40">click to dismiss</div>
        </div>

        {/* 10s lifetime drain bar. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-white/10">
          <div className="announcement-drain h-full bg-indigo-400/70" />
        </div>
      </button>
    </div>
  )
}
