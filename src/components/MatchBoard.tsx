import { useState } from 'react'
import { getCard } from '../data/cards'
import {
  type MatchState,
  type PlayerId,
  type EngineCard,
} from '../engine/types'
import { canAfford } from '../engine/autopay'
import BoardCard from './BoardCard'

// Presentational match board, rendered from one player's `perspective`.
// All mutations are delegated to handlers; the board owns only unit-selection.

export interface MatchBoardProps {
  match: MatchState
  perspective: PlayerId
  /** Whether the local player may act right now (false for a remote spectator
   *  or when it's the opponent's decision). */
  canAct: boolean
  onPlay: (c: EngineCard) => void
  onMove: (iid: string, bf: number) => void
  onPass: () => void
  onEndTurn: () => void
  /** Hide the opponent's hand contents (true for online; false for hotseat). */
  hideOpponentHand?: boolean
}

export default function MatchBoard({
  match,
  perspective,
  canAct,
  onPlay,
  onMove,
  onPass,
  onEndTurn,
  hideOpponentHand,
}: MatchBoardProps) {
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  const me = match.players[perspective]
  const opp = match.players[(perspective === 0 ? 1 : 0) as PlayerId]

  const myActionTurn =
    canAct && match.phase === 'action' && match.activePlayer === perspective
  const myShowdown =
    canAct &&
    match.phase === 'showdown' &&
    match.showdown?.priority === perspective

  const move = (bf: number) => {
    if (selectedUnit) {
      onMove(selectedUnit, bf)
      setSelectedUnit(null)
    }
  }

  return (
    <div className="space-y-3">
      {/* Opponent */}
      <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#13131c] px-3 py-2 text-xs">
        <span className="font-semibold">{opp.name}</span>
        <span className="text-white/50">{opp.points} pts</span>
        <span className="text-white/40">
          ✋ {hideOpponentHand ? opp.zones.hand.length : opp.zones.hand.length}
        </span>
        <span className="text-white/40">🂠 {opp.zones.mainDeck.length}</span>
        <span className="text-white/40">
          ⚡ {opp.zones.runePool.filter((r) => !r.exhausted).length}
        </span>
        <span className="text-white/40">🗑 {opp.zones.trash.length}</span>
        {match.activePlayer === opp.id && (
          <span className="ml-auto rounded bg-indigo-500/20 px-2 py-0.5 text-indigo-200">
            their turn
          </span>
        )}
      </div>

      {/* Opponent base preview */}
      {opp.zones.base.length > 0 && (
        <div className="flex flex-wrap gap-1 rounded-lg border border-white/5 bg-black/20 p-2">
          {opp.zones.base.map((u) => (
            <BoardCard key={u.iid} ci={u} size="sm" />
          ))}
        </div>
      )}

      {/* Battlefields */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {match.battlefields.map((bf, i) => {
          const def = getCard(bf.cardId)
          const targetable = selectedUnit !== null && myActionTurn
          return (
            <div
              key={i}
              onClick={() => targetable && move(i)}
              className={`rounded-xl border bg-[#13131c] p-2 transition ${
                bf.controller === perspective
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
                      bf.controller === perspective
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
                  <div key={u.iid} className={u.owner === perspective ? '' : 'opacity-80'}>
                    <BoardCard ci={u} size="sm" />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Showdown */}
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

      {/* My board */}
      <div className="rounded-xl border border-indigo-400/30 bg-[#13131c] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">
            {me.name}{' '}
            <span className="text-white/40">
              · {me.points} pts ·{' '}
              {me.zones.runePool.filter((r) => !r.exhausted).length} ready runes
            </span>
          </span>
          {myActionTurn && (
            <button
              onClick={onEndTurn}
              className="rounded bg-indigo-500 px-3 py-1 text-sm font-semibold hover:bg-indigo-400"
            >
              End turn ▶
            </button>
          )}
        </div>

        <Zone label={`Base (${me.zones.base.length})`}>
          {me.zones.base.map((u) => {
            const isUnitCard = getCard(u.cardId)?.type === 'unit'
            const selectable = myActionTurn && isUnitCard && !u.exhausted
            return (
              <button
                key={u.iid}
                onClick={() => selectable && setSelectedUnit(u.iid)}
                className={selectedUnit === u.iid ? 'rounded ring-2 ring-indigo-400' : ''}
              >
                <BoardCard ci={u} selected={selectedUnit === u.iid} />
              </button>
            )
          })}
          {me.zones.base.length === 0 && <Empty />}
        </Zone>

        <Zone label={`Rune Pool (${me.zones.runePool.length})`}>
          {me.zones.runePool.map((r) => (
            <BoardCard key={r.iid} ci={r} size="sm" />
          ))}
          {me.zones.runePool.length === 0 && <Empty />}
        </Zone>

        <Zone label={`Hand (${me.zones.hand.length})`}>
          {me.zones.hand.map((c) => {
            const card = getCard(c.cardId)
            const playable =
              myActionTurn &&
              card != null &&
              (card.type === 'unit' || card.type === 'spell' || card.type === 'gear') &&
              canAfford(me, card)
            return (
              <div key={c.iid} className="flex flex-col items-center gap-1">
                <BoardCard ci={c} />
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
        </Zone>

        {selectedUnit && myActionTurn && (
          <p className="mt-2 text-xs text-indigo-300">
            Click a battlefield to move this unit.
          </p>
        )}
      </div>

      {/* Log */}
      <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
          Log
        </div>
        <div className="flex max-h-40 flex-col-reverse gap-0.5 overflow-y-auto text-[11px] text-white/60">
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
