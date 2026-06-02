import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listDecks, getDeck } from '../lib/deckStorage'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'
import {
  type MatchState,
  type PlayerId,
  type EngineCard,
  type Action,
} from '../engine/types'
import { createMatch } from '../engine/setup'
import { reduce } from '../engine/engine'
import { autoPayForCard } from '../engine/autopay'
import {
  type Transport,
  type NetMessage,
  createTransport,
  makeRoomCode,
  onlineAvailable,
} from '../net/transport'
import BoardCard from '../components/BoardCard'
import MatchBoard from '../components/MatchBoard'

type Role = 'host' | 'guest'
type Status = 'lobby' | 'waiting' | 'connected'

export default function OnlinePage() {
  const decks = useMemo(() => listDecks(), [])
  const [status, setStatus] = useState<Status>('lobby')
  const [role, setRole] = useState<Role>('host')
  const [roomCode, setRoomCode] = useState('')
  const [match, setMatch] = useState<MatchState | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '')

  const transportRef = useRef<Transport | null>(null)
  const matchRef = useRef<MatchState | null>(null)
  const roleRef = useRef<Role>('host')
  const myDeckRef = useRef<Deck | null>(null)

  const seat: PlayerId = role === 'host' ? 0 : 1

  const flash = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => {
    return () => transportRef.current?.close()
  }, [])

  function wire(t: Transport) {
    t.onMessage((msg: NetMessage) => {
      const r = roleRef.current
      if (r === 'host') {
        if (msg.kind === 'join') {
          const myDeck = myDeckRef.current
          if (!myDeck) return
          const m = createMatch(myDeck, msg.deck, {
            names: [myDeck.name, msg.name],
          })
          matchRef.current = m
          setMatch(m)
          setStatus('connected')
          t.send({ kind: 'hostInfo', name: myDeck.name })
          t.send({ kind: 'state', state: m })
        } else if (msg.kind === 'action') {
          const cur = matchRef.current
          if (!cur) return
          const { state, error } = reduce(cur, msg.action)
          if (error) return
          matchRef.current = state
          setMatch(state)
          t.send({ kind: 'state', state })
        } else if (msg.kind === 'leave') {
          flash('Opponent left the room.')
        }
      } else {
        if (msg.kind === 'state') {
          matchRef.current = msg.state
          setMatch(msg.state)
          setStatus('connected')
        } else if (msg.kind === 'leave') {
          flash('Host left the room.')
        }
      }
    })
  }

  const createRoom = () => {
    const deck = getDeck(deckId)
    if (!deck) return flash('Pick a deck first.')
    const code = makeRoomCode()
    roleRef.current = 'host'
    myDeckRef.current = deck
    setRole('host')
    setRoomCode(code)
    const t = createTransport(code)
    transportRef.current = t
    wire(t)
    setStatus('waiting')
  }

  const joinRoom = (code: string) => {
    const deck = getDeck(deckId)
    if (!deck) return flash('Pick a deck first.')
    if (!code.trim()) return flash('Enter a room code.')
    roleRef.current = 'guest'
    myDeckRef.current = deck
    setRole('guest')
    setRoomCode(code.toUpperCase())
    const t = createTransport(code.toUpperCase())
    transportRef.current = t
    wire(t)
    setStatus('waiting')
    // Announce ourselves to the host.
    t.send({ kind: 'join', name: deck.name, deck })
  }

  const leave = () => {
    transportRef.current?.close()
    transportRef.current = null
    matchRef.current = null
    setMatch(null)
    setStatus('lobby')
  }

  // Dispatch an engine action: host applies+broadcasts; guest forwards to host.
  const dispatch = (action: Action) => {
    if (roleRef.current === 'host') {
      const cur = matchRef.current
      if (!cur) return
      const { state, error } = reduce(cur, action)
      if (error) return flash(error)
      matchRef.current = state
      setMatch(state)
      transportRef.current?.send({ kind: 'state', state })
    } else {
      transportRef.current?.send({ kind: 'action', action })
    }
  }

  // --- render ---
  if (status === 'lobby')
    return (
      <Lobby
        decks={decks}
        deckId={deckId}
        setDeckId={setDeckId}
        onCreate={createRoom}
        onJoin={joinRoom}
        toast={toast}
      />
    )

  if (status === 'waiting' || !match)
    return (
      <Waiting role={role} roomCode={roomCode} onLeave={leave} toast={toast} />
    )

  if (match.phase === 'gameover') {
    const w = match.winner!
    return (
      <div className="space-y-4 py-16 text-center">
        <div className="text-5xl">🏆</div>
        <h2 className="text-3xl font-bold">{match.players[w].name} wins!</h2>
        <button onClick={leave} className="rounded-lg bg-indigo-500 px-4 py-2 font-semibold">
          Back to lobby
        </button>
      </div>
    )
  }

  const controlling: PlayerId =
    match.phase === 'showdown' && match.showdown
      ? match.showdown.priority
      : match.activePlayer

  if (match.phase === 'mulligan') {
    const me = match.players[seat]
    return (
      <div className="space-y-4">
        <RoomBar roomCode={roomCode} onLeave={leave} />
        <h2 className="text-xl font-bold">Your opening hand</h2>
        {me.mulliganed ? (
          <p className="text-white/50">Waiting for opponent…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {me.zones.hand.map((c) => (
                <BoardCard key={c.iid} ci={c} />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => dispatch({ type: 'MULLIGAN', player: seat, redraw: false })}
                className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold hover:bg-indigo-400"
              >
                Keep
              </button>
              <button
                onClick={() => dispatch({ type: 'MULLIGAN', player: seat, redraw: true })}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5"
              >
                Mulligan
              </button>
            </div>
          </>
        )}
        {toast && <Toast text={toast} />}
      </div>
    )
  }

  const myTurn = controlling === seat

  const play = (c: EngineCard) => {
    const card = getCard(c.cardId)
    if (!card) return
    const payment = autoPayForCard(match.players[seat], card)
    if (!payment) return flash('Not enough resources.')
    const type =
      card.type === 'unit'
        ? 'PLAY_UNIT'
        : card.type === 'gear'
          ? 'PLAY_GEAR'
          : card.type === 'spell'
            ? 'PLAY_SPELL'
            : null
    if (!type) return
    dispatch({ type, player: seat, iid: c.iid, payment })
  }

  return (
    <div className="space-y-3">
      <RoomBar
        roomCode={roomCode}
        onLeave={leave}
        extra={
          <span className={`rounded px-2 py-1 text-xs ${myTurn ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/5 text-white/50'}`}>
            {myTurn ? 'Your move' : "Opponent's move"}
          </span>
        }
      />
      <MatchBoard
        match={match}
        perspective={seat}
        canAct={myTurn}
        hideOpponentHand
        onPlay={play}
        onMove={(iid, bf) => dispatch({ type: 'MOVE_UNIT', player: seat, iid, toBattlefield: bf })}
        onPass={() => dispatch({ type: 'PASS', player: seat })}
        onEndTurn={() => dispatch({ type: 'END_TURN', player: seat })}
      />
      {toast && <Toast text={toast} />}
    </div>
  )
}

// --- subviews --------------------------------------------------------------

function Lobby({
  decks,
  deckId,
  setDeckId,
  onCreate,
  onJoin,
  toast,
}: {
  decks: Deck[]
  deckId: string
  setDeckId: (v: string) => void
  onCreate: () => void
  onJoin: (code: string) => void
  toast: string | null
}) {
  const [code, setCode] = useState('')
  if (decks.length === 0)
    return (
      <div className="rounded-xl border border-dashed border-white/15 p-10 text-center">
        <p className="text-white/60">Build a deck before playing online.</p>
        <Link to="/decks" className="mt-3 inline-block rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold">
          Build a deck
        </Link>
      </div>
    )
  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div>
        <h2 className="text-2xl font-bold">Play Online</h2>
        <p className="mt-1 text-sm text-white/50">
          {onlineAvailable
            ? 'Connected to Supabase — share a room code with anyone, anywhere.'
            : 'Same-device mode: open this page in two browser tabs and use the same room code. (Add Supabase keys for true cross-device play.)'}
        </p>
      </div>

      <label className="block rounded-xl border border-white/10 bg-[#15151f] p-4">
        <span className="text-xs uppercase tracking-wide text-white/40">Your deck</span>
        <select
          value={deckId}
          onChange={(e) => setDeckId(e.target.value)}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        >
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={onCreate}
          className="rounded-xl border border-indigo-400/40 bg-indigo-500/10 p-5 text-left transition hover:bg-indigo-500/20"
        >
          <div className="text-lg font-semibold">Create room</div>
          <div className="text-xs text-white/50">Get a code and wait for an opponent.</div>
        </button>
        <div className="rounded-xl border border-white/10 bg-[#15151f] p-5">
          <div className="text-lg font-semibold">Join room</div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={4}
            placeholder="CODE"
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-indigo-400"
          />
          <button
            onClick={() => onJoin(code)}
            className="mt-2 w-full rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-400"
          >
            Join
          </button>
        </div>
      </div>
      {toast && <Toast text={toast} />}
    </div>
  )
}

