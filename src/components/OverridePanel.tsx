import { useMemo, useState } from 'react'
import { CARDS, getCard } from '../data/cards'
import { DOMAINS, DOMAIN_META } from '../types/cards'
import type { Action, MatchState, OverrideOp, OverrideZone, PlayerId, Phase } from '../engine/types'
import { DomainIcon } from './CardText'

// The left-rail manual override / tabletop fail-safe panel (sandbox only). Every
// control dispatches an OVERRIDE action for the selected target player. Use it
// when the engine fails to auto-do something: grant resources, draw/channel, peek
// the deck, retrieve a mis-discard, spawn any card, or (Advanced) edit game state.

const BTN = 'rounded bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20'
const SECTION = 'rounded-xl border border-amber-400/25 bg-amber-500/5 p-2.5 space-y-2'
const LABEL = 'text-[10px] font-semibold uppercase tracking-wide text-amber-200/70'
const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')

export default function OverridePanel({
  match,
  perspective,
  onAct,
}: {
  match: MatchState
  perspective: PlayerId
  onAct: (a: Action) => void
}) {
  const [target, setTarget] = useState<PlayerId>(perspective)
  const [query, setQuery] = useState('')
  const [zone, setZone] = useState<string>('hand')
  const [browse, setBrowse] = useState(false)
  const [adv, setAdv] = useState(false)
  const [bz, setBz] = useState<{ from: string; to: string }>({ from: 'hand', to: 'mainDeck' })
  const p = match.players[target] ?? match.players[perspective]

  const ov = (op: OverrideOp, extra: Partial<Action & { amount: number; domain: string; cardId: string; value: number; phase: Phase; toZone: OverrideZone; toBattlefield: number; iid: string; fromZone: string; targetPlayer: number }> = {}) =>
    onAct({ type: 'OVERRIDE', player: target, op, ...extra } as Action)

  const ZONES: { v: string; label: string }[] = [
    { v: 'hand', label: 'Hand' },
    { v: 'base', label: 'Base' },
    { v: 'mainDeck', label: 'Deck' },
    { v: 'runeDeck', label: 'Rune deck' },
    { v: 'runePool', label: 'Rune pool' },
    { v: 'trash', label: 'Trash' },
  ]

  const spawn = (cardId: string) => {
    if (zone.startsWith('bf')) ov('spawn', { cardId, toBattlefield: parseInt(zone.slice(2), 10) })
    else ov('spawn', { cardId, toZone: zone as OverrideZone })
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return CARDS.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 14)
  }, [query])

  const zoneOpts: { v: string; label: string }[] = [
    { v: 'hand', label: 'Hand' },
    { v: 'base', label: 'Base' },
    { v: 'mainDeck', label: 'Deck (top)' },
    { v: 'runePool', label: 'Rune pool' },
    { v: 'trash', label: 'Trash' },
    { v: 'banished', label: 'Banished' },
    ...match.battlefields.map((b, i) => ({ v: `bf${i}`, label: getCard(b.cardId)?.name ?? `Battlefield ${i + 1}` })),
  ]

  return (
    <div className="order-last space-y-2 rounded-xl border border-amber-400/40 bg-[#160d1a] p-2.5 xl:order-first xl:w-[300px] xl:shrink-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-amber-100">🛠 Manual override</span>
      </div>
      <div className="rounded bg-black/20 px-2 py-1 text-[10px] leading-relaxed text-white/40">
        Click-tips: <b className="text-white/60">Z</b>+click hide · <b className="text-white/60">C</b>+click marker · <b className="text-white/60">Ctrl+C</b>+click clears · <b className="text-white/60">Shift</b>+click recycle rune
      </div>

      {/* Target player */}
      <div className="flex flex-wrap gap-1">
        {match.players.map((pl, i) => (
          <button
            key={i}
            onClick={() => setTarget(i)}
            className={`rounded px-2 py-1 text-xs font-semibold ${target === i ? 'bg-amber-500/40 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
          >
            {i === perspective ? 'You' : bare(pl.name)}
          </button>
        ))}
      </div>

      {/* Score & resources */}
      <div className={SECTION}>
        <div className={LABEL}>Score & resources — {bare(p.name)}</div>
        <div className="flex items-center gap-1">
          <span className="w-14 text-xs text-white/60">Points {p.points}</span>
          <button className={BTN} onClick={() => ov('points', { amount: -1 })}>−1</button>
          <button className={BTN} onClick={() => ov('points', { amount: 1 })}>+1</button>
          <button className={BTN} onClick={() => ov('points', { amount: 5 })}>+5</button>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-14 text-xs text-white/60">XP {p.xp}</span>
          <button className={BTN} onClick={() => ov('xp', { amount: -1 })}>−1</button>
          <button className={BTN} onClick={() => ov('xp', { amount: 1 })}>+1</button>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-14 text-xs text-white/60">Energy {p.pool?.energy ?? 0}</span>
          <button className={BTN} onClick={() => ov('energy', { amount: 1 })}>+1</button>
          <button className={BTN} onClick={() => ov('energy', { amount: -1 })}>−1</button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-14 text-xs text-white/60">+Power</span>
          {DOMAINS.map((d) => (
            <button key={d} title={DOMAIN_META[d].label} className={BTN} onClick={() => ov('power', { domain: d, amount: 1 })}>
              <DomainIcon domain={d} size={14} />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button className={BTN} onClick={() => ov('draw', { amount: 1 })}>Draw 1</button>
          <button className={BTN} onClick={() => ov('draw', { amount: 2 })}>Draw 2</button>
          <button className={BTN} onClick={() => ov('channel', { amount: 1 })}>Channel 1</button>
          <button className={BTN} title="Channel 1 rune entered exhausted" onClick={() => ov('channelExhausted', { amount: 1 })}>Channel 1 (exh)</button>
        </div>
      </div>

      {/* Deck */}
      <div className={SECTION}>
        <div className={LABEL}>Deck ({p.zones.mainDeck.length})</div>
        <div className="flex flex-wrap items-center gap-1">
          <button className={BTN} onClick={() => setBrowse((b) => !b)}>{browse ? 'Hide deck' : 'Browse / tutor'}</button>
          <button className={BTN} onClick={() => ov('shuffle')}>Shuffle</button>
          <button className={BTN} onClick={() => ov('mill', { amount: 1 })}>Mill 1</button>
          <button className={BTN} onClick={() => ov('readyAll')}>Ready all</button>
        </div>
        {browse && (
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {p.zones.mainDeck.map((c, i) => (
              <div key={c.iid} className="flex items-center gap-1 text-[11px] text-white/70">
                <span className="w-5 shrink-0 text-white/30">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{bare(getCard(c.cardId)?.name) || c.cardId}</span>
                <button className={BTN} title="To hand" onClick={() => ov('move', { iid: c.iid, toZone: 'hand' })}>✋</button>
                <button className={BTN} title="To bottom" onClick={() => ov('move', { iid: c.iid, toZone: 'mainDeck', bottom: true })}>⤓</button>
                <button className={BTN} title="Trash" onClick={() => ov('move', { iid: c.iid, toZone: 'trash' })}>🗑</button>
              </div>
            ))}
            {p.zones.mainDeck.length === 0 && <div className="text-white/30">empty</div>}
          </div>
        )}
      </div>

      {/* Retrieve from trash (take back a mis-discard) */}
      {p.zones.trash.length > 0 && (
        <div className={SECTION}>
          <div className={LABEL}>Trash ({p.zones.trash.length}) — click to take back</div>
          <div className="max-h-28 space-y-0.5 overflow-y-auto">
            {p.zones.trash.map((c) => (
              <button
                key={c.iid}
                onClick={() => ov('move', { iid: c.iid, toZone: 'hand' })}
                className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/70 hover:bg-white/10"
              >
                ↩ {bare(getCard(c.cardId)?.name) || c.cardId}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Spawn any card */}
      <div className={SECTION}>
        <div className={LABEL}>Spawn a card</div>
        <div className="flex items-center gap-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search by name…"
            className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-xs outline-none placeholder:text-white/30"
          />
          <select value={zone} onChange={(e) => setZone(e.target.value)} className="rounded bg-black/30 px-1 py-1 text-xs">
            {zoneOpts.map((z) => (
              <option key={z.v} value={z.v}>{z.label}</option>
            ))}
          </select>
        </div>
        {matches.length > 0 && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {matches.map((c) => (
              <button
                key={c.id}
                onClick={() => spawn(c.id)}
                className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/75 hover:bg-amber-500/25"
              >
                + {bare(c.name)} <span className="text-white/30">· {c.type}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Advanced game-state */}
      <div className={SECTION}>
        <button className="flex w-full items-center justify-between" onClick={() => setAdv((a) => !a)}>
          <span className={LABEL}>⚠ Advanced game state</span>
          <span className="text-xs text-white/50">{adv ? '▾' : '▸'}</span>
        </button>
        {adv && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-20 text-xs text-white/60">Active turn</span>
              {match.players.map((pl, i) => (
                <button key={i} className={BTN} onClick={() => ov('setActive', { value: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="w-20 text-xs text-white/60">Phase</span>
              <button className={BTN} onClick={() => ov('setPhase', { phase: 'action' })}>Action</button>
              <button className={BTN} onClick={() => ov('setPhase', { phase: 'showdown' })}>Showdown</button>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-20 text-xs text-white/60">Turn # {match.turn}</span>
              <button className={BTN} onClick={() => ov('setTurn', { value: match.turn - 1 })}>−1</button>
              <button className={BTN} onClick={() => ov('setTurn', { value: match.turn + 1 })}>+1</button>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-20 text-xs text-white/60">Win at {match.pointsToWin}</span>
              <button className={BTN} onClick={() => ov('setPointsToWin', { value: match.pointsToWin - 1 })}>−1</button>
              <button className={BTN} onClick={() => ov('setPointsToWin', { value: match.pointsToWin + 1 })}>+1</button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-20 text-xs text-white/60">Winner</span>
              {match.players.map((pl, i) => (
                <button key={i} className={BTN} onClick={() => ov('setWinner', { value: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
              ))}
              <button className={BTN} onClick={() => ov('setWinner', { value: -1 })}>Clear</button>
            </div>
            <div className="flex flex-wrap gap-1">
              <button className={BTN} onClick={() => ov('clearChain')}>Clear chain</button>
              <button className={BTN} onClick={() => ov('clearShowdown')}>Clear showdown</button>
              <button className={BTN} title="Reset this player's stuck per-turn flags (cards played, equipment played, XP gained, …)" onClick={() => ov('clearTurnState')}>Clear turn counters</button>
              <button className={BTN} title="Re-sync who controls each battlefield" onClick={() => ov('recomputeControllers')}>Recompute control</button>
            </div>
            {/* Bulk zone tools: move a whole zone, or swap a zone with another player. */}
            <div className="space-y-1 border-t border-white/10 pt-2">
              <div className={LABEL}>Zone tools — {bare(p.name)}</div>
              <div className="flex items-center gap-1">
                <select value={bz.from} onChange={(e) => setBz((b) => ({ ...b, from: e.target.value }))} className="rounded bg-black/30 px-1 py-1 text-xs">
                  {ZONES.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
                </select>
                <span className="text-white/40">→</span>
                <select value={bz.to} onChange={(e) => setBz((b) => ({ ...b, to: e.target.value }))} className="rounded bg-black/30 px-1 py-1 text-xs">
                  {ZONES.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
                </select>
                <button className={BTN} onClick={() => ov('bulkMove', { fromZone: bz.from, toZone: bz.to as OverrideZone })}>Move all</button>
              </div>
              {match.players.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-white/60">Swap {ZONES.find((z) => z.v === bz.from)?.label} with</span>
                  {match.players.map((pl, i) => (i === target ? null : (
                    <button key={i} className={BTN} onClick={() => ov('swapZone', { fromZone: bz.from, targetPlayer: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
                  )))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
