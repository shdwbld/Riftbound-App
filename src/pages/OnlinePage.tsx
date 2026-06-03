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
  type Payment,
  type ResolvedCost,
  type GameEvent,
} from '../engine/types'
import { createMatch } from '../engine/setup'
import { reduce, getLegalTargets, pendingAssignment, deflectSurcharge } from '../engine/engine'
import { autoPay, canAfford, costOf, addCost, costIsFree } from '../engine/autopay'
import { needsTarget, spellEffect } from '../engine/effects'
import { accelerateCost, parseKeywords, type KeywordCost } from '../engine/keywords'
import { DOMAIN_META, type Domain } from '../types/cards'
import PaymentModal from '../components/PaymentModal'
import ChoiceModal from '../components/ChoiceModal'
import VisionPrompt from '../components/VisionPrompt'
import DamageAssignModal from '../components/DamageAssignModal'
import BattleSummary, { worthSummarizing } from '../components/BattleSummary'

type PlayType = 'PLAY_UNIT' | 'PLAY_GEAR' | 'PLAY_SPELL'

/** Plain-text label for a cost (used in the Accelerate confirm dialog). */
function costLabel(cost: KeywordCost | ResolvedCost): string {
  const parts: string[] = []
  if (cost.energy) parts.push(`${cost.energy} Energy`)
  for (const [d, n] of Object.entries(cost.power) as [Domain, number][])
    if (n) parts.push(`${n} ${DOMAIN_META[d].label}`)
  return parts.join(' + ') || 'nothing'
}
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
import SetupScreen from '../components/SetupScreen'

type Role = 'host' | 'guest'
type Status = 'lobby' | 'waiting' | 'connected'

