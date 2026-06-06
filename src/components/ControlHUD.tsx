import { useEffect, useMemo, useState } from 'react'
import { CARDS, getCard } from '../data/cards'
import { DOMAINS, DOMAIN_META } from '../types/cards'
import type { Action, EngineCard, MatchState, OverrideOp, OverrideZone, PlayerId, Phase } from '../engine/types'
import { DomainIcon } from './CardText'

// The consolidated manual-override HUD (sandbox only). A collapsible LEFT rail
// (the bottom-dock version covered the playable hand area, so it lives on the
// left where the rules text stays readable). Three tabs:
//   ① Selected  — contextual one-tap ops for the card you clicked (stays open so
//                 you can chain ops without re-summoning a menu).
//   ② Player    — score/resources, deck tutor, trash retrieve, spawn-any-card.
//   ③ Game      — advanced game-state + bulk zone tools.
// Right-click / drag / hotkeys are untouched and dispatch through the SAME
// OVERRIDE path, so all input surfaces stay in sync. Every player-level op is
// preserved from the old OverridePanel (full parity — points & spawn included).
// The niche per-card steppers (exact temp-Might, move-X-from-top, equip/gear)
// remain available via the right-click drill-down.

const BTN = 'rounded bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20'
const TAB = 'flex-1 rounded px-2 py-1 text-xs font-bold'
const LABEL = 'text-[10px] font-semibold uppercase tracking-wide text-fuchsia-200/70'
const SECTION = 'rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/5 p-2 space-y-1.5'
const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')

type OvExtra = Partial<{
  amount: number
  domain: string
  cardId: string
  value: number
  phase: Phase
  toZone: OverrideZone
  toBattlefield: number
  iid: string
  fromZone: string
  targetPlayer: number
  flag: string
  bottom: boolean
}>

type Located = {
  ci: EngineCard
  owner: PlayerId
  zone: 'base' | 'runePool' | 'hand' | 'battlefield' | 'legend' | 'champion'
  bfIndex?: number
}

function locate(match: MatchState, iid: string): Located | null {
  for (const p of match.players) {
    for (const z of ['base', 'runePool', 'hand'] as const) {
      const ci = p.zones[z].find((c) => c.iid === iid)
      if (ci) return { ci, owner: ci.owner, zone: z }
    }
    if (p.legend?.iid === iid) return { ci: p.legend, owner: p.legend.owner, zone: 'legend' }
    if (p.champion?.iid === iid) return { ci: p.champion, owner: p.champion.owner, zone: 'champion' }
  }
  for (let bi = 0; bi < match.battlefields.length; bi++) {
    const bf = match.battlefields[bi]
    const ci = bf.units.find((c) => c.iid === iid)
    if (ci) return { ci, owner: ci.owner, zone: 'battlefield', bfIndex: bi }
    if (bf.facedown?.iid === iid) return { ci: bf.facedown, owner: bf.facedown.owner, zone: 'battlefield', bfIndex: bi }
  }
  return null
}

