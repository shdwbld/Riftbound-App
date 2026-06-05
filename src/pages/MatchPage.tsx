import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { listDecks, getDeck } from '../lib/deckStorage'
import { getCard } from '../data/cards'
import type { Deck } from '../types/deck'
import type { Card } from '../types/cards'
import { type MatchState, type PlayerId, type EngineCard, type Action, type Payment, type ResolvedCost, type GameEvent } from '../engine/types'
import { createMatch } from '../engine/setup'
import { reduce, getLegalTargets, pendingAssignment, deflectSurcharge, repeatCostFor, canActivateUnit } from '../engine/engine'
import { autoPay, autoPayEff, effectiveCostOf, addCost, costIsFree } from '../engine/autopay'
import { needsTarget, spellEffect } from '../engine/effects'
import { accelerateCost, optionalPlayCost, parseKeywords, type KeywordCost } from '../engine/keywords'
import { DOMAIN_META, type Domain } from '../types/cards'
import MulliganHand from '../components/MulliganHand'
import MatchBoard from '../components/MatchBoard'
import CardDetailModal from '../components/CardDetailModal'
import PaymentModal from '../components/PaymentModal'
import PromptModal from '../components/PromptModal'
import ChoiceModal from '../components/ChoiceModal'
import VisionPrompt from '../components/VisionPrompt'
import SetupScreen from '../components/SetupScreen'
import DamageAssignModal from '../components/DamageAssignModal'
import BattleSummary, { worthSummarizing } from '../components/BattleSummary'
import TurnRecapBanner, { type TurnRecapData } from '../components/TurnRecapBanner'
import HotkeyHelp from '../components/HotkeyHelp'

/** Accumulate this-turn events into a buffer; when the turn flips, build a
 *  recap from the just-ended turn's buffer and reset to the new turn. Shared by
 *  hotseat (MatchPage) and online (OnlinePage). Returns recap data, or null if
 *  the turn didn't change. Mutates `buf` in place. */
export function accumulateTurnRecap(
  buf: { turn: number; events: GameEvent[] },
  match: MatchState,
  events: GameEvent[] | undefined,
): TurnRecapData | null {
  // First observation: seed the buffer to the current turn, no recap yet.
  if (buf.turn < 0) {
    buf.turn = match.turn
    buf.events = events?.length ? [...events] : []
    return null
  }
  // Same turn: keep buffering.
  if (buf.turn === match.turn) {
    if (events?.length) buf.events.push(...events)
    return null
  }
  // Turn flipped — summarize the buffer that belongs to the just-ended turn.
  const ended = buf.events
  let spells = 0
  let units = 0
  let exhausted = 0
  let recycled = 0
  let points = 0
  const played: string[] = [] // card ids played this turn, for the thumbnail strip
  const scoreByPlayer = new Map<PlayerId, number>()
  for (const e of ended) {
    if (e.kind === 'play' && e.cardId) {
      const t = getCard(e.cardId)?.type
      if (t === 'spell') spells++
      else if (t === 'unit') units++
      if (t === 'unit' || t === 'spell' || t === 'gear') played.push(e.cardId)
    } else if (e.kind === 'payment') {
      exhausted += e.exhaust ?? 0
      recycled += e.recycle ?? 0
    } else if (e.kind === 'score') {
      points += e.amount ?? 0
      if (e.player != null) scoreByPlayer.set(e.player, (scoreByPlayer.get(e.player) ?? 0) + (e.amount ?? 0))
    }
  }
  const bare = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '')
  const scorers = [...scoreByPlayer.entries()]
    .filter(([, n]) => n > 0)
    .map(([pid, amount]) => ({ name: bare(match.players[pid]?.name ?? `P${pid + 1}`), amount }))
  const recapKey = buf.turn
  // Reset the buffer to the new turn, seeding it with this action's events.
  buf.turn = match.turn
  buf.events = events?.length ? [...events] : []
  return {
    key: recapKey,
    nextPlayer: match.players[match.activePlayer]?.name ?? 'Next player',
    spells,
    units,
    exhausted,
    recycled,
    points,
    played,
    scorers,
  }
}

type PlayType = 'PLAY_UNIT' | 'PLAY_GEAR' | 'PLAY_SPELL'