/** Unit iids the given player controls (base + battlefields) — gear targets. */
function friendlyUnitIids(m: MatchState, p: PlayerId): string[] {
  const ids = m.players[p].zones.base
    .filter((u) => getCard(u.cardId)?.type === 'unit')
    .map((u) => u.iid)
  for (const bf of m.battlefields)
    for (const u of bf.units) if (u.owner === p) ids.push(u.iid)
  return ids
}

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
  const [targeting, setTargeting] = useState<{ iid: string; cardId: string; payment: Payment; kind: 'spell' | 'gear'; count: number; picked: string[] } | null>(null)
  const [lastEvents, setLastEvents] = useState<GameEvent[] | undefined>(undefined)
  // The pending play awaiting a chosen rune payment (the overlay).
  const [paying, setPaying] = useState<{ c: EngineCard; card: Card; type: PlayType; cost: ResolvedCost; accelerate: boolean; counterChainId?: string } | null>(null)
  const [summary, setSummary] = useState<{ events: GameEvent[]; token: number } | null>(null)
  const [ambushPick, setAmbushPick] = useState<{ iid: string; payment: Payment; accelerate: boolean; options: { label: string; value: number }[] } | null>(null)
  const [deflectPay, setDeflectPay] = useState<{ iid: string; card: Card; base: Payment; targets: string[]; surcharge: number } | null>(null)
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
  // Replay combat/chain resolutions (host, guest, or local all flow through lastEvents).
  useEffect(() => {
    if (worthSummarizing(lastEvents)) setSummary({ events: lastEvents!, token: matchRef.current?.seq ?? 0 })
  }, [lastEvents])

  function startMatchAsHost(t: Transport) {
    const myDeck = myDeckRef.current
    if (!myDeck) return
    const guests = joinsRef.current.slice(0, countRef.current - 1)
    const ds = [myDeck, ...guests.map((g) => g.deck)]
    const names = [myDeck.name, ...guests.map((g) => g.name)]
    const m = createMatch(ds, { names, interactiveSetup: true })
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
          const { state, error, events } = reduce(cur, msg.action)
          if (error) return
          matchRef.current = state
          setLastEvents(events)
          setMatch(state)
          t.send({ kind: 'state', state, events })
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
          setLastEvents(msg.events)
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
      const { state, error, events } = reduce(cur, action)
      if (error) return flash(error)
      matchRef.current = state
      setLastEvents(events)
      setMatch(state)
      transportRef.current?.send({ kind: 'state', state, events })
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
    match.chain.length > 0 && match.priority != null
      ? match.priority
      : match.phase === 'showdown' && match.showdown
        ? match.showdown.priority
        : match.activePlayer

  const counterWith = (targetChainId: string) => {
    const me = match.players[seat]
    const reaction = me.zones.hand.find((c) => {
      const card = getCard(c.cardId)
      return card?.type === 'spell' && canAfford(me, card)
    })
    if (!reaction) return flash('No affordable Reaction spell to counter with.')
    const card = getCard(reaction.cardId)!
    const cost = costOf(card)
    // Route the Counter's rune payment through the picker overlay too.
    if (!costIsFree(cost)) {
      if (!autoPay(me, cost)) return flash('Cannot pay for the counter.')
      setPaying({ c: reaction, card, type: 'PLAY_SPELL', cost, accelerate: false, counterChainId: targetChainId })
      return
    }
    dispatch({ type: 'COUNTER', player: seat, iid: reaction.iid, targetChainId, payment: { exhaust: [], recycle: [] } })
  }

  if (match.phase === 'setup') {
    return (
      <div className="space-y-4">
        <RoomBar roomCode={roomCode} onLeave={leave} />
        <SetupScreen match={match} onAct={(a) => dispatch(a as Action)} seat={seat} />
        {toast && <Toast text={toast} />}
      </div>
    )
  }

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
    const type: PlayType | null =
      card.type === 'unit' ? 'PLAY_UNIT' : card.type === 'gear' ? 'PLAY_GEAR' : card.type === 'spell' ? 'PLAY_SPELL' : null
    if (!type) return

    // Accelerate is an OPTIONAL extra cost on units — confirm to pay it so the
    // unit enters READY (can act the turn it arrives).
    let accelerate = false
    let cost = costOf(card)
    if (type === 'PLAY_UNIT') {
      const ac = accelerateCost(card)
      if (ac) {
        accelerate = window.confirm(
          `${card.name} has Accelerate. Pay ${costLabel(ac)} extra so it enters READY (can act now)?\n\nOK = pay & enter ready · Cancel = enter exhausted.`,
        )
        if (accelerate) cost = addCost(cost, ac)
      }
    }

    // Every rune-spending play opens the rune picker overlay.
    if (!costIsFree(cost)) {
      if (!autoPay(match.players[seat], cost)) return flash('Not enough resources.')
      setPaying({ c, card, type, cost, accelerate })
      return
    }
    proceedPlay(c, card, type, { exhaust: [], recycle: [] }, accelerate)
  }

  const proceedPlay = (c: EngineCard, card: Card, type: PlayType, payment: Payment, accelerate: boolean) => {
    if (type === 'PLAY_SPELL' && needsTarget(card)) {
      const legal = getLegalTargets(match, card, seat)
      if (legal.length === 0) {
        if (confirm('No legal targets. Play it anyway for its other effect?'))
          dispatch({ type: 'PLAY_SPELL', player: seat, iid: c.iid, payment })
        return
      }
      const count = spellEffect(card).targetCount || 1
      setTargeting({ iid: c.iid, cardId: card.id, payment, kind: 'spell', count, picked: [] })
      flash(count > 1 ? `Pick up to ${count} targets.` : 'Pick a target unit.')
      return
    }
    if (type === 'PLAY_GEAR' && friendlyUnitIids(match, seat).length > 0) {
      setTargeting({ iid: c.iid, cardId: card.id, payment, kind: 'gear', count: 1, picked: [] })
      flash('Choose a unit to equip.')
      return
    }
    if (type === 'PLAY_UNIT') {
      const reactionWindow = match.chain.length > 0 || match.phase === 'showdown'
      if (parseKeywords(card).ambush && reactionWindow) {
        const legal = match.battlefields
          .map((bf, i) => ({ bf, i }))
          .filter((x) => x.bf.units.some((u) => u.owner === seat))
        if (legal.length === 0) return flash('No battlefield with your units for Ambush.')
        if (legal.length === 1) {
          dispatch({ type, player: seat, iid: c.iid, payment, accelerate, toBattlefield: legal[0].i })
          return
        }
        setAmbushPick({
          iid: c.iid,
          payment,
          accelerate,
          options: legal.map((x) => ({ label: getCard(x.bf.cardId)?.name ?? `Battlefield ${x.i + 1}`, value: x.i })),
        })
        return
      }
      dispatch({ type, player: seat, iid: c.iid, payment, accelerate })
    } else dispatch({ type, player: seat, iid: c.iid, payment })
  }
  const castSpell = (t: NonNullable<typeof targeting>, targets: string[]) => {
    setTargeting(null)
    const card = getCard(t.cardId)
    const surcharge = deflectSurcharge(match, targets, seat)
    if (surcharge > 0 && card) {
      setDeflectPay({ iid: t.iid, card, base: t.payment, targets, surcharge })
      return
    }
    dispatch({ type: 'PLAY_SPELL', player: seat, iid: t.iid, payment: t.payment, targets })
  }

  const onTarget = (targetIid: string) => {
    if (!targeting) return
    if (targeting.kind === 'gear') {
      dispatch({ type: 'PLAY_GEAR', player: seat, iid: targeting.iid, payment: targeting.payment, targetIid })
      setTargeting(null)
      return
    }
    const picked = [...targeting.picked, targetIid]
    if (picked.length >= targeting.count) castSpell(targeting, picked)
    else setTargeting({ ...targeting, picked })
  }
  const confirmTargets = () => {
    if (!targeting || targeting.picked.length === 0) return
    castSpell(targeting, targeting.picked)
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
        onMove={(iids, bf) => dispatch({ type: 'MOVE_UNITS', player: seat, iids, toBattlefield: bf })}
        onPass={() => dispatch({ type: 'PASS', player: seat })}
        onPassPriority={() => dispatch({ type: 'PASS_PRIORITY', player: seat })}
        onCounter={counterWith}
        onEndTurn={() => dispatch({ type: 'END_TURN', player: seat })}
        onConcede={() => dispatch({ type: 'CONCEDE', player: seat })}
        onCardAction={(a) => dispatch(a)}
        targetingActive={!!targeting}
        legalTargets={
          targeting
            ? (targeting.kind === 'gear'
                ? friendlyUnitIids(match, seat)
                : getLegalTargets(match, getCard(targeting.cardId)!, seat)
              ).filter((id) => !targeting.picked.includes(id))
            : undefined
        }
        targetProgress={targeting && targeting.count > 1 ? { picked: targeting.picked.length, count: targeting.count } : undefined}
        onTarget={onTarget}
        onConfirmTargets={confirmTargets}
        onCancelTarget={() => setTargeting(null)}
        onInspect={setInspect}
        events={lastEvents}
      />
      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
      {paying && (
        <PaymentModal
          player={match.players[seat]}
          card={paying.card}
          cost={paying.cost}
          onCancel={() => setPaying(null)}
          onConfirm={(payment) => {
            const p = paying
            setPaying(null)
            if (p.counterChainId)
              dispatch({ type: 'COUNTER', player: seat, iid: p.c.iid, targetChainId: p.counterChainId, payment })
            else proceedPlay(p.c, p.card, p.type, payment, p.accelerate)
          }}
        />
      )}
      {(() => {
        const step = pendingAssignment(match, seat)
        return step ? (
          <DamageAssignModal
            match={match}
            step={step}
            onConfirm={(allocations) => dispatch({ type: 'ASSIGN_DAMAGE', player: seat, allocations })}
          />
        ) : null
      })()}
      {summary && (
        <BattleSummary match={match} events={summary.events} token={summary.token} onClose={() => setSummary(null)} />
      )}
      {match.vision && match.vision.player === seat && (
        <VisionPrompt
          cardId={match.vision.cardId}
          onKeep={() => dispatch({ type: 'VISION_DECIDE', player: seat, recycle: false })}
          onRecycle={() => dispatch({ type: 'VISION_DECIDE', player: seat, recycle: true })}
        />
      )}
      {match.readyChoice && match.readyChoice.player === seat && (() => {
        const units = [...match.players[seat].zones.base, ...match.battlefields.flatMap((b) => b.units)].filter(
          (u) => u.owner === seat && u.exhausted && getCard(u.cardId)?.type === 'unit',
        )
        return units.length ? (
          <ChoiceModal
            title="↻ Ready a unit"
            subtitle={`Choose an exhausted unit to ready (${match.readyChoice!.count} to ready).`}
            options={units.map((u) => ({ label: getCard(u.cardId)?.name ?? u.iid, value: u.iid }))}
            onPick={(iid) => dispatch({ type: 'READY_UNIT', player: seat, iid: String(iid) })}
          />
        ) : null
      })()}
      {ambushPick && (
        <ChoiceModal
          title="⚡ Ambush"
          subtitle="Choose a battlefield where you have units to play this unit into combat."
          options={ambushPick.options}
          onPick={(bf) => {
            const a = ambushPick
            setAmbushPick(null)
            dispatch({ type: 'PLAY_UNIT', player: seat, iid: a.iid, payment: a.payment, accelerate: a.accelerate, toBattlefield: bf })
          }}
          onCancel={() => setAmbushPick(null)}
        />
      )}
      {deflectPay && (
        <PaymentModal
          player={match.players[seat]}
          card={deflectPay.card}
          cost={{ energy: deflectPay.surcharge, power: {} }}
          reserved={[...deflectPay.base.exhaust, ...deflectPay.base.recycle]}
          onCancel={() => setDeflectPay(null)}
          onConfirm={(sur) => {
            const d = deflectPay
            setDeflectPay(null)
            const merged: Payment = {
              exhaust: [...d.base.exhaust, ...sur.exhaust],
              recycle: [...d.base.recycle, ...sur.recycle],
              poolEnergy: (d.base.poolEnergy ?? 0) + (sur.poolEnergy ?? 0) || undefined,
            }
            dispatch({ type: 'PLAY_SPELL', player: seat, iid: d.iid, payment: merged, targets: d.targets })
          }}
        />
      )}
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
