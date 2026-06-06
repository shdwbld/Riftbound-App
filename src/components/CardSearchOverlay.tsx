import { useMemo, useState } from 'react'
import { getCard } from '../data/cards'
import type { Action, MatchState, OverrideZone, PlayerId } from '../engine/types'
import CardPreview from './CardPreview'

// A big centered search / tutor pop-up (sandbox manual tool). Right-click a pile
// (trash / rune deck / main deck) → search its cards in an art grid → send the
// chosen one to a destination (deck / hand / bench / rune pool). The main-deck
// search uses `tutorShuffle` so it doesn't leak deck order. "Manage top cards"
// shows the top of the deck in order with reorder controls. Stays open so you can
// grab several; the pile updates live as `match` re-flows in after each dispatch.

export type SearchSource = 'trash' | 'runeDeck' | 'mainDeck' | 'manageTop'

const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')

type Dest = { label: string; toZone: OverrideZone; tutor?: boolean }
const DESTS: Record<SearchSource, Dest[]> = {
  trash: [
    { label: 'Hand', toZone: 'hand' },
    { label: 'Bench', toZone: 'base' },
    { label: 'Deck (top)', toZone: 'mainDeck' },
  ],
  runeDeck: [
    { label: 'Rune pool', toZone: 'runePool' },
    { label: 'Hand', toZone: 'hand' },
    { label: 'Bench', toZone: 'base' },
    { label: 'Deck', toZone: 'mainDeck' },
  ],
  mainDeck: [
    { label: 'Hand (shuffle after)', toZone: 'hand', tutor: true },
    { label: 'Bench (shuffle after)', toZone: 'base', tutor: true },
  ],
  manageTop: [],
}

const TITLE: Record<SearchSource, string> = {
  trash: 'Search Trash',
  runeDeck: 'Search Rune Deck',
  mainDeck: 'Search Deck (shuffled after)',
  manageTop: 'Manage Top Cards',
}

export default function CardSearchOverlay({
  match,
  owner,
  source,
  onAct,
  onClose,
}: {
  match: MatchState
  owner: PlayerId
  source: SearchSource
  onAct: (a: Action) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [dest, setDest] = useState(0)
  const dests = DESTS[source]
  const zoneKey = source === 'trash' ? 'trash' : source === 'runeDeck' ? 'runeDeck' : 'mainDeck'
  const full = match.players[owner].zones[zoneKey]
  const pile = source === 'manageTop' ? full.slice(0, 8) : full

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pile
    return pile.filter((c) => (getCard(c.cardId)?.name ?? '').toLowerCase().includes(q))
  }, [query, pile])

  const send = (iid: string) => {
    const d = dests[dest]
    if (!d) return
    if (d.tutor) onAct({ type: 'OVERRIDE', player: owner, op: 'tutorShuffle', iid, toZone: d.toZone })
    else onAct({ type: 'OVERRIDE', player: owner, op: 'move', iid, toZone: d.toZone })
  }
  const mv = (iid: string, extra: Partial<Action> = {}): Action =>
    ({ type: 'OVERRIDE', player: owner, op: 'move', iid, toZone: 'mainDeck', ...extra }) as Action

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="flex flex-col gap-3 overflow-hidden rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        style={{ width: '80vw', height: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-amber-100">🔎 {TITLE[source]}</span>
          <span className="text-xs text-white/40">({full.length})</span>
          {source !== 'manageTop' && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name…"
              className="ml-2 min-w-0 flex-1 rounded bg-black/30 px-3 py-1.5 text-sm outline-none placeholder:text-white/30"
            />
          )}
          <button onClick={onClose} className="ml-auto rounded bg-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/20">Done</button>
        </div>

        {/* Destination selector (not for manage-top) */}
        {source !== 'manageTop' && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-xs uppercase tracking-wide text-white/40">Send to:</span>
            {dests.map((d, i) => (
              <button
                key={d.label}
                onClick={() => setDest(i)}
                className={`rounded px-2.5 py-1 text-xs font-semibold ${i === dest ? 'bg-amber-500/40 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
              >
                {d.label}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-white/30">click a card to send it</span>
          </div>
        )}

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {source === 'manageTop' ? (
            <div className="space-y-1">
              {pile.map((c, i) => {
                const def = getCard(c.cardId)
                return (
                  <div key={c.iid} className="flex items-center gap-2 rounded bg-white/5 px-2 py-1 text-sm">
                    <span className="w-5 shrink-0 text-white/30">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{bare(def?.name) || c.cardId}</span>
                    <button disabled={i === 0} onClick={() => onAct(mv(c.iid, { value: i - 1 }))} className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20 disabled:opacity-30" title="Move up">▲</button>
                    <button onClick={() => onAct(mv(c.iid, { bottom: true }))} className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20" title="To bottom">⤓</button>
                    <button onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'move', iid: c.iid, toZone: 'hand' } as Action)} className="rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20" title="To hand">✋</button>
                  </div>
                )
              })}
              {pile.length === 0 && <div className="py-8 text-center text-white/30">deck is empty</div>}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filtered.map((c) => {
                const def = getCard(c.cardId)
                return (
                  <CardPreview key={c.iid} cardId={c.cardId} delay={300}>
                    <button
                      onClick={() => send(c.iid)}
                      title={`${def?.name ?? c.cardId} — send to ${dests[dest]?.label}`}
                      className="w-20 overflow-hidden rounded-md border border-white/15 bg-[#0a1e33] transition hover:border-amber-300 hover:ring-2 hover:ring-amber-300/60"
                      style={{ aspectRatio: '744/1039' }}
                    >
                      {def?.imageUrl ? (
                        <img src={def.imageUrl} alt={def.name} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center p-1 text-center text-[8px] text-white/70">{def?.name ?? c.cardId}</div>
                      )}
                    </button>
                  </CardPreview>
                )
              })}
              {filtered.length === 0 && <div className="w-full py-8 text-center text-white/30">{query ? 'no matches' : 'empty'}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
