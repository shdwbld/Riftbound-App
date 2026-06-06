import { useEffect, useRef, useState } from 'react'
import type { GameEvent } from '../engine/types'

// Consumes the structured GameEvents from the latest reduce() call and spawns
// short-lived, coordinate-free toasts near the top-center of the board (points
// scored, units defeated, spells countered, cards drawn). Card-anchored flashes
// (damage / play / buff) are handled directly on the BoardCards in MatchBoard;
// this layer covers the events that have no surviving card to attach to.

type Tone = 'emerald' | 'rose' | 'amber' | 'sky'
interface Toast {
  id: number
  text: string
  tone: Tone
}

const TONE: Record<Tone, string> = {
  emerald: 'bg-emerald-500/90 text-black',
  rose: 'bg-rose-500/90 text-white',
  amber: 'bg-amber-500/90 text-white',
  sky: 'bg-sky-500/90 text-black',
}

export default function FeedbackLayer({
  events,
  seq,
  players,
}: {
  events: GameEvent[] | undefined
  seq: number
  players: { id: number; name: string }[]
}) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const lastSeq = useRef(-1)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  // Clear any pending removal timers when the layer unmounts.
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    if (seq === lastSeq.current) return
    lastSeq.current = seq
    if (!events?.length) return

    const queued: Omit<Toast, 'id'>[] = []
    let defeats = 0
    for (const e of events) {
      switch (e.kind) {
        case 'score': {
          const who = e.player != null ? players[e.player]?.name : ''
          const n = e.amount ?? 1
          queued.push({ text: `+${n} point${n > 1 ? 's' : ''}${who ? ` · ${who}` : ''}`, tone: 'emerald' })
          break
        }
        case 'counter':
          queued.push({ text: 'Countered!', tone: 'amber' })
          break
        case 'defeat':
          defeats++
          break
      }
    }
    if (defeats > 0)
      queued.push({ text: `${defeats} unit${defeats > 1 ? 's' : ''} defeated`, tone: 'rose' })

    if (!queued.length) return
    const withIds = queued.map((t) => ({ ...t, id: idRef.current++ }))
    setToasts((prev) => [...prev, ...withIds])
    const ids = new Set(withIds.map((t) => t.id))
    // Self-removing: each batch clears itself ~1.6s later, independent of any
    // later dispatches (so rapid actions don't strand earlier toasts).
    timers.current.push(
      setTimeout(() => setToasts((prev) => prev.filter((t) => !ids.has(t.id))), 1600),
    )
  }, [seq, events, players])

  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed left-1/2 top-24 z-[55] flex -translate-x-1/2 flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`fx-toast rounded-full px-4 py-1.5 text-sm font-bold shadow-lg ${TONE[t.tone]}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