export default function ControlHUD({
  match,
  perspective,
  onAct,
  selectedIid,
  onClearSelected,
  open,
  onOpenChange,
}: {
  match: MatchState
  perspective: PlayerId
  onAct: (a: Action) => void
  selectedIid: string | null
  onClearSelected: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tab, setTab] = useState<'selected' | 'player' | 'game'>('player')
  const [target, setTarget] = useState<PlayerId>(perspective)
  const [query, setQuery] = useState('')
  const [spawnZone, setSpawnZone] = useState<string>('hand')
  const [browse, setBrowse] = useState(false)
  const [bz, setBz] = useState<{ from: string; to: string }>({ from: 'hand', to: 'mainDeck' })

  const sel = selectedIid ? locate(match, selectedIid) : null
  // Auto-focus the Selected tab whenever a new card is picked.
  useEffect(() => {
    if (selectedIid && sel) {
      setTab('selected')
      if (!open) onOpenChange(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIid])

  const p = match.players[target] ?? match.players[perspective]

  // Player-scoped OVERRIDE (Player + Game tabs target the selected player).
  const pov = (op: OverrideOp, extra: OvExtra = {}) =>
    onAct({ type: 'OVERRIDE', player: target, op, ...extra } as Action)

  const ZONES: { v: string; label: string }[] = [
    { v: 'hand', label: 'Hand' },
    { v: 'base', label: 'Base' },
    { v: 'mainDeck', label: 'Deck' },
    { v: 'runeDeck', label: 'Rune deck' },
    { v: 'runePool', label: 'Rune pool' },
    { v: 'trash', label: 'Trash' },
  ]
  const spawnZoneOpts: { v: string; label: string }[] = [
    { v: 'hand', label: 'Hand' },
    { v: 'base', label: 'Base' },
    { v: 'mainDeck', label: 'Deck (top)' },
    { v: 'runePool', label: 'Rune pool' },
    { v: 'trash', label: 'Trash' },
    { v: 'banished', label: 'Banished' },
    ...match.battlefields.map((b, i) => ({ v: `bf${i}`, label: getCard(b.cardId)?.name ?? `Battlefield ${i + 1}` })),
  ]
  const spawn = (cardId: string) => {
    if (spawnZone.startsWith('bf')) pov('spawn', { cardId, toBattlefield: parseInt(spawnZone.slice(2), 10) })
    else pov('spawn', { cardId, toZone: spawnZone as OverrideZone })
  }
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return CARDS.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 14)
  }, [query])

  return (
    <div className="order-last w-full shrink-0 space-y-2 rounded-xl border-2 border-fuchsia-400/40 bg-[#160d1a] p-2 xl:order-first xl:w-[300px]">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-fuchsia-100">🛠 Manual override</span>
        {sel && !open && <span className="truncate text-[11px] text-white/55">{bare(getCard(sel.ci.cardId)?.name)}</span>}
        <button onClick={() => onOpenChange(!open)} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-xs font-semibold hover:bg-white/20">
          {open ? '▾ Hide' : '▸ Show'}
        </button>
      </div>

      {open && (
        <>
          {/* Tab strip */}
          <div className="flex gap-1">
            <button onClick={() => setTab('selected')} className={`${TAB} ${tab === 'selected' ? 'bg-fuchsia-500/30 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>① Selected</button>
            <button onClick={() => setTab('player')} className={`${TAB} ${tab === 'player' ? 'bg-fuchsia-500/30 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>② Player</button>
            <button onClick={() => setTab('game')} className={`${TAB} ${tab === 'game' ? 'bg-fuchsia-500/30 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>③ Game</button>
          </div>
          <div className="rounded bg-black/20 px-2 py-1 text-[10px] leading-relaxed text-white/40">
            right-click a card = full menu · <b className="text-white/60">Z</b>+click hide · <b className="text-white/60">C</b>+click marker · <b className="text-white/60">Shift</b>+click recycle rune
          </div>

          <div className="max-h-[62vh] overflow-y-auto pr-0.5">
        {tab === 'selected' && <SelectedTab match={match} perspective={perspective} sel={sel} onAct={onAct} onClearSelected={onClearSelected} />}

        {tab === 'player' && (
          <div className="space-y-2">
            {/* Target player */}
            <div className={SECTION}>
              <div className={LABEL}>Target player</div>
              <div className="flex flex-wrap gap-1">
                {match.players.map((pl, i) => (
                  <button key={i} onClick={() => setTarget(i)} className={`rounded px-2 py-1 text-xs font-semibold ${target === i ? 'bg-fuchsia-500/40 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}>
                    {i === perspective ? 'You' : bare(pl.name)}
                  </button>
                ))}
              </div>
              <div className={LABEL}>Score &amp; resources — {bare(p.name)}</div>
              <div className="flex items-center gap-1">
                <span className="w-16 text-xs text-white/60">Points {p.points}</span>
                <button className={BTN} onClick={() => pov('points', { amount: -1 })}>−1</button>
                <button className={BTN} onClick={() => pov('points', { amount: 1 })}>+1</button>
                <button className={BTN} onClick={() => pov('points', { amount: 5 })}>+5</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-16 text-xs text-white/60">XP {p.xp}</span>
                <button className={BTN} onClick={() => pov('xp', { amount: -1 })}>−1</button>
                <button className={BTN} onClick={() => pov('xp', { amount: 1 })}>+1</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-16 text-xs text-white/60">Energy {p.pool?.energy ?? 0}</span>
                <button className={BTN} onClick={() => pov('energy', { amount: 1 })}>+1</button>
                <button className={BTN} onClick={() => pov('energy', { amount: -1 })}>−1</button>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-16 text-xs text-white/60">+Power</span>
                {DOMAINS.map((d) => (
                  <button key={d} title={DOMAIN_META[d].label} className={BTN} onClick={() => pov('power', { domain: d, amount: 1 })}>
                    <DomainIcon domain={d} size={14} />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button className={BTN} onClick={() => pov('draw', { amount: 1 })}>Draw 1</button>
                <button className={BTN} onClick={() => pov('draw', { amount: 2 })}>Draw 2</button>
                <button className={BTN} onClick={() => pov('channel', { amount: 1 })}>Channel 1</button>
                <button className={BTN} title="Channel 1 rune entered exhausted" onClick={() => pov('channelExhausted', { amount: 1 })}>Channel 1 (exh)</button>
              </div>
            </div>

            {/* Deck + trash retrieve */}
            <div className={SECTION}>
              <div className={LABEL}>Deck ({p.zones.mainDeck.length})</div>
              <div className="flex flex-wrap items-center gap-1">
                <button className={BTN} onClick={() => setBrowse((b) => !b)}>{browse ? 'Hide deck' : 'Browse / tutor'}</button>
                <button className={BTN} onClick={() => pov('shuffle')}>Shuffle</button>
                <button className={BTN} onClick={() => pov('mill', { amount: 1 })}>Mill 1</button>
                <button className={BTN} onClick={() => pov('readyAll')}>Ready all</button>
              </div>
              {browse && (
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {p.zones.mainDeck.map((c, i) => (
                    <div key={c.iid} className="flex items-center gap-1 text-[11px] text-white/70">
                      <span className="w-5 shrink-0 text-white/30">{i + 1}.</span>
                      <span className="min-w-0 flex-1 truncate">{bare(getCard(c.cardId)?.name) || c.cardId}</span>
                      <button className={BTN} title="To hand" onClick={() => pov('move', { iid: c.iid, toZone: 'hand' })}>✋</button>
                      <button className={BTN} title="To bottom" onClick={() => pov('move', { iid: c.iid, toZone: 'mainDeck', bottom: true })}>⤓</button>
                      <button className={BTN} title="Trash" onClick={() => pov('move', { iid: c.iid, toZone: 'trash' })}>🗑</button>
                    </div>
                  ))}
                  {p.zones.mainDeck.length === 0 && <div className="text-white/30">empty</div>}
                </div>
              )}
              {p.zones.trash.length > 0 && (
                <>
                  <div className={LABEL}>Trash ({p.zones.trash.length}) — click to take back</div>
                  <div className="max-h-24 space-y-0.5 overflow-y-auto">
                    {p.zones.trash.map((c) => (
                      <button key={c.iid} onClick={() => pov('move', { iid: c.iid, toZone: 'hand' })} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/70 hover:bg-white/10">
                        ↩ {bare(getCard(c.cardId)?.name) || c.cardId}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Spawn */}
            <div className={SECTION}>
              <div className={LABEL}>Spawn a card → {bare(p.name)}</div>
              <div className="flex items-center gap-1">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search by name…" className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-xs outline-none placeholder:text-white/30" />
                <select value={spawnZone} onChange={(e) => setSpawnZone(e.target.value)} className="rounded bg-black/30 px-1 py-1 text-xs">
                  {spawnZoneOpts.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
                </select>
              </div>
              {matches.length > 0 && (
                <div className="max-h-40 space-y-0.5 overflow-y-auto">
                  {matches.map((c) => (
                    <button key={c.id} onClick={() => spawn(c.id)} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-white/75 hover:bg-fuchsia-500/25">
                      + {bare(c.name)} <span className="text-white/30">· {c.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'game' && (
          <div className="space-y-2">
            <div className={SECTION}>
              <div className={LABEL}>⚠ Advanced game state</div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-20 text-xs text-white/60">Active turn</span>
                {match.players.map((pl, i) => (
                  <button key={i} className={BTN} onClick={() => pov('setActive', { value: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <span className="w-20 text-xs text-white/60">Phase</span>
                <button className={BTN} onClick={() => pov('setPhase', { phase: 'action' as Phase })}>Action</button>
                <button className={BTN} onClick={() => pov('setPhase', { phase: 'showdown' as Phase })}>Showdown</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-20 text-xs text-white/60">Turn # {match.turn}</span>
                <button className={BTN} onClick={() => pov('setTurn', { value: match.turn - 1 })}>−1</button>
                <button className={BTN} onClick={() => pov('setTurn', { value: match.turn + 1 })}>+1</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-20 text-xs text-white/60">Win at {match.pointsToWin}</span>
                <button className={BTN} onClick={() => pov('setPointsToWin', { value: match.pointsToWin - 1 })}>−1</button>
                <button className={BTN} onClick={() => pov('setPointsToWin', { value: match.pointsToWin + 1 })}>+1</button>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-20 text-xs text-white/60">Winner</span>
                {match.players.map((pl, i) => (
                  <button key={i} className={BTN} onClick={() => pov('setWinner', { value: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
                ))}
                <button className={BTN} onClick={() => pov('setWinner', { value: -1 })}>Clear</button>
              </div>
              <div className="flex flex-wrap gap-1">
                <button className={BTN} onClick={() => pov('clearChain')}>Clear chain</button>
                <button className={BTN} onClick={() => pov('clearShowdown')}>Clear showdown</button>
                <button className={BTN} title="Reset this player's stuck per-turn flags" onClick={() => pov('clearTurnState')}>Clear turn counters</button>
                <button className={BTN} title="Re-sync who controls each battlefield" onClick={() => pov('recomputeControllers')}>Recompute control</button>
              </div>
            </div>

            <div className={SECTION}>
              <div className={LABEL}>Zone tools — {bare(p.name)}</div>
              <div className="flex flex-wrap items-center gap-1">
                <select value={bz.from} onChange={(e) => setBz((b) => ({ ...b, from: e.target.value }))} className="rounded bg-black/30 px-1 py-1 text-xs">
                  {ZONES.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
                </select>
                <span className="text-white/40">→</span>
                <select value={bz.to} onChange={(e) => setBz((b) => ({ ...b, to: e.target.value }))} className="rounded bg-black/30 px-1 py-1 text-xs">
                  {ZONES.map((z) => <option key={z.v} value={z.v}>{z.label}</option>)}
                </select>
                <button className={BTN} onClick={() => pov('bulkMove', { fromZone: bz.from, toZone: bz.to as OverrideZone })}>Move all</button>
              </div>
              {match.players.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-white/60">Swap {ZONES.find((z) => z.v === bz.from)?.label} with</span>
                  {match.players.map((pl, i) => (i === target ? null : (
                    <button key={i} className={BTN} onClick={() => pov('swapZone', { fromZone: bz.from, targetPlayer: i })}>{i === perspective ? 'You' : bare(pl.name)}</button>
                  )))}
                </div>
              )}
            </div>
          </div>
        )}
          </div>
        </>
      )}
    </div>
  )
}

// ---- Selected (contextual) tab -------------------------------------------
function SelectedTab({
  match,
  perspective,
  sel,
  onAct,
  onClearSelected,
}: {
  match: MatchState
  perspective: PlayerId
  sel: Located | null
  onAct: (a: Action) => void
  onClearSelected: () => void
}) {
  if (!sel) {
    return (
      <div className="py-6 text-center text-sm text-white/40">
        Click any card on the board to manage it here — then fire ops without re-opening a menu.
      </div>
    )
  }
  const { ci, owner, zone, bfIndex } = sel
  const card = getCard(ci.cardId)
  const cc = ci as EngineCard & {
    stunned?: boolean
    grantGanking?: boolean
    temporary?: boolean
    deathShield?: boolean
    banishShield?: boolean
    token?: boolean
    grantAssault?: number
    facedown?: boolean
  }
  const ov = (op: OverrideOp, extra: OvExtra = {}) =>
    onAct({ type: 'OVERRIDE', player: owner, op, iid: ci.iid, ...extra } as Action)
  const mv = (toZone: OverrideZone | undefined, toBattlefield: number | undefined, bottom?: boolean) =>
    onAct({ type: 'OVERRIDE', player: owner, op: 'move', iid: ci.iid, toZone, toBattlefield, bottom } as Action)
  const mark = (on?: boolean) => (on ? '✓ ' : '○ ')
  const isUnit = card?.type === 'unit'
  const isRune = card?.type === 'rune'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-fuchsia-100">{bare(card?.name) || ci.cardId}</span>
        <span className="text-[10px] uppercase tracking-wide text-white/40">{card?.type} · {zone}{bfIndex != null ? ` ${bfIndex + 1}` : ''} · {owner === perspective ? 'you' : bare(match.players[owner]?.name)}</span>
        <button onClick={onClearSelected} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-[11px] hover:bg-white/20">Clear ✕</button>
      </div>

      <div className="space-y-2">
        {isUnit && (
          <div className={SECTION}>
            <div className={LABEL}>State</div>
            <div className="flex flex-wrap gap-1">
              <button className={BTN} onClick={() => ov(cc.stunned ? 'unstun' : 'stun')}>{mark(cc.stunned)}Stun</button>
              <button className={BTN} onClick={() => ov(ci.exhausted ? 'ready' : 'exhaust')}>{mark(ci.exhausted)}Exhaust</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'facedown' })}>{mark(cc.facedown)}Facedown</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'ganking' })}>{mark(cc.grantGanking)}[Ganking]</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'temporary' })}>{mark(cc.temporary)}[Temporary]</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'deathShield' })}>{mark(cc.deathShield)}Death shield</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'banishShield' })}>{mark(cc.banishShield)}Banish shield</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'token' })}>{mark(cc.token)}Token</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'sickness' })}>Clear sickness</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'cantmove' })}>Clear can't-move</button>
              <button className={BTN} onClick={() => ov('triggerEnterPlay')}>⚡ Re-fire enter</button>
              <button className={BTN} onClick={() => ov('marker')}>◍ Marker</button>
              <button className={BTN} onClick={() => ov('marker', { value: -1 })}>○ Clear</button>
              {zone === 'battlefield' && <button className={BTN} onClick={() => ov('toBase')}>↩ Recall to base</button>}
            </div>
          </div>
        )}

        {isUnit && (
          <div className={SECTION}>
            <div className={LABEL}>Might &amp; damage</div>
            <div className="flex flex-wrap gap-1">
              <button className={BTN} onClick={() => ov('mightUp')}>Might +1</button>
              <button className={BTN} onClick={() => ov('mightUp', { amount: 5 })}>+5</button>
              <button className={BTN} onClick={() => ov('mightDown')}>Might −1</button>
              <button className={BTN} onClick={() => ov('buff')}>Buff +1 ({(cc as { buffs?: number }).buffs ?? 0})</button>
              <button className={BTN} onClick={() => ov('unbuff')}>Buff −1</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'assault', amount: 1 })}>[Assault] +1 ({cc.grantAssault ?? 0})</button>
              <button className={BTN} onClick={() => ov('grant', { flag: 'assault', amount: -1 })}>[Assault] −1</button>
            </div>
            <div className="flex flex-wrap gap-1">
              <button className={BTN} onClick={() => ov('damage', { amount: 1 })}>Dmg +1</button>
              <button className={BTN} onClick={() => ov('damage', { amount: -1 })}>Dmg −1</button>
              <button className={BTN} onClick={() => ov('setDamage', { value: 0 })}>Set 0</button>
              <button className={BTN} onClick={() => ov('setDamage', { value: 2 })}>2</button>
              <button className={BTN} onClick={() => ov('setDamage', { value: 4 })}>4</button>
              <button className={BTN} onClick={() => ov('setDamage', { value: 6 })}>6</button>
            </div>
          </div>
        )}

        {isRune && (
          <div className={SECTION}>
            <div className={LABEL}>Rune</div>
            <div className="flex flex-wrap gap-1">
              <button className={BTN} onClick={() => ov(ci.exhausted ? 'ready' : 'exhaust')}>{mark(ci.exhausted)}Exhaust</button>
              <button className={BTN} onClick={() => onAct({ type: 'RECYCLE_RUNE', player: owner, iid: ci.iid } as Action)}>♺ Recycle</button>
              <button className={BTN} onClick={() => ov('marker')}>◍ Marker</button>
              <button className={BTN} onClick={() => ov('marker', { value: -1 })}>○ Clear</button>
            </div>
          </div>
        )}

        {/* Control battlefield (units on a battlefield). */}
        {isUnit && zone === 'battlefield' && bfIndex != null && (
          <div className={SECTION}>
            <div className={LABEL}>Control battlefield {bfIndex + 1}</div>
            <div className="flex flex-wrap gap-1">
              {match.players.map((pl, i) => (
                <button key={i} className={BTN} onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'setController', toBattlefield: bfIndex, value: i } as Action)}>
                  → {i === perspective ? 'You' : bare(pl.name)}
                </button>
              ))}
              <button className={BTN} onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'setController', toBattlefield: bfIndex, value: -1 } as Action)}>Uncontrolled</button>
            </div>
          </div>
        )}

        {/* Move to … */}
        <div className={SECTION}>
          <div className={LABEL}>Move to</div>
          <div className="flex flex-wrap gap-1">
            {zone !== 'hand' && <button className={BTN} onClick={() => mv('hand', undefined)}>Hand</button>}
            {zone !== 'base' && <button className={BTN} onClick={() => mv('base', undefined)}>Base</button>}
            {match.battlefields.map((_, i) =>
              zone === 'battlefield' && i === bfIndex ? null : (
                <button key={i} className={BTN} onClick={() => mv(undefined, i)}>BF {i + 1}</button>
              ),
            )}
            <button className={BTN} onClick={() => mv('mainDeck', undefined)}>Deck top</button>
            <button className={BTN} onClick={() => mv('mainDeck', undefined, true)}>Deck bottom</button>
            <button className={BTN} onClick={() => mv('trash', undefined)}>Trash</button>
            <button className={BTN} onClick={() => mv('banished', undefined)}>Banished</button>
          </div>
        </div>

        {/* Remove + owner quick ops. */}
        <div className={SECTION}>
          <div className={LABEL}>Remove &amp; owner</div>
          <div className="flex flex-wrap gap-1">
            <button className={BTN} onClick={() => ov('kill')}>Kill</button>
            <button className={BTN} onClick={() => ov('sacrifice')}>Sacrifice</button>
            <button className={BTN} onClick={() => ov('banish')}>Banish</button>
            <button className={BTN} onClick={() => ov('trash')}>Trash</button>
          </div>
          <div className="flex flex-wrap gap-1">
            <button className={BTN} onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'draw' } as Action)}>Owner draw 1</button>
            <button className={BTN} onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'channel' } as Action)}>Channel 1</button>
            <button className={BTN} onClick={() => onAct({ type: 'OVERRIDE', player: owner, op: 'readyAll' } as Action)}>Ready all</button>
          </div>
        </div>
      </div>
    </div>
  )
}