/** Plain-text label for a cost (used in the Accelerate confirm dialog). */
function costLabel(cost: KeywordCost | ResolvedCost): string {
  const parts: string[] = []
  if (cost.energy) parts.push(`${cost.energy} Energy`)
  for (const [d, n] of Object.entries(cost.power) as [Domain, number][])
    if (n) parts.push(`${n} ${DOMAIN_META[d].label}`)
  return parts.join(' + ') || 'nothing'
}

/** Unit iids the given player controls (base + battlefields) — gear targets. */
function friendlyUnitIids(m: MatchState, p: PlayerId): string[] {
  const ids = m.players[p].zones.base
    .filter((u) => getCard(u.cardId)?.type === 'unit')
    .map((u) => u.iid)
  for (const bf of m.battlefields)
    for (const u of bf.units) if (u.owner === p) ids.push(u.iid)
  return ids
}

export default function MatchPage() {
  const location = useLocation()
  const preDeckId = (location.state as { deckId?: string } | null)?.deckId
  const [match, setMatch] = useState<MatchState | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [inspect, setInspect] = useState<Card | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [targeting, setTargeting] = useState<{ iid: string; cardId: string; payment: Payment; player: PlayerId; kind: 'spell' | 'gear' | 'activateUnit'; count: number; picked: string[]; repeat?: boolean; targetScope?: 'enemy' | 'friendly' | 'any' } | null>(null)
  const [lastEvents, setLastEvents] = useState<GameEvent[] | undefined>(undefined)
  // Rune picker is ON by default — every rune-spending play opens the overlay.
  // Toggle off to auto-pay silently.
  const [manualPay, setManualPay] = useState(true)
  const [paying, setPaying] = useState<{ c: EngineCard; card: Card; type: PlayType; cost: ResolvedCost; accelerate: boolean; counterChainId?: string; repeat?: boolean; payAdditionalCost?: boolean } | null>(null)
  // Animated battle summary after a combat / chain resolution.
  const [summary, setSummary] = useState<{ events: GameEvent[]; token: number } | null>(null)
  // End-of-turn recap banner + per-turn event buffer (keyed by match.turn).
  const [recap, setRecap] = useState<TurnRecapData | null>(null)
  const recapBufRef = useRef<{ turn: number; events: GameEvent[] }>({ turn: -1, events: [] })
  // Pending Ambush battlefield choice.
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
  // Pending Deflect surcharge payment (after a spell's targets are chosen).
  const [deflectPay, setDeflectPay] = useState<{ iid: string; card: Card; base: Payment; targets: string[]; surcharge: number; repeat?: boolean } | null>(null)

  // Stable refs so the keyboard handler always sees current state.
  const matchRef = useRef<MatchState | null>(match)
  matchRef.current = match
  const historyRef = useRef<MatchState[]>([])
  // The most recent {pre → action → post → events} step, for one-click bug capture.
  const lastStepRef = useRef<{ pre: MatchState; action: Action; post: MatchState; events: GameEvent[] } | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }, [])

  const dispatch = useCallback(
    (action: Action) => {
      const cur = matchRef.current
      if (!cur) return
      const { state, error, events } = reduce(cur, action)
      if (error) return flash(error)
      historyRef.current.push(cur)
      if (historyRef.current.length > 100) historyRef.current.shift()
      lastStepRef.current = { pre: cur, action, post: state, events: events ?? [] }
      setLastEvents(events)
      if (worthSummarizing(events)) setSummary({ events: events!, token: state.seq })
      const r = accumulateTurnRecap(recapBufRef.current, state, events)
      if (r) setRecap(r)
      setMatch(state)
    },
    [flash],
  )
  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (prev) setMatch(prev)
    else flash('Nothing to undo.')
  }, [flash])

  // Global hotkeys (active during a live match).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = matchRef.current
      if (!m) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const ctrl =
        m.phase === 'showdown' && m.showdown ? m.showdown.priority : m.activePlayer
      const k = e.key.toLowerCase()
      if (k === '?' || k === 'h') {
        setShowHelp((v) => !v)
        return
      }
      if (k === 'escape') {
        setTargeting(null)
        return
      }
      if (m.phase === 'gameover' || m.phase === 'mulligan') return
      const chainOpen = m.chain.length > 0
      const cp = chainOpen && m.priority != null ? m.priority : ctrl
      switch (k) {
        case ' ':
          e.preventDefault()
          if (chainOpen) dispatch({ type: 'PASS_PRIORITY', player: cp })
          else dispatch(m.phase === 'showdown' ? { type: 'PASS', player: ctrl } : { type: 'END_TURN', player: ctrl })
          break
        case 'a':
        case 's':
          // Approve / resolve the top of the chain = pass priority.
          if (chainOpen) dispatch({ type: 'PASS_PRIORITY', player: cp })
          else flash('No chain to act on.')
          break
        case 'd':
          dispatch({ type: 'DRAW', player: ctrl })
          break
        case 'r':
        case 'backspace':
          e.preventDefault()
          undo()
          break
        case 't':
        case 'c':
          flash('Targeting/counter via the chain panel buttons for now.')
          break
        case 'e':
        case 'p':
          flash('Emotes/pings are not available yet.')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, undo, flash])

  if (!match) return <MatchSetup preDeckId={preDeckId} onStart={setMatch} />

  const act = dispatch

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

  if (match.phase === 'setup')
    return (
      <div className="space-y-3">
        <Toolbar match={match} controlling={0} onExit={() => setMatch(null)} manualPay={manualPay} onToggleManualPay={() => setManualPay((v) => !v)} />
        <SetupScreen match={match} onAct={act} />
      </div>
    )

  if (match.phase === 'mulligan')
    return <MulliganPhase match={match} onAct={act} onExit={() => setMatch(null)} />

  // Hotseat: control flips to whoever must decide — chain priority first,
  // then showdown priority, then the active player.
  const controlling: PlayerId =
    match.chain.length > 0 && match.priority != null
      ? match.priority
      : match.phase === 'showdown' && match.showdown
        ? match.showdown.priority
        : match.activePlayer

  const counterWith = (targetChainId: string) => {
    const me = match.players[controlling]
    const reaction = me.zones.hand.find((c) => {
      const card = getCard(c.cardId)
      return card?.type === 'spell' && !!autoPayEff(match, controlling, card)
    })
    if (!reaction) return flash('No affordable Reaction spell to counter with.')
    const card = getCard(reaction.cardId)!
    const cost = effectiveCostOf(match, controlling, card)
    // Route the Counter's rune payment through the picker overlay too.
    if (!costIsFree(cost)) {
      if (!autoPay(me, cost)) return flash('Cannot pay for the counter.')
      setPaying({ c: reaction, card, type: 'PLAY_SPELL', cost, accelerate: false, counterChainId: targetChainId })
      return
    }
    act({ type: 'COUNTER', player: controlling, iid: reaction.iid, targetChainId, payment: { exhaust: [], recycle: [] } })
  }

  const play = (c: EngineCard) => {
    const card = getCard(c.cardId)
    if (!card) return
    const type: PlayType | null =
      card.type === 'unit' ? 'PLAY_UNIT' : card.type === 'gear' ? 'PLAY_GEAR' : card.type === 'spell' ? 'PLAY_SPELL' : null
    if (!type) return

    const cost = effectiveCostOf(match, controlling, card)
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
      if (repeatCostFor(match, controlling, card)) {
        setRepeatPrompt({ c, card })
        return
      }
    }
    finishPlay(c, card, type, cost, false, false, false)
  }

  /** Continue a unit play once Accelerate is decided: handle the optional
   *  additional-cost Pay/Skip prompt, else settle payment. */
  const continueUnitPlay = (c: EngineCard, card: Card, cost: ResolvedCost, accelerate: boolean) => {
    // Optional "you may pay X as an additional cost to play me" — pause for a styled
    // Pay/Skip prompt. Bard - Mercurial's cost is "exhaust your legend" (no rune cost).
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
    let cost = effectiveCostOf(match, controlling, p.card)
    const ac = accelerateCost(p.card)
    if (pay && ac) cost = addCost(cost, ac)
    continueUnitPlay(p.c, p.card, cost, pay)
  }

  /** Resolve the Repeat Pay/Skip modal and resume the spell play. */
  const resolveRepeat = (pay: boolean) => {
    const p = repeatPrompt
    if (!p) return
    setRepeatPrompt(null)
    let cost = effectiveCostOf(match, controlling, p.card)
    const rc = repeatCostFor(match, controlling, p.card)
    if (pay && rc) cost = addCost(cost, rc)
    finishPlay(p.c, p.card, 'PLAY_SPELL', cost, false, pay, false)
  }

  /** Settle payment (manual modal or auto) then hand off to proceedPlay. */
  const finishPlay = (c: EngineCard, card: Card, type: PlayType, cost: ResolvedCost, accelerate: boolean, repeat: boolean, payAdditionalCost: boolean) => {
    if (manualPay && !costIsFree(cost)) {
      if (!autoPay(match.players[controlling], cost)) return flash('Not enough resources.')
      setPaying({ c, card, type, cost, accelerate, repeat, payAdditionalCost })
      return
    }
    const payment = autoPay(match.players[controlling], cost)
    if (!payment) return flash('Not enough resources.')
    proceedPlay(c, card, type, payment, accelerate, repeat, payAdditionalCost)
  }

  /** Resolve the optional additional-cost Pay/Skip prompt and resume the play. */
  const resolveOptCost = (pay: boolean) => {
    const p = optCostPrompt
    if (!p) return
    setOptCostPrompt(null)
    const cost = pay && p.opt ? addCost(p.cost, p.opt) : p.cost
    finishPlay(p.c, p.card, 'PLAY_UNIT', cost, p.accelerate, false, pay)
  }

  /** Finish a play once payment is settled (auto or manual): targeting for
   *  spells/gear, or an immediate dispatch for units. */
  const proceedPlay = (c: EngineCard, card: Card, type: PlayType, payment: Payment, accelerate: boolean, repeat = false, payAdditionalCost = false) => {
    if (type === 'PLAY_SPELL' && needsTarget(card)) {
      const legal = getLegalTargets(match, card, controlling)
      if (legal.length === 0) {
        if (confirm('No legal targets. Play it anyway for its other effect?'))
          act({ type: 'PLAY_SPELL', player: controlling, iid: c.iid, payment, repeat })
        return
      }
      const count = spellEffect(card).targetCount || 1
      setTargeting({ iid: c.iid, cardId: card.id, payment, player: controlling, kind: 'spell', count, picked: [], repeat })
      flash(count > 1 ? `Pick up to ${count} targets.` : 'Pick a target unit.')
      return
    }
    const isEquipment = parseKeywords(card).equip || /attach (?:this|it) to a unit/i.test(card.text ?? '')
    if (type === 'PLAY_GEAR' && isEquipment && friendlyUnitIids(match, controlling).length > 0) {
      setTargeting({ iid: c.iid, cardId: card.id, payment, player: controlling, kind: 'gear', count: 1, picked: [] })
      flash('Choose a unit to equip (or right-click the gear later to attach).')
      return
    }
    if (type === 'PLAY_UNIT') {
      // Ambush: during a react window, play directly to a battlefield where you
      // have units (joining the combat) instead of to Base.
      const reactionWindow = match.chain.length > 0 || match.phase === 'showdown'
      if (parseKeywords(card).ambush && reactionWindow) {
        const legal = match.battlefields
          .map((bf, i) => ({ bf, i }))
          .filter((x) => x.bf.units.some((u) => u.owner === controlling))
        if (legal.length === 0) return flash('No battlefield with your units for Ambush.')
        if (legal.length === 1) {
          act({ type, player: controlling, iid: c.iid, payment, accelerate, payAdditionalCost, toBattlefield: legal[0].i })
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
      // Marai, Shadow): offer Base vs each battlefield — the card rules override the
      // default "units enter base".
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
      act({ type, player: controlling, iid: c.iid, payment, accelerate, payAdditionalCost })
    } else if (type === 'PLAY_SPELL') act({ type, player: controlling, iid: c.iid, payment, repeat })
    else act({ type, player: controlling, iid: c.iid, payment })
  }

  // Cast a spell at the chosen targets — charging the Deflect surcharge first
  // if any chosen enemy unit has Deflect.
  const castSpell = (t: NonNullable<typeof targeting>, targets: string[]) => {
    setTargeting(null)
    const card = getCard(t.cardId)
    const surcharge = deflectSurcharge(match, targets, t.player)
    if (surcharge > 0 && card) {
      setDeflectPay({ iid: t.iid, card, base: t.payment, targets, surcharge, repeat: t.repeat })
      return
    }
    act({ type: 'PLAY_SPELL', player: t.player, iid: t.iid, payment: t.payment, targets, repeat: t.repeat })
  }

  // Activate a unit's own printed ability: dispatch directly when it needs no
  // target, else open the picker (damage → enemies, +Might → friendlies).
  const activateUnit = (iid: string) => {
    const ab = canActivateUnit(match, controlling, iid)
    if (!ab) return
    const needsTgt = ab.effect.damage > 0 || ab.effect.buff > 0 || /\bmove\b/i.test(ab.effectText) || /(return|put|bounce)[^.]*\bhand\b/i.test(ab.effectText) || (ab.effect.tempMight !== 0 && !ab.doubleMight && !ab.effect.tempMightSelf)
    if (!needsTgt) {
      act({ type: 'ACTIVATE_UNIT', player: controlling, iid })
      return
    }
    const scope: 'enemy' | 'friendly' = ab.effect.damage > 0 ? 'enemy' : 'friendly'
    setTargeting({ iid, cardId: '', payment: { exhaust: [], recycle: [] }, player: controlling, kind: 'activateUnit', count: 1, picked: [], targetScope: scope })
    flash(scope === 'enemy' ? 'Pick an enemy unit.' : 'Pick a unit to buff.')
  }

  const onTarget = (targetIid: string) => {
    if (!targeting) return
    if (targeting.kind === 'gear') {
      act({ type: 'PLAY_GEAR', player: targeting.player, iid: targeting.iid, payment: targeting.payment, targetIid })
      setTargeting(null)
      return
    }
    if (targeting.kind === 'activateUnit') {
      act({ type: 'ACTIVATE_UNIT', player: targeting.player, iid: targeting.iid, targets: [targetIid] })
      setTargeting(null)
      return
    }
    const picked = [...targeting.picked, targetIid]
    if (picked.length >= targeting.count) castSpell(targeting, picked)
    else setTargeting({ ...targeting, picked }) // keep choosing
  }

  /** Legal targets for the active picker (spell/gear via getLegalTargets, or a
   *  unit-ability via its scope). */
  const activeLegalTargets = (): string[] => {
    if (!targeting) return []
    if (targeting.kind === 'gear') return friendlyUnitIids(match, controlling)
    if (targeting.kind === 'activateUnit') {
      const units = match.battlefields.flatMap((b) => b.units).concat(match.players.flatMap((p) => p.zones.base.filter((c) => getCard(c.cardId)?.type === 'unit')))
      return units.filter((u) => (targeting.targetScope === 'enemy' ? u.owner !== controlling : u.owner === controlling)).map((u) => u.iid)
    }
    return getLegalTargets(match, getCard(targeting.cardId)!, controlling)
  }
  // Resolve a multi-target spell with the targets picked so far ("up to N").
  const confirmTargets = () => {
    if (!targeting || targeting.picked.length === 0) return
    castSpell(targeting, targeting.picked)
  }

  return (
    <div className="space-y-3">
      <Toolbar
        match={match}
        controlling={controlling}
        onExit={() => setMatch(null)}
        manualPay={manualPay}
        onToggleManualPay={() => setManualPay((v) => !v)}
        onToggleSandbox={() => act({ type: 'SET_SANDBOX', player: controlling, on: !match.sandbox })}
      />
      <MatchBoard
        match={match}
        perspective={controlling}
        canAct
        onPlay={play}
        onMove={(iids, bf) => act({ type: 'MOVE_UNITS', player: controlling, iids, toBattlefield: bf })}
        onPass={() => act({ type: 'PASS', player: controlling })}
        onPassPriority={() => act({ type: 'PASS_PRIORITY', player: controlling })}
        onCounter={counterWith}
        onEndTurn={() => act({ type: 'END_TURN', player: controlling })}
        onConcede={() => act({ type: 'CONCEDE', player: controlling })}
        onCardAction={(a) => act(a)}
        onActivateUnit={activateUnit}
        onAttachGear={(gearIid) => setAttachPick({ gearIid })}
        onUndo={undo}
        targetingActive={!!targeting}
        legalTargets={targeting ? activeLegalTargets().filter((id) => !targeting.picked.includes(id)) : undefined}
        targetProgress={targeting && targeting.count > 1 ? { picked: targeting.picked.length, count: targeting.count } : undefined}
        onTarget={onTarget}
        onConfirmTargets={confirmTargets}
        onCancelTarget={() => setTargeting(null)}
        onInspect={setInspect}
        events={lastEvents}
      />
      <div className="flex justify-end">
        <button
          onClick={() => setShowHelp(true)}
          className="rounded bg-white/5 px-2 py-1 text-[11px] text-white/40 hover:bg-white/10"
        >
          ⌨ Hotkeys (H)
        </button>
      </div>
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
          message={`Pay ${costLabel(repeatCostFor(match, controlling, repeatPrompt.card) ?? { energy: 0, power: {} })} extra to resolve its effect again — otherwise it resolves once.`}
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
          player={match.players[controlling]}
          card={paying.card}
          cost={paying.cost}
          onCancel={() => setPaying(null)}
          onConfirm={(payment) => {
            const p = paying
            setPaying(null)
            if (p.counterChainId)
              act({ type: 'COUNTER', player: controlling, iid: p.c.iid, targetChainId: p.counterChainId, payment })
            else proceedPlay(p.c, p.card, p.type, payment, p.accelerate, p.repeat, p.payAdditionalCost)
          }}
        />
      )}
      {(() => {
        const step = pendingAssignment(match, controlling)
        return step ? (
          <DamageAssignModal
            match={match}
            step={step}
            onConfirm={(allocations) => act({ type: 'ASSIGN_DAMAGE', player: controlling, allocations })}
          />
        ) : null
      })()}
      {summary && (
        <BattleSummary match={match} events={summary.events} token={summary.token} onClose={() => setSummary(null)} />
      )}
      <TurnRecapBanner data={recap} />
      {match.vision && match.vision.player === controlling && (
        <VisionPrompt
          cardId={match.vision.cardId}
          onKeep={() => act({ type: 'VISION_DECIDE', player: controlling, recycle: false })}
          onRecycle={() => act({ type: 'VISION_DECIDE', player: controlling, recycle: true })}
        />
      )}
      {match.readyChoice && match.readyChoice.player === controlling && (() => {
        const units = [...match.players[controlling].zones.base, ...match.battlefields.flatMap((b) => b.units)].filter(
          (u) => u.owner === controlling && u.exhausted && getCard(u.cardId)?.type === 'unit' && u.iid !== match.readyChoice!.excludeIid,
        )
        return units.length ? (
          <ChoiceModal
            title="↻ Ready a unit"
            subtitle={`Choose an exhausted unit to ready (${match.readyChoice!.count} to ready).`}
            options={units.map((u) => ({ label: getCard(u.cardId)?.name ?? u.iid, value: u.iid }))}
            onPick={(iid) => act({ type: 'READY_UNIT', player: controlling, iid: String(iid) })}
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
            act({ type: 'PLAY_UNIT', player: controlling, iid: a.iid, payment: a.payment, accelerate: a.accelerate, payAdditionalCost: a.payAdditionalCost, toBattlefield: bf })
          }}
          onCancel={() => setAmbushPick(null)}
        />
      )}
      {attachPick && (() => {
        const units = [...match.players[controlling].zones.base, ...match.battlefields.flatMap((b) => b.units)].filter(
          (u) => u.owner === controlling && getCard(u.cardId)?.type === 'unit',
        )
        const gearName = getCard(match.players[controlling].zones.base.find((g) => g.iid === attachPick.gearIid)?.cardId ?? '')?.name ?? 'gear'
        return (
          <ChoiceModal
            title="🔗 Equip"
            subtitle={`Attach ${gearName} to which unit?`}
            options={units.map((u) => ({ label: getCard(u.cardId)?.name ?? u.iid, value: u.iid }))}
            onPick={(uid) => {
              const a = attachPick
              setAttachPick(null)
              act({ type: 'ATTACH', player: controlling, unitIid: String(uid), gearIid: a.gearIid })
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
            act({ type: 'PLAY_UNIT', player: controlling, iid: d.iid, payment: d.payment, accelerate: d.accelerate, payAdditionalCost: d.payAdditionalCost, ...(toBf >= 0 ? { toBattlefield: toBf } : {}) })
          }}
          onCancel={() => setDestPick(null)}
        />
      )}
      {match.pendingChoice && match.pendingChoice.player === controlling && (
        <ChoiceModal
          title="✦ Battlefield"
          subtitle={match.pendingChoice.prompt}
          options={match.pendingChoice.options.map((o) => ({ label: o.label, value: o.iid }))}
          onPick={(iid) => act({ type: 'RESOLVE_CHOICE', player: controlling, iid: String(iid) })}
          onCancel={() => act({ type: 'RESOLVE_CHOICE', player: controlling, iid: null })}
        />
      )}
      {deflectPay && (
        <PaymentModal
          player={match.players[controlling]}
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
            act({ type: 'PLAY_SPELL', player: controlling, iid: d.iid, payment: merged, targets: d.targets, repeat: d.repeat })
          }}
        />
      )}
      {showHelp && <HotkeyHelp onClose={() => setShowHelp(false)} />}
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
  manualPay,
  onToggleManualPay,
  onToggleSandbox,
}: {
  match: MatchState
  controlling: PlayerId
  onExit: () => void
  manualPay: boolean
  onToggleManualPay: () => void
  onToggleSandbox?: () => void
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
      {onToggleSandbox && (
        <button
          onClick={onToggleSandbox}
          title="Manual overrides (shared): when ON, either player can right-click ANY card to stun / ready / kill / ±Might / move it, to fix or override the engine."
          className={`ml-auto rounded px-2 py-1 text-xs font-semibold ${
            match.sandbox ? 'bg-fuchsia-500/40 text-fuchsia-100' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}
        >
          {match.sandbox ? '🛠 Overrides: ON' : '🛠 Overrides'}
        </button>
      )}
      <button
        onClick={onToggleManualPay}
        title="ON: every rune-spending play opens the rune picker. OFF: auto-pay silently."
        className={`${onToggleSandbox ? '' : 'ml-auto '}rounded px-2 py-1 text-xs font-semibold ${
          manualPay ? 'bg-amber-500/30 text-amber-100' : 'bg-white/5 text-white/50 hover:bg-white/10'
        }`}
      >
        {manualPay ? '⚙ Rune picker: ON' : '⚙ Auto-pay'}
      </button>
      <span className="rounded bg-indigo-500/20 px-2 py-1 text-xs text-indigo-200">
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
    <div className="mx-auto max-w-5xl space-y-6 py-8 text-center">
      <div>
        <h2 className="text-3xl font-bold tracking-wide">Choose your mulligan</h2>
        <p className="mt-1 text-white/55">
          {pending.name} — set aside up to 2 cards (sent to the bottom, then redraw that many).{' '}
          <span className="text-white/80">{aside.length}/2 marked.</span>
        </p>
      </div>

      <MulliganHand hand={pending.zones.hand} aside={aside} onToggle={toggle} onInspect={(cardId) => setView(getCard(cardId) ?? null)} />

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => onAct({ type: 'MULLIGAN', player: pending.id, toBottom: aside })}
          className="rounded-xl bg-indigo-500 px-8 py-3 text-base font-bold hover:bg-indigo-400"
        >
          {aside.length ? `Mulligan ${aside.length} ▶` : 'Keep hand ▶'}
        </button>
        {onExit && (
          <button onClick={onExit} className="rounded-lg bg-white/5 px-4 py-3 text-sm text-white/50 hover:bg-white/10">
            Exit
          </button>
        )}
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
    onStart(createMatch(ds, { names: ds.map((d, i) => `${d.name}`.slice(0, 16) || `P${i + 1}`), interactiveSetup: true }))
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
        2-4 players on one screen with full rules enforced. Every free-for-all
        (1v1 or 3-4 players) plays to 8 points. Card-specific ability text is resolved manually.
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
