import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listDecks, getDeck } from '../lib/deckStorage'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'
import type { Card } from '../types/cards'
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
import MatchBoard from '../components/MatchBoard'
import CardDetailModal from '../components/CardDetailModal'
import { MulliganView } from './MatchPage'

type Role = 'host' | 'guest'
type Status = 'lobby' | 'waiting' | 'connected'

interface JoinRecord {
  clientId: string
  name: string
  deck: Deck
}

export default function OnlinePage() {
  const decks = useMemo(() => listDecks(), [])
  const [status, setStatus] = useState<Status>('lobby')
  const [role, setRole] = useState<Role>('host')
  const [roomCode, setRoomCode] = useState('')
  const [match, setMatch] = useState<MatchState | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [inspect, setInspect] = useState<Card | null>(null)
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '')
  const [seat, setSeat] = useState<PlayerId>(0)
  const [lobbyInfo, setLobbyInfo] = useState<{ joined: number; needed: number }>({
    joined: 1,
    needed: 2,
  })

  const transportRef = useRef<Transport | null>(null)
  const matchRef = useRef<MatchState | null>(null)
  const roleRef = useRef<Role>('host')
  const myDeckRef = useRef<Deck | null>(null)
  const clientIdRef = useRef<string>(makeClientId())
  const seatRef = useRef<PlayerId>(0)
  const countRef = useRef<number>(2)
  const joinsRef = useRef<JoinRecord[]>([])
  const startedRef = useRef(false)

  const flash = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 2600)
  }

  useEffect(() => () => transportRef.current?.close(), [])

  function startMatchAsHost(t: Transport) {
    const myDeck = myDeckRef.current
    if (!myDeck) return
    const guests = joinsRef.current.slice(0, countRef.current - 1)
    const ds = [myDeck, ...guests.map((g) => g.deck)]
    const names = [myDeck.name, ...guests.map((g) => g.name)]
    const m = createMatch(ds, { names })
    const seats: Record<string, number> = {}
    guests.forEach((g, i) => (seats[g.clientId] = i + 1))
    startedRef.current = true
    matchRef.current = m
    setMatch(m)
    setStatus('connected')
    t.send({ kind: 'start', state: m, seats })
  }

  function wire(t: Transport) {
    t.onMessage((msg: NetMessage) => {
      if (roleRef.current === 'host') {
        if (msg.kind === 'join') {
          if (startedRef.current) return
          if (!joinsRef.current.some((j) => j.clientId === msg.clientId))
            joinsRef.current.push({
              clientId: msg.clientId,
              name: msg.name,
              deck: msg.deck,
            })
          const joined = joinsRef.current.length + 1
          setLobbyInfo({ joined, needed: countRef.current })
          t.send({ kind: 'lobby', joined, needed: countRef.current })
          if (joined >= countRef.current) startMatchAsHost(t)
        } else if (msg.kind === 'action') {
          const cur = matchRef.current
          if (!cur) return
          const { state, error } = reduce(cur, msg.action)
          if (error) return
          matchRef.current = state
          setMatch(state)
          t.send({ kind: 'state', state })
        } else if (msg.kind === 'leave') {
          flash('A player left the room.')
        }
      } else {
        // guest
        if (msg.kind === 'lobby') {
          setLobbyInfo({ joined: msg.joined, needed: msg.needed })
        } else if (msg.kind === 'start') {
          const mySeat = msg.seats[clientIdRef.current]
          if (mySeat === undefined) {
            flash('Room is full.')
            return
          }
          seatRef.current = mySeat as PlayerId
          setSeat(mySeat as PlayerId)
          matchRef.current = msg.state
          setMatch(msg.state)
          setStatus('connected')
        } else if (msg.kind === 'state') {
          matchRef.current = msg.state
          setMatch(msg.state)
        } else if (msg.kind === 'leave') {
          flash('The host left the room.')
        }
      }
    })
  }

  const createRoom = (count: number) => {
    const deck = getDeck(deckId)
    if (!deck) return flash('Pick a deck first.')
    const code = makeRoomCode()
    roleRef.current = 'host'
    myDeckRef.current = deck
    countRef.current = count
    seatRef.current = 0
    joinsRef.current = []
    startedRef.current = false
    setRole('host')
    setSeat(0)
    setRoomCode(code)
    setLobbyInfo({ joined: 1, needed: count })
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
    t.send({ kind: 'join', name: deck.name, deck, clientId: clientIdRef.current })
  }

  const leave = () => {
    transportRef.current?.close()
    transportRef.current = null
    matchRef.current = null
    startedRef.current = false
    joinsRef.current = []
    setMatch(null)
    setStatus('lobby')
  }

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
      <Waiting
        role={role}
        roomCode={roomCode}
        info={lobbyInfo}
        onLeave={leave}
        toast={toast}
      />
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
    match.phase === 'showdown' && match.showdown ? match.showdown.priority : match.activePlayer

  if (match.phase === 'mulligan') {
    const me = match.players[seat]
    return (
      <div className="space-y-4">
        <RoomBar roomCode={roomCode} onLeave={leave} />
        {me.mulliganed ? (
          <p className="py-8 text-center text-white/50">Waiting for other players…</p>
        ) : (
          <MulliganView pending={me} onAct={(a) => dispatch(a as Action)} />
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
      card.type === 'unit' ? 'PLAY_UNIT' : card.type === 'gear' ? 'PLAY_GEAR' : card.type === 'spell' ? 'PLAY_SPELL' : null
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
            {myTurn ? 'Your move' : `${match.players[controlling].name}'s move`}
          </span>
        }
      />
      <MatchBoard
        match={match}
        perspective={seat}
        canAct={myTurn}
        onPlay={play}
        onMove={(iid, bf) => dispatch({ type: 'MOVE_UNIT', player: seat, iid, toBattlefield: bf })}
        onPass={() => dispatch({ type: 'PASS', player: seat })}
        onEndTurn={() => dispatch({ type: 'END_TURN', player: seat })}
        onInspect={setInspect}
      />
      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
      {toast && <Toast text={toast} />}
    </div>
  )
}

function makeClientId(): string {
  // Browser-safe unique id (crypto when available; Math.random fallback is fine
  // for a lobby handshake).
  try {
    return crypto.randomUUID()
  } catch {
    return 'c' + Math.random().toString(36).slice(2)
  }
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
  onCreate: (count: number) => void
  onJoin: (code: string) => void
  toast: string | null
}) {
  const [code, setCode] = useState('')
  const [count, setCount] = useState(2)
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
            : 'Same-device mode: open this page in multiple browser tabs and use the same room code. (Add Supabase keys for true cross-device play.)'}
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
        <div className="rounded-xl border border-indigo-400/40 bg-indigo-500/10 p-5">
          <div className="text-lg font-semibold">Create room</div>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <span className="text-white/60">Players:</span>
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                onClick={() => setCount(n)}
                className={`rounded px-2.5 py-1 text-sm font-semibold ${
                  count === n ? 'bg-indigo-500 text-white' : 'border border-white/15 text-white/70 hover:bg-white/5'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => onCreate(count)}
            className="mt-3 w-full rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-400"
          >
            Create {count}-player room
          </button>
        </div>
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
  info,
  onLeave,
  toast,
}: {
  role: Role
  roomCode: string
  info: { joined: number; needed: number }
  onLeave: () => void
  toast: string | null
}) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-12 text-center">
      <div className="text-4xl">📡</div>
      <h2 className="text-xl font-bold">
        {role === 'host' ? 'Waiting for players…' : 'Connecting…'}
      </h2>
      <div className="rounded-xl border border-white/10 bg-[#15151f] p-5">
        <div className="text-xs uppercase tracking-wide text-white/40">Room code</div>
        <div className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] text-indigo-300">
          {roomCode}
        </div>
        <p className="mt-2 text-sm text-white/60">
          {info.joined} / {info.needed} players joined
        </p>
        <p className="mt-1 text-xs text-white/40">Share this code to fill the table.</p>
      </div>
      <button onClick={onLeave} className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/5">
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
      <span className="rounded bg-white/5 px-2 py-1 font-mono text-xs tracking-widest">{roomCode}</span>
      {extra}
      <button onClick={onLeave} className="ml-auto rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30">
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
