import { useState } from 'react'
import { getCard } from '../data/cards'
import type { EngineCard } from '../engine/types'
import BoardCard from './BoardCard'

/** The classic mulligan presentation: a large hover-preview pane on the left and
 *  the opening hand (full BoardCards) on the right. Click a card to toggle it
 *  "set aside" (sent to the bottom, then redrawn); double-click to inspect. Purely
 *  presentational — the caller owns the `aside` set and the submit button, so this
 *  is shared by the legacy mulligan phase and the pre-game setup wizard. */
export default function MulliganHand({
  hand,
  aside,
  onToggle,
  onInspect,
}: {
  hand: EngineCard[]
  aside: string[]
  onToggle: (iid: string) => void
  onInspect: (cardId: string) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const previewId = hover ?? hand[0]?.cardId
  const preview = previewId ? getCard(previewId) : null
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
      {/* Hover preview area */}
      <div className="hidden w-56 shrink-0 sm:block">
        {preview?.imageUrl ? (
          <img
            src={preview.imageUrl}
            alt={preview.name}
            className="w-full rounded-2xl shadow-2xl"
            style={{ aspectRatio: '744/1039', objectFit: 'cover' }}
          />
        ) : (
          <div className="flex w-full items-center justify-center rounded-2xl bg-[#1c1c28] p-4" style={{ aspectRatio: '744/1039' }}>
            {preview?.name}
          </div>
        )}
        <div className="mt-2 text-sm font-semibold">{preview?.name}</div>
      </div>

      {/* The opening hand — big cards */}
      <div className="flex flex-wrap justify-center gap-4">
        {hand.map((c) => (
          <div key={c.iid} className="flex flex-col items-center gap-2" onMouseEnter={() => setHover(c.cardId)}>
            <button
              onClick={() => onToggle(c.iid)}
              onDoubleClick={() => onInspect(c.cardId)}
              className={`w-[var(--card-w)] rounded-xl transition hover:-translate-y-1 ${
                aside.includes(c.iid) ? 'opacity-50 ring-2 ring-rose-400' : 'ring-1 ring-white/10 hover:ring-amber-300/60'
              }`}
              title="Click to set aside · double-click to inspect"
            >
              <BoardCard ci={c} />
            </button>
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                aside.includes(c.iid) ? 'bg-rose-500/30 text-rose-200' : 'bg-white/10 text-white/60'
              }`}
            >
              {aside.includes(c.iid) ? '↩ set aside' : 'keep'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
