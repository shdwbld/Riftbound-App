import { useState } from 'react'
import { getCard } from '../data/cards'
import { totalCost } from '../types/cards'
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
    <div className="flex flex-col items-center gap-4">
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
          <div className="flex w-full items-center justify-center rounded-2xl bg-[#0a1e33] p-4" style={{ aspectRatio: '744/1039' }}>
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

      {/* Redraw preview — what the kept hand looks like (count + energy-cost curve). */}
      {(() => {
        const kept = hand.filter((c) => !aside.includes(c.iid))
        const MAXB = 6
        const buckets = new Array(MAXB + 1).fill(0)
        for (const c of kept) {
          const d = getCard(c.cardId)
          if (d) buckets[Math.min(MAXB, totalCost(d))]++
        }
        const peak = Math.max(1, ...buckets)
        return (
          <div className="flex flex-col items-center gap-1 rounded-xl border border-white/10 bg-[#0a1428] px-4 py-2">
            <div className="text-[11px] text-white/60">
              Keeping <b className="text-white/90">{kept.length}</b> · replacing <b className="text-rose-300">{aside.length}</b>
            </div>
            <div className="flex h-10 items-end gap-1">
              {buckets.map((n, i) => (
                <div key={i} className="flex w-5 flex-col items-center gap-0.5">
                  <div
                    className="w-full rounded-t bg-amber-400/70"
                    style={{ height: `${(n / peak) * 28 + 2}px` }}
                    title={`${n} card${n === 1 ? '' : 's'} at cost ${i}${i === MAXB ? '+' : ''}`}
                  />
                  <span className="text-[8px] text-white/40">{i}{i === MAXB ? '+' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
