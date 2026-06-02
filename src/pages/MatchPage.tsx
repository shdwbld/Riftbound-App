import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { listDecks, getDeck } from '../lib/deckStorage'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'
import type { Card } from '../types/cards'
import { type MatchState, type PlayerId, type EngineCard } from '../engine/types'
import { createMatch } from '../engine/setup'
import { reduce } from '../engine/engine'
import { autoPayForCard } from '../engine/autopay'
import BoardCard from '../components/BoardCard'
import MatchBoard from '../components/MatchBoard'
import CardDetailModal from '../components/CardDetailModal'

export default function MatchPage() {
  const location = useLocation()
  const preDeckId = (location.state as { deckId?: string } | null)?.deckId
  const [match, setMatch] = useState<MatchState | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [inspect, setInspect] = useState<Card | null>(null)

  if (!match) return <MatchSetup preDeckId={preDeckId} onStart={setMatch} />

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }
  const act = (action: Parameters<typeof reduce>[1]) => {
    const { state, error } = reduce(match, action)
    if (error) return flash(error)
    setMatch(state)
  }

  if (match.phase === 'gameover') {
    const w = match.winner!
    return (
      <div className="space-y-4 py-16 text-center">
        <div className="text-5xl">🏆</div>
        <h2 className="text-3xl font-bold">{match.players[w].name} wins!</h2>
        <p className="text-white/50">
          {match.players.map((p) => `${p.name} ${p.points}`).join(' · ')}
        </p>
        <button onClick={() => setMatch(null)} className="rounded-lg bg-indigo-500 px-4 py-2 font-semibold">
          New match
        </button>
      </div>
    )
  }

  if (match.phase === 'mulligan')
    return <MulliganPhase match={match} onAct={act} onExit={() => setMatch(null)} />

  // Hotseat: control flips to whoever must decide.
  const controlling: PlayerId =
    match.phase === 'showdown' && match.showdown ? match.showdown.priority : match.activePlayer

  const play = (c: EngineCard) => {
    const card = getCard(c.cardId)
    if (!card) return
    const payment = autoPayForCard(match.players[controlling], card)
    if (!payment) return flash('Not enough resources.')
    const type =
      card.type === 'unit' ? 'PLAY_UNIT' : card.type === 'gear' ? 'PLAY_GEAR' : card.type === 'spell' ? 'PLAY_SPELL' : null
    if (!type) return
    act({ type, player: controlling, iid: c.iid, payment })
  }

  return (
    <div className="space-y-3">
      <Toolbar match={match} controlling={controlling} onExit={() => setMatch(null)} />
      <MatchBoard
        match={match}
        perspective={controlling}
        canAct
        onPlay={play}
        onMove={(iid, bf) => act({ type: 'MOVE_UNIT', player: controlling, iid, toBattlefield: bf })}
        onPass={() => act({ type: 'PASS', player: controlling })}
        onEndTurn={() => act({ type: 'END_TURN', player: controlling })}
        onActivateLegend={() => act({ type: 'ACTIVATE_LEGEND', player: controlling })}
        onConcede={() => act({ type: 'CONCEDE', player: controlling })}
        onInspect={setInspect}
      />
      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-rose-500/90 px-4 py-2 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function Toolbar({
  match,
  controlling,
  onExit,
}: {
  match: MatchState
  controlling: PlayerId
  onExit: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-[#15151f] p-2 text-sm">
      <span className="rounded bg-white/5 px-2 py-1 text-xs">Turn {match.turn}</span>
      <span className="rounded bg-white/5 px-2 py-1 text-xs capitalize">{match.phase}</span>
      <span className="text-xs text-white/50">First to {match.pointsToWin}</span>
      <div className="flex flex-wrap items-center gap-1">
        {match.players.map((p) => (
          <span
            key={p.id}
            className={`rounded px-2 py-1 text-xs font-semibold ${
              match.activePlayer === p.id ? 'bg-indigo-500/30 text-indigo-100' : 'bg-white/5 text-white/60'
            }`}
          >
            {p.name}: {p.points}
          </span>
        ))}
      </div>
      <span className="ml-auto rounded bg-indigo-500/20 px-2 py-1 text-xs text-indigo-200">
        Acting: {match.players[controlling].name}
      </span>
      <button onClick={onExit} className="rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30">
        Exit
      </button>
    </div>
  )
}

function MulliganPhase({
  match,
  onAct,
  onExit,
}: {
  match: MatchState
  onAct: (a: Parameters<typeof reduce>[1]) => void
  onExit: () => void
}) {
  const pending = match.players.find((p) => !p.mulliganed)
  return <MulliganView key={pending?.id} pending={pending} onAct={onAct} onExit={onExit} />
}

export function MulliganView({
  pending,
  onAct,
  onExit,
}: {
  pending: MatchState['players'][number] | undefined
  onAct: (a: Parameters<typeof reduce>[1]) => void
  onExit?: () => void
}) {
  const [aside, setAside] = useState<string[]>([])
  const [view, setView] = useState<Card | null>(null)
  if (!pending) return null
  const toggle = (iid: string) =>
    setAside((s) => (s.includes(iid) ? s.filter((x) => x !== iid) : s.length < 2 ? [...s, iid] : s))
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Opening hand — {pending.name}</h2>
        {onExit && (
          <button onClick={onExit} className="text-xs text-white/40 hover:text-white">
            Exit
          </button>
        )}
      </div>
      <p className="text-sm text-white/50">
        Tap a card to view it. Mark up to 2 to set aside (sent to the bottom of
        your deck, then redraw that many). {aside.length}/2 marked.
      </p>
      <div className="flex flex-wrap gap-3">
        {pending.zones.hand.map((c) => (
          <div key={c.iid} className="flex flex-col items-center gap-1">
            <button
              onClick={() => setView(getCard(c.cardId) ?? null)}
              className={`rounded ${aside.includes(c.iid) ? 'opacity-40 ring-2 ring-rose-400' : ''}`}
            >
              <BoardCard ci={c} />
            </button>
            <button
              onClick={() => toggle(c.iid)}
              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                aside.includes(c.iid)
                  ? 'bg-rose-500/30 text-rose-200'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              {aside.includes(c.iid) ? '↩ Set aside' : 'Set aside'}
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onAct({ type: 'MULLIGAN', player: pending.id, toBottom: aside })}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold hover:bg-indigo-400"
        >
          {aside.length ? `Mulligan ${aside.length}` : 'Keep hand'}
        </button>
      </div>
      {view && <CardDetailModal card={view} onClose={() => setView(null)} />}
    </div>
  )
}

function MatchSetup({ preDeckId, onStart }: { preDeckId?: string; onStart: (m: MatchState) => void }) {
  const decks = useMemo(() => listDecks(), [])
  const [count, setCount] = useState(2)
  const [seats, setSeats] = useState<string[]>(() => {
    const first = preDeckId ?? decks[0]?.id ?? ''
    return [first, decks[0]?.id ?? '', decks[0]?.id ?? '', decks[0]?.id ?? '']
  })

  const setSeat = (i: number, v: string) =>
    setSeats((s) => s.map((x, idx) => (idx === i ? v : x)))

  const start = () => {
    const chosen = seats.slice(0, count).map(getDeck)
    if (chosen.some((d) => !d)) return
    const ds = chosen as Deck[]
    onStart(createMatch(ds, { names: ds.map((d, i) => `${d.name}`.slice(0, 16) || `P${i + 1}`) }))
  }

  if (decks.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-white/15 p-10 text-center">
        <p className="text-white/60">You need at least one deck to play a match.</p>
        <Link to="/decks" className="mt-3 inline-block rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold">
          Build a deck
        </Link>
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Ruled Match — Hotseat</h2>
        <Link to="/online" className="rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5">
          Play online →
        </Link>
      </div>
      <p className="text-sm text-white/50">
        2-4 players on one screen with full rules enforced. 1v1 plays to 8 points;
        3-4 player free-for-all plays to 11. Card-specific ability text is resolved manually.
      </p>

      <div className="flex items-center gap-2">
        <span className="text-sm text-white/60">Players:</span>
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            onClick={() => setCount(n)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
              count === n ? 'bg-indigo-500 text-white' : 'border border-white/15 text-white/70 hover:bg-white/5'
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: count }).map((_, i) => (
          <DeckSelect key={i} label={`Player ${i + 1}`} decks={decks} value={seats[i]} onChange={(v) => setSeat(i, v)} />
        ))}
      </div>

      <button
        onClick={start}
        disabled={seats.slice(0, count).some((s) => !s)}
        className="rounded-lg bg-indigo-500 px-5 py-2.5 font-semibold hover:bg-indigo-400 disabled:opacity-40"
      >
        Start {count}-player match ▶
      </button>
    </div>
  )
}

function DeckSelect({
  label,
  decks,
  value,
  onChange,
}: {
  label: string
  decks: Deck[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block rounded-xl border border-white/10 bg-[#15151f] p-4">
      <span className="text-xs uppercase tracking-wide text-white/40">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-indigo-400"
      >
        {decks.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  )
}
