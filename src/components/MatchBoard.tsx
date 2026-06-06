import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getCard } from '../data/cards'
import {
  type MatchState,
  type PlayerId,
  type EngineCard,
  type PlayerState,
  type Action,
  type OverrideOp,
  type OverrideZone,
  type GameEvent,
} from '../engine/types'
import { canPlay, combatMight, matchUsesXp, grantedAbilityFor, canActivateUnit, auraMightFor } from '../engine/engine'
import { parseKeywords, keywordsAt } from '../engine/keywords'
import { RULES } from '../engine/setup'
import MechanicTooltip from './MechanicTooltip'
import CombatBanner, { type BannerData } from './CombatBanner'
import { type Card, type Domain, DOMAIN_META, DOMAINS } from '../types/cards'
import { matGradient, domainGlow, domainAnimClass } from '../lib/theme'
import { audio } from '../lib/audio'
import BoardCard from './BoardCard'
import CardBack from './CardBack'
import CardPreview from './CardPreview'
import CardText, { DomainIcon } from './CardText'
import PlayedCardSpotlight from './PlayedCardSpotlight'
import PlayedCardAnnouncement from './PlayedCardAnnouncement'
import ChainResponsePopup from './ChainResponsePopup'
import OverridePanel from './OverridePanel'
import CardSearchOverlay, { type SearchSource } from './CardSearchOverlay'

/** A context-menu entry (a normal action, a unit-activation, or a gear-attach). */
type MenuItem = { label: string; action?: Action; activateIid?: string; attachGearIid?: string; moveGearIid?: { gearIid: string; fromUnitIid: string; owner: PlayerId }; stepper?: { title: string; make: (n: number) => Action }; openSearch?: { source: SearchSource; owner: PlayerId } }
/** A drill-down category in the right-click menu (collapses the rest when open). */
type MenuGroup = { label: string; items: MenuItem[] }
import FeedbackLayer from './FeedbackLayer'

/** Name of a unit anywhere on the board, by iid (for combat banners). */
function unitName(match: MatchState, iid: string): string {
  for (const bf of match.battlefields)
    for (const u of bf.units) if (u.iid === iid) return getCard(u.cardId)?.name ?? 'a unit'
  for (const p of match.players) for (const u of p.zones.base) if (u.iid === iid) return getCard(u.cardId)?.name ?? 'a unit'
  return 'a unit'
}

// Rift Atlas-style board: opponents at the top (face-down hands), shared
// battlefields in the prominent center, the local player's domain-themed mat at
// the bottom. Supports 2-4 players. Click any card to expand and read it.

export interface MatchBoardProps {
  match: MatchState
  perspective: PlayerId
  canAct: boolean
  onPlay: (c: EngineCard) => void
  /** Move one or more selected units to a battlefield (group standard move). */
  onMove: (iids: string[], bf: number) => void
  onPass: () => void
  onPassPriority?: () => void
  onCounter?: (targetChainId: string) => void
  onEndTurn: () => void
  onConcede?: () => void
  /** Right-click card actions (buff / recycle / trash). */
  onCardAction?: (action: Action) => void
  /** Activate a unit's own printed ability (the page handles its targeting). */
  onActivateUnit?: (iid: string) => void
  /** Attach an unattached Equipment in base to a unit (page opens a unit picker). */
  onAttachGear?: (gearIid: string) => void
  /** Move attached gear from one unit to another (page opens a unit picker). */
  onMoveGear?: (gearIid: string, fromUnitIid: string, owner: PlayerId) => void
  /** Revert the last action (multi-step history lives in the page). */
  onUndo?: () => void
  /** Targeting mode: clicking a legal unit picks it as a spell target. */
  targetingActive?: boolean
  /** The unit iids that are legal targets for the spell being aimed. */
  legalTargets?: string[]
  /** Progress for a multi-target spell ("pick up to N"). */
  targetProgress?: { picked: number; count: number }
  onTarget?: (iid: string) => void
  /** Resolve a multi-target spell with the targets picked so far. */
  onConfirmTargets?: () => void
  onCancelTarget?: () => void
  /** Open the card detail modal for any card on the board. */
  onInspect?: (card: Card) => void
  /** Feedback signals from the latest action (for animations). */
  events?: GameEvent[]
}

/** Per-card flash kind that survives on a card still in play. */
type FlashKind = 'damage' | 'play' | 'buff' | 'stun' | 'move' | 'equip'

interface Fx {
  seq: number
  flashOf: (iid: string) => FlashKind | undefined
  legalSet: Set<string>
  targeting: boolean
}

/** Compute affordance/animation props + a remount-key for one board card. */
function cardFx(fx: Fx, ci: EngineCard, ready = false) {
  const flash = fx.flashOf(ci.iid)
  let glow: 'ready' | 'playable' | 'target' | undefined
  let dim = false
  if (fx.targeting) {
    if (fx.legalSet.has(ci.iid)) glow = 'target'
    else dim = true
  } else if (ready) {
    glow = 'ready'
  }
  return { flash, glow, dim, key: flash ? `${ci.iid}-${fx.seq}` : ci.iid }
}

/** Attached Equipment shown as card slivers peeking from the unit's right edge.
 *  Each peek hover-expands (its own CardPreview, outside the unit's preview so they
 *  don't both fire) and click-inspects. Rendered as a sibling overlay of the unit. */
function GearPeek({ unit, onInspectGear }: { unit: EngineCard; onInspectGear?: (cardId: string) => void }) {
  const attached = unit.attached ?? []
  if (attached.length === 0) return null
  return (
    <span className="pointer-events-none absolute right-0 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-0.5">
      {attached.map((ref, i) => {
        const [gid, giid] = ref.split('|')
        const g = getCard(gid)
        return (
          <CardPreview key={giid || `${gid}-${i}`} cardId={gid} delay={80}>
            <span
              role="button"
              title={g?.name ? `Equipped: ${g.name} — hover to enlarge, click to inspect` : 'Equipped gear'}
              onClick={(e) => { e.stopPropagation(); onInspectGear?.(gid) }}
              className="pointer-events-auto block h-5 w-2.5 overflow-hidden rounded-r border border-l-0 border-amber-300/80 bg-[#1c1c28] shadow-md ring-1 ring-black/50 transition-[width] hover:w-4"
            >
              {g?.imageUrl ? (
                <img src={g.imageUrl} alt={g.name} className="h-full w-[320%] max-w-none object-cover object-left" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[7px]">🔧</span>
              )}
            </span>
          </CardPreview>
        )
      })}
    </span>
  )
}

function playerDomains(p: PlayerState): Domain[] {
  if (!p.legend) return []
  const l = getCard(p.legend.cardId)
  return l && l.type === 'legend' ? l.identity : []
}

// --- Sandbox drag-and-drop -------------------------------------------------
// In Override mode any card can be dragged to any zone/battlefield. These build
// the native HTML5 drag source / drop target props, spread onto card buttons
// and zone containers. The drop dispatches an OVERRIDE 'move'.
type MoveDest = { toZone?: OverrideZone; toBattlefield?: number }
function dragSrc(enabled: boolean, iid: string) {
  if (!enabled) return {}
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/iid', iid)
      e.dataTransfer.effectAllowed = 'move'
    },
  }
}
function dropTgt(enabled: boolean, dest: MoveDest, onMove?: (iid: string, d: MoveDest) => void) {
  if (!enabled || !onMove) return {}
  return {
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const iid = e.dataTransfer.getData('text/iid')
      if (iid) onMove(iid, dest)
    },
  }
}