function Waiting({
  role,
  roomCode,
  onLeave,
  toast,
}: {
  role: Role
  roomCode: string
  onLeave: () => void
  toast: string | null
}) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-12 text-center">
      <div className="text-4xl">📡</div>
      <h2 className="text-xl font-bold">
        {role === 'host' ? 'Waiting for an opponent…' : 'Connecting…'}
      </h2>
      <div className="rounded-xl border border-white/10 bg-[#15151f] p-5">
        <div className="text-xs uppercase tracking-wide text-white/40">Room code</div>
        <div className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] text-indigo-300">
          {roomCode}
        </div>
        <p className="mt-2 text-xs text-white/40">
          Share this code. {role === 'host' && 'The match starts when they join.'}
        </p>
      </div>
      <button
        onClick={onLeave}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
      >
        Cancel
      </button>
      {toast && <Toast text={toast} />}
    </div>
  )
}

function RoomBar({
  roomCode,
  onLeave,
  extra,
}: {
  roomCode: string
  onLeave: () => void
  extra?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#15151f] p-2 text-sm">
      <span className="rounded bg-white/5 px-2 py-1 font-mono text-xs tracking-widest">
        {roomCode}
      </span>
      {extra}
      <button
        onClick={onLeave}
        className="ml-auto rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30"
      >
        Leave
      </button>
    </div>
  )
}

function Toast({ text }: { text: string }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-rose-500/90 px-4 py-2 text-sm font-medium shadow-lg">
      {text}
    </div>
  )
}
