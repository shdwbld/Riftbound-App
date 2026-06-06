import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'
import CardPreview from './CardPreview'

// An end-of-turn recap modal (~80% of the screen). Announces who's up next and
// summarizes the turn: a thumbnail grid of the cards played (hover any to
// expand), units/spells played, runes exhausted/recycled, points earned, and
// WHO scored. It BLOCKS until dismissed (click the backdrop or the Dismiss
// button) so the recap can actually be read. Driven by a `data.key` that
// changes once per ended turn.

export interface TurnRecapData {
  /** Changes once per ended turn (use the just-ended turn number). */
  key: number
  /** Name of the player whose turn is now beginning. */
  nextPlayer: string
  spells: number
  units: number
  exhausted: number
  recycled: number
  points: number
  /** Card ids played during the turn (thumbnail grid). */
  played: string[]
  /** Who scored this turn and how much. */
  scorers: { name: string; amount: number }[]
}

export default function TurnRecapBanner({ data }: { data: TurnRecapData | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!data) return
    setShow(true)
  }, [data?.key, data])
  if (!data || !show) return null

  const stats: { label: string; value: number }[] = [
    { label: 'Units', value: data.units },
    { label: 'Spells', value: data.spells },
    { label: 'Exhausted', value: data.exhausted },
    { label: 'Recycled', value: data.recycled },
    { label: 'Points', value: data.points },
  ].filter((s) => s.value > 0)

  return (
    <div
      className="fixed inset-0 z-[59] flex items-center justify-center bg-black/80 p-4"
      onClick={() => setShow(false)}
    >
      <div
        className="fx-play flex flex-col gap-4 overflow-hidden rounded-3xl border-2 border-indigo-400/50 bg-[#0d0f1c] p-6 text-indigo-50 shadow-2xl"
        style={{ width: '80vw', height: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl font-bold">Turn ended — {data.nextPlayer} is up</span>
          {data.scorers.length > 0 && (
            <span className="text-base font-semibold text-amber-200">
              🏆 {data.scorers.map((s) => `${s.name} +${s.amount}`).join(' · ')}
            </span>
          )}
          <button
            onClick={() => setShow(false)}
            className="ml-auto rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20"
          >
            Dismiss
          </button>
        </div>

        {/* Stat pills */}
        {stats.length ? (
          <div className="flex flex-wrap gap-2">
            {stats.map((s) => (
              <span key={s.label} className="rounded-full bg-white/10 px-3 py-1 text-sm">
                <span className="font-bold">{s.value}</span> <span className="opacity-70">{s.label}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-sm opacity-70">Nothing happened this turn.</div>
        )}

        {/* Cards played — hover any to expand. */}
        {data.played.length > 0 && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mb-2 text-xs uppercase tracking-wide opacity-50">
              Cards played ({data.played.length}) — hover to expand
            </div>
            <div className="flex flex-wrap gap-2">
              {data.played.map((cid, i) => {
                const def = getCard(cid)
                return (
                  <CardPreview key={`${cid}-${i}`} cardId={cid} delay={80}>
                    <div
                      className="w-24 overflow-hidden rounded-lg border border-white/20 bg-[#1c1c28]"
                      style={{ aspectRatio: '744/1039' }}
                    >
                      {def?.imageUrl ? (
                        <img src={def.imageUrl} alt={def.name} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center p-1 text-center text-[9px] leading-tight text-white/70">
                          {def?.name ?? cid}
                        </div>
                      )}
                    </div>
                  </CardPreview>
                )
              })}
            </div>
          </div>
        )}

        <div className="text-center text-[11px] uppercase tracking-wide opacity-40">
          click anywhere outside to dismiss
        </div>
      </div>
    </div>
  )
}