export default function MatchBoard({
  match,
  perspective,
  canAct,
  onPlay,
  onMove,
  onPass,
  onPassPriority,
  onCounter,
  onEndTurn,
  onConcede,
  onCardAction,
  onActivateUnit,
  onAttachGear,
  onMoveGear,
  onUndo,
  targetingActive,
  legalTargets,
  targetProgress,
  onTarget,
  onConfirmTargets,
  onCancelTarget,
  onInspect,
  events,
}: MatchBoardProps) {
  // Multi-select for group moves.
  const [selectedUnits, setSelectedUnits] = useState<string[]>([])
  const toggleSelected = (iid: string) =>
    setSelectedUnits((s) => (s.includes(iid) ? s.filter((x) => x !== iid) : [...s, iid]))
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; groups?: MenuGroup[]; statuses?: MenuItem[] } | null>(null)
  const [drill, setDrill] = useState<number | null>(null) // open drill-down category
  const [sub, setSub] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null) // hover flyout (Add status effect)
  const [stepper, setStepper] = useState<{ title: string; value: number; make: (n: number) => Action } | null>(null) // inline −/value/+ set
  const [searchOverlay, setSearchOverlay] = useState<{ owner: PlayerId; source: SearchSource } | null>(null) // big search/tutor pop-up
  // Keep the right-click menu + status flyout inside the viewport: after each render
  // measure the panel and, if it overflows the bottom/right edge, shift it back in
  // (effectively opening upward / leftward). Runs pre-paint so there's no flash.
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const clamp = (el: HTMLDivElement | null) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const m = 8
      if (r.bottom > window.innerHeight - m) el.style.top = `${Math.max(m, window.innerHeight - r.height - m)}px`
      if (r.right > window.innerWidth - m) el.style.left = `${Math.max(m, window.innerWidth - r.width - m)}px`
    }
    clamp(menuRef.current)
    clamp(subRef.current)
  }, [menu, drill, sub, stepper])
  const me = match.players[perspective]
  // Only surface the XP meter when some card in the match actually uses XP.
  const usesXp = useMemo(() => matchUsesXp(match), [match])

  // --- combat banners (1.5s overlays for chain links / showdown / react) ---
  const [combatBanner, setCombatBanner] = useState<BannerData | null>(null)
  const prevChainLen = useRef(match.chain.length)
  const prevShowdown = useRef(!!match.showdown)
  useEffect(() => {
    const order = match.players.map((p, i) => `${i + 1}. ${p.name}`).join('   ')
    const len = match.chain.length
    if (len > prevChainLen.current) {
      const top = match.chain[len - 1]
      const who = match.players[top.controller].name
      const cardName = getCard(top.cardId)?.name ?? 'a card'
      const tgt = (top.targets ?? []).map((id) => unitName(match, id)).join(', ')
      const reacting = match.priority != null ? match.players[match.priority].name : null
      setCombatBanner({
        key: match.seq,
        tone: match.priority === perspective ? 'react' : 'chain',
        title: `⛓ ${who} ${top.kind === 'counter' ? 'countered with' : 'played'} ${cardName}${tgt ? ` → ${tgt}` : ''}`,
        lines: [`Turn order: ${order}`, match.priority === perspective ? '⚡ Your window to react' : reacting ? `${reacting} may react` : 'Resolving…'],
      })
    } else if (!prevShowdown.current && match.showdown) {
      const bfName = getCard(match.battlefields[match.showdown.battlefield].cardId)?.name ?? 'a battlefield'
      setCombatBanner({
        key: match.seq,
        tone: 'showdown',
        title: `⚔ Showdown at ${bfName}`,
        lines: [`Turn order: ${order}`, match.showdown.priority === perspective ? '⚡ Your window to react' : `${match.players[match.showdown.priority].name} may react`],
      })
    }
    prevChainLen.current = len
    prevShowdown.current = !!match.showdown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // --- feedback wiring -----------------------------------------------------
  const flashMap = useMemo(() => {
    const m = new Map<string, FlashKind>()
    for (const e of events ?? []) {
      if (
        e.iid &&
        (e.kind === 'damage' || e.kind === 'play' || e.kind === 'buff' || e.kind === 'stun' || e.kind === 'move' || e.kind === 'equip')
      )
        m.set(e.iid, e.kind)
    }
    return m
  }, [events])
  const legalSet = useMemo(() => new Set(legalTargets ?? []), [legalTargets])
  const fx: Fx = {
    seq: match.seq,
    flashOf: (iid) => flashMap.get(iid),
    legalSet,
    targeting: !!targetingActive,
  }

  // Brief board screen-shake on scoring / conquer (no remount of children).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!events?.some((e) => e.kind === 'score' || e.kind === 'conquer')) return
    const el = rootRef.current
    if (!el) return
    el.classList.remove('fx-board-shake')
    void el.offsetWidth // force reflow so the animation replays
    el.classList.add('fx-board-shake')
    const t = setTimeout(() => el.classList.remove('fx-board-shake'), 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // Track the most recently played card for the right-rail spotlight (persists
  // between actions; the chain itself drives the stacked reaction view).
  const [lastPlayed, setLastPlayed] = useState<{ cardId: string; player: PlayerId } | null>(null)
  useEffect(() => {
    const plays = (events ?? []).filter((e) => e.kind === 'play' && e.cardId)
    if (plays.length) {
      const last = plays[plays.length - 1]
      setLastPlayed({ cardId: last.cardId!, player: last.player ?? perspective })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // Premium 80%-screen "card played" announcement for ALL players. Only units,
  // spells & gear (skip rune channels / token spawns). Keyed on seq so it fires
  // once per play; the float is non-blocking and click-dismissable.
  const [announce, setAnnounce] = useState<{ cardId: string; player: PlayerId; seq: number } | null>(null)
  useEffect(() => {
    const plays = (events ?? []).filter(
      (e) => e.kind === 'play' && e.cardId && ['unit', 'spell', 'gear'].includes(getCard(e.cardId)?.type ?? ''),
    )
    if (plays.length) {
      const last = plays[plays.length - 1]
      setAnnounce({ cardId: last.cardId!, player: last.player ?? perspective, seq: match.seq })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // Sound effects for this action's events (deduped per batch).
  useEffect(() => {
    if (!events?.length) return
    const kinds = new Set(events.map((e) => e.kind))
    const playEvt = events.find((e) => e.kind === 'play')
    if (playEvt?.cardId) {
      const c = getCard(playEvt.cardId)
      if (c && c.type === 'spell') audio.play((c.energy ?? 0) >= 5 ? 'spellBig' : 'spell')
      else if (c) audio.play('playCard')
    }
    if (kinds.has('draw')) audio.play('cardFlip')
    if (kinds.has('channel')) audio.play('shuffle', { volume: 0.6 })
    if (kinds.has('move')) audio.play('cardThrow')
    if (kinds.has('damage')) audio.play(Math.random() < 0.5 ? 'sword' : 'punch')
    if (kinds.has('defeat')) audio.play('unitKilled')
    if (kinds.has('counter')) audio.play('spell')
    if (kinds.has('conquer')) audio.play('sword')
    if (kinds.has('score') && !kinds.has('conquer')) audio.play('confirm', { volume: 0.7 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.seq])

  // Battle music + ambience while the board is mounted (gameplay phases). The
  // music bus keeps it low; the per-track volumes are scaled by the settings.
  useEffect(() => {
    audio.init()
    audio.playMusic(Math.random() < 0.5 ? 'battle' : 'battle2', { volume: 0.9 })
    audio.playMusic('ambience', { volume: 0.5 })
    return () => audio.stopMusic()
  }, [])

  const openMenu = (e: React.MouseEvent, ci: EngineCard, zone: 'base' | 'runePool' | 'hand' | 'battlefield' | 'legend' | 'champion') => {
    e.preventDefault()
    if (!onCardAction) return
    const card = getCard(ci.cardId)
    const items: MenuItem[] = []
    if (card?.type === 'unit') {
      items.push({ label: '⊘ Stun', action: { type: 'STUN_UNIT', player: perspective, iid: ci.iid } })
      items.push({ label: '⊗ Banish', action: { type: 'BANISH', player: perspective, iid: ci.iid } })
    }
    if (ci.owner === perspective) {
      // Battlefield-granted activated ability (Gardens of Becoming → gain XP).
      const ga = grantedAbilityFor(match, perspective, ci.iid)
      if (ga) items.push({ label: `⚡ ${ga.label}`, action: { type: 'ACTIVATE_ABILITY', player: perspective, iid: ci.iid } })
      // A unit's OWN printed activated ability (Arena Kingpin, Xerath, …). The
      // page handles its cost + targeting via onActivateUnit.
      const ua = onActivateUnit && canActivateUnit(match, perspective, ci.iid)
      if (ua) items.push({ label: `⚡ ${ua.label}`, activateIid: ci.iid })
      if (card?.type === 'rune' && zone === 'runePool')
        items.push({ label: '♺ Recycle rune', action: { type: 'RECYCLE_RUNE', player: perspective, iid: ci.iid } })
      if (card?.type === 'unit')
        items.push({ label: '✦ Buff +1', action: { type: 'BUFF_UNIT', player: perspective, iid: ci.iid } })
      // Detach each attached gear from a unit.
      if (card?.type === 'unit') {
        for (const ref of ci.attached) {
          const [gid, giid] = ref.split('|')
          items.push({ label: `🔓 Detach ${getCard(gid)?.name ?? 'gear'}`, action: { type: 'DETACH', player: perspective, unitIid: ci.iid, gearIid: giid } })
        }
        // In sandbox, also offer to move each attached gear to another unit.
        if (match.sandbox && onMoveGear) {
          for (const ref of ci.attached) {
            const [gid, giid] = ref.split('|')
            items.push({ label: `↔ Move ${getCard(gid)?.name ?? 'gear'} to a unit`, moveGearIid: { gearIid: giid, fromUnitIid: ci.iid, owner: perspective } })
          }
        }
      }
      // Equip an unattached piece of Equipment sitting on your Base to a unit (its
      // [Equip] activated ability). Only for Equipment (has [Equip] / "attach … to a
      // unit"), not Gold/standalone gear, and only if you have a unit to equip.
      if (
        onAttachGear && zone === 'base' && card?.type === 'gear' && card?.supertype !== 'token' &&
        (parseKeywords(card).equip || /attach (?:this|it) to a unit/i.test(card?.text ?? '')) &&
        [...me.zones.base, ...match.battlefields.flatMap((b) => b.units)].some((u) => u.owner === perspective && getCard(u.cardId)?.type === 'unit')
      ) {
        items.push({ label: '🔗 Equip to a unit', attachGearIid: ci.iid })
      }
      // Gold gear token: cash in for 1 Power of any domain (kills the token).
      if (card?.supertype === 'token' && card?.type === 'gear') {
        for (const d of DOMAINS)
          items.push({ label: `🪙→ ${DOMAIN_META[d].label} Power`, action: { type: 'USE_GOLD', player: perspective, iid: ci.iid, domain: d } })
      }
      // Reveal your own facedown unit at a battlefield.
      if (zone === 'battlefield' && ci.facedown)
        items.push({ label: '👁 Reveal', action: { type: 'REVEAL', player: perspective, iid: ci.iid } })
      // Hide a [Hidden] card from your HAND facedown at a battlefield you control
      // (empty slot), paying 1 Wild Power (recycle a ready rune). One entry per legal
      // battlefield so you can choose where to hide it when you control more than one.
      if (zone === 'hand' && card && parseKeywords(card).hidden) {
        const rune = me.zones.runePool.find((r) => !r.exhausted)
        const legalBfs = match.battlefields.map((b, i) => ({ b, i })).filter((x) => x.b.controller === perspective && !x.b.facedown)
        if (rune && legalBfs.length === 1)
          items.push({ label: '🙈 Hide (facedown)', action: { type: 'HIDE', player: perspective, iid: ci.iid, toBattlefield: legalBfs[0].i, runeIid: rune.iid } })
        else if (rune)
          for (const x of legalBfs)
            items.push({ label: `🙈 Hide at ${getCard(x.b.cardId)?.name ?? `Battlefield ${x.i + 1}`}`, action: { type: 'HIDE', player: perspective, iid: ci.iid, toBattlefield: x.i, runeIid: rune.iid } })
      }
      items.push({ label: '🗑 Trash', action: { type: 'TRASH_CARD', player: perspective, iid: ci.iid } })
    }
    // Manual overrides (shared sandbox): full god-mode ops on ANY card for EITHER
    // player, organized into drill-down categories so the menu stays uncluttered.
    const groups: MenuGroup[] = []
    // Statuses live in a single hover flyout ("Add status effect") rather than two
    // click-drill categories — toggles show their live on/off state.
    const statuses: MenuItem[] = []
    if (match.sandbox) {
      const owner = ci.owner
      const ov = (op: OverrideOp, extra: Record<string, unknown> = {}): Action =>
        ({ type: 'OVERRIDE', player: owner, op, iid: ci.iid, ...extra }) as Action
      const mv = (toZone: OverrideZone | undefined, toBattlefield: number | undefined, bottom?: boolean): Action =>
        ({ type: 'OVERRIDE', player: owner, op: 'move', iid: ci.iid, toZone, toBattlefield, bottom }) as Action
      const cc = ci as { stunned?: boolean; grantGanking?: boolean; temporary?: boolean; deathShield?: boolean; banishShield?: boolean; token?: boolean; grantAssault?: number; buffs?: number }
      const mark = (on?: boolean) => (on ? '✓ ' : '○ ')
      if (card?.type === 'unit') {
        statuses.push(
          { label: `${mark(cc.stunned)}Stunned`, action: ov(cc.stunned ? 'unstun' : 'stun') },
          { label: `${mark(ci.exhausted)}Exhausted`, action: ov(ci.exhausted ? 'ready' : 'exhaust') },
          { label: `${mark(ci.facedown)}Facedown`, action: ov('grant', { flag: 'facedown' }) },
          { label: `${mark(cc.grantGanking)}[Ganking]`, action: ov('grant', { flag: 'ganking' }) },
          { label: `${mark(cc.temporary)}[Temporary]`, action: ov('grant', { flag: 'temporary' }) },
          { label: `${mark(cc.deathShield)}Death shield`, action: ov('grant', { flag: 'deathShield' }) },
          { label: `${mark(cc.banishShield)}Banish shield`, action: ov('grant', { flag: 'banishShield' }) },
          { label: `${mark(cc.token)}Token`, action: ov('grant', { flag: 'token' }) },
          { label: `[Assault] ${cc.grantAssault ?? 0}　+1`, action: ov('grant', { flag: 'assault', amount: 1 }) },
          { label: `[Assault] ${cc.grantAssault ?? 0}　−1`, action: ov('grant', { flag: 'assault', amount: -1 }) },
          { label: `Buff ${cc.buffs ?? 0}　+1`, action: ov('buff') },
          { label: `Buff ${cc.buffs ?? 0}　−1`, action: ov('unbuff') },
          { label: 'Clear summoning sickness', action: ov('grant', { flag: 'sickness' }) },
          { label: "Clear can't-move", action: ov('grant', { flag: 'cantmove' }) },
          { label: '⚡ Re-fire enter triggers', action: ov('triggerEnterPlay') },
          { label: '◍ Cycle marker', action: ov('marker') },
          { label: '○ Clear marker', action: ov('marker', { value: -1 }) },
        )
        if (zone === 'battlefield') statuses.push({ label: '↩ Recall to base (exhaust)', action: ov('toBase') })
        groups.push({ label: 'Might & damage', items: [
          { label: 'Might +1', action: ov('mightUp') },
          { label: 'Might +5', action: ov('mightUp', { amount: 5 }) },
          { label: 'Might −1', action: ov('mightDown') },
          { label: 'Damage +1', action: ov('damage', { amount: 1 }) },
          { label: 'Damage −1', action: ov('damage', { amount: -1 }) },
          { label: 'Set damage 0', action: ov('setDamage', { value: 0 }) },
          { label: 'Set damage 2', action: ov('setDamage', { value: 2 }) },
          { label: 'Set damage 4', action: ov('setDamage', { value: 4 }) },
          { label: 'Set damage 6', action: ov('setDamage', { value: 6 }) },
          { label: 'Buff (net)… ⇄', stepper: { title: 'Net buff counters', make: (n: number) => (n >= 0 ? ov('buff', { amount: n }) : ov('unbuff', { amount: -n })) } },
          { label: 'Might (net, this turn)… ⇄', stepper: { title: 'Net temp Might (this turn)', make: (n: number) => (n >= 0 ? ov('mightUp', { amount: n }) : ov('mightDown', { amount: -n })) } },
          { label: 'Set temp Might (exact)… ⇄', stepper: { title: 'Set temp Might to (this turn)', make: (n: number) => ov('setTempMight', { value: n }) } },
          { label: 'Damage (net)… ⇄', stepper: { title: 'Net damage', make: (n: number) => ov('damage', { amount: n }) } },
        ] })
        // Manually set who controls the battlefield this unit stands on.
        if (zone === 'battlefield') {
          const bfi = match.battlefields.findIndex((b) => b.units.some((x) => x.iid === ci.iid))
          if (bfi >= 0)
            groups.push({ label: 'Control battlefield', items: [
              ...match.players.map((pl, i) => ({ label: `→ ${i === perspective ? 'You' : pl.name.replace(/\s*\([^)]*\)\s*$/, '')}`, action: ({ type: 'OVERRIDE', player: owner, op: 'setController', toBattlefield: bfi, value: i }) as Action })),
              { label: 'Uncontrolled', action: ({ type: 'OVERRIDE', player: owner, op: 'setController', toBattlefield: bfi, value: -1 }) as Action },
            ] })
        }
      } else if (card?.type === 'rune') {
        statuses.push(
          { label: `${mark(ci.exhausted)}Exhausted`, action: ov(ci.exhausted ? 'ready' : 'exhaust') },
          { label: '◍ Cycle marker', action: ov('marker') },
          { label: '○ Clear marker', action: ov('marker', { value: -1 }) },
        )
      }
      // Sandbox equip / detach / move-equipment entries for cards owned by the
      // OTHER player (the owner's own cards already show these via the owner block
      // above; we only add here when this card belongs to the opponent).
      if (card?.type === 'unit' && ci.owner !== perspective) {
        // Detach each attached gear (sandbox: use ci.owner as the action player).
        for (const ref of ci.attached) {
          const [gid, giid] = ref.split('|')
          items.push({ label: `🔓 Detach ${getCard(gid)?.name ?? 'gear'}`, action: { type: 'DETACH', player: ci.owner, unitIid: ci.iid, gearIid: giid } })
        }
        // Move each attached gear to another unit.
        if (onMoveGear) {
          for (const ref of ci.attached) {
            const [gid, giid] = ref.split('|')
            items.push({ label: `↔ Move ${getCard(gid)?.name ?? 'gear'} to a unit`, moveGearIid: { gearIid: giid, fromUnitIid: ci.iid, owner: ci.owner } })
          }
        }
      }
      // Sandbox "Equip to a unit" for opponent's unattached Equipment in base.
      if (
        onAttachGear && zone === 'base' && card?.type === 'gear' && card?.supertype !== 'token' &&
        ci.owner !== perspective &&
        (parseKeywords(card).equip || /attach (?:this|it) to a unit/i.test(card?.text ?? '')) &&
        [...match.players[ci.owner].zones.base, ...match.battlefields.flatMap((b) => b.units)].some((u) => u.owner === ci.owner && getCard(u.cardId)?.type === 'unit')
      ) {
        items.push({ label: '🔗 Equip to a unit', attachGearIid: ci.iid })
      }
      // Reveal/remove a battlefield's face-down [Hidden] card (sandbox tools beyond
      // the normal "Reveal = play for 0").
      if (ci.facedown && zone === 'battlefield') {
        groups.push({ label: 'Hidden card', items: [
          { label: '👁 Reveal to hand', action: ov('revealFacedown') },
          { label: '🗑 Remove (trash)', action: ov('removeFacedown') },
          { label: '⊗ Remove (banish)', action: ov('removeFacedown', { flag: 'banish' }) },
        ] })
      }
      const moveItems: MenuItem[] = []
      if (zone !== 'hand') moveItems.push({ label: 'Hand', action: mv('hand', undefined) })
      if (zone !== 'base') moveItems.push({ label: 'Base', action: mv('base', undefined) })
      for (let i = 0; i < match.battlefields.length; i++)
        if (!(zone === 'battlefield' && match.battlefields[i].units.some((u) => u.iid === ci.iid)))
          moveItems.push({ label: `Battlefield ${i + 1}`, action: mv(undefined, i) })
      moveItems.push({ label: 'Deck (top)', action: mv('mainDeck', undefined) })
      moveItems.push({ label: 'Deck (bottom)', action: mv('mainDeck', undefined, true) })
      moveItems.push({ label: 'Deck (X from top)… ⇄', stepper: { title: 'Insert X cards from the top of the deck', make: (n: number) => ({ type: 'OVERRIDE', player: owner, op: 'move', iid: ci.iid, toZone: 'mainDeck', value: Math.max(0, n) }) as Action } })
      if (card?.type === 'rune') moveItems.push({ label: 'Rune deck (top)', action: mv('runeDeck', undefined) })
      moveItems.push({ label: 'Trash', action: mv('trash', undefined) })
      moveItems.push({ label: 'Banished', action: mv('banished', undefined) })
      if (zone !== 'legend') moveItems.push({ label: 'Legend zone', action: mv('legend', undefined) })
      if (zone !== 'champion') moveItems.push({ label: 'Champion zone', action: mv('champion', undefined) })
      groups.push({ label: 'Move to…', items: moveItems })
      groups.push({ label: 'Remove', items: [
        { label: 'Kill', action: ov('kill') },
        { label: 'Sacrifice (ignore shields)', action: ov('sacrifice') },
        { label: 'Banish', action: ov('banish') },
        { label: 'Trash', action: ov('trash') },
      ] })
      groups.push({ label: 'Owner', items: [
        { label: 'Draw 1', action: { type: 'OVERRIDE', player: owner, op: 'draw' } },
        { label: 'Channel 1', action: { type: 'OVERRIDE', player: owner, op: 'channel' } },
        { label: 'Ready all units', action: { type: 'OVERRIDE', player: owner, op: 'readyAll' } },
      ] })
    }
    if (items.length || groups.length || statuses.length) {
      setDrill(null)
      setSub(null)
      setStepper(null)
      setMenu({ x: e.clientX, y: e.clientY, items, groups: groups.length ? groups : undefined, statuses: statuses.length ? statuses : undefined })
    }
  }

  /** Right-click a ZONE (not a card) — quick sandbox actions for that pile.
   *  Native menu is already suppressed at the board root; this adds function. */
  const openZoneMenu = (e: React.MouseEvent, kind: 'deck' | 'runeDeck' | 'base' | 'hand' | 'battlefield' | 'trash', owner: PlayerId) => {
    e.preventDefault()
    e.stopPropagation()
    if (!onCardAction || !match.sandbox) return
    const O = (op: OverrideOp, extra: Record<string, unknown> = {}): Action => ({ type: 'OVERRIDE', player: owner, op, ...extra }) as Action
    const items: MenuItem[] = []
    if (kind === 'deck') {
      items.push({ label: '🔎 Search deck…', openSearch: { source: 'mainDeck', owner } })
      items.push({ label: '🗂 Manage top cards', openSearch: { source: 'manageTop', owner } })
      items.push({ label: '🛠 Draw 1', action: O('draw') })
      items.push({ label: '🛠 Draw 3', action: O('draw', { amount: 3 }) })
      items.push({ label: '🛠 Mill 1', action: O('mill', { amount: 1 }) })
      items.push({ label: '🛠 Shuffle deck', action: O('shuffle') })
    } else if (kind === 'runeDeck') {
      items.push({ label: '🔎 Search rune deck…', openSearch: { source: 'runeDeck', owner } })
      items.push({ label: '🛠 Channel 1', action: O('channel') })
      items.push({ label: '🛠 Channel 3', action: O('channel', { amount: 3 }) })
      items.push({ label: '🛠 Channel 1 (exhausted)', action: O('channelExhausted') })
    } else if (kind === 'trash') {
      items.push({ label: '🔎 Search trash…', openSearch: { source: 'trash', owner } })
    } else if (kind === 'hand') {
      items.push({ label: '🛠 Draw 1', action: O('draw') })
      items.push({ label: '🛠 Draw 3', action: O('draw', { amount: 3 }) })
    } else {
      // base / battlefield
      items.push({ label: '🛠 Ready all units', action: O('readyAll') })
    }
    setDrill(null)
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // Right-click a battlefield's art. When its identity was replaced by a token
  // (Brush / Baron Pit), offer to revert it to the original. Sandbox-gated, like
  // the other zone right-clicks (it's a referee action — the token swap is
  // otherwise one-way).
  const openBfMenu = (e: React.MouseEvent, bfIndex: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (!onCardAction || !match.sandbox) return
    const bf = match.battlefields[bfIndex]
    if (!bf?.originalCardId) return // nothing to revert — suppress the menu
    const origName = getCard(bf.originalCardId)?.name ?? 'original battlefield'
    const items: MenuItem[] = [
      {
        label: `↩ Revert to ${origName}`,
        action: { type: 'OVERRIDE', player: perspective, op: 'revertBf', toBattlefield: bfIndex } as Action,
      },
    ]
    setDrill(null)
    setSub(null)
    setStepper(null)
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // Manual keyboard shortcuts (sandbox): track held letter keys, then route a
  // modified click on any card (data-iid) to a manual op in the capture phase
  // so the card's own onClick (inspect/play/target) is bypassed.
  //   Z+click = toggle facedown (hide) · C+click = cycle marker ·
  //   Ctrl+C+click = clear marker · Shift+click = recycle a rune.
  const heldKeys = useRef<Set<string>>(new Set())
  useEffect(() => {
    const down = (e: KeyboardEvent) => { const k = e.key.toLowerCase(); if (k === 'z' || k === 'c') heldKeys.current.add(k) }
    const up = (e: KeyboardEvent) => heldKeys.current.delete(e.key.toLowerCase())
    const clear = () => heldKeys.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear) }
  }, [])
  const findInstance = (iid: string): EngineCard | undefined => {
    for (const pl of match.players) {
      if (pl.legend?.iid === iid) return pl.legend
      if (pl.champion?.iid === iid) return pl.champion
      for (const z of Object.keys(pl.zones) as (keyof typeof pl.zones)[])
        for (const c of pl.zones[z]) if (c.iid === iid) return c
    }
    for (const bf of match.battlefields) for (const u of bf.units) if (u.iid === iid) return u
    return undefined
  }
  const onManualClickCapture = (e: React.MouseEvent) => {
    if (!match.sandbox || !onCardAction) return
    const z = heldKeys.current.has('z')
    const c = heldKeys.current.has('c')
    if (!z && !c && !e.shiftKey) return
    const el = (e.target as HTMLElement | null)?.closest('[data-iid]') as HTMLElement | null
    if (!el) return
    const iid = el.getAttribute('data-iid')
    if (!iid) return
    const inst = findInstance(iid)
    if (!inst) return
    const owner = inst.owner
    let act: Action | null = null
    if (z) act = { type: 'OVERRIDE', player: owner, op: 'grant', iid, flag: 'facedown' } as Action
    else if (c) act = { type: 'OVERRIDE', player: owner, op: 'marker', iid, ...(e.ctrlKey ? { value: -1 } : {}) } as Action
    else if (e.shiftKey && getCard(inst.cardId)?.type === 'rune') act = { type: 'RECYCLE_RUNE', player: owner, iid } as Action
    if (!act) return // no manual action for this gesture — let the normal click proceed
    e.preventDefault()
    e.stopPropagation()
    onCardAction(act)
  }

  // Opponents in seating order, starting just after the local player.
  const opponents: PlayerState[] = []
  for (let i = 1; i < match.players.length; i++)
    opponents.push(match.players[(perspective + i) % match.players.length])

  const chainOpen = match.chain.length > 0
  const myChainPriority = canAct && chainOpen && match.priority === perspective
  const myActionTurn =
    canAct && !chainOpen && match.phase === 'action' && match.activePlayer === perspective
  const myShowdown =
    canAct && match.phase === 'showdown' && match.showdown?.priority === perspective

  // Do I currently hold a priority window with at least one playable response?
  const canRespondNow = myChainPriority || myShowdown
  const hasPlayableResponse =
    canRespondNow && me.zones.hand.some((c) => canPlay(match, perspective, c.iid).valid)

  // The top-of-chain card to surface in the 80%-screen react popup (chain
  // reactions only — showdowns without a chain are skipped).
  const respondChainTop =
    myChainPriority && match.chain.length > 0 ? match.chain[match.chain.length - 1] : null

  // End-turn guard: still have a playable card or a unit that can move?
  const championPlayable = !!me.champion && canPlay(match, perspective, me.champion.iid).valid
  const hasUnplayedOptions =
    myActionTurn &&
    (championPlayable ||
      me.zones.hand.some((c) => canPlay(match, perspective, c.iid).valid) ||
      me.zones.base.some((u) => getCard(u.cardId)?.type === 'unit' && !u.exhausted))

  const passResponse = () => {
    if (myChainPriority) onPassPriority?.()
    else if (myShowdown) onPass()
  }

  const inspect = (ci: EngineCard) => {
    // In targeting mode, clicking a LEGAL unit selects it as the spell target;
    // clicking anything else is a no-op (validity gating).
    if (targetingActive && onTarget) {
      if (fx.legalSet.has(ci.iid)) onTarget(ci.iid)
      return
    }
    const c = getCard(ci.cardId)
    if (c && onInspect) onInspect(c)
  }
  const move = (bf: number) => {
    if (selectedUnits.length) {
      onMove(selectedUnits, bf)
      setSelectedUnits([])
    }
  }

  // Sandbox drag-and-drop: dispatch an OVERRIDE 'move' to relocate a card.
  const onMoveOverride =
    onCardAction && match.sandbox
      ? (iid: string, dest: MoveDest) =>
          onCardAction({ type: 'OVERRIDE', player: perspective, op: 'move', iid, ...dest })
      : undefined

  // --- turn / priority banner ---------------------------------------------
  const priorityName = match.priority != null ? match.players[match.priority].name : '…'
  const showdownName = match.showdown ? match.players[match.showdown.priority].name : '…'
  const activeName = match.players[match.activePlayer].name
  const banner: { text: string; cls: string; pulse?: boolean } | null = targetingActive
    ? null
    : myChainPriority
      ? { text: '⛓ Your priority — respond, Counter, or Pass', cls: 'border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-100', pulse: true }
      : chainOpen
        ? { text: `⛓ Chain open — waiting for ${priorityName}`, cls: 'border-fuchsia-400/25 bg-fuchsia-500/5 text-fuchsia-200/70' }
        : myShowdown
          ? { text: '⚔ Showdown — respond or Pass', cls: 'border-amber-400/50 bg-amber-500/15 text-amber-100', pulse: true }
          : match.phase === 'showdown'
            ? { text: `⚔ Showdown — waiting for ${showdownName}`, cls: 'border-amber-400/25 bg-amber-500/5 text-amber-200/70' }
            : myActionTurn
              ? { text: '✦ Your turn — play cards and move units', cls: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-100' }
              : { text: `${activeName}'s turn`, cls: 'border-white/15 bg-white/5 text-white/60' }

  return (
    <div className="flex flex-col gap-3 xl:flex-row xl:items-start" onContextMenu={(e) => e.preventDefault()} onClickCapture={onManualClickCapture}>
    {/* FAR-LEFT — manual override panel (sandbox only) */}
    {match.sandbox && onCardAction && <OverridePanel match={match} perspective={perspective} onAct={onCardAction} />}
    {/* CENTER — the board */}
    <div ref={rootRef} className={`min-w-0 flex-1 space-y-3 ${targetingActive ? 'rounded-xl ring-2 ring-rose-400/40' : ''}`}>
      {/* Opponents */}
      <div className={opponents.length > 1 ? 'grid gap-2 sm:grid-cols-2' : ''}>
        {opponents.map((opp) => (
          <OpponentMat key={opp.id} opp={opp} target={match.pointsToWin} active={match.activePlayer === opp.id} onInspect={inspect} onInspectCard={onInspect} fx={fx} usesXp={usesXp} />
        ))}
      </div>

      {/* Shared, contested battlefields — rendered ABOVE the mat. They belong to
          no single player, so they live outside any per-player Battlefield Zone. */}
      <div className="rounded-xl border border-amber-600/25 bg-[#0c1322]/70 p-2">
        <div className="pm-zone-label mb-1.5">Battlefields — shared & contested</div>
        <BattlefieldZone
          match={match}
          perspective={perspective}
          fx={fx}
          selectedUnits={selectedUnits}
          myActionTurn={myActionTurn}
          onMoveTo={move}
          inspect={inspect}
          openMenu={openMenu}
          onInspect={onInspect}
          targetingActive={targetingActive}
          onMoveOverride={onMoveOverride}
          onBfContext={onCardAction && match.sandbox ? openBfMenu : undefined}
        />
      </div>


      {/* Showdown — combat preview */}
      {match.phase === 'showdown' && match.showdown && (() => {
        const sd = match.showdown
        const bf = match.battlefields[sd.battlefield]
        const moverOwner = bf.units.find((u) => u.iid === sd.movedUnit)?.owner ?? match.activePlayer
        const attackers = bf.units.filter((u) => u.owner === moverOwner)
        const defenders = bf.units.filter((u) => u.owner !== moverOwner)
        const atk = attackers.reduce((a, u) => a + combatMight(u, 'attacker'), 0)
        const dfd = defenders.reduce((a, u) => a + combatMight(u, 'defender'), 0)
        const outcome =
          atk > dfd
            ? `${match.players[moverOwner].name} would conquer`
            : dfd > atk
              ? 'defenders would hold'
              : 'both sides would trade'
        // Who's taking part vs. who could still be invited (3-4 player tables).
        const involved = new Set<PlayerId>([...bf.units.map((u) => u.owner), ...(sd.helpers ?? [])])
        const invitable = match.players.filter((p) => !p.out && !involved.has(p.id))
        const inviteToMe = sd.invite?.to === perspective ? sd.invite : undefined
        const iAmCombatant = bf.units.some((u) => u.owner === perspective) || (sd.helpers ?? []).includes(perspective)
        return (
          <div className="rounded-xl border border-amber-400/50 bg-amber-500/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-amber-200">
                ⚔ Showdown at {getCard(bf.cardId)?.name ?? 'battlefield'}
              </span>
              {inviteToMe ? (
                <span className="flex items-center gap-2 text-sm text-amber-100">
                  {match.players[inviteToMe.from].name} invites you to help
                  <button
                    onClick={() => onCardAction?.({ type: 'INVITE_RESPOND', player: perspective, accept: true })}
                    className="rounded bg-emerald-500/30 px-2.5 py-1 font-semibold text-emerald-100 hover:bg-emerald-500/50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => onCardAction?.({ type: 'INVITE_RESPOND', player: perspective, accept: false })}
                    className="rounded bg-rose-500/30 px-2.5 py-1 font-semibold text-rose-100 hover:bg-rose-500/50"
                  >
                    Decline
                  </button>
                </span>
              ) : myShowdown && !sd.invite ? (
                <button
                  onClick={onPass}
                  className="rounded bg-amber-500/30 px-3 py-1 text-sm font-semibold text-amber-100 hover:bg-amber-500/50"
                >
                  Pass (Space)
                </button>
              ) : null}
            </div>
            {/* Invite another player to help (attacker or a defender may invite). */}
            {myShowdown && !sd.invite && iAmCombatant && invitable.length > 0 && onCardAction && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-100/80">
                <span>Invite to help:</span>
                {invitable.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onCardAction({ type: 'INVITE', player: perspective, invitee: p.id })}
                    className="rounded border border-amber-400/40 px-2 py-0.5 font-semibold text-amber-100 hover:bg-amber-500/20"
                  >
                    + {p.name}
                  </button>
                ))}
              </div>
            )}
            {sd.invite && sd.invite.from === perspective && (
              <p className="mt-2 text-xs text-amber-100/70">
                Waiting for {match.players[sd.invite.to].name} to respond to your invitation…
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-rose-500/15 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <b className="text-rose-100">{match.players[moverOwner].name}</b>
                  <span className="font-mono text-rose-200">⚔ {atk}</span>
                </div>
                <CombatList units={attackers} role="attacker" />
              </div>
              <div className="rounded-lg bg-sky-500/15 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <b className="text-sky-100">Defenders{defenders.length === 1 ? ' (alone)' : ''}</b>
                  <span className="font-mono text-sky-200">⚔ {dfd}</span>
                </div>
                <CombatList units={defenders} role="defender" />
              </div>
            </div>
            <p className="mt-1 text-center text-[11px] text-white/55">
              {outcome} ·{' '}
              {myShowdown ? 'your priority' : `waiting for ${match.players[sd.priority].name}`}
            </p>
          </div>
        )
      })()}

      {/* Local player mat (playmat grid — battlefields live above, not on it) */}
      <PlayerMat
        me={me}
        target={match.pointsToWin}
        turn={match.turn}
        myActionTurn={myActionTurn}
        canRespond={myChainPriority}
        selectedUnits={selectedUnits}
        onToggleUnit={toggleSelected}
        onInspect={inspect}
        onInspectCard={onInspect}
        onPlay={onPlay}
        onEndTurn={onEndTurn}
        endTurnNeedsConfirm={hasUnplayedOptions}
        onConcede={onConcede}
        onContext={onCardAction ? openMenu : undefined}
        onZoneContext={onCardAction && match.sandbox ? (e, kind) => openZoneMenu(e, kind, perspective) : undefined}
        onOpenSearch={onCardAction && match.sandbox ? (source) => setSearchOverlay({ owner: perspective, source }) : undefined}
        onRevealTop={onCardAction ? () => onCardAction({ type: 'REVEAL_TOP', player: perspective }) : undefined}
        canPlayIid={(iid) => canPlay(match, perspective, iid)}
        fx={fx}
        usesXp={usesXp}
        sandbox={!!match.sandbox}
        onMoveOverride={onMoveOverride}
        activateLegendLabel={me.legend ? grantedAbilityFor(match, perspective, me.legend.iid)?.label : undefined}
        onActivateLegend={
          onCardAction && me.legend && grantedAbilityFor(match, perspective, me.legend.iid)
            ? () => onCardAction({ type: 'ACTIVATE_ABILITY', player: perspective, iid: me.legend!.iid })
            : undefined
        }
        legendOwnLabel={onActivateUnit && me.legend ? canActivateUnit(match, perspective, me.legend.iid)?.label : undefined}
        onActivateLegendOwn={
          onActivateUnit && me.legend && canActivateUnit(match, perspective, me.legend.iid)
            ? () => onActivateUnit(me.legend!.iid)
            : undefined
        }
      />

      {/* Right-click context menu — categorized drill-down (click a category to
          expand just its items; ‹ Back returns; click anywhere else closes). */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setMenu(null); setDrill(null); setSub(null); setStepper(null) }} onContextMenu={(e) => { e.preventDefault(); setMenu(null); setDrill(null); setSub(null); setStepper(null) }} />
          <div
            ref={menuRef}
            className="fixed z-50 max-h-[80vh] min-w-44 overflow-y-auto rounded-lg border border-white/15 bg-[#1a1a26] text-sm shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {(() => {
              const closeAll = () => { setMenu(null); setDrill(null); setSub(null); setStepper(null) }
              const run = (it: MenuItem) => {
                // A stepper item opens the inline −/value/+ panel instead of dispatching.
                if (it.stepper) { setSub(null); setStepper({ title: it.stepper.title, value: 0, make: it.stepper.make }); return }
                // A search item opens the big card-search overlay.
                if (it.openSearch) { setSearchOverlay(it.openSearch); closeAll(); return }
                if (it.activateIid) onActivateUnit?.(it.activateIid)
                else if (it.attachGearIid) onAttachGear?.(it.attachGearIid)
                else if (it.moveGearIid) onMoveGear?.(it.moveGearIid.gearIid, it.moveGearIid.fromUnitIid, it.moveGearIid.owner)
                else if (it.action) onCardAction?.(it.action)
                closeAll()
              }
              const Item = (it: MenuItem) => (
                <button key={it.label} onClick={() => run(it)} onMouseEnter={() => setSub(null)} className="block w-full px-3 py-1.5 text-left hover:bg-white/10">
                  {it.label}
                </button>
              )
              // Inline stepper view: −/value/+ then Confirm dispatches one net OVERRIDE.
              if (stepper) {
                return (
                  <div className="min-w-[11rem]">
                    <button onClick={() => setStepper(null)} className="block w-full border-b border-white/10 px-3 py-1.5 text-left text-white/50 hover:bg-white/10">‹ Back</button>
                    <div className="px-3 py-2">
                      <div className="mb-2 text-center text-[11px] text-white/60">{stepper.title}</div>
                      <div className="flex items-center justify-center gap-3">
                        <button onClick={() => setStepper({ ...stepper, value: stepper.value - 1 })} className="h-7 w-7 rounded bg-white/10 text-base font-bold hover:bg-white/20">−</button>
                        <span className="w-10 text-center text-lg font-bold tabular-nums">{stepper.value > 0 ? `+${stepper.value}` : stepper.value}</span>
                        <button onClick={() => setStepper({ ...stepper, value: stepper.value + 1 })} className="h-7 w-7 rounded bg-white/10 text-base font-bold hover:bg-white/20">+</button>
                      </div>
                      <button onClick={() => { onCardAction?.(stepper.make(stepper.value)); closeAll() }} className="mt-2 block w-full rounded bg-emerald-500/30 px-3 py-1.5 text-center font-semibold hover:bg-emerald-500/50">Confirm</button>
                    </div>
                  </div>
                )
              }
              if (drill != null && menu.groups?.[drill]) {
                const g = menu.groups[drill]
                return (
                  <>
                    <button onClick={() => setDrill(null)} onMouseEnter={() => setSub(null)} className="block w-full border-b border-white/10 px-3 py-1.5 text-left text-white/50 hover:bg-white/10">‹ Back</button>
                    {g.items.map(Item)}
                  </>
                )
              }
              return (
                <>
                  {menu.items.map(Item)}
                  {/* Hover flyout entry: opens the status list to the right (Add status effect). */}
                  {menu.statuses && (
                    <button
                      onMouseEnter={(ev) => {
                        const r = ev.currentTarget.getBoundingClientRect()
                        const w = 184
                        const x = r.right + w > window.innerWidth ? r.left - w + 2 : r.right - 2
                        setSub({ x, y: r.top, items: menu.statuses! })
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-semibold text-emerald-200 hover:bg-emerald-500/20"
                    >
                      <span>✨ Add status effect</span>
                      <span className="text-white/40">▸</span>
                    </button>
                  )}
                  {menu.groups?.map((g, gi) => (
                    <button
                      key={g.label}
                      onClick={() => setDrill(gi)}
                      onMouseEnter={() => setSub(null)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-semibold text-fuchsia-200 hover:bg-fuchsia-500/20"
                    >
                      <span>{g.label}</span>
                      <span className="text-white/40">▸</span>
                    </button>
                  ))}
                </>
              )
            })()}
          </div>
          {/* Status-effect flyout — a second panel to the right of the entry. */}
          {sub && (
            <div
              ref={subRef}
              className="fixed z-[51] max-h-[80vh] min-w-44 overflow-y-auto rounded-lg border border-emerald-400/30 bg-[#13161b] text-sm shadow-xl"
              style={{ left: sub.x, top: sub.y }}
              onMouseLeave={() => setSub(null)}
            >
              {sub.items.map((it) => (
                <button
                  key={it.label}
                  onClick={() => { if (it.action) onCardAction?.(it.action); setMenu(null); setDrill(null); setSub(null) }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-emerald-500/15"
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Big search / tutor pop-up (sandbox) — trash / rune deck / main deck. */}
      {searchOverlay && onCardAction && (
        <CardSearchOverlay
          match={match}
          owner={searchOverlay.owner}
          source={searchOverlay.source}
          onAct={onCardAction}
          onClose={() => setSearchOverlay(null)}
        />
      )}

      {/* Floating feedback toasts */}
      <FeedbackLayer events={events} seq={match.seq} players={match.players} />

      {/* Transient combat banner (chain link / showdown / react window) */}
      <CombatBanner data={combatBanner} />

      {/* Premium 80%-screen announcements (both non-blocking floats). */}
      <PlayedCardAnnouncement
        seq={announce?.seq ?? -1}
        cardId={announce?.cardId ?? null}
        playerName={announce ? (match.players[announce.player]?.name ?? '') : ''}
      />
      <ChainResponsePopup
        chainItemId={respondChainTop?.id ?? null}
        cardId={respondChainTop?.cardId ?? null}
        playerName={respondChainTop ? (match.players[respondChainTop.controller]?.name ?? '') : ''}
      />
    </div>

    {/* RIGHT RAIL — last-played spotlight (top) · log (bottom). The middle Action
        panel lands here in Stage 2. On < xl this stacks below the board. */}
    <aside className="space-y-3 xl:w-[340px] xl:shrink-0">
      {onUndo && (
        <button
          onClick={onUndo}
          title="Revert the last action (multi-step)"
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-white/70 hover:bg-white/10"
        >
          ↶ Undo
        </button>
      )}
      <PlayedCardSpotlight match={match} perspective={perspective} lastPlayed={lastPlayed} />

      {/* MIDDLE — Action: turn/priority + Pass, targeting, chain Pass/Counter */}
      {banner && (
        <div
          className={`flex items-center justify-between gap-2 rounded-xl border p-2.5 text-sm font-semibold ${banner.cls} ${
            banner.pulse ? 'fx-ready' : ''
          }`}
        >
          <span>{banner.text}</span>
          {canRespondNow && (
            <button
              onClick={passResponse}
              className="shrink-0 rounded bg-white/15 px-3 py-1 text-xs font-semibold hover:bg-white/25"
            >
              {hasPlayableResponse ? 'Pass (Space)' : 'No response — Pass (Space)'}
            </button>
          )}
        </div>
      )}

      {targetingActive && (
        <div className="rounded-xl border border-rose-400/50 bg-rose-500/10 p-3">
          <span className="text-sm font-semibold text-rose-200">
            🎯 {targetProgress ? `Pick up to ${targetProgress.count} targets (${targetProgress.picked} chosen)` : 'Choose a target unit'}
            {fx.legalSet.size ? ` · ${fx.legalSet.size} legal` : ''}…
          </span>
          <div className="mt-2 flex gap-2">
            {targetProgress && targetProgress.picked > 0 && onConfirmTargets && (
              <button
                onClick={onConfirmTargets}
                className="rounded bg-emerald-500/30 px-3 py-1 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/50"
              >
                Done ({targetProgress.picked})
              </button>
            )}
            <button onClick={onCancelTarget} className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20">
              Cancel (Esc)
            </button>
          </div>
        </div>
      )}

      {chainOpen && (
        <div className="rounded-xl border border-fuchsia-400/40 bg-fuchsia-500/10 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-fuchsia-200">
              ⛓ Chain ({match.chain.length}) —{' '}
              {myChainPriority
                ? 'your priority'
                : `waiting for ${match.priority != null ? match.players[match.priority].name : '…'}`}
            </span>
            {myChainPriority && onPassPriority && (
              <button
                onClick={onPassPriority}
                className="shrink-0 rounded bg-fuchsia-500/30 px-3 py-1 text-sm font-semibold text-fuchsia-100 hover:bg-fuchsia-500/50"
              >
                Pass (A)
              </button>
            )}
          </div>
          {/* Top of chain is last; show top-first */}
          <div className="flex flex-col gap-1">
            {[...match.chain].reverse().map((item, i) => {
              const card = getCard(item.cardId)
              return (
                <div
                  key={item.id}
                  className={`fx-slidein flex items-center justify-between gap-2 rounded px-2 py-1 text-xs ${
                    i === 0 ? 'bg-fuchsia-500/20' : 'bg-black/20'
                  }`}
                >
                  <span>
                    {i === 0 && <span className="text-fuchsia-300">▶ </span>}
                    {item.kind === 'counter' ? '✗ Counter: ' : ''}
                    <span className="font-medium">{card?.name ?? item.cardId}</span>{' '}
                    <span className="text-white/40">· {match.players[item.controller].name}</span>
                  </span>
                  {myChainPriority && onCounter && item.kind === 'spell' && (
                    <button
                      onClick={() => onCounter(item.id)}
                      className="shrink-0 rounded bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-500/40"
                    >
                      Counter
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {myChainPriority && (
            <p className="mt-2 text-[11px] text-white/40">
              Play a Reaction spell to respond, Counter a spell, or Pass (A) to let the top resolve.
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Log</div>
        <div className="flex max-h-[55vh] flex-col-reverse gap-0.5 overflow-y-auto text-[11px] text-white/60">
          {[...match.log].reverse().map((l, i) => (
            <div key={i}>
              <span className="text-white/30">T{l.turn} </span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </aside>
    </div>
  )
}

// --- opponent --------------------------------------------------------------

function OpponentMat({
  opp,
  target,
  active,
  onInspect,
  onInspectCard,
  fx,
  usesXp,
}: {
  opp: PlayerState
  target: number
  active: boolean
  onInspect: (ci: EngineCard) => void
  onInspectCard?: (card: Card) => void
  fx: Fx
  usesXp: boolean
}) {
  const domains = playerDomains(opp)
  const inspectGear = (cid: string) => { const c = getCard(cid); if (c) onInspectCard?.(c) }
  return (
    <div
      className={`rounded-xl border p-2 ${active ? 'border-indigo-400/50' : 'border-white/10'}`}
      style={{ background: matGradient(domains) }}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">{opp.name}</span>
        <ScoreTrack points={opp.points} target={target} />
        {usesXp && (
          <MechanicTooltip mechanic="xp">
            <span className="text-amber-300/70">✦{opp.xp} XP</span>
          </MechanicTooltip>
        )}
        {active && <span className="rounded bg-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-200">turn</span>}
        <span className="ml-auto flex items-center gap-1 text-white/40">
          {domains.map((d) => (
            <span key={d} className="h-2 w-4 rounded-full" style={{ background: DOMAIN_META[d].color }} />
          ))}
        </span>
      </div>
      <div className="flex items-end gap-2">
        {/* Legend + Champion — face-up, inspectable by everyone */}
        {opp.legend && (
          <CardPreview cardId={opp.legend.cardId}>
            <button onClick={() => onInspect(opp.legend!)} title="Opponent's Legend">
              <BoardCard ci={opp.legend} size="sm" xp={opp.xp} />
            </button>
          </CardPreview>
        )}
        {opp.champion && (
          <CardPreview cardId={opp.champion.cardId}>
            <button onClick={() => onInspect(opp.champion!)} title="Opponent's Champion" className="relative">
              <BoardCard ci={opp.champion} size="sm" xp={opp.xp} />
              <span className="absolute left-0 top-0 rounded-br bg-amber-500/80 px-0.5 text-[7px] font-bold text-black">CH</span>
            </button>
          </CardPreview>
        )}
        {/* Hand: rune cards are public (shown face-up); everything else stays
            face-down. */}
        <div className="flex gap-0.5">
          {opp.zones.hand.map((c) =>
            getCard(c.cardId)?.type === 'rune' ? (
              <CardPreview key={c.iid} cardId={c.cardId}>
                <button onClick={() => onInspect(c)} title="Opponent's rune (revealed)">
                  <BoardCard ci={c} size="sm" xp={opp.xp} />
                </button>
              </CardPreview>
            ) : (
              <CardBack key={c.iid} size="sm" />
            ),
          )}
          {opp.zones.hand.length === 0 && <span className="text-[10px] text-white/30">no cards</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {opp.zones.trash.length > 0 && (
            <button
              onClick={() => {
                const top = opp.zones.trash[opp.zones.trash.length - 1]
                if (top) onInspect(top)
              }}
              title={`Trash (${opp.zones.trash.length}) — click to view top card`}
              className="flex h-[60px] w-9 items-center justify-center rounded-md border border-dashed border-white/15 text-[11px] text-white/40 hover:border-white/40"
            >
              🗑{opp.zones.trash.length}
            </button>
          )}
          <CardBack size="sm" count={opp.zones.mainDeck.length} />
          <CardBack size="sm" count={opp.zones.runeDeck.length} />
        </div>
      </div>
      {/* opponent base + battlefield presence summary */}
      {opp.zones.base.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {opp.zones.base.map((u) => {
            const cf = cardFx(fx, u)
            return (
              <span key={cf.key} className="relative inline-block">
                <CardPreview cardId={u.cardId}>
                  <button onClick={() => onInspect(u)}>
                    <BoardCard ci={u} size="sm" flash={cf.flash} glow={cf.glow} dim={cf.dim} xp={opp.xp} />
                  </button>
                </CardPreview>
                <GearPeek unit={u} onInspectGear={inspectGear} />
              </span>
            )
          })}
        </div>
      )}
      {/* Rune pool — runes are public; exhausted (spent) runes stay visible to
          everyone so opponents can see what's been used. */}
      {opp.zones.runePool.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[8px] uppercase tracking-wide text-white/30">
            Runes {opp.zones.runePool.filter((r) => !r.exhausted).length}/{opp.zones.runePool.length}
          </span>
          {opp.zones.runePool.map((r) => {
            const d = getCard(r.cardId)
            const dom = d?.type === 'rune' ? d.produces[0] : undefined
            const color = dom ? DOMAIN_META[dom].color : '#888'
            return (
              <CardPreview key={r.iid} cardId={r.cardId}>
                <button
                  onClick={() => onInspect(r)}
                  title={`${d?.name ?? 'Rune'}${r.exhausted ? ' (exhausted)' : ''}`}
                  className={`relative w-7 shrink-0 overflow-hidden rounded border transition-all hover:border-white/50 ${
                    r.exhausted ? 'rotate-90 opacity-40 saturate-50' : ''
                  }`}
                  style={{ aspectRatio: '744/1039', borderColor: color }}
                >
                  {d?.imageUrl ? (
                    <img src={d.imageUrl} alt={d.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center" style={{ color }}>
                      {dom ? <DomainIcon domain={dom} size={14} /> : '◆'}
                    </span>
                  )}
                  {r.exhausted && (
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[6px] font-bold uppercase tracking-wide text-white/70">
                      used
                    </span>
                  )}
                </button>
              </CardPreview>
            )
          })}
        </div>
      )}
    </div>
  )
}

// --- battlefield zone (shared) ---------------------------------------------

/** Ambient particle effect for a battlefield, picked from its name/theme.
 *  Unknown battlefields fall back to '' (the default domain-glow overlay). */
function bfEffectClass(name?: string): string {
  const n = (name ?? '').toLowerCase()
  // Desert / tomb → sand drifting top-right → bottom-left.
  if (/waste|tomb|dune|sand|desert|emperor|dais|sunken|vaults|helia|idols/.test(n)) return 'bf-fx-sand'
  // Peaks / sky → low-opacity clouds drifting right → left.
  if (/peak|climb|hillock|spire|summit|mountain|windswept|rockfall|cloud|sky|aspirant|marai/.test(n)) return 'bf-fx-clouds'
  // Groves / temples → red leaves falling (Monastery of Hirana et al.).
  if (/tree|grove|garden|willow|papertree|conservator|sanctum|forest|bloom|becoming|candlelit|monastery|hirana|veiled|dreaming|grand plaza|library|academy/.test(n))
    return 'bf-fx-leaves'
  // Storm / power → periodic lightning strikes (Obelisk of Power, Sigil of the Storm).
  if (/storm|obelisk|nexus|sigil|thunder|lightning|\bpower\b|tempest|seat of power/.test(n)) return 'bf-fx-lightning'
  // Arenas / forges → minimal fire embers (Reckoner's Arena et al.).
  if (/arena|forge|flame|fighting pit|war camp|blood|reckoner|furnace|ember|fluft|minefield|altar of blood|pit|ripper/.test(n))
    return 'bf-fx-fire'
  return '' // building / unknown → default domain overlay
}

function BattlefieldZone({
  match,
  perspective,
  fx,
  selectedUnits,
  myActionTurn,
  onMoveTo,
  inspect,
  openMenu,
  onInspect,
  targetingActive,
  onMoveOverride,
  onBfContext,
}: {
  match: MatchState
  perspective: PlayerId
  fx: Fx
  selectedUnits: string[]
  myActionTurn: boolean
  onMoveTo: (bf: number) => void
  inspect: (ci: EngineCard) => void
  openMenu: (e: React.MouseEvent, ci: EngineCard, zone: 'base' | 'runePool' | 'hand' | 'battlefield' | 'legend' | 'champion') => void
  onInspect?: (card: Card) => void
  targetingActive?: boolean
  onMoveOverride?: (iid: string, dest: MoveDest) => void
  onBfContext?: (e: React.MouseEvent, bfIndex: number) => void
}) {
  const dndOn = !!match.sandbox && !!onMoveOverride
  return (
    <div className="grid h-full gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(match.battlefields.length, 4)}, minmax(0,1fr))` }}>
      {match.battlefields.map((bf, i) => {
        const bfCard = getCard(bf.cardId)
        const ctrl = bf.controller
        const ctrlDomains = ctrl != null ? playerDomains(match.players[ctrl]) : []
        const targetable = selectedUnits.length > 0 && myActionTurn
        const isFury = ctrlDomains[0] === 'fury'
        const isLight = ctrlDomains[0] === 'order' || ctrlDomains[0] === 'mind'
        const effectClass = bfEffectClass(bfCard?.name)
        const rulesTip = bfCard?.text ? `${bfCard.name}\n\n${bfCard.text.replace(/:rb_[a-z0-9_]+:/g, '')}` : bfCard?.name
        return (
          <div
            key={i}
            onClick={() => targetable && onMoveTo(i)}
            {...dropTgt(dndOn, { toBattlefield: i }, onMoveOverride)}
            className={`relative rounded-xl border-2 p-1.5 transition ${
              ctrl === perspective
                ? 'border-emerald-400/60'
                : ctrl != null
                  ? 'border-rose-400/50'
                  : 'border-amber-600/30'
            } ${targetable ? 'cursor-pointer ring-2 ring-indigo-400/50' : ''} ${
              ctrl != null ? domainAnimClass(ctrlDomains) : ''
            }`}
            style={{
              background: ctrl != null ? matGradient(ctrlDomains) : 'linear-gradient(135deg,#11192e,#0a0f1c)',
              ['--glow' as string]: ctrl != null ? domainGlow(ctrlDomains) : 'transparent',
            }}
          >
            {/* Cropped art band: only the title art (name + BATTLEFIELD tag are
                baked into the image); rules text bands are cropped out. The slot
                clips the oversized image so nothing escapes its border. */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (bfCard && onInspect && !targetable) onInspect(bfCard)
              }}
              onContextMenu={(e) => {
                e.stopPropagation()
                onBfContext?.(e, i)
              }}
              title={rulesTip ?? undefined}
              className="bf-slot relative block w-full"
            >
              {bfCard?.imageUrl ? (
                <img src={bfCard.imageUrl} alt={bfCard.name} loading="lazy" className="bf-art" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-amber-100">
                  {bfCard?.name ?? `Battlefield ${i + 1}`}
                </span>
              )}
              {/* ambient per-battlefield effect, over the art only */}
              {effectClass ? (
                <div className={`pointer-events-none absolute inset-0 ${effectClass}`} />
              ) : (
                <>
                  {isFury && <div className="fire-overlay" />}
                  {isLight && <div className="light-overlay" />}
                </>
              )}
              {ctrl != null && (
                <span className="absolute right-1 top-1 flex items-center gap-1">
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] font-semibold shadow"
                    style={{ background: '#000c', color: domainGlow(ctrlDomains) }}
                  >
                    {match.players[ctrl].name}
                  </span>
                  <MechanicTooltip
                    title="Holding"
                    text={`${match.players[ctrl].name} controls this battlefield and scores +${RULES.pointsPerBattlefield} at the start of their next turn (while still holding).`}
                  >
                    <span className="rounded bg-emerald-500/80 px-1 py-0.5 text-[9px] font-bold text-black shadow">
                      ▲+{RULES.pointsPerBattlefield}
                    </span>
                  </MechanicTooltip>
                </span>
              )}
            </button>
            {/* Readable rules text below the art band (the art band itself is
                cropped, so the printed rules are shown here with icons). */}
            {bfCard?.text && (
              <p className="mt-1 rounded bg-black/35 px-1.5 py-1 text-[10px] leading-snug text-white/90">
                <CardText text={bfCard.text} />
              </p>
            )}
            <div className="relative mt-1.5 flex min-h-[92px] flex-wrap content-start gap-1">
              {bf.facedown && (() => {
                const fd = bf.facedown
                const mine = fd.owner === perspective
                return (
                  <button
                    key={fd.iid}
                    title={mine ? `Your Hidden card (${getCard(fd.cardId)?.name}) — right-click to Reveal (play for 0)` : 'A Hidden card (facedown)'}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => { e.stopPropagation(); if (mine) openMenu(e, fd, 'battlefield') }}
                    className="relative"
                  >
                    <CardBack size="sm" />
                    <span className="absolute -right-1 -top-1 z-10 rounded-full bg-amber-500/90 px-1 text-[8px] font-bold text-black shadow" title="Hidden (facedown)">H</span>
                  </button>
                )
              })()}
              {bf.units.map((u) => {
                const cf = cardFx(fx, u)
                if (u.facedown && u.owner !== perspective) {
                  return (
                    <button
                      key={u.iid}
                      title="Hidden unit"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (targetingActive) inspect(u)
                      }}
                      className={fx.targeting && fx.legalSet.has(u.iid) ? 'rounded ring-2 ring-amber-300/70' : ''}
                    >
                      <CardBack size="sm" />
                    </button>
                  )
                }
                // Ganking: your unit here may move directly to another
                // battlefield — pulse it to advertise the gank.
                const canGank = u.owner === perspective && myActionTurn && !u.exhausted && keywordsAt(getCard(u.cardId), match.players[u.owner].xp).ganking
                return (
                  <span key={cf.key} className="relative inline-block">
                    <CardPreview cardId={u.cardId}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          inspect(u)
                        }}
                        onContextMenu={(e) => {
                          e.stopPropagation()
                          openMenu(e, u, 'battlefield')
                        }}
                        {...dragSrc(dndOn, u.iid)}
                        title={canGank ? 'Ganking — can move directly to another battlefield' : u.facedown ? 'Your Hidden unit — right-click to Reveal' : undefined}
                        className={`relative ${u.owner === perspective ? '' : 'opacity-90'} ${u.facedown ? 'rounded ring-2 ring-amber-300/60' : ''} ${canGank ? 'fx-gank rounded' : ''}`}
                      >
                        <BoardCard ci={u} size="sm" flash={cf.flash} glow={cf.glow} dim={cf.dim} xp={match.players[u.owner].xp} auraBonus={auraMightFor(match, i, u)} />
                        {canGank && (
                          <span className="absolute -right-1 -top-1 z-10 rounded-full bg-fuchsia-500/90 px-1 text-[8px] font-bold text-white shadow">⚡G</span>
                        )}
                      </button>
                    </CardPreview>
                    <GearPeek unit={u} onInspectGear={(cid) => { const c = getCard(cid); if (c) onInspect?.(c) }} />
                  </span>
                )
              })}
              {bf.units.length === 0 && <span className="self-center text-[10px] text-white/30">uncontested</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- local player ----------------------------------------------------------

function PlayerMat({
  me,
  target,
  turn,
  myActionTurn,
  canRespond,
  selectedUnits,
  onToggleUnit,
  onInspect,
  onInspectCard,
  onPlay,
  onEndTurn,
  endTurnNeedsConfirm,
  onConcede,
  onContext,
  onZoneContext,
  onRevealTop,
  canPlayIid,
  fx,
  usesXp,
  sandbox,
  onMoveOverride,
  onActivateLegend,
  activateLegendLabel,
  onActivateLegendOwn,
  legendOwnLabel,
  onOpenSearch,
}: {
  me: PlayerState
  target: number
  turn: number
  myActionTurn: boolean
  canRespond?: boolean
  selectedUnits: string[]
  onToggleUnit: (iid: string) => void
  onInspect: (ci: EngineCard) => void
  onInspectCard?: (card: Card) => void
  onPlay: (c: EngineCard) => void
  onEndTurn: () => void
  endTurnNeedsConfirm?: boolean
  onConcede?: () => void
  onContext?: (e: React.MouseEvent, ci: EngineCard, zone: 'base' | 'runePool' | 'hand' | 'legend' | 'champion') => void
  onZoneContext?: (e: React.MouseEvent, kind: 'deck' | 'runeDeck' | 'base' | 'hand' | 'trash') => void
  /** Open the big card-search overlay for one of this player's piles (sandbox). */
  onOpenSearch?: (source: SearchSource) => void
  onRevealTop?: () => void
  canPlayIid: (iid: string) => { valid: boolean; reason?: string }
  fx: Fx
  usesXp: boolean
  sandbox?: boolean
  onMoveOverride?: (iid: string, dest: MoveDest) => void
  /** Forge of the Fluft: activate the legend's granted ability (or undefined). */
  onActivateLegend?: () => void
  activateLegendLabel?: string
  /** The legend's own printed activated ability (Lee Sin, …) + its label. */
  onActivateLegendOwn?: () => void
  legendOwnLabel?: string
}) {
  const dndOn = !!sandbox && !!onMoveOverride
  const domains = playerDomains(me)
  const readyRunes = me.zones.runePool.filter((r) => !r.exhausted).length
  const championCheck = me.champion ? canPlayIid(me.champion.iid) : null
  // Gold gear tokens you hold (each cashes in for 1 Power of any domain).
  const gold = me.zones.base.filter((g) => getCard(g.cardId)?.supertype === 'token' && getCard(g.cardId)?.type === 'gear').length
  // Spendable Energy at a glance: ready runes + pooled energy.
  const spendableEnergy = readyRunes + (me.pool?.energy ?? 0)
  const deckLow = me.zones.mainDeck.length <= 5

  const endTurn = () => {
    if (endTurnNeedsConfirm && !confirm('You still have plays or moves available. End turn anyway?')) return
    onEndTurn()
  }

  return (
    <div className="space-y-2">
      {/* slim status bar above the mat */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-600/25 bg-[#0c1322]/70 px-3 py-1.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">
            {me.name} <span className="text-white/40">· ⚡{readyRunes}</span>
            {usesXp && <span className="ml-1 text-amber-300/80" title="Experience">· ✦{me.xp} XP</span>}
          </span>
          <PoolMeter pool={me.pool} />
        </div>
        <div className="flex items-center gap-2">
          {myActionTurn && onConcede && (
            <button
              onClick={() => confirm('Concede this match?') && onConcede()}
              className="rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30"
            >
              Concede
            </button>
          )}
          {myActionTurn && (
            <button onClick={endTurn} className="rounded bg-indigo-500 px-3 py-1 text-sm font-semibold hover:bg-indigo-400">
              End turn ▶
            </button>
          )}
        </div>
      </div>

      {/* The playmat — irregular grid-template-areas */}
      <div className={`playmat ${domainAnimClass(domains)}`} style={{ ['--glow' as string]: domainGlow(domains) }}>
        {/* Score track (8 → 0, top to bottom) */}
        <div className="pm-score flex flex-col items-center justify-between py-1">
          {Array.from({ length: target + 1 }).map((_, idx) => {
            const n = target - idx
            return (
              <span
                key={n}
                title={`${me.points} / ${target} points`}
                className={`flex aspect-square w-full max-w-[34px] items-center justify-center rounded-full border text-[10px] font-bold ${
                  n === me.points
                    ? 'border-emerald-300 bg-emerald-400 text-black'
                    : n < me.points
                      ? 'border-emerald-500/50 bg-emerald-500/30 text-emerald-100'
                      : 'border-[var(--zone-line)] text-[#e7d9b0]'
                }`}
              >
                {n}
              </span>
            )
          })}
        </div>

        {/* Resources (repurposed from the old on-mat Battlefield Zone — the
            shared battlefields now render above the mat). */}
        <div className="pm-zone pm-bf">
          <div className="pm-zone-label mb-1.5">Resources</div>
          <div className="flex flex-wrap items-stretch gap-1.5 text-[11px]">
            <MechanicTooltip mechanic="rune">
              <span className="flex flex-col rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1">
                <span className="text-[8px] uppercase tracking-wide text-amber-200/50">Runes</span>
                <span className="font-bold text-amber-100">⚡ {readyRunes}<span className="text-amber-200/40">/{me.zones.runePool.length}</span></span>
              </span>
            </MechanicTooltip>
            <MechanicTooltip mechanic="energy" title="Spendable Energy" text="Energy you can spend right now: ready runes plus pooled Energy.">
              <span className="flex flex-col rounded-lg border border-amber-300/40 bg-amber-400/10 px-2.5 py-1">
                <span className="text-[8px] uppercase tracking-wide text-amber-200/50">Spendable</span>
                <span className="font-bold text-amber-50">⚡ {spendableEnergy}</span>
              </span>
            </MechanicTooltip>
            <MechanicTooltip mechanic="gold">
              <span className="flex flex-col rounded-lg border border-yellow-300/30 bg-yellow-400/10 px-2.5 py-1">
                <span className="text-[8px] uppercase tracking-wide text-yellow-200/50">Gold</span>
                <span className="font-bold text-yellow-100">🪙 {gold}</span>
              </span>
            </MechanicTooltip>
            {usesXp && (
              <MechanicTooltip mechanic="xp">
                <span className="flex flex-col rounded-lg border border-fuchsia-300/30 bg-fuchsia-500/10 px-2.5 py-1">
                  <span className="text-[8px] uppercase tracking-wide text-fuchsia-200/50">XP</span>
                  <span className="font-bold text-fuchsia-100">✦ {me.xp}</span>
                </span>
              </MechanicTooltip>
            )}
            <MechanicTooltip mechanic="power" title="Resource pool" text="Added Energy/Power that sits on top of your runes and is spent first. Empties at end of turn.">
              <span className="flex flex-col justify-center rounded-lg border border-white/15 bg-white/5 px-2.5 py-1">
                <span className="text-[8px] uppercase tracking-wide text-white/40">Pool</span>
                <PoolMeter pool={me.pool} placeholder />
              </span>
            </MechanicTooltip>
          </div>
        </div>

        {/* Legend Zone */}
        <div className="pm-zone pm-legend flex flex-col items-center gap-1">
          <div className="pm-zone-label self-start">Legend Zone</div>
          {me.legend ? (
            <>
              <CardPreview cardId={me.legend.cardId}>
                <button onClick={() => onInspect(me.legend!)} onContextMenu={(e) => onContext?.(e, me.legend!, 'legend')}>
                  <BoardCard ci={me.legend} xp={me.xp} />
                </button>
              </CardPreview>
              <MechanicTooltip
                title="Legend ability"
                text={me.legend.exhausted ? 'Already used this turn — readies on your next Awaken.' : 'Auto-resolves — available this turn.'}
              >
                <span className={`rounded px-1 text-[8px] font-bold ${me.legend.exhausted ? 'bg-white/10 text-white/40' : 'bg-emerald-500/30 text-emerald-200'}`}>
                  {me.legend.exhausted ? '○ ability used' : '● ability ready'}
                </span>
              </MechanicTooltip>
              {/* The legend's OWN printed activated ability (Lee Sin buff, …) —
                  needs a target, so it routes through the unit-activation picker. */}
              {onActivateLegendOwn && legendOwnLabel && !me.legend.exhausted && (
                <button
                  onClick={onActivateLegendOwn}
                  className="rounded bg-sky-500/30 px-1 text-[8px] font-bold text-sky-100 hover:bg-sky-500/50"
                >
                  ⚡ {legendOwnLabel}
                </button>
              )}
              {/* Battlefield-granted legend ability (Forge of the Fluft). */}
              {onActivateLegend && activateLegendLabel && (
                <button
                  onClick={onActivateLegend}
                  className="rounded bg-amber-500/30 px-1 text-[8px] font-bold text-amber-100 hover:bg-amber-500/50"
                >
                  ⚡ {activateLegendLabel}
                </button>
              )}
            </>
          ) : (
            <Empty />
          )}
        </div>

        {/* Champion Zone */}
        <div className="pm-zone pm-champion flex flex-col items-center gap-1">
          <div className="pm-zone-label self-start">Champion Zone</div>
          {me.champion ? (
            <>
              <CardPreview cardId={me.champion.cardId}>
                <button onClick={() => onInspect(me.champion!)} onContextMenu={(e) => onContext?.(e, me.champion!, 'champion')} className="relative">
                  <BoardCard ci={me.champion} dim={!!championCheck && !championCheck.valid && myActionTurn} xp={me.xp} />
                  <span className="absolute left-0 top-0 rounded-br bg-amber-500/80 px-1 text-[8px] font-bold text-black">CHAMP</span>
                </button>
              </CardPreview>
              <button
                disabled={!championCheck?.valid}
                title={championCheck?.reason}
                onClick={() => onPlay(me.champion!)}
                className="rounded bg-indigo-500/80 px-2 py-0.5 text-[10px] font-semibold hover:bg-indigo-500 disabled:opacity-30"
              >
                Play
              </button>
            </>
          ) : (
            <Empty />
          )}
        </div>

        {/* Base: Units + Gears */}
        <div className="pm-zone pm-baseunits" onContextMenu={onZoneContext ? (e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pm-zone-label')) onZoneContext(e, 'base') } : undefined}>
          <div className="pm-zone-label mb-1">Base: Units + Gears ({me.zones.base.length})</div>
          <div className="flex min-h-[80px] flex-wrap gap-1.5" {...dropTgt(dndOn, { toZone: 'base' }, onMoveOverride)}>
        {me.zones.base.map((u) => {
          const isUnit = getCard(u.cardId)?.type === 'unit'
          const movable = myActionTurn && isUnit && !u.exhausted
          // Entered this turn and still exhausted → can't act yet (summoning sick).
          const summoningSick = isUnit && u.exhausted && u.enteredTurn === turn
          const cf = cardFx(fx, u, movable)
          return (
            <div key={cf.key} className="flex flex-col items-center gap-0.5">
              <span className="relative inline-block">
                <CardPreview cardId={u.cardId}>
                  <button
                    onClick={() => onInspect(u)}
                    onContextMenu={(e) => onContext?.(e, u, 'base')}
                    {...dragSrc(dndOn, u.iid)}
                    className={selectedUnits.includes(u.iid) ? 'rounded ring-2 ring-indigo-400' : ''}
                  >
                    <BoardCard
                      ci={u}
                      selected={selectedUnits.includes(u.iid)}
                      flash={cf.flash}
                      glow={selectedUnits.includes(u.iid) ? undefined : cf.glow}
                      dim={cf.dim}
                      xp={me.xp}
                    />
                  </button>
                </CardPreview>
                <GearPeek unit={u} onInspectGear={(cid) => { const c = getCard(cid); if (c) onInspectCard?.(c) }} />
              </span>
              {movable && (
                <button
                  onClick={() => onToggleUnit(u.iid)}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                    selectedUnits.includes(u.iid)
                      ? 'bg-indigo-500 text-white'
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  ⚔ Move
                </button>
              )}
              {!movable && summoningSick && (
                <MechanicTooltip mechanic="summoning">
                  <span className="rounded bg-white/10 px-1 text-[8px] font-semibold text-white/50">💤 can’t act</span>
                </MechanicTooltip>
              )}
            </div>
          )
        })}
            {me.zones.base.length === 0 && <Empty />}
          </div>
        </div>

        {/* Main Deck */}
        <div className="pm-zone pm-maindeck flex flex-col items-center justify-center gap-1" {...dropTgt(dndOn, { toZone: 'mainDeck' }, onMoveOverride)} onContextMenu={onZoneContext ? (e) => onZoneContext(e, 'deck') : undefined}>
          <div className="pm-zone-label self-start">Main Deck</div>
          <button onClick={onRevealTop} title="Reveal top card" className="rounded transition hover:ring-2 hover:ring-indigo-400/50">
            <CardBack size="sm" count={me.zones.mainDeck.length} />
          </button>
          {deckLow && (
            <MechanicTooltip
              title="Deck running low"
              text="When your deck empties, drawing triggers Burn Out (reshuffle Trash; an opponent scores). Empty Trash too = you lose."
            >
              <span className={`rounded px-1 text-[8px] font-bold ${me.zones.mainDeck.length === 0 ? 'bg-rose-600/80 text-white' : 'bg-amber-500/30 text-amber-200'}`}>
                {me.zones.mainDeck.length === 0 ? '⚠ empty!' : `⚠ ${me.zones.mainDeck.length} left`}
              </span>
            </MechanicTooltip>
          )}
        </div>

        {/* Rune Deck */}
        <div className="pm-zone pm-runedeck flex flex-col items-center justify-center gap-1" onContextMenu={onZoneContext ? (e) => onZoneContext(e, 'runeDeck') : undefined}>
          <div className="pm-zone-label self-start">Rune Deck</div>
          <CardBack size="sm" count={me.zones.runeDeck.length} />
        </div>

        {/* Base: Runes */}
        <div className="pm-zone pm-baserunes">
          <div className="pm-zone-label mb-1">Base: Runes ({readyRunes}/{me.zones.runePool.length} ready)</div>
          <div className="flex flex-wrap gap-1" {...dropTgt(dndOn, { toZone: 'runePool' }, onMoveOverride)}>
        {me.zones.runePool.map((r) => {
          const d = getCard(r.cardId)
          const dom = d?.type === 'rune' ? d.produces[0] : undefined
          const color = dom ? DOMAIN_META[dom].color : '#888'
          return (
            <CardPreview key={r.iid} cardId={r.cardId}>
              <button
                title={`${d?.name ?? 'Rune'}${r.exhausted ? ' (exhausted)' : ''}`}
                onClick={() => onInspect(r)}
                onContextMenu={(e) => onContext?.(e, r, 'runePool')}
                {...dragSrc(dndOn, r.iid)}
                className={`relative w-9 shrink-0 overflow-hidden rounded border transition-all hover:border-white/50 ${
                  r.exhausted ? 'rotate-90 opacity-40 saturate-50' : ''
                }`}
                style={{ aspectRatio: '744/1039', borderColor: color }}
              >
                {d?.imageUrl ? (
                  <img src={d.imageUrl} alt={d.name} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center" style={{ color }}>
                    {dom ? <DomainIcon domain={dom} size={18} /> : '◆'}
                  </span>
                )}
                {r.exhausted && (
                  <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[7px] font-bold uppercase tracking-wide text-white/70">
                    used
                  </span>
                )}
              </button>
            </CardPreview>
          )
        })}
            {me.zones.runePool.length === 0 && <Empty />}
          </div>
        </div>

        {/* Trash (+ Banished) */}
        <div className="pm-zone pm-trash flex flex-col items-center justify-center gap-1">
          <div className="pm-zone-label self-start">Trash</div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              title={onOpenSearch ? 'Search / take back from trash' : undefined}
              onClick={onOpenSearch ? () => onOpenSearch('trash') : undefined}
              onContextMenu={onZoneContext ? (e) => onZoneContext(e, 'trash') : undefined}
              className={`flex h-[60px] w-11 items-center justify-center rounded-md border border-dashed border-white/15 text-sm text-white/40 ${onOpenSearch ? 'cursor-pointer hover:border-white/40' : ''}`}
              {...dropTgt(dndOn, { toZone: 'trash' }, onMoveOverride)}
            >
              🗑 {me.zones.trash.length}
            </button>
            {me.banished.length > 0 && (
              <div className="flex flex-col items-center gap-0.5">
                <div className="flex h-[60px] w-11 items-center justify-center rounded-md border border-dashed border-fuchsia-400/30 text-sm text-fuchsia-300/60">
                  ⊗ {me.banished.length}
                </div>
                <span className="text-[8px] uppercase tracking-wide text-fuchsia-300/40">Banished</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hand strip (below the mat) */}
      <div className="rounded-xl border border-amber-600/25 bg-[#0c1322]/70 p-2" onContextMenu={onZoneContext ? (e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pm-zone-label')) onZoneContext(e, 'hand') } : undefined}>
        <div className="pm-zone-label mb-1">Hand ({me.zones.hand.length})</div>
        <div className="flex min-h-[80px] flex-wrap gap-1.5" {...dropTgt(dndOn, { toZone: 'hand' }, onMoveOverride)} onContextMenu={onZoneContext ? (e) => { if (e.target === e.currentTarget) onZoneContext(e, 'hand') } : undefined}>
        {me.zones.hand.map((c) => {
          const check = canPlayIid(c.iid)
          // Greyable only when it's a context where playing is conceivable
          // (your action turn, or you hold a response window).
          const relevant = myActionTurn || canRespond
          const cf = cardFx(fx, c)
          return (
            <div key={cf.key} className="flex flex-col items-center gap-0.5">
              <CardPreview cardId={c.cardId}>
                <button className="card-lift" onClick={() => onInspect(c)} onContextMenu={(e) => onContext?.(e, c, 'hand')} {...dragSrc(dndOn, c.iid)}>
                  <BoardCard
                    ci={c}
                    flash={cf.flash}
                    dim={relevant && !check.valid}
                    glow={check.valid ? 'playable' : undefined}
                    xp={me.xp}
                  />
                </button>
              </CardPreview>
              <button
                disabled={!check.valid}
                title={check.reason}
                onClick={() => onPlay(c)}
                className="rounded bg-indigo-500/80 px-2 py-0.5 text-[10px] font-semibold hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-30"
              >
                Play
              </button>
            </div>
          )
        })}
          {me.zones.hand.length === 0 && <Empty />}
        </div>
      </div>

      {selectedUnits.length > 0 && myActionTurn && (
        <p className="text-xs text-indigo-300">
          {selectedUnits.length} unit(s) selected — click a battlefield to move them together.
        </p>
      )}
    </div>
  )
}

const Empty = () => <span className="text-xs text-white/25">—</span>

/** Per-unit combat contribution rows for the showdown preview: Tank-first
 *  ordering, Shield/Assault deltas, and stunned/backline = 0. */
function CombatList({ units, role }: { units: EngineCard[]; role: 'attacker' | 'defender' }) {
  if (units.length === 0) return <div className="text-[10px] text-white/40">— none —</div>
  // Show in damage-assignment order: Tanks first.
  const ordered = [...units].sort((a, b) => {
    const ra = parseKeywords(getCard(a.cardId)).tank ? 0 : 1
    const rb = parseKeywords(getCard(b.cardId)).tank ? 0 : 1
    return ra - rb
  })
  return (
    <div className="flex flex-col gap-0.5">
      {ordered.map((u) => {
        const c = getCard(u.cardId)
        const k = parseKeywords(c)
        const m = combatMight(u, role)
        const tags: string[] = []
        if (k.tank) tags.push('Tank · hit first')
        if (role === 'attacker' && k.assault) tags.push(`+${k.assault} assault`)
        if (role === 'defender' && k.shield) tags.push(`+${k.shield} shield`)
        if (u.stunned) tags.push('stunned · 0')
        if (k.backline) tags.push('backline · 0')
        return (
          <div key={u.iid} className="flex items-center justify-between gap-2 text-[10px]">
            <span className="truncate text-white/80">
              {c?.name ?? u.cardId}
              {tags.length > 0 && <span className="ml-1 text-white/40">({tags.join(', ')})</span>}
            </span>
            <span className="shrink-0 font-mono text-white/70">⚔{m}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Resource pool meter: bonus Energy + colored Power (from "Add" effects) that
 *  is spent before runes. Hidden when empty. */
function PoolMeter({
  pool,
  placeholder,
}: {
  pool: { energy: number; power: Partial<Record<Domain, number>> }
  /** When the pool is empty, render a muted dash instead of nothing. */
  placeholder?: boolean
}) {
  const power = Object.entries(pool.power).filter(([, n]) => (n ?? 0) > 0) as [Domain, number][]
  if (pool.energy <= 0 && power.length === 0)
    return placeholder ? <span className="font-bold text-white/35">—</span> : null
  if (placeholder)
    return (
      <span className="flex items-center gap-1 font-bold text-amber-100">
        {pool.energy > 0 && <span>⚡{pool.energy}</span>}
        {power.map(([d, n]) => (
          <span key={d} className="flex items-center" style={{ color: DOMAIN_META[d].color }}>
            <DomainIcon domain={d} />
            {n}
          </span>
        ))}
      </span>
    )
  return (
    <span
      className="flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold"
      title="Resource pool — added Energy/Power, spent before your runes"
    >
      <span className="text-amber-200/50">pool</span>
      {pool.energy > 0 && <span className="text-amber-100">⚡{pool.energy}</span>}
      {power.map(([d, n]) => (
        <span key={d} className="flex items-center" style={{ color: DOMAIN_META[d].color }}>
          <DomainIcon domain={d} />
          {n}
        </span>
      ))}
    </span>
  )
}

/** The 0 → target score track from the playmat (current point highlighted). */
function ScoreTrack({ points, target }: { points: number; target: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`${points} / ${target} points`}>
      {Array.from({ length: target + 1 }).map((_, n) => (
        <span
          key={n}
          className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold ${
            n === points
              ? 'bg-emerald-400 text-black ring-2 ring-emerald-300'
              : n < points
                ? 'bg-emerald-500/40 text-emerald-100'
                : 'bg-white/5 text-white/30'
          }`}
        >
          {n}
        </span>
      ))}
    </div>
  )
}
