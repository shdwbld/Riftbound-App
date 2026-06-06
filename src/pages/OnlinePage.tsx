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
import { reduce, getLegalTargets, pendingAssignment, deflectSurcharge, repeatCostFor, canActivateUnit } from '../engine/engine'
import { autoPay, autoPayEff, effectiveCostOf, addCost, costIsFree } from '../engine/autopay'
import { needsTarget, spellEffect } from '../engine/effects'
import { checkInvariants } from '../engine/invariants'
import { accelerateCost, optionalPlayCost, parseKeywords, type KeywordCost } from '../engine/keywords'
import { DOMAIN_META, type Domain } from '../types/cards'
import PaymentModal from '../components/PaymentModal'
import PromptModal from '../components/PromptModal'
import BugReportModal from '../components/BugReportModal'
import { submitBugReport, bugCaptureEnabled } from '../lib/bugReport'
import ChoiceModal from '../components/ChoiceModal'
import TagNameModal from '../components/TagNameModal'
import VisionPrompt from '../components/VisionPrompt'
import DamageAssignModal from '../components/DamageAssignModal'
import BattleSummary, { worthSummarizing } from '../components/BattleSummary'
import TurnRecapBanner, { type TurnRecapData } from '../components/TurnRecapBanner'
import { accumulateTurnRecap } from './MatchPage'

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
import type { PingData } from '../components/PingLayer'
import CardDetailModal from '../components/CardDetailModal'
import { MulliganView } from './MatchPage'
import SetupScreen from '../components/SetupScreen'
import { saveSession, loadSession, clearSession, saveHostState, loadHostState } from '../lib/onlineSession'

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
  const [targeting, setTargeting] = useState<{ iid: string; cardId: string; payment: Payment; kind: 'spell' | 'gear' | 'activateUnit'; count: number; picked: string[]; repeat?: boolean; targetScope?: 'enemy' | 'friendly' | 'any' } | null>(null)
  const [lastEvents, setLastEvents] = useState<GameEvent[] | undefined>(undefined)
  // The pending play awaiting a chosen rune payment (the overlay).
  const [paying, setPaying] = useState<{ c: EngineCard; card: Card; type: PlayType; cost: ResolvedCost; accelerate: boolean; counterChainId?: string; repeat?: boolean; payAdditionalCost?: boolean } | null>(null)
  const [summary, setSummary] = useState<{ events: GameEvent[]; token: number } | null>(null)
  // End-of-turn recap banner + per-turn event buffer (keyed by match.turn).
  const [recap, setRecap] = useState<TurnRecapData | null>(null)
  const recapBufRef = useRef<{ turn: number; events: GameEvent[] }>({ turn: -1, events: [] })
  const [ambushPick, setAmbushPick] = useState<{ iid: string; payment: Payment; accelerate: boolean; payAdditionalCost?: boolean; options: { label: string; value: number }[] } | null>(null)
  // Pending "Equip to a unit" choice for an unattached gear in base.
  const [attachPick, setAttachPick] = useState<{ gearIid: string } | null>(null)
  // Pending play destination for a unit whose rules let it enter a battlefield.
  const [destPick, setDestPick] = useState<{ iid: string; payment: Payment; accelerate: boolean; payAdditionalCost?: boolean; options: { label: string; value: number }[] } | null>(null)
  // Pending optional additional-cost Pay/Skip prompt (rune-modal style).
  const [optCostPrompt, setOptCostPrompt] = useState<{ c: EngineCard; card: Card; cost: ResolvedCost; accelerate: boolean; opt: KeywordCost | null } | null>(null)
  // Pending Accelerate / Repeat decisions — centered rune-modal style (not a browser confirm).
  const [accelPrompt, setAccelPrompt] = useState<{ c: EngineCard; card: Card } | null>(null)
  const [repeatPrompt, setRepeatPrompt] = useState<{ c: EngineCard; card: Card } | null>(null)
  const [deflectPay, setDeflectPay] = useState<{ iid: string; card: Card; base: Payment; targets: string[]; surcharge: number; repeat?: boolean } | null>(null)
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '')
  const [seat, setSeat] = useState<PlayerId>(0)
  const [lobbyInfo, setLobbyInfo] = useState<{ joined: number; needed: number }>({
    joined: 1,
    needed: 2,
  })

  // Ephemeral Alt+click pings, broadcast peer-to-peer (cosmetic, not via the
  // host-authoritative state path).
  const [pings, setPings] = useState<PingData[]>([])
  const pingId = useRef(0)
  const addPing = (x: number, y: number, name?: string) => {
    const id = ++pingId.current
    setPings((ps) => [...ps, { id, x, y, name }])
    setTimeout(() => setPings((ps) => ps.filter((p) => p.id !== id)), 2000)
  }

  const transportRef = useRef<Transport | null>(null)
  const matchRef = useRef<MatchState | null>(null)
  const historyRef = useRef<MatchState[]>([]) // host-side undo history (pre-action states)
  // The most recent {pre → action → post → events} step, for one-click bug capture (host-side).
  const lastStepRef = useRef<{ pre: MatchState; action: Action; post: MatchState; events: GameEvent[] } | null>(null)
  const [bugOpen, setBugOpen] = useState(false)
  const roleRef = useRef<Role>('host')
  const myDeckRef = useRef<Deck | null>(null)
  const clientIdRef = useRef<string>(makeClientId())
  const seatRef = useRef<PlayerId>(0)
  const countRef = useRef<number>(2)
  const joinsRef = useRef<JoinRecord[]>([])
  const startedRef = useRef(false)
  const joinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seatsRef = useRef<Record<string, number>>({})
  const roomCodeRef = useRef('')
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // An opponent dropped out of presence (not a clean leave) — waiting to reconnect.
  const [disconnected, setDisconnected] = useState(false)

  const flash = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 2600)
  }

  // Persist the session so a refresh can rejoin the same match.
  const persistSession = (role: Role, seat: number) => {
    if (!roomCodeRef.current) return
    saveSession({ roomCode: roomCodeRef.current, role, seat, clientId: clientIdRef.current, count: countRef.current })
  }
  const hostPersist = (state: MatchState) => saveHostState({ state, seats: seatsRef.current })

  // Presence: detect an opponent dropping out (not a clean leave) once the match
  // is live, and clear the banner when they reconnect.
  const onPresence = (ids: string[]) => {
    if (!matchRef.current) return // still in lobby — ignore
    const peers = ids.filter((id) => id !== clientIdRef.current).length
    const expected = Math.max(1, countRef.current - 1)
    if (peers >= expected) {
      setDisconnected(false)
      if (graceRef.current) {
        clearTimeout(graceRef.current)
        graceRef.current = null
      }
    } else {
      setDisconnected(true)
      if (!graceRef.current)
        graceRef.current = setTimeout(() => {
          graceRef.current = null
          flash('Opponent did not reconnect — you can end the match from the room bar.')
        }, 45000)
    }
  }
  /** Wire a transport's message + presence handlers. */
  const connect = (t: Transport) => {
    wire(t)
    t.onPresence(onPresence)
  }

  useEffect(() => () => transportRef.current?.close(), [])

  // Reconnect after a refresh: if a session was persisted, rejoin the same room.
  // Host restores its canonical state and re-broadcasts; guest rejoins and asks
  // the host to resync. Runs once on mount.
  useEffect(() => {
    const s = loadSession()
    if (!s || transportRef.current) return
    clientIdRef.current = s.clientId
    countRef.current = s.count
    roomCodeRef.current = s.roomCode
    roleRef.current = s.role
    seatRef.current = s.seat as PlayerId
    setRole(s.role)
    setSeat(s.seat as PlayerId)
    setRoomCode(s.roomCode)
    const t = createTransport(s.roomCode, s.clientId)
    transportRef.current = t
    connect(t)
    if (s.role === 'host') {
      const snap = loadHostState()
      if (snap) {
        startedRef.current = true
        seatsRef.current = snap.seats
        matchRef.current = snap.state
        setMatch(snap.state)
        setStatus('connected')
        // Re-broadcast so any still-connected guest resyncs.
        setTimeout(() => t.send({ kind: 'state', state: snap.state }), 300)
      } else {
        clearSession() // host had no match yet — nothing to resume
      }
    } else {
      // Guest: rejoin and request the current match from the host.
      setStatus('waiting')
      t.send({ kind: 'resync', clientId: s.clientId })
      if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current)
      joinTimeoutRef.current = setTimeout(() => {
        flash('Could not reconnect to the room.')
        leave()
      }, 9000)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clear the persisted session once the match is over.
  useEffect(() => {
    if (match?.winner != null) clearSession()
  }, [match?.winner])

  // Replay combat/chain resolutions (host, guest, or local all flow through lastEvents).
  useEffect(() => {
    if (worthSummarizing(lastEvents)) setSummary({ events: lastEvents!, token: matchRef.current?.seq ?? 0 })
    // Accumulate the turn's events; show the recap banner when the turn flips.
    const m = matchRef.current
    if (m) {
      const r = accumulateTurnRecap(recapBufRef.current, m, lastEvents)
      if (r) setRecap(r)
    }
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
    seatsRef.current = seats
    matchRef.current = m
    setMatch(m)
    setStatus('connected')
    persistSession('host', 0)
    hostPersist(m)
    t.send({ kind: 'start', state: m, seats })
  }

  function wire(t: Transport) {
    t.onMessage((msg: NetMessage) => {
      // Pings are cosmetic and peer-to-peer — render them regardless of role.
      if (msg.kind === 'ping') {
        addPing(msg.x, msg.y, msg.name)
        return
      }
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
          historyRef.current.push(cur)
          if (historyRef.current.length > 100) historyRef.current.shift()
          lastStepRef.current = { pre: cur, action: msg.action, post: state, events: events ?? [] }
          if (import.meta.env.DEV) { const viol = checkInvariants(state); if (viol.length) console.warn('[invariants]', msg.action.type, viol) }
          matchRef.current = state
          setLastEvents(events)
          setMatch(state)
          hostPersist(state)
          t.send({ kind: 'state', state, events })
        } else if (msg.kind === 'undo') {
          // A guest asked to undo — pop the host's history and rebroadcast.
          const prev = historyRef.current.pop()
          if (!prev) return
          matchRef.current = prev
          setLastEvents(undefined)
          setMatch(prev)
          hostPersist(prev)
          t.send({ kind: 'state', state: prev })
        } else if (msg.kind === 'resync') {
          // A reconnecting guest asks for the current match — re-send start + state.
          if (matchRef.current) {
            t.send({ kind: 'start', state: matchRef.current, seats: seatsRef.current })
            t.send({ kind: 'state', state: matchRef.current })
          }
        } else if (msg.kind === 'leave') {
          flash('A player left the room.')
        }
      } else {
        // guest — a reply means we found the room; cancel the join timeout.
        if (joinTimeoutRef.current) {
          clearTimeout(joinTimeoutRef.current)
          joinTimeoutRef.current = null
        }
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
          countRef.current = msg.state.players.length
          matchRef.current = msg.state
          setMatch(msg.state)
          setStatus('connected')
          persistSession('guest', mySeat) // remember our seat for a refresh
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
    roomCodeRef.current = code
    setRoomCode(code)
    setLobbyInfo({ joined: 1, needed: count })
    const t = createTransport(code, clientIdRef.current)
    transportRef.current = t
    connect(t)
    setStatus('waiting')
    persistSession('host', 0)
  }

  const joinRoom = (code: string) => {
    const deck = getDeck(deckId)
    if (!deck) return flash('Pick a deck first.')
    if (!code.trim()) return flash('Enter a room code.')
    roleRef.current = 'guest'
    myDeckRef.current = deck
    setRole('guest')
    roomCodeRef.current = code.toUpperCase()
    setRoomCode(code.toUpperCase())
    const t = createTransport(code.toUpperCase(), clientIdRef.current)
    transportRef.current = t
    connect(t)
    setStatus('waiting')
    persistSession('guest', 0)
    t.send({ kind: 'join', name: deck.name, deck, clientId: clientIdRef.current })
    // No host responds to an invalid/expired code — give feedback instead of
    // hanging in "waiting" forever.
    if (joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current)
    joinTimeoutRef.current = setTimeout(() => {
      flash(`No room found for code "${code.toUpperCase()}". Check the code and try again.`)
      leave()
    }, 9000)
  }

  const leave = () => {
    if (joinTimeoutRef.current) {
      clearTimeout(joinTimeoutRef.current)
      joinTimeoutRef.current = null
    }
    if (graceRef.current) {
      clearTimeout(graceRef.current)
      graceRef.current = null
    }
    clearSession()
    setDisconnected(false)
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
      historyRef.current.push(cur)
      if (historyRef.current.length > 100) historyRef.current.shift()
      lastStepRef.current = { pre: cur, action, post: state, events: events ?? [] }
      if (import.meta.env.DEV) { const viol = checkInvariants(state); if (viol.length) console.warn('[invariants]', action.type, viol) }
      matchRef.current = state
      setLastEvents(events)
      setMatch(state)
      transportRef.current?.send({ kind: 'state', state, events })
    } else {
      transportRef.current?.send({ kind: 'action', action })
    }
  }

  // Multi-step undo. Host pops its history + rebroadcasts; a guest asks the host.
  const undo = () => {
    if (roleRef.current === 'host') {
      const prev = historyRef.current.pop()
      if (!prev) return flash('Nothing to undo.')
      matchRef.current = prev
      setLastEvents(undefined)
      setMatch(prev)
      hostPersist(prev)
      transportRef.current?.send({ kind: 'state', state: prev })
    } else {
      transportRef.current?.send({ kind: 'undo' })
    }
  }

  // Capture a bug: the last {pre → action → post → events} step + invariants → Supabase.
  const submitBug = async (note: string, severity: 'low' | 'med' | 'high') => {
    const post = matchRef.current
    if (!post) throw new Error('No active match.')
    const step = lastStepRef.current
    const id = await submitBugReport({
      note,
      severity,
      mode: 'online',
      seq: post.seq,
      preState: step?.pre ?? null,
      action: step?.action ?? null,
      postState: step?.post ?? post,
      events: step?.events ?? [],
      invariants: checkInvariants(step?.post ?? post),
      appVersion: import.meta.env.MODE,
    })
    flash(`🐞 Bug ${id.slice(0, 8)} captured.`)
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
      return card?.type === 'spell' && !!autoPayEff(match, seat, card)
    })
    if (!reaction) return flash('No affordable Reaction spell to counter with.')
    const card = getCard(reaction.cardId)!
    const cost = effectiveCostOf(match, seat, card)
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

  const amOut = match.players[seat]?.out === true
  const myTurn = controlling === seat && !amOut
  const play = (c: EngineCard) => {
    const card = getCard(c.cardId)
    if (!card) return
    const type: PlayType | null =
      card.type === 'unit' ? 'PLAY_UNIT' : card.type === 'gear' ? 'PLAY_GEAR' : card.type === 'spell' ? 'PLAY_SPELL' : null
    if (!type) return

    const cost = effectiveCostOf(match, seat, card)
    if (type === 'PLAY_UNIT') {
      // Accelerate is an OPTIONAL extra cost on units — ask via a centered modal
      // (pay → enter ready and act now; skip → enter exhausted). Resume in resolveAccel.
      if (accelerateCost(card)) {
        setAccelPrompt({ c, card })
        return
      }
      continueUnitPlay(c, card, cost, false)
      return
    }
    if (type === 'PLAY_SPELL') {
      // Repeat is an OPTIONAL extra cost on spells — ask via a centered modal
      // (pay → resolve its effect twice). Resume in resolveRepeat.
      if (repeatCostFor(match, seat, card)) {
        setRepeatPrompt({ c, card })
        return
      }
    }
    finishPlay(c, card, type, cost, false, false, false)
  }

  /** Continue a unit play once Accelerate is decided: handle the optional
   *  additional-cost Pay/Skip prompt, else settle payment. */
  const continueUnitPlay = (c: EngineCard, card: Card, cost: ResolvedCost, accelerate: boolean) => {
    const opt = optionalPlayCost(card)
    const isBard = card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Bard - Mercurial'
    if (opt || isBard) {
      setOptCostPrompt({ c, card, cost, accelerate, opt: opt ?? null })
      return
    }
    finishPlay(c, card, 'PLAY_UNIT', cost, accelerate, false, false)
  }

  /** Resolve the Accelerate Pay/Skip modal and resume the unit play. */
  const resolveAccel = (pay: boolean) => {
    const p = accelPrompt
    if (!p) return
    setAccelPrompt(null)
    let cost = effectiveCostOf(match, seat, p.card)
    const ac = accelerateCost(p.card)
    if (pay && ac) cost = addCost(cost, ac)
    continueUnitPlay(p.c, p.card, cost, pay)
  }

  /** Resolve the Repeat Pay/Skip modal and resume the spell play. */
  const resolveRepeat = (pay: boolean) => {
    const p = repeatPrompt
    if (!p) return
    setRepeatPrompt(null)
    let cost = effectiveCostOf(match, seat, p.card)
    const rc = repeatCostFor(match, seat, p.card)
    if (pay && rc) cost = addCost(cost, rc)
    finishPlay(p.c, p.card, 'PLAY_SPELL', cost, false, pay, false)
  }

  /** Settle payment (rune picker or free) then hand off to proceedPlay. */
  const finishPlay = (c: EngineCard, card: Card, type: PlayType, cost: ResolvedCost, accelerate: boolean, repeat: boolean, payAdditionalCost: boolean) => {
    if (!costIsFree(cost)) {
      if (!autoPay(match.players[seat], cost)) return flash('Not enough resources.')
      setPaying({ c, card, type, cost, accelerate, repeat, payAdditionalCost })
      return
    }
    proceedPlay(c, card, type, { exhaust: [], recycle: [] }, accelerate, repeat, payAdditionalCost)
  }

  /** Resolve the optional additional-cost Pay/Skip prompt and resume the play. */
  const resolveOptCost = (pay: boolean) => {
    const p = optCostPrompt
    if (!p) return
    setOptCostPrompt(null)
    const cost = pay && p.opt ? addCost(p.cost, p.opt) : p.cost
    finishPlay(p.c, p.card, 'PLAY_UNIT', cost, p.accelerate, false, pay)
  }

  const proceedPlay = (c: EngineCard, card: Card, type: PlayType, payment: Payment, accelerate: boolean, repeat = false, payAdditionalCost = false) => {
    if (type === 'PLAY_SPELL' && needsTarget(card)) {
      const legal = getLegalTargets(match, card, seat)
      if (legal.length === 0) {
        if (confirm('No legal targets. Play it anyway for its other effect?'))
          dispatch({ type: 'PLAY_SPELL', player: seat, iid: c.iid, payment, repeat })
        return
      }
      const count = spellEffect(card).targetCount || 1
      setTargeting({ iid: c.iid, cardId: card.id, payment, kind: 'spell', count, picked: [], repeat })
      flash(count > 1 ? `Pick up to ${count} targets.` : 'Pick a target unit.')
      return
    }
    const isEquipment = parseKeywords(card).equip || /attach (?:this|it) to a unit/i.test(card.text ?? '')
    if (type === 'PLAY_GEAR' && isEquipment && friendlyUnitIids(match, seat).length > 0) {
      setTargeting({ iid: c.iid, cardId: card.id, payment, kind: 'gear', count: 1, picked: [] })
      flash('Choose a unit to equip (or right-click the gear later to attach).')
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
          dispatch({ type, player: seat, iid: c.iid, payment, accelerate, payAdditionalCost, toBattlefield: legal[0].i })
          return
        }
        setAmbushPick({
          iid: c.iid,
          payment,
          accelerate,
          payAdditionalCost,
          options: legal.map((x) => ({ label: getCard(x.bf.cardId)?.name ?? `Battlefield ${x.i + 1}`, value: x.i })),
        })
        return
      }
      // Cards whose rules let them be played to a battlefield (Blitzcrank, Mischievous
      // Marai, Shadow): offer Base vs each battlefield — card rules override "enter base".
      if (/play (?:me|this) to (?:a|an|any|its)?\s*battlefield/i.test(card.text ?? '') && match.battlefields.length > 0) {
        setDestPick({
          iid: c.iid,
          payment,
          accelerate,
          payAdditionalCost,
          options: [
            { label: '🏠 Base (bench)', value: -1 },
            ...match.battlefields.map((bf, i) => ({ label: getCard(bf.cardId)?.name ?? `Battlefield ${i + 1}`, value: i })),
          ],
        })
        return
      }
      dispatch({ type, player: seat, iid: c.iid, payment, accelerate, payAdditionalCost })
    } else if (type === 'PLAY_SPELL') dispatch({ type, player: seat, iid: c.iid, payment, repeat })
    else dispatch({ type, player: seat, iid: c.iid, payment })
  }
  const castSpell = (t: NonNullable<typeof targeting>, targets: string[]) => {
    setTargeting(null)
    const card = getCard(t.cardId)
    const surcharge = deflectSurcharge(match, targets, seat)
    if (surcharge > 0 && card) {
      setDeflectPay({ iid: t.iid, card, base: t.payment, targets, surcharge, repeat: t.repeat })
      return
    }
    dispatch({ type: 'PLAY_SPELL', player: seat, iid: t.iid, payment: t.payment, targets, repeat: t.repeat })
  }

  const activateUnit = (iid: string) => {
    const ab = canActivateUnit(match, seat, iid)
    if (!ab) return
    // Deck-dig / play-from-zone abilities (Baited Hook: "Kill a friendly unit. Look
    // at the top 5 → play it") auto-resolve in the engine — activate with no target
    // prompt even though the first sentence ("kill a friendly unit") looks targeted.
    const autoResolves = !!(ab.effect.peekBanishPlay || ab.effect.playUnitFromTrash || ab.effect.playUnitFromHand || ab.effect.revealPlayFromDeck || ab.effect.peekDraw || ab.effect.peekToHand || ab.effect.returnFromTrash)
    const needsTgt = !autoResolves && (ab.effect.damage > 0 || ab.effect.buff > 0 || ab.effect.stun > 0 || ab.effect.kill > 0 || ab.effect.grantAssault > 0 || ab.effect.grantGanking || ab.effect.readyUnits > 0 || /\bmove\b/i.test(ab.effectText) || /(return|put|bounce)[^.]*\bhand\b/i.test(ab.effectText) || (ab.effect.tempMight !== 0 && !ab.doubleMight && !ab.effect.tempMightSelf))
    if (!needsTgt) { dispatch({ type: 'ACTIVATE_UNIT', player: seat, iid }); return }
    const scope: 'enemy' | 'friendly' = (ab.effect.damage > 0 || ab.effect.stun > 0 || ab.effect.kill > 0) ? 'enemy' : 'friendly'
    setTargeting({ iid, cardId: '', payment: { exhaust: [], recycle: [] }, kind: 'activateUnit', count: 1, picked: [], targetScope: scope })
    flash(scope === 'enemy' ? 'Pick an enemy unit.' : 'Pick a unit to buff.')
  }
  const activeLegalTargets = (): string[] => {
    if (!targeting) return []
    if (targeting.kind === 'gear') return friendlyUnitIids(match, seat)
    if (targeting.kind === 'activateUnit') {
      const units = match.battlefields.flatMap((b) => b.units).concat(match.players.flatMap((p) => p.zones.base.filter((c) => getCard(c.cardId)?.type === 'unit')))
      return units.filter((u) => (targeting.targetScope === 'enemy' ? u.owner !== seat : u.owner === seat)).map((u) => u.iid)
    }
    return getLegalTargets(match, getCard(targeting.cardId)!, seat)
  }

  const onTarget = (targetIid: string) => {
    if (!targeting) return
    if (targeting.kind === 'gear') {
      dispatch({ type: 'PLAY_GEAR', player: seat, iid: targeting.iid, payment: targeting.payment, targetIid })
      setTargeting(null)
      return
    }
    if (targeting.kind === 'activateUnit') {
      dispatch({ type: 'ACTIVATE_UNIT', player: seat, iid: targeting.iid, targets: [targetIid] })
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
          <>
            <button
              onClick={() => dispatch({ type: 'SET_SANDBOX', player: seat, on: !match.sandbox })}
              title="Manual overrides (shared): when ON, either player can right-click ANY card to stun / ready / kill / ±Might / move it, to fix or override the engine."
              className={`rounded px-2 py-1 text-xs font-semibold ${
                match.sandbox ? 'bg-fuchsia-500/40 text-fuchsia-100' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              {match.sandbox ? '🛠 Overrides: ON' : '🛠 Overrides'}
            </button>
            <button
              onClick={() => setBugOpen(true)}
              title="Report a bug — captures the last action + game state"
              className="rounded bg-white/5 px-2 py-1 text-xs font-semibold text-white/50 hover:bg-white/10"
            >
              🐞 Report bug
            </button>
            <span className={`rounded px-2 py-1 text-xs ${myTurn ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/5 text-white/50'}`}>
              {myTurn ? 'Your move' : `${match.players[controlling].name}'s move`}
            </span>
          </>
        }
      />
      {amOut && (
        <div className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/60">
          👁 You're out of the match — spectating the remaining players.
        </div>
      )}
      {disconnected && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-400/50 bg-amber-500/15 px-3 py-2 text-sm text-amber-100">
          <span className="fx-ready">⚠ Opponent disconnected — waiting for them to reconnect…</span>
          <button onClick={leave} className="rounded bg-rose-500/30 px-3 py-1 text-xs font-semibold text-rose-100 hover:bg-rose-500/50">
            End match
          </button>
        </div>
      )}
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
        onActivateUnit={activateUnit}
        onAttachGear={(gearIid) => setAttachPick({ gearIid })}
        onUndo={undo}
        targetingActive={!!targeting}
        legalTargets={
          targeting
            ? activeLegalTargets().filter((id) => !targeting.picked.includes(id))
            : undefined
        }
        targetProgress={targeting && targeting.count > 1 ? { picked: targeting.picked.length, count: targeting.count } : undefined}
        onTarget={onTarget}
        onConfirmTargets={confirmTargets}
        onCancelTarget={() => setTargeting(null)}
        onInspect={setInspect}
        events={lastEvents}
        onPing={(x, y) => {
          const name = match.players[seat]?.name?.replace(/\s*\([^)]*\)\s*$/, '')
          addPing(x, y, name)
          transportRef.current?.send({ kind: 'ping', x, y, name })
        }}
        pings={pings}
      />
      {inspect && <CardDetailModal card={inspect} onClose={() => setInspect(null)} />}
      {accelPrompt && (
        <PromptModal
          title={`Accelerate ${accelPrompt.card.name.replace(/\s*\([^)]*\)\s*$/, '')}?`}
          message={`Pay ${costLabel(accelerateCost(accelPrompt.card) ?? { energy: 0, power: {} })} extra so it enters ready (can act this turn) — otherwise it enters exhausted.`}
          card={accelPrompt.card}
          options={[
            { label: 'Pay & enter ready', onClick: () => resolveAccel(true), variant: 'primary' },
            { label: 'Enter exhausted', onClick: () => resolveAccel(false) },
          ]}
          onCancel={() => resolveAccel(false)}
        />
      )}
      {repeatPrompt && (
        <PromptModal
          title={`Repeat ${repeatPrompt.card.name.replace(/\s*\([^)]*\)\s*$/, '')}?`}
          message={`Pay ${costLabel(repeatCostFor(match, seat, repeatPrompt.card) ?? { energy: 0, power: {} })} extra to resolve its effect again — otherwise it resolves once.`}
          card={repeatPrompt.card}
          options={[
            { label: 'Pay & repeat', onClick: () => resolveRepeat(true), variant: 'primary' },
            { label: 'Resolve once', onClick: () => resolveRepeat(false) },
          ]}
          onCancel={() => resolveRepeat(false)}
        />
      )}
      {optCostPrompt && (
        <PromptModal
          title="Pay an additional cost?"
          message={`${optCostPrompt.card.name}: ${optCostPrompt.opt ? `pay ${costLabel(optCostPrompt.opt)}` : 'exhaust your legend'} for its bonus.`}
          card={optCostPrompt.card}
          options={[
            { label: optCostPrompt.opt ? `Pay ${costLabel(optCostPrompt.opt)}` : 'Exhaust legend', onClick: () => resolveOptCost(true), variant: 'primary' },
            { label: 'Skip', onClick: () => resolveOptCost(false) },
          ]}
          onCancel={() => resolveOptCost(false)}
        />
      )}
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
            else proceedPlay(p.c, p.card, p.type, payment, p.accelerate, p.repeat, p.payAdditionalCost)
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
      <TurnRecapBanner data={recap} />
      {match.vision && match.vision.player === seat && (
        <VisionPrompt
          cardId={match.vision.cardId}
          onKeep={() => dispatch({ type: 'VISION_DECIDE', player: seat, recycle: false })}
          onRecycle={() => dispatch({ type: 'VISION_DECIDE', player: seat, recycle: true })}
        />
      )}
      {match.readyChoice && match.readyChoice.player === seat && (() => {
        const units = [...match.players[seat].zones.base, ...match.battlefields.flatMap((b) => b.units)].filter(
          (u) => u.owner === seat && u.exhausted && getCard(u.cardId)?.type === 'unit' && u.iid !== match.readyChoice!.excludeIid,
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
            dispatch({ type: 'PLAY_UNIT', player: seat, iid: a.iid, payment: a.payment, accelerate: a.accelerate, payAdditionalCost: a.payAdditionalCost, toBattlefield: bf })
          }}
          onCancel={() => setAmbushPick(null)}
        />
      )}
      {attachPick && (() => {
        const units = [...match.players[seat].zones.base, ...match.battlefields.flatMap((b) => b.units)].filter(
          (u) => u.owner === seat && getCard(u.cardId)?.type === 'unit',
        )
        const gearName = getCard(match.players[seat].zones.base.find((g) => g.iid === attachPick.gearIid)?.cardId ?? '')?.name ?? 'gear'
        return (
          <ChoiceModal
            title="🔗 Equip"
            subtitle={`Attach ${gearName} to which unit?`}
            options={units.map((u) => ({ label: getCard(u.cardId)?.name ?? u.iid, value: u.iid }))}
            onPick={(uid) => {
              const a = attachPick
              setAttachPick(null)
              dispatch({ type: 'ATTACH', player: seat, unitIid: String(uid), gearIid: a.gearIid })
            }}
            onCancel={() => setAttachPick(null)}
          />
        )
      })()}
      {destPick && (
        <ChoiceModal
          title="✦ Where to play?"
          subtitle="This unit's rules let it enter a battlefield, or stay on your base."
          options={destPick.options}
          onPick={(v) => {
            const d = destPick
            setDestPick(null)
            const toBf = Number(v)
            dispatch({ type: 'PLAY_UNIT', player: seat, iid: d.iid, payment: d.payment, accelerate: d.accelerate, payAdditionalCost: d.payAdditionalCost, ...(toBf >= 0 ? { toBattlefield: toBf } : {}) })
          }}
          onCancel={() => setDestPick(null)}
        />
      )}
      {match.pendingChoice && match.pendingChoice.player === seat && match.pendingChoice.kind === 'nameTag' && (
        <TagNameModal
          prompt={match.pendingChoice.prompt}
          onConfirm={(tag) => dispatch({ type: 'RESOLVE_CHOICE', player: seat, iid: tag })}
          onCancel={() => dispatch({ type: 'RESOLVE_CHOICE', player: seat, iid: null })}
        />
      )}
      {match.pendingChoice && match.pendingChoice.player === seat && match.pendingChoice.kind !== 'nameTag' && (
        <ChoiceModal
          title="✦ Battlefield"
          subtitle={match.pendingChoice.prompt}
          options={match.pendingChoice.options.map((o) => ({ label: o.label, value: o.iid }))}
          onPick={(iid) => dispatch({ type: 'RESOLVE_CHOICE', player: seat, iid: String(iid) })}
          onCancel={() => dispatch({ type: 'RESOLVE_CHOICE', player: seat, iid: null })}
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
            dispatch({ type: 'PLAY_SPELL', player: seat, iid: d.iid, payment: merged, targets: d.targets, repeat: d.repeat })
          }}
        />
      )}
      {bugOpen && <BugReportModal enabled={bugCaptureEnabled} onClose={() => setBugOpen(false)} onSubmit={submitBug} />}
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
