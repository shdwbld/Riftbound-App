import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { listDecks } from '../lib/deckStorage'
import { validateDeck } from '../lib/deckValidation'
import { getCard } from '../data/cards'
import {
  type GameState,
  type ZoneId,
  setupGame,
  card,
} from '../game/state'
import {
  type MoveTarget,
  move,
  draw,
  channel,
  awaken,
  recycle,
  toggleExhaust,
  adjustPoints,
  toggleHold,
  mulligan,
  availableResources,
} from '../game/boardActions'
import { DOMAIN_META } from '../types/cards'
import type { Deck } from '../types/deck'
import BoardCard from '../components/BoardCard'

export default function PlayPage() {
  const [game, setGame] = useState<GameState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  if (!game)
    return <DeckPicker onStart={(d) => setGame(setupGame(d))} />

  const apply = (fn: (g: GameState) => GameState) => {
    setGame((g) => (g ? fn(g) : g))
  }
  const res = availableResources(game)

  const moveSelected = (target: MoveTarget) => {
    if (!selected) return
    apply((g) => move(g, selected, target))
    setSelected(null)
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-[#15151f] p-2">
        <span className="px-2 font-semibold">{game.deckName}</span>
        <span className="rounded bg-white/5 px-2 py-1 text-xs">
          Turn {game.turn}
        </span>
        <div className="flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs">
          <span className="text-white/50">Points</span>
          <button onClick={() => apply((g) => adjustPoints(g, -1))} className="px-1">
            −
          </button>
          <span className="w-5 text-center font-bold text-emerald-300">
            {game.points}
          </span>
          <button onClick={() => apply((g) => adjustPoints(g, 1))} className="px-1">
            +
          </button>
        </div>
        <div className="flex items-center gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
          <span>⚡{res.energy}</span>
          {Object.entries(res.power).map(([d, n]) => {
            const meta = DOMAIN_META[d as keyof typeof DOMAIN_META]
            return (
              <span key={d} style={{ color: meta?.color }}>
                {n}
                {meta?.glyph ?? '◆'}
              </span>
            )
          })}
        </div>

        <div className="ml-auto flex flex-wrap gap-1">
          <TurnBtn onClick={() => apply(awaken)}>Awaken</TurnBtn>
          <TurnBtn onClick={() => apply((g) => channel(g, 2))}>Channel 2</TurnBtn>
          <TurnBtn onClick={() => apply((g) => draw(g, 1))}>Draw</TurnBtn>
          <TurnBtn onClick={() => apply((g) => adjustPoints(g, 1))}>+ Score</TurnBtn>
          <TurnBtn onClick={() => apply(mulligan)}>Mulligan</TurnBtn>
          <button
            onClick={() => {
              setSelected(null)
              setGame(null)
            }}
            className="rounded bg-rose-500/20 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/30"
          >
            Exit
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_240px]">
        <div className="space-y-3">
          {/* Battlefields */}
          <div className="grid grid-cols-3 gap-2">
            {game.battlefields.map((bf, i) => {
              const def = getCard(bf.cardId)
              return (
                <div
                  key={i}
                  className={`rounded-xl border bg-[#13131c] p-2 ${
                    bf.held ? 'border-emerald-400/50' : 'border-white/10'
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between gap-1">
                    <span className="truncate text-[11px] font-medium text-white/70">
                      {def?.name ?? `Battlefield ${i + 1}`}
                    </span>
                    <button
                      onClick={() => apply((g) => toggleHold(g, i))}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        bf.held
                          ? 'bg-emerald-500/30 text-emerald-200'
                          : 'bg-white/5 text-white/50'
                      }`}
                    >
                      {bf.held ? 'held' : 'hold'}
                    </button>
                  </div>
                  <div
                    onClick={() => selected && moveSelected({ kind: 'battlefield', index: i })}
                    className={`flex min-h-[96px] flex-wrap gap-1 rounded-lg p-1 ${
                      selected ? 'bg-indigo-500/10 ring-1 ring-indigo-400/30' : ''
                    }`}
                  >
                    {bf.units.map((ci) => (
                      <BoardCard
                        key={ci.iid}
                        ci={ci}
                        selected={selected === ci.iid}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelected(ci.iid)
                        }}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Base */}
          <DropZone
            label="Base"
            active={!!selected}
            onDrop={() => moveSelected({ kind: 'zone', zone: 'base' })}
          >
            {game.zones.base.map((ci) => (
              <BoardCard
                key={ci.iid}
                ci={ci}
                selected={selected === ci.iid}
                onClick={() => setSelected(ci.iid)}
              />
            ))}
          </DropZone>

          {/* Rune pool */}
          <DropZone
            label={`Rune Pool (${game.zones.runePool.filter((r) => !r.exhausted).length} ready)`}
            active={!!selected}
            onDrop={() => moveSelected({ kind: 'zone', zone: 'runePool' })}
          >
            {game.zones.runePool.map((ci) => (
              <BoardCard
                key={ci.iid}
                ci={ci}
                size="sm"
                selected={selected === ci.iid}
                onClick={() => setSelected(ci.iid)}
              />
            ))}
          </DropZone>

          {/* Hand */}
          <DropZone
            label={`Hand (${game.zones.hand.length})`}
            active={!!selected}
            onDrop={() => moveSelected({ kind: 'zone', zone: 'hand' })}
          >
            {game.zones.hand.map((ci) => (
              <BoardCard
                key={ci.iid}
                ci={ci}
                selected={selected === ci.iid}
                onClick={() => setSelected(ci.iid)}
              />
            ))}
          </DropZone>
        </div>

        {/* Sidebar */}
        <aside className="space-y-3">
          {game.legend && (
            <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                Legend
              </div>
              <BoardCard
                ci={game.legend}
                selected={selected === game.legend.iid}
                onClick={() => setSelected(game.legend!.iid)}
              />
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Stack
              label="Deck"
              count={game.zones.mainDeck.length}
              onClick={() => apply((g) => draw(g, 1))}
            />
            <Stack
              label="Runes"
              count={game.zones.runeDeck.length}
              onClick={() => apply((g) => channel(g, 1))}
            />
            <Stack
              label="Trash"
              count={game.zones.trash.length}
              onClick={() => selected && moveSelected({ kind: 'zone', zone: 'trash' })}
              highlight={!!selected}
            />
          </div>

          <LogPanel log={game.log} />
        </aside>
      </div>

      {/* Selected action bar */}
      {selected && (
        <ActionBar
          game={game}
          iid={selected}
          onClose={() => setSelected(null)}
          onMove={moveSelected}
          onExhaust={() => apply((g) => toggleExhaust(g, selected))}
          onRecycle={() => {
            apply((g) => recycle(g, selected))
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

// --- Subcomponents ---------------------------------------------------------

function TurnBtn({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="rounded bg-indigo-500/80 px-2.5 py-1 text-xs font-semibold hover:bg-indigo-500"
    >
      {children}
    </button>
  )
}

function DropZone({
  label,
  active,
  onDrop,
  children,
}: {
  label: string
  active: boolean
  onDrop: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#13131c] p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-white/40">
          {label}
        </span>
        {active && (
          <button
            onClick={onDrop}
            className="rounded bg-indigo-500/30 px-2 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-500/50"
          >
            move here
          </button>
        )}
      </div>
      <div className="flex min-h-[88px] flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Stack({
  label,
  count,
  onClick,
  highlight,
}: {
  label: string
  count: number
  onClick: () => void
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex aspect-[744/1039] flex-col items-center justify-center rounded-lg border bg-gradient-to-br from-indigo-950 to-fuchsia-950 ${
        highlight ? 'border-indigo-400' : 'border-white/15'
      }`}
    >
      <span className="text-lg font-bold">{count}</span>
      <span className="text-[10px] text-white/50">{label}</span>
    </button>
  )
}

function LogPanel({ log }: { log: string[] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#15151f] p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
        Log
      </div>
      <div className="flex max-h-48 flex-col-reverse gap-0.5 overflow-y-auto text-[11px] text-white/60">
        {[...log].reverse().map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  )
}

function ActionBar({
  game,
  iid,
  onClose,
  onMove,
  onExhaust,
  onRecycle,
}: {
  game: GameState
  iid: string
  onClose: () => void
  onMove: (t: MoveTarget) => void
  onExhaust: () => void
  onRecycle: () => void
}) {
  const ci =
    game.legend?.iid === iid
      ? game.legend
      : (Object.values(game.zones).flat().find((c) => c.iid === iid) ??
        game.battlefields.flatMap((b) => b.units).find((c) => c.iid === iid))
  const def = ci ? card(ci) : undefined
  const zones: { z: ZoneId; label: string }[] = [
    { z: 'hand', label: 'Hand' },
    { z: 'base', label: 'Base' },
    { z: 'trash', label: 'Trash' },
    { z: 'mainDeck', label: 'Deck' },
  ]
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#10101a]/95 p-3 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{def?.name ?? iid}</span>
        <span className="text-xs text-white/40">{def?.type}</span>
        <div className="mx-2 h-5 w-px bg-white/10" />
        <button onClick={onExhaust} className="rounded bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20">
          {ci?.exhausted ? 'Ready' : 'Exhaust'}
        </button>
        {zones.map((z) => (
          <button
            key={z.z}
            onClick={() => onMove({ kind: 'zone', zone: z.z })}
            className="rounded bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20"
          >
            → {z.label}
          </button>
        ))}
        {game.battlefields.map((_, i) => (
          <button
            key={i}
            onClick={() => onMove({ kind: 'battlefield', index: i })}
            className="rounded bg-indigo-500/30 px-2.5 py-1 text-xs text-indigo-100 hover:bg-indigo-500/50"
          >
            → BF{i + 1}
          </button>
        ))}
        {def?.type === 'rune' && (
          <button onClick={onRecycle} className="rounded bg-amber-500/20 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/30">
            Recycle
          </button>
        )}
        <button onClick={onClose} className="ml-auto rounded px-2.5 py-1 text-xs text-white/50 hover:bg-white/5">
          Deselect ✕
        </button>
      </div>
    </div>
  )
}

function DeckPicker({ onStart }: { onStart: (d: Deck) => void }) {
  const decks = useMemo(() => listDecks(), [])
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Play — Solo Goldfish</h2>
      <p className="text-sm text-white/50">
        Pick a deck to test. The board is manual for now — drag-free moves via
        click + action bar. Rule enforcement arrives in Phase 4.
      </p>
      {decks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-10 text-center">
          <p className="text-white/60">No decks yet.</p>
          <Link
            to="/decks"
            className="mt-3 inline-block rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold"
          >
            Build a deck
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {decks.map((d) => {
            const v = validateDeck(d)
            const legend = d.legendId ? getCard(d.legendId) : undefined
            return (
              <button
                key={d.id}
                onClick={() => onStart(d)}
                className="rounded-xl border border-white/10 bg-[#15151f] p-4 text-left transition hover:border-indigo-400/50"
              >
                <div className="font-semibold">{d.name}</div>
                <div className="text-xs text-white/50">
                  {legend?.name ?? 'No legend'}
                </div>
                {!v.isLegal && (
                  <div className="mt-1 text-[11px] text-amber-300/80">
                    Draft — playable, not tournament-legal
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
