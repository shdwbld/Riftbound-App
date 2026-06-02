import { useState } from 'react'
import { getCard } from '../data/cards'
import {
  type MatchState,
  type PlayerId,
  type EngineCard,
  type PlayerState,
} from '../engine/types'
import { canAfford } from '../engine/autopay'
import { type Card, type Domain, DOMAIN_META } from '../types/cards'
import { matGradient, domainGlow, domainAnimClass } from '../lib/theme'
import BoardCard from './BoardCard'
import CardBack from './CardBack'

// Rift Atlas-style board: opponents at the top (face-down hands), shared
// battlefields in the prominent center, the local player's domain-themed mat at
// the bottom. Supports 2-4 players. Click any card to expand and read it.

export interface MatchBoardProps {
  match: MatchState
  perspective: PlayerId
  canAct: boolean
  onPlay: (c: EngineCard) => void
  onMove: (iid: string, bf: number) => void
  onPass: () => void
  onEndTurn: () => void
  onActivateLegend?: () => void
  onConcede?: () => void
  /** Open the card detail modal for any card on the board. */
  onInspect?: (card: Card) => void
}

function playerDomains(p: PlayerState): Domain[] {
  if (!p.legend) return []
  const l = getCard(p.legend.cardId)
  return l && l.type === 'legend' ? l.identity : []
}

