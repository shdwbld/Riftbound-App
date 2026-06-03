import { useState } from 'react'
import { getCard } from '../data/cards'
import type { MatchState, Action, PlayerId } from '../engine/types'
import CardDetailModal from './CardDetailModal'

// Pre-game setup (Core Rules §111–120): roll for turn order → the winner chooses
// the First Player → each player picks their Chosen Champion (when a variant
// choice exists) and their Battlefield. Hotseat: one screen drives all players.

/** Fair d20 per player, re-rolled until there's a unique highest roller. */
function rollTurnOrder(n: number): number[] {
  for (let tries = 0; tries < 50; tries++) {
    const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 20))
    const max = Math.max(...rolls)
    if (rolls.filter((r) => r === max).length === 1) return rolls
  }
  return Array.from({ length: n }, (_, i) => i + 1) // fallback (deterministic)
}

function artLabel(name: string): string | null {
  const m = name.match(/\(([^)]+)\)\s*$/)
  return m ? m[1] : null
}

function BigCard({ cardId, onClick, onInspect, selected }: { cardId: string; onClick: () => void; onInspect: () => void; selected?: boolean }) {
  const card = getCard(cardId)
  const art = card ? artLabel(card.name) : null
  return (
    <div className="group flex w-40 flex-col items-center gap-2">
      <button
        onClick={onClick}
        className={`relative w-40 overflow-hidden rounded-xl border-2 transition hover:-translate-y-1 hover:border-amber-300 hover:shadow-[0_0_24px_-4px_rgba(252,211,77,0.7)] ${
          selected ? 'border-amber-300 shadow-[0_0_24px_-4px_rgba(252,211,77,0.8)]' : 'border-white/15'
        }`}
        style={{ aspectRatio: '744/1039' }}
      >
        {card?.imageUrl ? (
          <img src={card.imageUrl} alt={card.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[#1c1c28] p-2 text-center text-sm">{card?.name ?? cardId}</div>
        )}
      </button>
      <div className="text-center text-sm font-semibold">
        {card ? card.name.replace(/\s*\([^)]*\)\s*$/, '') : cardId}
        <span className="ml-1 rounded bg-white/10 px-1 text-[9px] font-normal uppercase tracking-wide text-white/55">
          {art ?? card?.set ?? 'art'}
        </span>
      </div>
      <div className="flex gap-2">
        <button onClick={onClick} className="rounded-lg bg-indigo-500 px-3 py-1 text-xs font-semibold hover:bg-indigo-400">
          Choose
        </button>
        <button onClick={onInspect} className="rounded-lg bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
          View
        </button>
      </div>
    </div>
  )
}

export default function SetupScreen({
  match,
  onAct,
  seat,
}: {
  match: MatchState
  onAct: (a: Action) => void
  /** Local player's seat (online). Omit for hotseat (one screen drives all). */
  seat?: PlayerId
}) {
  const su = match.setup
  const [inspect, setInspect] = useState<string | null>(null)
  const [tentative, setTentative] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const [anim, setAnim] = useState<number[]>([])
  if (!su) return null
  const doRoll = () => {
    const n = match.players.length
    setRolling(true)
    let ticks = 0
    const id = setInterval(() => {
      setAnim(Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 20)))
      if (++ticks >= 11) {
        clearInterval(id)
        setRolling(false)
        onAct({ type: 'ROLL_TURN_ORDER', player: seat ?? 0, rolls: rollTurnOrder(n) })
      }
    }, 80)
  }
  const names = match.players.map((p) => p.name)
  const Waiting = ({ who }: { who: string }) => <p className="py-6 text-white/50">Waiting for {who}…</p>

  // A small overview of every player's Legend (shown during champion select).
  const LegendsRow = () => (
    <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-white/55">
      {match.players.map((p, i) => {
        const lg = p.legend ? getCard(p.legend.cardId) : null
        return (
          <span key={i} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1">
            {lg?.imageUrl && <img src={lg.imageUrl} alt="" className="h-7 w-5 rounded object-cover" />}
            <span>
              <b className="text-white/80">{names[i]}</b> · {lg?.name ?? 'no legend'}
            </span>
          </span>
        )
      })}
    </div>
  )

  const Frame = ({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) => (
    <div className="mx-auto max-w-3xl space-y-6 py-10 text-center">
      <div>
        <h2 className="text-3xl font-bold tracking-wide">{title}</h2>
        {subtitle && <p className="mt-1 text-white/55">{subtitle}</p>}
      </div>
      {children}
      {inspect && <CardDetailModal card={getCard(inspect)!} onClose={() => setInspect(null)} />}
    </div>
  )

  // --- Roll for turn order --------------------------------------------------
  if (su.step === 'roll') {
    return (
      <Frame title="🎲 Roll for turn order" subtitle="Highest roll chooses who takes the first turn.">
        {su.rolls ? (
          <div className="flex flex-wrap justify-center gap-4">
            {su.rolls.map((r, i) => (
              <div key={i} className="rounded-xl border border-white/15 bg-white/5 px-6 py-4">
                <div className="text-sm text-white/60">{names[i]}</div>
                <div className="text-4xl font-bold">{r}</div>
              </div>
            ))}
          </div>
        ) : rolling ? (
          <div className="flex flex-wrap justify-center gap-4">
            {anim.map((r, i) => (
              <div key={i} className="fx-roll rounded-xl border border-amber-300/50 bg-amber-500/10 px-6 py-4">
                <div className="text-sm text-white/60">{names[i]}</div>
                <div className="text-4xl font-bold text-amber-100">🎲 {r}</div>
              </div>
            ))}
          </div>
        ) : seat != null && seat !== 0 ? (
          <Waiting who={`${names[0]} to roll`} />
        ) : (
          <button onClick={doRoll} className="rounded-xl bg-indigo-500 px-8 py-4 text-lg font-bold hover:bg-indigo-400">
            🎲 Roll
          </button>
        )}
      </Frame>
    )
  }

  // --- Winner chooses the first player --------------------------------------
  if (su.step === 'first' && su.winner != null) {
    const w = su.winner
    if (seat != null && seat !== w)
      return <Frame title={`${names[w]} rolled highest`}><Waiting who={`${names[w]} to choose`} /></Frame>
    return (
      <Frame title={`${names[w]} rolled highest`} subtitle="Choose who takes the first turn.">
        <div className="flex flex-wrap justify-center gap-3">
          {match.players.map((p, i) => (
            <button
              key={i}
              onClick={() => onAct({ type: 'CHOOSE_FIRST', player: w, firstPlayer: i })}
              className={`rounded-xl border-2 px-6 py-4 font-semibold transition ${
                i === w ? 'border-emerald-400/60 bg-emerald-500/15 hover:bg-emerald-500/25' : 'border-white/15 bg-white/5 hover:bg-white/10'
              }`}
            >
              {i === w ? 'I go first' : `${p.name} goes first`}
              <div className="mt-1 text-[11px] font-normal text-white/45">
                {match.players.length === 2 && i !== w ? '(you channel +1 rune on turn 1)' : ''}
              </div>
            </button>
          ))}
        </div>
      </Frame>
    )
  }

  // --- Champion selection ---------------------------------------------------
  if (su.step === 'champion') {
    const i = su.championOptions.findIndex((o, idx) => o.length > 1 && su.championPick[idx] == null)
    if (i >= 0) {
      if (seat != null && seat !== i)
        return <Frame title="Choose your Champion"><Waiting who={`${names[i]} to pick a Champion`} /></Frame>
      const pick = tentative ?? su.championOptions[i][0]
      return (
        <Frame title="Choose your Champion" subtitle={`${names[i]} — choose your Chosen Champion (set aside in the Champion Zone) from your deck.`}>
          <LegendsRow />
          <div className="flex flex-wrap justify-center gap-6">
            {su.championOptions[i].map((cid) => (
              <BigCard key={cid} cardId={cid} selected={pick === cid} onClick={() => setTentative(cid)} onInspect={() => setInspect(cid)} />
            ))}
          </div>
          <button
            onClick={() => { setTentative(null); onAct({ type: 'CHOOSE_CHAMPION', player: i, cardId: pick }) }}
            className="rounded-xl bg-indigo-500 px-8 py-3 text-base font-bold hover:bg-indigo-400"
          >
            Confirm Champion ▶
          </button>
        </Frame>
      )
    }
  }

  // --- Battlefield selection ------------------------------------------------
  if (su.step === 'battlefield') {
    const i = su.battlefieldOptions.findIndex((o, idx) => o.length > 1 && su.battlefieldPick[idx] == null)
    if (i >= 0) {
      if (seat != null && seat !== i)
        return <Frame title="Choose your Battlefield"><Waiting who={`${names[i]} to pick a Battlefield`} /></Frame>
      const pick = tentative ?? su.battlefieldOptions[i][0]
      return (
        <Frame title="Choose your Battlefield" subtitle={`${names[i]} — pick the battlefield you bring to the row.`}>
          <div className="flex flex-wrap justify-center gap-6">
            {su.battlefieldOptions[i].map((cid) => (
              <BigCard key={cid} cardId={cid} selected={pick === cid} onClick={() => setTentative(cid)} onInspect={() => setInspect(cid)} />
            ))}
          </div>
          <button
            onClick={() => { setTentative(null); onAct({ type: 'CHOOSE_BATTLEFIELD', player: i, cardId: pick }) }}
            className="rounded-xl bg-indigo-500 px-8 py-3 text-base font-bold hover:bg-indigo-400"
          >
            Confirm Battlefield ▶
          </button>
        </Frame>
      )
    }
  }

  return <Frame title="Setting up…" />
}
