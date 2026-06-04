import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'

// A transient (~5s) end-of-turn recap. Announces who's up next and summarizes
// what just happened: a thumbnail strip of the cards played, spells & units
// played, runes exhausted / recycled, points earned, and WHO scored.
// Auto-dismisses after 5000ms; a tap dismisses it early. The overlay never
// blocks input — only the card itself catches pointer events. Driven by a
// `data.key` that changes once per turn.

const RECAP_MS = 5000
const MAX_THUMBS = 12

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
  /** Card ids played during the turn (thumbnail strip). */
  played: string[]
  /** Who scored this turn and how much. */
  scorers: { name: string; amount: number }[]
}

export default function TurnRecapBanner({ data }: { data: TurnRecapData | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!data) return
    setShow(true)
    const t = setTimeout(() => setShow(false), RECAP_MS)
    return () => clearTimeout(t)
  }, [data?.key, data])
  if (!data || !show) return null

  const stats: { label: string; value: number }[] = [
    { label: 'Units', value: data.units },
    { label: 'Spells', value: data.spells },
    { label: 'Exhausted', value: data.exhausted },
    { label: 'Recycled', value: data.recycled },
    { label: 'Points', value: data.points },
  ].filter((s) => s.value > 0)

  const thumbs = data.played.slice(0, MAX_THUMBS)
  const extra = data.played.length - thumbs.length

  return (
    <div className="pointer-events-none fixed inset-x-0 top-24 z-[55] flex justify-center px-4">
      <button
        type="button"
        onClick={() => setShow(false)}
        className="fx-banner pointer-events-auto max-w-xl cursor-pointer rounded-2xl border-2 border-indigo-400/60 bg-slate-800/90 px-6 py-3 text-center text-indigo-50 shadow-2xl backdrop-blur-sm"
      >
        <div className="text-base font-bold">Turn ended — {data.nextPlayer} is up</div>

        {/* Thumbnail strip of cards played this turn. */}
        {thumbs.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1">
            {thumbs.map((cid, i) => {
              const def = getCard(cid)
              return (
                <div
                  key={`${cid}-${i}`}
                  title={def?.name ?? cid}
                  className="w-9 overflow-hidden rounded border border-white/20 bg-[#1c1c28]"
                  style={{ aspectRatio: '744/1039' }}
                >
                  {def?.imageUrl ? (
                    <img src={def.imageUrl} alt={def.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center p-0.5 text-center text-[6px] leading-tight text-white/70">
                      {def?.name ?? cid}
                    </div>
                  )}
                </div>
              )
            })}
            {extra > 0 && <span className="self-center px-1 text-xs font-semibold opacity-70">+{extra}</span>}
          </div>
        )}

        {stats.length ? (
          <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[11px] opacity-80">
            {stats.map((s) => (
              <span key={s.label}>
                <span className="font-semibold">{s.value}</span> {s.label}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-1 text-[11px] opacity-70">Nothing happened.</div>
        )}

        {/* Who scored this turn. */}
        {data.scorers.length > 0 && (
          <div className="mt-1.5 text-xs font-semibold text-amber-200">
            🏆 {data.scorers.map((s) => `${s.name} +${s.amount}`).join(' · ')}
          </div>
        )}

        <div className="mt-1 text-[10px] uppercase tracking-wide opacity-50">tap to skip</div>
      </button>
    </div>
  )
}