export default function MatchBoard({
  match,
  perspective,
  canAct,
  onPlay,
  onMove,
  onPass,
  onEndTurn,
  onActivateLegend,
  onConcede,
  onInspect,
}: MatchBoardProps) {
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  const me = match.players[perspective]
  // Opponents in seating order, starting just after the local player.
  const opponents: PlayerState[] = []
  for (let i = 1; i < match.players.length; i++)
    opponents.push(match.players[(perspective + i) % match.players.length])

  const myActionTurn =
    canAct && match.phase === 'action' && match.activePlayer === perspective
  const myShowdown =
    canAct && match.phase === 'showdown' && match.showdown?.priority === perspective

  const inspect = (ci: EngineCard) => {
    const c = getCard(ci.cardId)
    if (c && onInspect) onInspect(c)
  }
  const move = (bf: number) => {
    if (selectedUnit) {
      onMove(selectedUnit, bf)
      setSelectedUnit(null)
    }
  }

  return (
    <div className="space-y-3">
      {/* Opponents */}
      <div className={opponents.length > 1 ? 'grid gap-2 sm:grid-cols-2' : ''}>
        {opponents.map((opp) => (
          <OpponentMat key={opp.id} opp={opp} active={match.activePlayer === opp.id} onInspect={inspect} />
        ))}
      </div>

      {/* Battlefields — the focal center */}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(match.battlefields.length, 4)}, minmax(0,1fr))` }}>
        {match.battlefields.map((bf, i) => {
          const bfCard = getCard(bf.cardId)
          const ctrl = bf.controller
          const ctrlDomains = ctrl != null ? playerDomains(match.players[ctrl]) : []
          const targetable = selectedUnit !== null && myActionTurn
          const isFury = ctrlDomains[0] === 'fury'
          const isLight = ctrlDomains[0] === 'order' || ctrlDomains[0] === 'mind'
          return (
            <div
              key={i}
              onClick={() => targetable && move(i)}
              className={`relative overflow-hidden rounded-xl border-2 p-2 transition ${
                ctrl === perspective
                  ? 'border-emerald-400/60'
                  : ctrl != null
                    ? 'border-rose-400/50'
                    : 'border-white/15'
              } ${targetable ? 'cursor-pointer ring-2 ring-indigo-400/50' : ''} ${
                ctrl != null ? domainAnimClass(ctrlDomains) : ''
              }`}
              style={{
                background: ctrl != null ? matGradient(ctrlDomains) : 'linear-gradient(135deg,#15151f,#0a0a12)',
                ['--glow' as string]: ctrl != null ? domainGlow(ctrlDomains) : 'transparent',
              }}
            >
              {isFury && <div className="fire-overlay" />}
              {isLight && <div className="light-overlay" />}
              <div className="relative mb-1 flex items-center justify-between">
                <span className="truncate text-[11px] font-semibold text-white/80">
                  {bfCard?.name ?? `Battlefield ${i + 1}`}
                </span>
                {ctrl != null && (
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
                    style={{ background: '#0008', color: domainGlow(ctrlDomains) }}
                  >
                    {match.players[ctrl].name}
                  </span>
                )}
              </div>
              <div className="relative flex min-h-[92px] flex-wrap content-start gap-1">
                {bf.units.map((u) => (
                  <button
                    key={u.iid}
                    onClick={(e) => {
                      e.stopPropagation()
                      inspect(u)
                    }}
                    className={u.owner === perspective ? '' : 'opacity-90'}
                  >
                    <BoardCard ci={u} size="sm" />
                  </button>
                ))}
                {bf.units.length === 0 && (
                  <span className="self-center text-[10px] text-white/30">uncontested</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Showdown banner */}
      {match.phase === 'showdown' && (
        <div className="flex items-center justify-between rounded-xl border border-amber-400/40 bg-amber-500/10 p-3">
          <span className="text-sm text-amber-200">
            ⚔ Showdown —{' '}
            {myShowdown
              ? 'you have priority.'
              : `waiting for ${match.players[match.showdown!.priority].name}.`}
          </span>
          {myShowdown && (
            <button
              onClick={onPass}
              className="rounded bg-amber-500/30 px-3 py-1 text-sm font-semibold text-amber-100 hover:bg-amber-500/50"
            >
              Pass
            </button>
          )}
        </div>
      )}

      {/* Local player mat */}
      <PlayerMat
        me={me}
        myActionTurn={myActionTurn}
        selectedUnit={selectedUnit}
        onSelectUnit={setSelectedUnit}
        onInspect={inspect}
        onPlay={onPlay}
        onEndTurn={onEndTurn}
        onActivateLegend={onActivateLegend}
        onConcede={onConcede}
      />

      {/* Log */}
      <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">Log</div>
        <div className="flex max-h-36 flex-col-reverse gap-0.5 overflow-y-auto text-[11px] text-white/60">
          {[...match.log].reverse().map((l, i) => (
            <div key={i}>
              <span className="text-white/30">T{l.turn} </span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// --- opponent --------------------------------------------------------------

function OpponentMat({
  opp,
  active,
  onInspect,
}: {
  opp: PlayerState
  active: boolean
  onInspect: (ci: EngineCard) => void
}) {
  const domains = playerDomains(opp)
  return (
    <div
      className={`rounded-xl border p-2 ${active ? 'border-indigo-400/50' : 'border-white/10'}`}
      style={{ background: matGradient(domains) }}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">{opp.name}</span>
        <span className="rounded bg-black/30 px-1.5 py-0.5 text-emerald-300">{opp.points} pts</span>
        {active && <span className="rounded bg-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-200">turn</span>}
        <span className="ml-auto flex items-center gap-1 text-white/40">
          {domains.map((d) => (
            <span key={d} className="h-2 w-4 rounded-full" style={{ background: DOMAIN_META[d].color }} />
          ))}
        </span>
      </div>
      <div className="flex items-end gap-2">
        {/* face-down hand */}
        <div className="flex gap-0.5">
          {opp.zones.hand.slice(0, 6).map((_, i) => (
            <CardBack key={i} size="sm" />
          ))}
          {opp.zones.hand.length === 0 && <span className="text-[10px] text-white/30">no cards</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <CardBack size="sm" count={opp.zones.mainDeck.length} />
          <CardBack size="sm" count={opp.zones.runeDeck.length} />
        </div>
      </div>
      {/* opponent base + battlefield presence summary */}
      {opp.zones.base.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {opp.zones.base.map((u) => (
            <button key={u.iid} onClick={() => onInspect(u)}>
              <BoardCard ci={u} size="sm" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- local player ----------------------------------------------------------

function PlayerMat({
  me,
  myActionTurn,
  selectedUnit,
  onSelectUnit,
  onInspect,
  onPlay,
  onEndTurn,
  onActivateLegend,
  onConcede,
}: {
  me: PlayerState
  myActionTurn: boolean
  selectedUnit: string | null
  onSelectUnit: (iid: string | null) => void
  onInspect: (ci: EngineCard) => void
  onPlay: (c: EngineCard) => void
  onEndTurn: () => void
  onActivateLegend?: () => void
  onConcede?: () => void
}) {
  const domains = playerDomains(me)
  const readyRunes = me.zones.runePool.filter((r) => !r.exhausted).length
  const legendCard = me.legend ? getCard(me.legend.cardId) : undefined
  const championAffordable =
    me.champion && myActionTurn && canAfford(me, getCard(me.champion.cardId)!)
  return (
    <div
      className={`relative overflow-hidden rounded-xl border-2 border-indigo-400/30 p-3 ${domainAnimClass(domains)}`}
      style={{ background: matGradient(domains), ['--glow' as string]: domainGlow(domains) }}
    >
      <div className="relative mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {me.name}{' '}
          <span className="text-white/40">· {me.points} pts · ⚡{readyRunes}</span>
        </span>
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
            <button
              onClick={onEndTurn}
              className="rounded bg-indigo-500 px-3 py-1 text-sm font-semibold hover:bg-indigo-400"
            >
              End turn ▶
            </button>
          )}
        </div>
      </div>

      {/* Legend + Champion zone */}
      <div className="relative mb-2 flex items-end gap-3">
        {me.legend && (
          <div className="flex flex-col items-center gap-0.5">
            <button onClick={() => onInspect(me.legend!)}>
              <BoardCard ci={me.legend} size="sm" />
            </button>
            {onActivateLegend && (
              <button
                disabled={!myActionTurn || me.legend.exhausted}
                onClick={onActivateLegend}
                title={legendCard?.text ?? ''}
                className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-30"
              >
                ★ Ability
              </button>
            )}
          </div>
        )}
        {me.champion && (
          <div className="flex flex-col items-center gap-0.5">
            <button onClick={() => onInspect(me.champion!)} className="relative">
              <BoardCard ci={me.champion} size="sm" />
              <span className="absolute left-0 top-0 rounded-br bg-amber-500/80 px-1 text-[8px] font-bold text-black">
                CHAMP
              </span>
            </button>
            <button
              disabled={!championAffordable}
              onClick={() => onPlay(me.champion!)}
              className="rounded bg-indigo-500/80 px-2 py-0.5 text-[10px] font-semibold hover:bg-indigo-500 disabled:opacity-30"
            >
              Play
            </button>
          </div>
        )}
      </div>

      {/* Base */}
      <ZoneLabel>Base ({me.zones.base.length})</ZoneLabel>
      <div className="mb-2 flex min-h-[88px] flex-wrap gap-1.5">
        {me.zones.base.map((u) => {
          const isUnit = getCard(u.cardId)?.type === 'unit'
          const movable = myActionTurn && isUnit && !u.exhausted
          return (
            <div key={u.iid} className="flex flex-col items-center gap-0.5">
              <button onClick={() => onInspect(u)} className={selectedUnit === u.iid ? 'rounded ring-2 ring-indigo-400' : ''}>
                <BoardCard ci={u} selected={selectedUnit === u.iid} />
              </button>
              {movable && (
                <button
                  onClick={() => onSelectUnit(selectedUnit === u.iid ? null : u.iid)}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                    selectedUnit === u.iid
                      ? 'bg-indigo-500 text-white'
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  ⚔ Move
                </button>
              )}
            </div>
          )
        })}
        {me.zones.base.length === 0 && <Empty />}
      </div>

      {/* Rune pool as tokens */}
      <ZoneLabel>Runes ({readyRunes}/{me.zones.runePool.length} ready)</ZoneLabel>
      <div className="mb-2 flex flex-wrap gap-1">
        {me.zones.runePool.map((r) => {
          const d = getCard(r.cardId)
          const dom = d?.type === 'rune' ? d.produces[0] : undefined
          const color = dom ? DOMAIN_META[dom].color : '#888'
          return (
            <span
              key={r.iid}
              title={d?.name}
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-bold ${
                r.exhausted ? 'opacity-30' : ''
              }`}
              style={{ borderColor: color, color, background: `${color}22` }}
            >
              {dom ? DOMAIN_META[dom].glyph : '◆'}
            </span>
          )
        })}
        {me.zones.runePool.length === 0 && <Empty />}
      </div>

      {/* Hand */}
      <ZoneLabel>Hand ({me.zones.hand.length})</ZoneLabel>
      <div className="flex min-h-[80px] flex-wrap gap-1.5">
        {me.zones.hand.map((c) => {
          const card = getCard(c.cardId)
          const playable =
            myActionTurn &&
            card != null &&
            (card.type === 'unit' || card.type === 'spell' || card.type === 'gear') &&
            canAfford(me, card)
          return (
            <div key={c.iid} className="flex flex-col items-center gap-0.5">
              <button onClick={() => onInspect(c)}>
                <BoardCard ci={c} />
              </button>
              <button
                disabled={!playable}
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

      {/* piles */}
      <div className="mt-2 flex items-end gap-2">
        <CardBack size="sm" count={me.zones.mainDeck.length} label="deck" />
        <CardBack size="sm" count={me.zones.runeDeck.length} label="runes" />
        <div className="flex items-center gap-1 text-[10px] text-white/40">🗑 {me.zones.trash.length}</div>
      </div>

      {selectedUnit && myActionTurn && (
        <p className="mt-2 text-xs text-indigo-300">Click a battlefield above to move the selected unit.</p>
      )}
    </div>
  )
}

const ZoneLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">{children}</div>
)
const Empty = () => <span className="text-xs text-white/25">—</span>
