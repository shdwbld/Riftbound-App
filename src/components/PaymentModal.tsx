import { useMemo, useState } from 'react'
import { getCard } from '../data/cards'
import { DOMAIN_META, type Card, type Domain } from '../types/cards'
import type { PlayerState, Payment, ResolvedCost } from '../engine/types'
import { autoPay } from '../engine/autopay'
import { DomainIcon } from './CardText'

// Rune-payment overlay (~75% of the screen). Opens every time a play spends
// runes. Pick which ready runes to EXHAUST (energy) and which to RECYCLE — i.e.
// put back to the rune pile — for Power. Pool resources are spent automatically
// first (they can't be split meaningfully); the player covers the remainder.

// A rune can be exhausted for Energy, recycled for Power, or BOTH — one rune may
// pay both (e.g. a single Calm rune covers Defy's 1 Energy + 1 Calm).
type Role = 'energy' | 'power' | 'both'
const hasEnergy = (r: Role | undefined) => r === 'energy' || r === 'both'
const hasPower = (r: Role | undefined) => r === 'power' || r === 'both'

function runeDomains(ci: { cardId: string }): Domain[] {
  const d = getCard(ci.cardId)
  return d?.type === 'rune' ? d.produces : []
}

export default function PaymentModal({
  player,
  card,
  cost,
  onConfirm,
  onCancel,
  reserved,
  confirmLabel = 'Pay & play ▶',
}: {
  player: PlayerState
  card: Card
  cost: ResolvedCost
  onConfirm: (payment: Payment) => void
  onCancel: () => void
  /** Rune iids already committed to a prior payment (e.g. a spell's base cost
   *  before its Deflect surcharge) — excluded from this picker. */
  reserved?: string[]
  /** Confirm-button label (e.g. "Pay & equip ▶" for the [Equip] flow). */
  confirmLabel?: string
}) {
  const pool = player.pool ?? { energy: 0, power: {} }
  const reservedSet = useMemo(() => new Set(reserved ?? []), [reserved])
  const available = useMemo(
    () => player.zones.runePool.filter((r) => !reservedSet.has(r.iid)),
    [player, reservedSet],
  )
  // Ready runes can be exhausted (Energy) and/or recycled (Power). Already-exhausted
  // runes can STILL be recycled for Power (recycling doesn't require a ready rune) — but
  // never exhausted again for Energy.
  const ready = useMemo(() => available.filter((r) => !r.exhausted), [available])
  const spent = useMemo(() => available.filter((r) => r.exhausted), [available])
  // A player view limited to the still-available runes, for seeding auto-pay.
  const seedPlayer = useMemo(
    () => ({ ...player, zones: { ...player.zones, runePool: available } }),
    [player, available],
  )

  // Pool resources auto-applied before runes.
  const poolEnergy = Math.min(cost.energy, pool.energy ?? 0)
  const poolPower: Partial<Record<Domain, number>> = {}
  for (const [d, n] of Object.entries(cost.power) as [Domain, number][]) {
    const fromPool = Math.min(n ?? 0, pool.power[d] ?? 0)
    if (fromPool > 0) poolPower[d] = fromPool
  }
  const needEnergy = Math.max(0, cost.energy - poolEnergy)
  const needPower: Partial<Record<Domain, number>> = {}
  for (const [d, n] of Object.entries(cost.power) as [Domain, number][]) {
    const rem = (n ?? 0) - (poolPower[d] ?? 0)
    if (rem > 0) needPower[d] = rem
  }
  const totalNeedPower = Object.values(needPower).reduce((a, b) => a + (b ?? 0), 0)

  // What you HAVE to spend: Energy = ready runes + pool energy; Power = any rune you
  // can recycle (ready or already-spent) + pool power. Per-domain shows what each rune
  // could produce (a multi-domain rune counts toward each of its domains).
  const energyAvail = ready.length + (pool.energy ?? 0)
  const recyclableRunes = available.length
  const poolPowerTotal = Object.values(pool.power).reduce((a, b) => a + (b ?? 0), 0)
  const powerAvail: Partial<Record<Domain, number>> = {}
  for (const r of available) for (const d of runeDomains(r)) powerAvail[d] = (powerAvail[d] ?? 0) + 1
  for (const [d, nn] of Object.entries(pool.power) as [Domain, number][]) if (nn) powerAvail[d] = (powerAvail[d] ?? 0) + nn

  // Build a seed assignment from auto-pay (a rune may end up doing BOTH).
  const seedFrom = (): Record<string, Role> => {
    const seed: Record<string, Role> = {}
    const auto = autoPay(seedPlayer, cost)
    if (auto) {
      for (const iid of auto.exhaust) seed[iid] = 'energy'
      for (const iid of auto.recycle) seed[iid] = seed[iid] === 'energy' ? 'both' : 'power'
    }
    return seed
  }

  // Seed the selection from auto-pay so the overlay opens pre-filled.
  const [roles, setRoles] = useState<Record<string, Role>>(seedFrom)

  // Tap to cycle. Ready runes: unused → ⚡ energy → ♺ power → ⚡♺ both → unused.
  // Exhausted runes can ONLY be recycled, so they toggle unused ↔ ♺ power.
  const cycle = (iid: string, isSpent = false) =>
    setRoles((r) => {
      const cur = r[iid]
      const next: Record<string, Role> = { ...r }
      if (isSpent) {
        if (cur === 'power') delete next[iid]
        else next[iid] = 'power'
      } else if (cur === undefined) next[iid] = 'energy'
      else if (cur === 'energy') next[iid] = 'power'
      else if (cur === 'power') next[iid] = 'both'
      else delete next[iid]
      return next
    })

  const setAuto = () => setRoles(seedFrom())
  const clearAll = () => setRoles({})

  // Tally the current assignment.
  const energyPicked = Object.values(roles).filter(hasEnergy).length
  const recyclePicked = Object.values(roles).filter(hasPower).length
  // Greedily match each power-assigned rune to a still-needed domain.
  const powerLeft = { ...needPower }
  let powerMatched = 0
  let powerUnmatched = 0
  for (const [iid, role] of Object.entries(roles)) {
    if (!hasPower(role)) continue
    const found = available.find((r) => r.iid === iid)
    if (!found) continue
    const doms = runeDomains(found)
    const d = (Object.keys(powerLeft) as Domain[]).find((dd) => (powerLeft[dd] ?? 0) > 0 && doms.includes(dd))
    if (d) {
      powerLeft[d] = (powerLeft[d] ?? 0) - 1
      powerMatched++
    } else {
      powerUnmatched++
    }
  }
  const energyOk = energyPicked === needEnergy
  const powerOk = powerMatched === totalNeedPower && powerUnmatched === 0
  const valid = energyOk && powerOk

  const confirm = () => {
    if (!valid) return
    const payment: Payment = {
      exhaust: Object.entries(roles).filter(([, v]) => hasEnergy(v)).map(([iid]) => iid),
      recycle: Object.entries(roles).filter(([, v]) => hasPower(v)).map(([iid]) => iid),
    }
    if (poolEnergy > 0) payment.poolEnergy = poolEnergy
    if (Object.keys(poolPower).length > 0) payment.poolPower = poolPower
    onConfirm(payment)
  }

  const renderRune = (r: { iid: string; cardId: string }, isSpent: boolean) => {
    const def = getCard(r.cardId)
    const doms = runeDomains(r)
    const dom = doms[0]
    const color = dom ? DOMAIN_META[dom].color : '#888'
    const role = roles[r.iid]
    return (
      <button
        key={r.iid}
        onClick={() => cycle(r.iid, isSpent)}
        title={isSpent ? `${def?.name ?? 'Rune'} (exhausted — recycle only)` : def?.name}
        className={`relative w-[68px] shrink-0 overflow-hidden rounded-lg border-2 transition ${
          role === 'energy'
            ? 'border-amber-300 shadow-[0_0_16px_-2px_rgba(251,191,36,0.8)]'
            : role === 'power'
              ? 'border-amber-300 shadow-[0_0_16px_-2px_rgba(232,121,249,0.8)]'
              : role === 'both'
                ? 'border-emerald-300 shadow-[0_0_16px_-2px_rgba(52,211,153,0.85)]'
                : 'border-white/15 hover:border-white/45'
        } ${isSpent ? 'rotate-3' : ''}`}
        style={{ aspectRatio: '744/1039' }}
      >
        {def?.imageUrl ? (
          <img src={def.imageUrl} alt={def.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center" style={{ color }}>
            {dom ? <DomainIcon domain={dom} size={34} /> : '◆'}
          </span>
        )}
        {/* dim runes not assigned a role (exhausted ones stay extra-dimmed) */}
        {!role && <span className={`absolute inset-0 ${isSpent ? 'bg-black/60' : 'bg-black/40'}`} />}
        {role && (
          <span
            className={`absolute inset-x-0 bottom-0 py-0.5 text-center text-[10px] font-bold text-white ${
              role === 'energy' ? 'bg-amber-500/90' : role === 'power' ? 'bg-amber-500/90' : 'bg-emerald-500/90'
            }`}
          >
            {role === 'energy' ? '⚡ Exhaust' : role === 'power' ? '♺ Recycle' : '⚡♺ Both'}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onCancel}>
      <div
        className="flex flex-col gap-4 overflow-hidden rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        style={{ width: '75vw', height: '75vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {card.imageUrl && (
              <img
                src={card.imageUrl}
                alt={card.name}
                className="h-20 w-[57px] shrink-0 rounded-md object-cover"
                style={{ aspectRatio: '744/1039' }}
              />
            )}
            <div>
              <h3 className="text-2xl font-bold">Pay for {card.name}</h3>
              <p className="text-sm text-white/50">
                Tap a rune to cycle:{' '}
                <span className="text-white/70">unused → ⚡ exhaust (Energy) → ♺ recycle (Power) → ⚡♺ both</span>. One
                rune can do both (e.g. a Calm rune pays 1 Energy + 1 Calm).
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="rounded px-2 py-1 text-xl text-white/40 hover:bg-white/5 hover:text-white">
            ✕
          </button>
        </div>

        {/* What you currently have to spend. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm">
          <span className="text-[11px] uppercase tracking-wide text-white/45">You have</span>
          <span className="font-mono font-bold text-emerald-200">⚡ {energyAvail} energy</span>
          <span className="text-white/15">·</span>
          <span className="font-mono font-bold text-sky-200">♺ {recyclableRunes + poolPowerTotal} power</span>
          {(Object.entries(powerAvail) as [Domain, number][]).filter(([, nn]) => nn > 0).length > 0 && (
            <span className="flex items-center gap-1.5">
              {(Object.entries(powerAvail) as [Domain, number][]).filter(([, nn]) => nn > 0).map(([d, nn]) => (
                <span key={d} className="flex items-center font-mono text-[13px]" style={{ color: DOMAIN_META[d].color }}>
                  <DomainIcon domain={d} /> {nn}
                </span>
              ))}
            </span>
          )}
          <span className="ml-auto text-[11px] text-white/35">{ready.length} ready · {spent.length} spent · 🪙 pool ⚡{pool.energy ?? 0}</span>
        </div>

        {/* Explicit instruction indicators */}
        <div className="flex flex-wrap gap-3">
          <div
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 ${
              energyOk ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-amber-400/50 bg-amber-500/10'
            }`}
          >
            <span className="text-2xl">⚡</span>
            <div>
              <div className="text-xs uppercase tracking-wide text-white/50">Exhaust for Energy</div>
              <div className={`font-mono text-lg font-bold ${energyOk ? 'text-emerald-200' : 'text-amber-200'}`}>
                {energyPicked} / {needEnergy} rune{needEnergy === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          <div
            className={`flex items-center gap-2 rounded-xl border px-4 py-3 ${
              totalNeedPower === 0
                ? 'border-white/10 bg-white/5 opacity-50'
                : powerOk
                  ? 'border-emerald-400/50 bg-emerald-500/10'
                  : 'border-amber-400/50 bg-amber-500/10'
            }`}
          >
            <span className="text-2xl">♺</span>
            <div>
              <div className="text-xs uppercase tracking-wide text-white/50">Recycle (put back to rune pile)</div>
              <div className={`font-mono text-lg font-bold ${powerOk ? 'text-emerald-200' : 'text-amber-200'}`}>
                {recyclePicked} / {totalNeedPower} rune{totalNeedPower === 1 ? '' : 's'}
              </div>
              {totalNeedPower > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1 text-[11px]">
                  {(Object.entries(needPower) as [Domain, number][]).map(([d, n]) => (
                    <span key={d} className="rounded px-1 font-mono" style={{ color: DOMAIN_META[d].color }}>
                      <DomainIcon domain={d} /> {n} {DOMAIN_META[d].label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {(poolEnergy > 0 || Object.keys(poolPower).length > 0) && (
            <div className="flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3">
              <span className="text-2xl">🪙</span>
              <div>
                <div className="text-xs uppercase tracking-wide text-white/50">From pool (auto)</div>
                <div className="flex items-center gap-1.5 font-mono text-sm font-bold text-sky-200">
                  {poolEnergy > 0 && <span>⚡{poolEnergy}</span>}
                  {(Object.entries(poolPower) as [Domain, number][]).map(([d, n]) => (
                    <span key={d} className="flex items-center" style={{ color: DOMAIN_META[d].color }}>
                      <DomainIcon domain={d} />
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Runes (large, scrollable) */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-white/40">
            Your ready runes ({ready.length})
          </div>
          <div className="flex flex-wrap gap-3">
            {ready.map((r) => renderRune(r, false))}
            {ready.length === 0 && <span className="text-sm text-white/40">No ready runes.</span>}
          </div>
          {spent.length > 0 && (
            <>
              <div className="mb-2 mt-4 text-xs uppercase tracking-wide text-white/40">
                Exhausted — recyclable for Power ({spent.length})
              </div>
              <div className="flex flex-wrap gap-3">{spent.map((r) => renderRune(r, true))}</div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-2">
            <button onClick={setAuto} className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20">
              ✨ Auto-fill
            </button>
            <button onClick={clearAll} className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20">
              Clear
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!valid}
              className="rounded-lg bg-sky-500 px-6 py-2 text-sm font-semibold hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
