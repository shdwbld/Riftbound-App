import { useEffect, useState } from 'react'
import { getCard } from '../data/cards'
import type { GameEvent, MatchState } from '../engine/types'

// An animated play-by-play of how a combat / chain resolution happened. Events
// are emitted by the reducer in resolution order (the chain resolves LIFO, so
// the top link's events come first). We reveal them one at a time with a hit /
// damage-number animation, then let the player dismiss.

interface Row {
  icon: string
  text: string
  tone: string
}

function nameOf(match: MatchState, iid?: string, cardId?: string): string {
  if (cardId) return getCard(cardId)?.name ?? cardId
  if (!iid) return 'a unit'
  for (const bf of match.battlefields)
    for (const u of bf.units) if (u.iid === iid) return getCard(u.cardId)?.name ?? 'a unit'
  for (const p of match.players) {
    for (const z of Object.values(p.zones)) for (const u of z) if (u.iid === iid) return getCard(u.cardId)?.name ?? 'a unit'
    for (const u of p.zones.trash) if (u.iid === iid) return getCard(u.cardId)?.name ?? 'a unit'
  }
  return 'a unit'
}

function toRows(match: MatchState, events: GameEvent[]): Row[] {
  const rows: Row[] = []
  for (const e of events) {
    switch (e.kind) {
      case 'play':
        rows.push({ icon: '✨', text: `${match.players[e.player ?? 0].name} played ${nameOf(match, undefined, e.cardId)}`, tone: 'text-sky-200' })
        break
      case 'counter':
        rows.push({ icon: '✗', text: `${e.player != null ? match.players[e.player].name : 'Someone'} countered a spell`, tone: 'text-rose-200' })
        break
      case 'damage':
        rows.push({ icon: '💥', text: `${nameOf(match, e.iid)} takes ${e.amount ?? 0} damage`, tone: 'text-rose-200' })
        break
      case 'defeat':
        rows.push({ icon: '☠', text: `${nameOf(match, e.iid, e.cardId)} is defeated`, tone: 'text-white' })
        break
      case 'conquer':
        rows.push({ icon: '🏆', text: `${e.player != null ? match.players[e.player].name : 'Someone'} conquered the battlefield`, tone: 'text-amber-200' })
        break
      case 'score':
        rows.push({ icon: '▲', text: `${e.player != null ? match.players[e.player].name : 'Someone'} scored +${e.amount ?? 1}`, tone: 'text-emerald-200' })
        break
    }
  }
  return rows
}

/** Which resolutions are worth replaying (combat / chain payoff). */
export function worthSummarizing(events: GameEvent[] | undefined): boolean {
  if (!events) return false
  const n = events.filter((e) => ['damage', 'defeat', 'counter', 'conquer'].includes(e.kind)).length
  return n >= 2
}

export default function BattleSummary({
  match,
  events,
  token,
  onClose,
}: {
  match: MatchState
  events: GameEvent[]
  /** Changes per resolution so the replay restarts. */
  token: number
  onClose: () => void
}) {
  const rows = toRows(match, events)
  const [shown, setShown] = useState(0)
  useEffect(() => {
    setShown(0)
    if (rows.length === 0) return
    let i = 0
    const id = setInterval(() => {
      i += 1
      setShown(i)
      if (i >= rows.length) clearInterval(id)
    }, 600)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
  if (rows.length === 0) return null

  return (
    <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-[#12101a] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xl font-bold text-amber-100">⚔ Battle summary</h3>
          <button onClick={onClose} className="rounded px-2 py-1 text-white/40 hover:bg-white/5 hover:text-white">
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {rows.slice(0, shown).map((r, i) => (
            <div key={i} className="fx-summary-row flex items-center gap-2 rounded-lg bg-black/30 px-3 py-1.5 text-sm">
              <span className="text-lg">{r.icon}</span>
              <span className={r.tone}>{r.text}</span>
            </div>
          ))}
          {shown < rows.length && <div className="px-3 text-xs text-white/30">…</div>}
        </div>
        {shown >= rows.length && (
          <button
            onClick={onClose}
            className="mt-4 w-full rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold hover:bg-indigo-400"
          >
            Continue ▶
          </button>
        )}
      </div>
    </div>
  )
}
