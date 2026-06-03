import { useMemo, useState } from 'react'
import { getCard } from '../data/cards'
import type { MatchState, DamageAssignStep } from '../engine/types'
import { autoAllocate, validateAllocation } from '../engine/engine'
import BoardCard from './BoardCard'

// Manual combat-damage assignment (Riftbound: the dealing player assigns, Tank
// first, lethal-before-next). Opens when a showdown pauses for this seat. The
// player taps +/− to place damage, or hits Auto-distribute, then Confirms.

export default function DamageAssignModal({
  match,
  step,
  onConfirm,
}: {
  match: MatchState
  step: DamageAssignStep
  onConfirm: (allocations: Record<string, number>) => void
}) {
  const bf = match.battlefields[match.showdown!.battlefield]
  const unitOf = (iid: string) => bf.units.find((u) => u.iid === iid)
  const totalHp = Object.values(step.hp).reduce((a, b) => a + b, 0)
  const mustAssign = Math.min(step.amount, totalHp)

  const [alloc, setAlloc] = useState<Record<string, number>>(() => autoAllocate(step))
  const sum = Object.values(alloc).reduce((a, b) => a + (b ?? 0), 0)
  const remaining = mustAssign - sum
  const err = useMemo(() => validateAllocation(step, alloc), [step, alloc])

  const bump = (iid: string, d: number) =>
    setAlloc((a) => {
      const next = Math.max(0, Math.min(step.hp[iid], (a[iid] ?? 0) + d))
      return { ...a, [iid]: next }
    })

  const dealerName = match.players[step.dealer].name
  const sideLabel = step.side === 'defenders' ? 'the defending units' : 'the attacking units'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div
        className="flex flex-col gap-4 overflow-hidden rounded-2xl border border-rose-500/40 bg-[#140d12] p-5 shadow-2xl"
        style={{ width: '75vw', maxWidth: 880, maxHeight: '85vh' }}
      >
        <div>
          <h3 className="text-2xl font-bold text-rose-100">⚔ Assign combat damage</h3>
          <p className="text-sm text-white/55">
            <b className="text-rose-200">{dealerName}</b> deals <b className="font-mono text-rose-200">{step.amount}</b>{' '}
            damage to {sideLabel}. Assign lethal to a unit before moving on; Tanks first.
          </p>
        </div>

        {/* remaining indicator */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-xl border px-4 py-2 font-mono text-lg font-bold ${
              remaining === 0 && !err
                ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-400/50 bg-amber-500/10 text-amber-200'
            }`}
          >
            {remaining > 0 ? `${remaining} damage left to place` : remaining < 0 ? `${-remaining} over` : 'All damage placed'}
          </span>
          {err && <span className="text-xs text-rose-300">{err}</span>}
        </div>

        {/* target units */}
        <div className="flex min-h-0 flex-1 flex-wrap gap-4 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-4">
          {step.targets.map((iid) => {
            const u = unitOf(iid)
            const def = getCard(u?.cardId ?? '')
            const placed = alloc[iid] ?? 0
            const hp = step.hp[iid]
            const lethal = placed >= hp
            const isTank = step.tanks.includes(iid)
            return (
              <div key={iid} className="flex w-28 flex-col items-center gap-1">
                <div className={`relative rounded-lg ${lethal ? 'ring-2 ring-rose-500' : ''}`}>
                  {u && <BoardCard ci={u} />}
                  {isTank && (
                    <span className="absolute -left-1 -top-1 rounded bg-sky-600 px-1 text-[8px] font-bold text-white">TANK</span>
                  )}
                  {lethal && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-rose-900/60 text-xs font-bold text-rose-100">
                      ☠ defeated
                    </span>
                  )}
                </div>
                <div className="text-center text-[11px] text-white/70">{def?.name ?? iid}</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => bump(iid, -1)}
                    className="h-6 w-6 rounded bg-white/10 text-sm font-bold hover:bg-white/20"
                  >
                    −
                  </button>
                  <span className="w-12 text-center font-mono text-sm">
                    {placed}
                    <span className="text-white/40">/{hp}</span>
                  </span>
                  <button
                    onClick={() => bump(iid, 1)}
                    className="h-6 w-6 rounded bg-white/10 text-sm font-bold hover:bg-white/20"
                  >
                    +
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setAlloc(autoAllocate(step))}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
          >
            ✨ Auto-distribute
          </button>
          <button
            onClick={() => !err && onConfirm(alloc)}
            disabled={!!err}
            className="rounded-lg bg-rose-500 px-6 py-2 text-sm font-semibold hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm damage ⚔
          </button>
        </div>
      </div>
    </div>
  )
}
