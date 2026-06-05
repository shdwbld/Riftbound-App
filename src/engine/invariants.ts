import type { MatchState, EngineCard, ZoneId } from './types'
import { getCard } from '../data/cards'

// Report-only sanity checks on a MatchState — NEVER throws. Returns a list of
// human-readable violations (empty = clean). Used by bug-capture (stored on each
// report) and a DEV-only console.warn after each reduce. It describes suspicious
// states; it does not block play.

export function checkInvariants(s: MatchState): string[] {
  const v: string[] = []
  if (!s || !Array.isArray(s.players)) return ['state has no players array']

  // 1. Duplicate iids — a single card instance present in two places at once.
  const seen = new Map<string, string>()
  const note = (iid: string | undefined, where: string) => {
    if (!iid) return
    const prev = seen.get(iid)
    if (prev) v.push(`duplicate card iid "${iid}" in ${prev} AND ${where}`)
    else seen.set(iid, where)
  }
  s.players.forEach((p, pi) => {
    for (const z of Object.keys(p.zones) as ZoneId[]) p.zones[z].forEach((c) => note(c.iid, `P${pi}.${z}`))
    p.banished.forEach((c) => note(c.iid, `P${pi}.banished`))
    if (p.legend) note(p.legend.iid, `P${pi}.legend`)
    if (p.champion) note(p.champion.iid, `P${pi}.champion`)
  })
  s.battlefields.forEach((b, bi) => {
    b.units.forEach((c) => note(c.iid, `bf${bi}`))
    if (b.facedown) note(b.facedown.iid, `bf${bi}.facedown`)
  })

  // 2. Negative scalars.
  s.players.forEach((p, pi) => {
    if (p.points < 0) v.push(`P${pi} has negative points (${p.points})`)
    if ((p.xp ?? 0) < 0) v.push(`P${pi} has negative xp (${p.xp})`)
    if (p.pool && p.pool.energy < 0) v.push(`P${pi} has negative pool energy (${p.pool.energy})`)
    if (p.pool) for (const [d, n] of Object.entries(p.pool.power)) if ((n ?? 0) < 0) v.push(`P${pi} has negative ${d} power (${n})`)
  })
  const allUnits: EngineCard[] = [
    ...s.players.flatMap((p) => [...p.zones.base, ...p.zones.hand]),
    ...s.battlefields.flatMap((b) => b.units),
  ]
  for (const u of allUnits) if ((u.damage ?? 0) < 0) v.push(`"${getCard(u.cardId)?.name ?? u.cardId}" has negative damage (${u.damage})`)

  // 3. Battlefield controller sanity.
  s.battlefields.forEach((b, bi) => {
    if (b.controller == null) return
    if (b.controller < 0 || b.controller >= s.players.length) v.push(`bf${bi} controller index ${b.controller} out of range`)
    else if (b.units.length === 0) v.push(`bf${bi} has a controller (P${b.controller}) but no units`)
    else if (!b.units.some((u) => u.owner === b.controller)) v.push(`bf${bi} controller P${b.controller} holds no unit there`)
  })

  // 4. Chain / priority / showdown consistency.
  if (s.chain.length > 0 && s.priority == null) v.push('chain is non-empty but priority is null')
  if (s.chain.length === 0 && s.priority != null) v.push('priority is set but the chain is empty')
  if (s.phase === 'showdown' && !s.showdown) v.push('phase is showdown but showdown is null')
  if (s.showdown && s.phase !== 'showdown') v.push('showdown is set but phase is not showdown')

  // 5. Index ranges.
  if (s.activePlayer < 0 || s.activePlayer >= s.players.length) v.push(`activePlayer ${s.activePlayer} out of range`)
  if (s.winner != null && (s.winner < 0 || s.winner >= s.players.length)) v.push(`winner ${s.winner} out of range`)

  return v
}
