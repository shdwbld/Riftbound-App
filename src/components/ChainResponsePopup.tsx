import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'
import CardText from './CardText'

// A NON-BLOCKING ~80%-screen popup that fires when it becomes THIS player's
// window to react to an open chain. Left = the card just played (what you're
// reacting to); right = its rules text + a 5s countdown. Auto-dismisses after
// 5s; click to dismiss early. The board stays usable underneath and the actual
// respond controls remain in the right rail. Keyed on the chain item id so it
// fires once per new chain entry.

const RESPOND_MS = 5000

export default function ChainResponsePopup({
  chainItemId,
  cardId,
  playerName,
}: {
  chainItemId: string | null
  cardId: string | null
  playerName: string
}) {
  const [show, setShow] = useState(false)
  const [seenId, setSeenId] = useState<string | null>(null)
  useEffect(() => {
    if (!chainItemId || chainItemId === seenId) return
    setSeenId(chainItemId)
    setShow(true)
    const t = setTimeout(() => setShow(false), RESPOND_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainItemId])

  if (!show || !cardId) return null
  const card = getCard(cardId)
  if (!card) return null

  return (
    <div className="pointer-events-none fixed inset-0 z-[56] flex items-center justify-center p-4">
      <div
        onClick={() => setShow(false)}
        title="Click to dismiss"
        className="fx-play pointer-events-auto relative flex cursor-pointer overflow-hidden rounded-2xl border-2 border-amber-400/50 bg-[#0d0f1c]/95 shadow-2xl backdrop-blur-md"
        style={{ width: '80vw', height: '80vh' }}
      >
        {/* LEFT — the card you're reacting to (with a premium foil shine + float). */}
        <div className="flex w-[38%] shrink-0 flex-col items-center justify-center gap-3 border-r border-white/10 bg-black/30 p-5">
          <div className="card-announce relative overflow-hidden rounded-xl shadow-xl">
            {card.imageUrl ? (
              <img
                src={card.imageUrl}
                alt={card.name}
                className="block max-h-[55vh]"
                style={{ aspectRatio: '744/1039', objectFit: 'contain' }}
              />
            ) : (
              <div className="flex aspect-[744/1039] w-full items-center justify-center bg-[#0a1e33] p-4 text-center">
                {card.name}
              </div>
            )}
            <div className="light-overlay-foil pointer-events-none absolute inset-0" />
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-white">{card.name}</div>
            {playerName && <div className="text-sm text-white/60">played by {playerName}</div>}
          </div>
        </div>

        {/* RIGHT — what you need to react to. */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-8">
          <div className="text-3xl font-extrabold text-amber-200">⛓ Your window to react</div>
          <div className="text-base text-white/50">Respond with a Reaction, Counter it, or Pass.</div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-black/30 p-5 text-lg leading-relaxed text-white/90">
            <CardText text={card.text ?? 'No rules text.'} />
          </div>
          <div className="text-xs uppercase tracking-wide text-white/40">
            click anywhere to dismiss · auto-closes in 5s
          </div>
        </div>

        {/* 5s countdown drain bar. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5 bg-white/10">
          <div className="chain-countdown-bar h-full bg-amber-400/70" />
        </div>
      </div>
    </div>
  )
}
