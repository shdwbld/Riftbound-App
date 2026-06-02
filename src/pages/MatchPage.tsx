import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { listDecks, getDeck } from '../lib/deckStorage'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'
import {
  type MatchState,
  type PlayerId,
  type EngineCard,
} from '../engine/types'
import { createMatch } from '../engine/setup'
import { reduce } from '../engine/engine'
import { autoPayForCard, canAfford } from '../engine/autopay'
import BoardCard from '../components/BoardCard'

export default function MatchPage() {
  const location = useLocation()
  const preDeckId = (location.state as { deckId?: string } | null)?.deckId
  const [match, setMatch] = useState<MatchState | null>(null)
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  if (!match)
    return <MatchSetup preDeckId={preDeckId} onStart={setMatch} />

  const act = (action: Parameters<typeof reduce>[1]) => {
    const { state, error } = reduce(match, action)
    if (error) {
      setToast(error)
      setTimeout(() => setToast(null), 2200)
      return
    }
    setSelectedUnit(null)
    setMatch(state)
  }

  const play = (c: EngineCard, player: PlayerId) => {
    const card = getCard(c.cardId)
    if (!card) return
    const me = match.players[player]
    const payment = autoPayForCard(me, card)
    if (!payment) {
      setToast('Not enough resources.')
      setTimeout(() => setToast(null), 2200)
      return
    }
    const type =
      card.type === 'unit'
        ? 'PLAY_UNIT'
        : card.type === 'gear'
          ? 'PLAY_GEAR'
          : card.type === 'spell'
            ? 'PLAY_SPELL'
            : null
    if (!type) return
    act({ type, player, iid: c.iid, payment })
  }

  if (match.phase === 'gameover') {
    const w = match.winner!
    return (
      <div className="space-y-4 py-16 text-center">
        <div className="text-5xl">🏆</div>
        <h2 className="text-3xl font-bold">{match.players[w].name} wins!</h2>
        <p className="text-white/50">
          {match.players[0].name} {match.players[0].points} –{' '}
          {match.players[1].points} {match.players[1].name}
        </p>
        <button
          onClick={() => setMatch(null)}
          className="rounded-lg bg-indigo-500 px-4 py-2 font-semibold"
        >
          New match
        </button>
      </div>
    )
  }

  if (match.phase === 'mulligan')
    return <MulliganPhase match={match} onAct={act} onExit={() => setMatch(null)} />

  // Whoever must decide: active player normally, priority holder in a showdown.
  const controlling: PlayerId =
    match.phase === 'showdown' && match.showdown
      ? match.showdown.priority
      : match.activePlayer
  const me = match.players[controlling]
  const opp = match.players[(controlling === 0 ? 1 : 0) as PlayerId]

  return (
    <div className="space-y-3">
      <MatchToolbar match={match} controlling={controlling} onExit={() => setMatch(null)} />

      {/* Opponent summary */}
      <PlayerStrip player={opp} active={match.activePlayer === opp.id} mini />

      {/* Shared battlefields */}
      <div className="grid grid-cols-3 gap-2">
        {match.battlefields.map((bf, i) => {
          const def = getCard(bf.cardId)
          const targetable = selectedUnit !== null
          return (
            <div
              key={i}
              onClick={() =>
                selectedUnit &&
                act({ type: 'MOVE_UNIT', player: controlling, iid: selectedUnit, toBattlefield: i })
              }
              className={`rounded-xl border bg-[#13131c] p-2 transition ${
                bf.controller === controlling
                  ? 'border-emerald-400/50'
                  : bf.controller === opp.id
                    ? 'border-rose-400/40'
                    : 'border-white/10'
              } ${targetable ? 'cursor-pointer ring-1 ring-indigo-400/40' : ''}`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="truncate text-[11px] font-medium text-white/70">
                  {def?.name ?? `Battlefield ${i + 1}`}
                </span>
                {bf.controller !== null && (
                  <span
                    className={`rounded px-1 text-[9px] ${
                      bf.controller === controlling
                        ? 'bg-emerald-500/30 text-emerald-200'
                        : 'bg-rose-500/30 text-rose-200'
                    }`}
                  >
                    {match.players[bf.controller].name}
                  </span>
                )}
              </div>
              <div className="flex min-h-[88px] flex-wrap gap-1">
                {bf.units.map((u) => (
                  <div key={u.iid} className={u.owner === controlling ? '' : 'opacity-80'}>
                    <BoardCard ci={u} size="sm" />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Showdown banner */}
      {match.phase === 'showdown' && (
        <div className="flex items-center justify-between rounded-xl border border-amber-400/40 bg-amber-500/10 p-3">
          <span className="text-sm text-amber-200">
            ⚔ Showdown — {me.name} has priority. Respond or pass.
          </span>
          <button
            onClick={() => act({ type: 'PASS', player: controlling })}
            className="rounded bg-amber-500/30 px-3 py-1 text-sm font-semibold text-amber-100 hover:bg-amber-500/50"
          >
            Pass
          </button>
        </div>
      )}

      {/* Active player board */}
      <div className="rounded-xl border border-indigo-400/30 bg-[#13131c] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">
            {me.name}{' '}
            <span className="text-white/40">
              · {me.points} pts · {me.zones.runePool.filter((r) => !r.exhausted).length} ready runes
            </span>
          </span>
          {match.phase === 'action' && match.activePlayer === controlling && (
            <button
              onClick={() => act({ type: 'END_TURN', player: controlling })}
              className="rounded bg-indigo-500 px-3 py-1 text-sm font-semibold hover:bg-indigo-400"
            >
              End turn ▶
            </button>
          )}
        </div>

        {/* Base */}
        <Zone label={`Base (${me.zones.base.length})`}>
          {me.zones.base.map((u) => {
            const isUnitCard = getCard(u.cardId)?.type === 'unit'
            return (
              <button
                key={u.iid}
                onClick={() => isUnitCard && !u.exhausted && setSelectedUnit(u.iid)}
                className={`rounded ${selectedUnit === u.iid ? 'ring-2 ring-indigo-400' : ''}`}
              >
                <BoardCard ci={u} selected={selectedUnit === u.iid} />
              </button>
            )
          })}
          {me.zones.base.length === 0 && <Empty />}
        </Zone>

        {/* Rune pool */}
        <Zone label={`Rune Pool (${me.zones.runePool.length})`}>
          {me.zones.runePool.map((r) => (
            <BoardCard key={r.iid} ci={r} size="sm" />
          ))}
          {me.zones.runePool.length === 0 && <Empty />}
        </Zone>

        {/* Hand */}
        <Zone label={`Hand (${me.zones.hand.length})`}>
          {me.zones.hand.map((c) => (
            <HandCard
              key={c.iid}
              ci={c}
              me={me}
              canPlay={
                match.phase === 'action' && match.activePlayer === controlling
              }
              onPlay={() => play(c, controlling)}
            />
          ))}
          {me.zones.hand.length === 0 && <Empty />}
        </Zone>

        {selectedUnit && (
          <p className="mt-2 text-xs text-indigo-300">
            Click a battlefield above to move this unit (or pick another).
          </p>
        )}
      </div>

      <LogPanel match={match} />

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-rose-500/90 px-4 py-2 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// --- subcomponents ---------------------------------------------------------

function Zone({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="flex min-h-[76px] flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

const Empty = () => <span className="text-xs text-white/25">—</span>

function HandCard({
  ci,
  me,
  canPlay,
  onPlay,
}: {
  ci: EngineCard
  me: MatchState['players'][number]
  canPlay: boolean
  onPlay: () => void
}) {
  const card = getCard(ci.cardId)
  if (!card) return null
  const playable =
    canPlay &&
    (card.type === 'unit' || card.type === 'spell' || card.type === 'gear') &&
    canAfford(me, card)
  return (
    <div className="flex flex-col items-center gap-1">
      <BoardCard ci={ci} />
      <button
        disabled={!playable}
        onClick={onPlay}
        className="rounded bg-indigo-500/80 px-2 py-0.5 text-[10px] font-semibold hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-30"
      >
        Play
      </button>
    </div>
  )
}

function MatchToolbar({
  match,
  controlling,
  onExit,
}: {
  match: MatchState
  controlling: PlayerId
  onExit: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#15151f] p-2 text-sm">
      <span className="rounded bg-white/5 px-2 py-1 text-xs">Turn {match.turn}</span>
      <span className="rounded bg-white/5 px-2 py-1 text-xs capitalize">
        {match.phase}
      </span>
      <span className="text-xs text-white/50">
        First to {match.pointsToWin} pts
      </span>
      <div className="flex items-center gap-2">
        <Score p={match.players[0]} active={match.activePlayer === 0} />
        <span className="text-white/30">vs</span>
        <Score p={match.players[1]} active={match.activePlayer === 1} />
      </div>
      <span className="ml-2 rounded bg-indigo-500/20 px-2 py-1 text-xs text-indigo-200">
        Acting: {match.players[controlling].name}
      </span>
      <button
        onClick={onExit}
        className="ml-auto rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Exit
      </button>
    </div>
  )
}

function Score({
  p,
  active,
}: {
  p: MatchState['players'][number]
  active: boolean
}) {
  return (
    <span
      className={`rounded px-2 py-1 text-xs font-semibold ${
        active ? 'bg-indigo-500/30 text-indigo-100' : 'bg-white/5 text-white/60'
      }`}
    >
      {p.name}: {p.points}
    </span>
  )
}

function PlayerStrip({
  player,
  active,
  mini,
}: {
  player: MatchState['players'][number]
  active: boolean
  mini?: boolean
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border bg-[#13131c] px-3 py-2 ${
        active ? 'border-indigo-400/40' : 'border-white/10'
      } ${mini ? 'text-xs' : ''}`}
    >
      <span className="font-semibold">{player.name}</span>
      <span className="text-white/50">{player.points} pts</span>
      <span className="text-white/40">✋ {player.zones.hand.length}</span>
      <span className="text-white/40">🂠 {player.zones.mainDeck.length}</span>
      <span className="text-white/40">⚡ {player.zones.runePool.filter((r) => !r.exhausted).length}</span>
      <span className="text-white/40">🗑 {player.zones.trash.length}</span>
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
  if (!pending) return null
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Opening hand — {pending.name}</h2>
        <button onClick={onExit} className="text-xs text-white/40 hover:text-white">
          Exit
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {pending.zones.hand.map((c) => (
          <BoardCard key={c.iid} ci={c} />
        ))}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onAct({ type: 'MULLIGAN', player: pending.id, redraw: false })}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold hover:bg-indigo-400"
        >
          Keep
        </button>
        <button
          onClick={() => onAct({ type: 'MULLIGAN', player: pending.id, redraw: true })}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5"
        >
          Mulligan (redraw)
        </button>
      </div>
    </div>
  )
}

function LogPanel({ match }: { match: MatchState }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Log</div>
      <div className="flex max-h-40 flex-col-reverse gap-0.5 overflow-y-auto text-[11px] text-white/60">
        {[...match.log].reverse().map((l, i) => (
          <div key={i}>
            <span className="text-white/30">T{l.turn} </span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function MatchSetup({
  preDeckId,
  onStart,
}: {
  preDeckId?: string
  onStart: (m: MatchState) => void
}) {
  const decks = useMemo(() => listDecks(), [])
  const [p1, setP1] = useState<string>(preDeckId ?? decks[0]?.id ?? '')
  const [p2, setP2] = useState<string>(decks[0]?.id ?? '')

  const start = () => {
    const d1 = getDeck(p1)
    const d2 = getDeck(p2)
    if (!d1 || !d2) return
    onStart(createMatch(d1, d2, { names: [d1.name, d2.name] }))
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
      <h2 className="text-2xl font-bold">Ruled Match — Hotseat</h2>
      <p className="text-sm text-white/50">
        Two players, one screen, full rules enforced (turn phases, resource
        payment, combat, conquering, win condition). Card-specific ability text
        is resolved manually.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <DeckSelect label="Player 1" decks={decks} value={p1} onChange={setP1} />
        <DeckSelect label="Player 2" decks={decks} value={p2} onChange={setP2} />
      </div>
      <button
        onClick={start}
        disabled={!p1 || !p2}
        className="rounded-lg bg-indigo-500 px-5 py-2.5 font-semibold hover:bg-indigo-400 disabled:opacity-40"
      >
        Start match ▶
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
