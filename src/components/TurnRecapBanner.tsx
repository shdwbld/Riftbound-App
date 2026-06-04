import { useEffect, useState } from 'react'

// A transient (~2s) end-of-turn recap. Announces who's up next and summarizes
// what just happened: spells & units played, runes exhausted / recycled, and
// points earned. Auto-dismisses after 2000ms; a tap dismisses it early. The
// overlay never blocks input — only the card itself catches pointer events.
// Driven by a `data.key` that changes once per turn.

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
}

export default function TurnRecapBanner({ data }: { data: TurnRecapData | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!data) return
    setShow(true)
    const t = setTimeout(() => setShow(false), 2000)
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

  return (
    <div className="pointer-events-none fixed inset-x-0 top-24 z-[55] flex justify-center px-4">
      <button
        type="button"
        onClick={() => setShow(false)}
        className="fx-banner pointer-events-auto max-w-lg cursor-pointer rounded-2xl border-2 border-indigo-400/60 bg-slate-800/85 px-6 py-3 text-center text-indigo-50 shadow-2xl backdrop-blur-sm"
      >
        <div className="text-base font-bold">Turn ended — {data.nextPlayer} is up</div>
        {stats.length ? (
          <div className="mt-1 flex flex-wrap justify-center gap-x-3 gap-y-0.5 text-[11px] opacity-80">
            {stats.map((s) => (
              <span key={s.label}>
                <span className="font-semibold">{s.value}</span> {s.label}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-1 text-[11px] opacity-70">Nothing happened.</div>
        )}
        <div className="mt-1 text-[10px] uppercase tracking-wide opacity-50">tap to skip</div>
      </button>
    </div>
  )
}
