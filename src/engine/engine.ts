import { getCard } from '../data/cards'
import { type Card, type Domain, isUnit } from '../types/cards'
import {
  type MatchState,
  type PlayerState,
  type EngineCard,
  type PlayerId,
  type Action,
  type Payment,
  type EngineResult,
  type ResolvedCost,
  type ZoneId,
  type GameEvent,
  type DamageAssignStep,
  ok,
  fail,
} from './types'
import { RULES, TOKEN_PILE_IDS, GOLD_TOKEN_ID, shuffle } from './setup'
import { parseKeywords, accelerateCost, levelBonus } from './keywords'
import { addCost } from './autopay'
import { bfScript, bfScriptAt, type BfApi } from './battlefieldScripts'

/** How many turns the given player has taken (incl. the current one). */
function playerTurnOrdinal(s: MatchState, player: PlayerId): number {
  const rank = (player - s.firstPlayer + s.players.length) % s.players.length
  return Math.floor((s.turn - 1 - rank) / s.players.length) + 1
}
import { spellEffect, onPlayEffect, needsTarget, hasUntargetedPart, hasTargetedPart, type ParsedEffect } from './effects'
import { triggersFor, orderTriggers, type TriggerEvent, type FiredTrigger } from './triggers'
import { canAfford } from './autopay'
import { battlefieldPassive } from './battlefields'

// ---------------------------------------------------------------------------
// Pure engine: reduce(state, action) -> { state, error? }
//
// Enforces the structural game. Combat is a deliberately simplified
// total-might model (clearly marked) pending finalized comprehensive rules;
// the surrounding flow (phases, payment, zones, scoring, win) is complete.
// ---------------------------------------------------------------------------

// --- immutable helpers -----------------------------------------------------

let tokenCounter = 0

// Deep-copy card instances so in-place mutations (buff/stun/damage) never leak
// into prior states kept for undo history.
const copyCard = (c: EngineCard): EngineCard => ({ ...c, attached: [...c.attached] })

function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    legend: p.legend ? copyCard(p.legend) : null,
    champion: p.champion ? copyCard(p.champion) : null,
    tokenPile: [...p.tokenPile],
    banished: p.banished.map(copyCard),
    pool: { energy: p.pool?.energy ?? 0, power: { ...(p.pool?.power ?? {}) } },
    zones: {
      mainDeck: p.zones.mainDeck.map(copyCard),
      runeDeck: p.zones.runeDeck.map(copyCard),
      hand: p.zones.hand.map(copyCard),
      base: p.zones.base.map(copyCard),
      runePool: p.zones.runePool.map(copyCard),
      trash: p.zones.trash.map(copyCard),
    },
  }
}

function clone(s: MatchState): MatchState {
  return {
    ...s,
    players: s.players.map(clonePlayer),
    battlefields: s.battlefields.map((b) => ({ ...b, units: b.units.map(copyCard) })),
    showdown: s.showdown ? { ...s.showdown } : null,
    chain: s.chain.map((c) => ({ ...c, instance: copyCard(c.instance) })),
    log: s.log,
    seq: s.seq + 1,
  }
}

let chainCounter = 0
const makeChainId = () => `chain${chainCounter++}`

// Feedback events for the current reduce() call. Reset at the top of reduce();
// collected synchronously by the mutation helpers via emit().
let pendingEvents: GameEvent[] = []
const emit = (e: GameEvent): void => {
  pendingEvents.push(e)
}

function log(s: MatchState, player: PlayerId | null, text: string): MatchState {
  return { ...s, log: [...s.log, { turn: s.turn, player, text }] }
}

/** Next seat in turn order (wraps around the table). */
const nextPlayer = (s: MatchState, p: PlayerId): PlayerId =>
  (p + 1) % s.players.length
const def = (ci: EngineCard): Card | undefined => getCard(ci.cardId)

/** The resolved energy+power cost of a playable card. */
function costOf(card: Card): ResolvedCost {
  if (card.type === 'unit' || card.type === 'spell' || card.type === 'gear')
    return { energy: card.energy, power: card.power }
  return { energy: 0, power: {} }
}

function findInZone(
  p: PlayerState,
  zone: ZoneId,
  iid: string,
): EngineCard | undefined {
  return p.zones[zone].find((c) => c.iid === iid)
}

function removeFromZone(p: PlayerState, zone: ZoneId, iid: string): EngineCard | null {
  const idx = p.zones[zone].findIndex((c) => c.iid === iid)
  if (idx < 0) return null
  const [c] = p.zones[zone].splice(idx, 1)
  return c
}

// --- payment validation ----------------------------------------------------

/**
 * Validate and apply a payment for a cost. Energy is paid by exhausting that
 * many ready runes; power by recycling ready runes whose produced domains
 * cover the colored requirement. Returns an error string or null (and mutates
 * the given player clone).
 */
function applyPayment(
  p: PlayerState,
  cost: ResolvedCost,
  payment: Payment,
): string | null {
  if (!p.pool) p.pool = { energy: 0, power: {} }
  const pool = p.pool
  // Pool resources are spent first, then the rune cost covers the remainder.
  const poolEnergy = payment.poolEnergy ?? 0
  const poolPower = payment.poolPower ?? {}
  if (poolEnergy < 0 || poolEnergy > cost.energy)
    return 'Invalid pooled energy amount.'
  if (poolEnergy > pool.energy) return 'Not enough Energy in your pool.'
  for (const [d, n] of Object.entries(poolPower) as [Domain, number][]) {
    if ((n ?? 0) < 0 || (n ?? 0) > (cost.power[d] ?? 0))
      return 'Invalid pooled Power amount.'
    if ((n ?? 0) > (pool.power[d] ?? 0)) return 'Not enough Power in your pool.'
  }

  const requiredEnergy = cost.energy - poolEnergy
  const requiredPower: Partial<Record<Domain, number>> = { ...cost.power }
  for (const [d, n] of Object.entries(poolPower) as [Domain, number][])
    requiredPower[d] = (requiredPower[d] ?? 0) - (n ?? 0)
  const powerTotal = Object.values(requiredPower).reduce((a, b) => a + (b ?? 0), 0)

  if (payment.exhaust.length !== requiredEnergy)
    return `Need to exhaust exactly ${requiredEnergy} rune(s) for energy.`
  if (payment.recycle.length !== powerTotal)
    return `Need to recycle exactly ${powerTotal} rune(s) for power.`

  // Energy: each exhaust target must be a ready rune in the pool. (A rune may
  // ALSO appear in `recycle` — exhaust for energy, then recycle for power.)
  const exhaustSet = new Set<string>()
  for (const iid of payment.exhaust) {
    if (exhaustSet.has(iid)) return 'A rune was listed twice for energy.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Energy rune not in your pool.'
    if (rune.exhausted) return 'Energy rune is already exhausted.'
    exhaustSet.add(iid)
  }
  // Power: runes recycled from the pool (ready, or already exhausted for energy
  // this payment). Match each to a colored requirement.
  const recycleSet = new Set<string>()
  const recycled: EngineCard[] = []
  for (const iid of payment.recycle) {
    if (recycleSet.has(iid)) return 'A rune was listed twice for power.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Power rune not in your pool.'
    // A still-ready rune not being exhausted this payment is fine; a rune
    // exhausted earlier (not in this payment) can't also be recycled.
    if (rune.exhausted && !exhaustSet.has(iid))
      return 'Power rune is already exhausted.'
    recycleSet.add(iid)
    recycled.push(rune)
  }
  // Greedy assignment of recycled runes to needed domains.
  const need = { ...requiredPower }
  for (const rune of recycled) {
    const produces = def(rune)?.type === 'rune' ? (def(rune) as { produces: Domain[] }).produces : []
    const match = (Object.keys(need) as Domain[]).find(
      (d) => (need[d] ?? 0) > 0 && produces.includes(d),
    )
    if (!match) return 'Recycled runes do not match the power cost.'
    need[match] = (need[match] ?? 0) - 1
  }
  if (Object.values(need).some((n) => (n ?? 0) > 0))
    return 'Power cost not fully paid.'

  // Apply: exhaust energy runes; recycle power runes to bottom of rune deck.
  for (const iid of payment.exhaust) {
    const rune = p.zones.runePool.find((c) => c.iid === iid)!
    rune.exhausted = true
  }
  for (const iid of payment.recycle) {
    const rune = removeFromZone(p, 'runePool', iid)!
    p.zones.runeDeck.push({ ...rune, exhausted: false, damage: 0 })
  }
  // Deduct the pooled resources actually spent.
  pool.energy -= poolEnergy
  for (const [d, n] of Object.entries(poolPower) as [Domain, number][]) {
    pool.power[d] = (pool.power[d] ?? 0) - (n ?? 0)
    if ((pool.power[d] ?? 0) <= 0) delete pool.power[d]
  }
  return null
}

// --- effect helpers --------------------------------------------------------

function drawN(p: PlayerState, n: number): number {
  let drew = 0
  for (let i = 0; i < n && p.zones.mainDeck.length > 0; i++) {
    p.zones.hand.push(p.zones.mainDeck.shift()!)
    drew++
  }
  return drew
}

function channelN(p: PlayerState, n: number): number {
  let ch = 0
  for (let i = 0; i < n && p.zones.runeDeck.length > 0; i++) {
    p.zones.runePool.push({ ...p.zones.runeDeck.shift()!, exhausted: false })
    ch++
  }
  return ch
}

/** Send a card to a player's Trash as it leaves play. Tokens cease to exist
 *  (they don't go to the Trash), and buffs/temp modifiers are cleared. */
function sendToTrash(p: PlayerState, card: EngineCard): void {
  if (getCard(card.cardId)?.supertype === 'token') return // tokens cease to exist
  p.zones.trash.push({
    ...card,
    damage: 0,
    exhausted: false,
    buffs: 0,
    tempMight: 0,
    stunned: false,
    facedown: false,
    attached: [],
  })
}

/** Banish a card to the Banishment zone (removed from the game). Like the Trash
 *  but Burn Out can't recycle it; tokens still cease to exist. Banish is NOT a
 *  Kill, so the caller must not fire death triggers. */
function banishCard(p: PlayerState, card: EngineCard): void {
  if (getCard(card.cardId)?.supertype === 'token') return // tokens cease to exist
  p.banished.push({
    ...card,
    damage: 0,
    exhausted: false,
    buffs: 0,
    tempMight: 0,
    stunned: false,
    facedown: false,
    attached: [],
  })
}

/** Create N Recruit tokens onto a player's Base (from card effects). */
function spawnRecruits(p: PlayerState, n: number, turn: number): number {
  const id = TOKEN_PILE_IDS[0]
  if (!id) return 0
  for (let i = 0; i < n; i++)
    p.zones.base.push({
      iid: `${p.id}:tok:${id}#${(tokenCounter++).toString(36)}`,
      cardId: id,
      owner: p.id,
      exhausted: true,
      damage: 0,
      attached: [],
      enteredTurn: turn,
    })
  return n
}

/** Create N Gold gear tokens onto a player's Base, exhausted (from card effects).
 *  A Gold token can be cashed in (killed) for 1 Power of any domain. */
function spawnGold(p: PlayerState, n: number, turn: number): number {
  if (!GOLD_TOKEN_ID) return 0
  for (let i = 0; i < n; i++)
    p.zones.base.push({
      iid: `${p.id}:tok:${GOLD_TOKEN_ID}#${(tokenCounter++).toString(36)}`,
      cardId: GOLD_TOKEN_ID,
      owner: p.id,
      exhausted: true,
      damage: 0,
      attached: [],
      enteredTurn: turn,
    })
  return n
}

/** Apply the auto-resolvable parts of a parsed effect to `p`; returns log text. */
function applyParsed(s: MatchState, p: PlayerState, e: ParsedEffect): string[] {
  const lines: string[] = []
  if (e.draw) lines.push(`Drew ${drawN(p, e.draw)}.`)
  if (e.channel) lines.push(`Channeled ${channelN(p, e.channel)}.`)
  if (e.recruits) lines.push(`Created ${spawnRecruits(p, e.recruits, s.turn)} Recruit(s).`)
  if (e.goldTokens) lines.push(`Created ${spawnGold(p, e.goldTokens, s.turn)} Gold token(s).`)
  if (e.readyUnits) {
    // Surface a "choose which unit(s) to ready" prompt for the player.
    const exhausted = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner === p.id && u.exhausted && getCard(u.cardId)?.type === 'unit',
    )
    const cnt = Math.min(e.readyUnits, exhausted.length)
    if (cnt > 0) {
      s.readyChoice = { player: p.id, count: (s.readyChoice?.player === p.id ? s.readyChoice.count : 0) + cnt }
      lines.push(`Ready ${cnt} unit(s) — choose which.`)
    }
  }
  return lines
}

// --- triggered abilities (Batch C) -----------------------------------------

/** A unit instance anywhere in play (battlefields or any base), by iid. */
function findUnitAnywhere(s: MatchState, iid: string): EngineCard | undefined {
  return (
    s.battlefields.flatMap((b) => b.units).find((u) => u.iid === iid) ??
    s.players.flatMap((p) => p.zones.base).find((u) => u.iid === iid)
  )
}

/** Permanents a player controls that can carry triggered abilities. */
function controlledPermanents(s: MatchState, player: PlayerId): EngineCard[] {
  const out: EngineCard[] = [
    ...s.battlefields.flatMap((b) => b.units.filter((u) => u.owner === player)),
    ...s.players[player].zones.base,
  ]
  if (s.players[player].legend) out.push(s.players[player].legend!)
  return out
}

/** Collect a player's GLOBAL ("when you …") triggers for an event. */
function collectGlobal(s: MatchState, player: PlayerId, event: TriggerEvent): FiredTrigger[] {
  const out: FiredTrigger[] = []
  for (const u of controlledPermanents(s, player))
    for (const ab of triggersFor(def(u), event))
      if (ab.scope === 'global') out.push({ player, ability: ab, sourceIid: u.iid })
  return out
}

/** Self-scope triggers ("when I …") for a player's units, optionally limited to
 *  specific source iids (e.g. the units that just moved / conquered). */
function collectSelf(s: MatchState, player: PlayerId, event: TriggerEvent, iids?: string[]): FiredTrigger[] {
  const only = iids ? new Set(iids) : null
  const out: FiredTrigger[] = []
  for (const u of controlledPermanents(s, player)) {
    if (only && !only.has(u.iid)) continue
    for (const ab of triggersFor(def(u), event))
      if (ab.scope === 'self') out.push({ player, ability: ab, sourceIid: u.iid })
  }
  return out
}

/** Apply fired triggers' auto-resolvable effects (ordered turn-player first,
 *  rule 4.6); log the remainder for manual resolution. */
function fireTriggers(s: MatchState, fired: FiredTrigger[]): MatchState {
  if (fired.length === 0) return s
  const ordered = orderTriggers(fired, s.activePlayer, s.players.length)
  for (const { player, ability, sourceIid } of ordered) {
    const label = ability.event === 'death' ? 'Deathknell' : `Trigger (${ability.event})`
    const p = s.players[player]
    const e = ability.effect
    let did = false
    for (const line of applyParsed(s, p, e)) {
      s = log(s, player, `${label}: ${line}`)
      did = true
    }
    if (e.buff && sourceIid) {
      const u = findUnitAnywhere(s, sourceIid)
      if (u && (u.buffs ?? 0) < 1) {
        u.buffs = 1
        emit({ kind: 'buff', iid: sourceIid, player })
        s = log(s, player, `${label}: +1 Might.`)
        did = true
      }
    }
    // "give me +1 Might this turn" — temporary Might on the source unit.
    if (e.tempMightSelf && sourceIid) {
      const u = findUnitAnywhere(s, sourceIid)
      if (u) {
        u.tempMight = (u.tempMight ?? 0) + e.tempMightSelf
        emit({ kind: 'buff', iid: sourceIid, player })
        s = log(s, player, `${label}: ${e.tempMightSelf > 0 ? '+' : ''}${e.tempMightSelf} Might this turn.`)
        did = true
      }
    }
    if (e.damage) s = log(s, player, `${label}: deal ${e.damage} — choose a target (resolve manually).`)
    else if (!did) s = log(s, player, `${label}: ${ability.text} — resolve manually.`)
  }
  return s
}

/** Fire the self death triggers (Deathknell) of a set of defeated units. */
function fireDeaths(s: MatchState, defeated: EngineCard[]): MatchState {
  const fired: FiredTrigger[] = []
  for (const u of defeated)
    for (const ab of triggersFor(def(u), 'death'))
      fired.push({ player: u.owner, ability: ab, sourceIid: u.iid })
  return fireTriggers(s, fired)
}

/** Fire a player's GLOBAL "when you play …" triggers as a card is played. Fires
 *  at play time regardless of whether the played card later resolves (a spell
 *  countered on the chain still triggers these — rule 4.x / T2). Excludes the
 *  card just played so it doesn't react to its own entry. */
function firePlayTriggers(s: MatchState, player: PlayerId, exceptIid: string): MatchState {
  const fired = collectGlobal(s, player, 'play').filter((f) => f.sourceIid !== exceptIid)
  return fireTriggers(s, fired)
}

/** Engine primitives a battlefield script may call. Mutates `s` in place
 *  (players are shared refs; logs push directly onto s.log). */
function makeBfApi(s: MatchState): BfApi {
  const note = (player: PlayerId | null, text: string) => s.log.push({ turn: s.turn, player, text })
  return {
    recycleRune(player) {
      const p = s.players[player]
      const idx = p.zones.runePool.findIndex((r) => !r.exhausted)
      const at = idx >= 0 ? idx : p.zones.runePool.length ? 0 : -1
      if (at < 0) return
      const [r] = p.zones.runePool.splice(at, 1)
      p.zones.runeDeck.push({ ...r, exhausted: false, damage: 0 })
      note(player, `Recycled a rune.`)
    },
    readyRunes(player, n) {
      const p = s.players[player]
      let readied = 0
      for (const r of p.zones.runePool) {
        if (readied >= n) break
        if (r.exhausted) {
          r.exhausted = false
          readied++
        }
      }
      if (readied) note(player, `Readied ${readied} rune(s).`)
    },
    revealTopSpellElseRecycle(player) {
      const p = s.players[player]
      const top = p.zones.mainDeck[0]
      if (!top) return
      p.zones.mainDeck.shift()
      if (getCard(top.cardId)?.type === 'spell') {
        p.zones.hand.push(top)
        note(player, `Revealed a spell — added it to hand.`)
      } else {
        p.zones.mainDeck.push(top)
        note(player, `Revealed a non-spell — recycled it.`)
      }
    },
    tempMightToUnitHere(player, bfIndex, n) {
      const u = s.battlefields[bfIndex]?.units.find((x) => x.owner === player && getCard(x.cardId)?.type === 'unit')
      if (u) {
        u.tempMight = (u.tempMight ?? 0) + n
        note(player, `+${n} Might this turn to ${getCard(u.cardId)?.name}.`)
      }
    },
    log: (text) => note(null, text),
  }
}

/** Fire battlefield "when a player plays a spell" scripts (Abandoned Hall). */
function bfSpellPlayed(s: MatchState, player: PlayerId): MatchState {
  for (let i = 0; i < s.battlefields.length; i++) {
    const script = bfScriptAt(s, i)
    if (script?.onSpellPlayed) script.onSpellPlayed(makeBfApi(s), player, i)
  }
  return s
}

/** Apply a battlefield's "when you conquer here" passive to the conqueror. */
function applyConquerPassive(s: MatchState, player: PlayerId, bfIndex: number): MatchState {
  if (s.winner !== null) return s
  const bf = s.battlefields[bfIndex]
  const passive = battlefieldPassive(bf.cardId)
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
  if (passive.onConquer)
    for (const line of applyParsed(s, s.players[player], passive.onConquer))
      s = log(s, player, `${bfName} (conquer): ${line}`)
  else if (passive.manualConquer)
    s = log(s, player, `${bfName} (conquer): resolve its effect manually.`)
  // Scripted on-conquer (Sigil of the Storm, Targon's Peak).
  const script = bfScript(bf.cardId)
  if (script?.onConquer) script.onConquer(makeBfApi(s), player, bfIndex)
  return s
}

/** Award Hunt XP for a player's units at a battlefield they just conquered or
 *  are holding (rule: Hunt N grants N XP on conquer/hold). Mutates + logs. */
function grantHunt(s: MatchState, player: PlayerId, bfIndex: number): MatchState {
  let xp = 0
  for (const u of s.battlefields[bfIndex].units)
    if (u.owner === player) xp += parseKeywords(def(u)).hunt
  if (xp > 0) {
    s.players[player].xp += xp
    s = log(s, player, `Hunt: +${xp} XP (${s.players[player].xp} total).`)
  }
  return s
}

/** Deal `amount` damage to a target unit anywhere; defeat it if lethal. Returns
 *  the defeated units (so the caller can fire their death triggers). */
function applyTargetDamage(s: MatchState, targetIid: string, amount: number, spellLike = false): EngineCard[] {
  for (let i = 0; i < s.battlefields.length; i++) {
    const bf = s.battlefields[i]
    const u = bf.units.find((x) => x.iid === targetIid)
    if (u) {
      // Void Gate: spells/abilities deal +N Bonus Damage to units here.
      if (spellLike) amount += bfScriptAt(s, i)?.bonusSpellDamageHere ?? 0
      u.damage += amount
      emit({ kind: 'damage', iid: targetIid, amount, cardId: u.cardId })
      let dead: EngineCard[] = []
      if (u.damage >= mightOf(u)) {
        bf.units = bf.units.filter((x) => x.iid !== targetIid)
        sendToTrash(s.players[u.owner], u)
        emit({ kind: 'defeat', iid: targetIid, cardId: u.cardId })
        dead = [u]
      }
      recomputeControllers(s)
      return dead
    }
  }
  for (const p of s.players) {
    const u = p.zones.base.find((x) => x.iid === targetIid)
    if (u) {
      u.damage += amount
      emit({ kind: 'damage', iid: targetIid, amount, cardId: u.cardId })
      if (u.damage >= mightOf(u)) {
        p.zones.base = p.zones.base.filter((x) => x.iid !== targetIid)
        sendToTrash(p, u)
        emit({ kind: 'defeat', iid: targetIid, cardId: u.cardId })
        return [u]
      }
      return []
    }
  }
  return []
}

/** Standard move of one or more ready units to a battlefield (group move). All
 *  exhaust; a single showdown opens if the destination is contested. */
function moveUnits(
  state: MatchState,
  player: PlayerId,
  iids: string[],
  toBattlefield: number,
): EngineResult {
  const guard = requireActiveAction(state, player)
  if (guard) return fail(state, guard)
  if (toBattlefield < 0 || toBattlefield >= state.battlefields.length)
    return fail(state, 'Invalid battlefield.')
  if (iids.length === 0) return fail(state, 'No units selected.')
  const prevController = state.battlefields[toBattlefield].controller
  const s = clone(state)
  const p = s.players[player]
  const moved: EngineCard[] = []
  for (const iid of iids) {
    let unit = removeFromZone(p, 'base', iid)
    if (!unit) {
      for (let i = 0; i < s.battlefields.length; i++) {
        if (i === toBattlefield) continue
        const idx = s.battlefields[i].units.findIndex(
          (u) => u.iid === iid && u.owner === player,
        )
        if (idx >= 0) {
          // Ganking from the keyword OR granted by the source battlefield
          // (Windswept Hillock). The destination must also allow it.
          const hasGank = parseKeywords(def(s.battlefields[i].units[idx])).ganking || !!bfScriptAt(s, i)?.grantsGanking
          if (!hasGank)
            return fail(state, 'Only units with Ganking can move between battlefields.')
          unit = s.battlefields[i].units.splice(idx, 1)[0]
          bfScriptAt(s, i)?.onMoveFrom?.(unit) // Back-Alley Bar: +1 Might this turn
          break
        }
      }
    }
    if (!unit) return fail(state, 'Unit not found at your base.')
    if (unit.exhausted) return fail(state, `${def(unit)?.name} is exhausted.`)
    unit.exhausted = true
    s.battlefields[toBattlefield].units.push(unit)
    moved.push(unit)
    emit({ kind: 'move', iid: unit.iid, player, cardId: unit.cardId })
  }
  recomputeControllers(s)
  const bf = s.battlefields[toBattlefield]
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
  let s2 = log(s, player, `Moved ${moved.length} unit(s) to ${bfName}.`)
  // "When I move" self triggers fire on the move itself (e.g. play a Gold token).
  s2 = fireTriggers(s2, collectSelf(s2, player, 'move', moved.map((u) => u.iid)))
  const contested = bf.units.some((u) => u.owner !== player)
  if (contested) {
    s2.phase = 'showdown'
    s2.showdown = {
      battlefield: toBattlefield,
      priority: nextPlayer(s2, player),
      passes: 0,
      movedUnit: moved[0].iid,
    }
    s2 = log(s2, player, 'Showdown opened — opponents may respond.')
  } else if (
    s2.battlefields[toBattlefield].controller === player &&
    prevController !== player
  ) {
    s2 = awardPoints(s2, player, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    s2 = grantHunt(s2, player, toBattlefield)
    s2 = applyConquerPassive(s2, player, toBattlefield)
    s2 = fireTriggers(s2, collectGlobal(s2, player, 'conquer'))
    const here = s2.battlefields[toBattlefield].units.filter((u) => u.owner === player).map((u) => u.iid)
    s2 = fireTriggers(s2, collectSelf(s2, player, 'conquer', here))
  }
  return ok(s2)
}

// --- turn flow -------------------------------------------------------------

/** Recompute controller for every battlefield from unit presence (most units
 *  present controls; ties keep the prior controller; empty = neutral). */
function recomputeControllers(s: MatchState): void {
  for (const bf of s.battlefields) {
    if (bf.units.length === 0) {
      bf.controller = null
      continue
    }
    const counts = new Map<PlayerId, number>()
    for (const u of bf.units) counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1)
    let best: PlayerId | null = null
    let bestN = 0
    let tied = false
    for (const [owner, n] of counts) {
      if (n > bestN) {
        best = owner
        bestN = n
        tied = false
      } else if (n === bestN) {
        tied = true
      }
    }
    bf.controller = tied ? bf.controller : best
  }
}

/** Run the automatic start-of-turn steps for the active player. */
export function beginTurn(state: MatchState): MatchState {
  let s = clone(state)
  const ap = s.activePlayer
  const p = s.players[ap]

  // Reset per-turn counters (LEGION) and empty the resource pool (it does not
  // carry between turns — emptied at end of the Draw step / end of turn).
  p.cardsPlayedThisTurn = 0
  p.pool = { energy: 0, power: {} }

  // Awaken: ready everything the active player controls.
  if (p.legend) p.legend.exhausted = false
  for (const z of Object.keys(p.zones) as ZoneId[])
    p.zones[z] = p.zones[z].map((c) => ({ ...c, exhausted: false }))
  for (const bf of s.battlefields)
    bf.units = bf.units.map((u) => (u.owner === ap ? { ...u, exhausted: false } : u))
  s = log(s, ap, `— Turn ${s.turn}: ${p.name} · Awaken —`)

  // Start-of-turn triggered abilities (card text "at the start of your turn …").
  s = fireTriggers(s, collectGlobal(s, ap, 'startOfTurn'))

  // Battlefield "first Beginning Phase" passives (e.g. Obelisk channels 1).
  if (s.turn <= s.players.length) {
    for (const bf of s.battlefields) {
      const passive = battlefieldPassive(bf.cardId)
      const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
      if (passive.firstBeginning)
        for (const line of applyParsed(s, p, passive.firstBeginning))
          s = log(s, ap, `${bfName} (first turn): ${line}`)
      if (passive.firstBeginningPoints)
        s = awardPoints(s, ap, passive.firstBeginningPoints, `gained from ${bfName}`, 'hold')
    }
    if (s.winner !== null) return s
  }

  // Temporary: kill the active player's Temporary units that have lived a round.
  for (const bf of s.battlefields) {
    const expired = bf.units.filter(
      (u) =>
        u.owner === ap &&
        parseKeywords(def(u)).temporary &&
        (u.enteredTurn ?? 0) < s.turn,
    )
    if (expired.length) {
      bf.units = bf.units.filter((u) => !expired.includes(u))
      for (const u of expired) sendToTrash(p, u)
      s = log(s, ap, `${expired.length} Temporary unit(s) expired.`)
    }
  }
  for (const u of p.zones.base.filter(
    (u) => parseKeywords(def(u)).temporary && (u.enteredTurn ?? 0) < s.turn,
  )) {
    p.zones.base = p.zones.base.filter((x) => x.iid !== u.iid)
    sendToTrash(p, u)
  }

  // Hidden cleanup: a facedown unit at a battlefield its owner no longer
  // controls is unsupported and is removed (sent to its owner's Trash).
  recomputeControllers(s)
  for (const bf of s.battlefields) {
    const orphaned = bf.units.filter((u) => u.facedown && bf.controller !== u.owner)
    if (orphaned.length) {
      bf.units = bf.units.filter((u) => !orphaned.includes(u))
      for (const u of orphaned) sendToTrash(s.players[u.owner], u)
      s = log(s, ap, `${orphaned.length} unsupported Hidden card(s) removed.`)
    }
  }

  // Frozen Fortress et al.: deal damage to every unit here at the start of each
  // player's turn (applies to all owners' units).
  for (let i = 0; i < s.battlefields.length; i++) {
    const dmg = bfScriptAt(s, i)?.beginningDamageHere
    if (!dmg) continue
    for (const u of [...s.battlefields[i].units]) {
      const dead = applyTargetDamage(s, u.iid, dmg)
      if (dead.length) s = fireDeaths(s, dead)
    }
    s = log(s, ap, `${getCard(s.battlefields[i].cardId)?.name ?? 'Battlefield'}: dealt ${dmg} to each unit here.`)
  }

  // Score: 1 point per held battlefield (skip the very first turn). Some
  // battlefields can't be scored until the controller's Nth turn.
  recomputeControllers(s)
  if (s.turn > 1) {
    const ord = playerTurnOrdinal(s, ap)
    let scorable = 0
    for (let i = 0; i < s.battlefields.length; i++) {
      if (s.battlefields[i].controller !== ap) continue
      const from = bfScriptAt(s, i)?.scoreFromTurn
      if (from && ord < from) continue
      scorable++
    }
    if (scorable > 0) {
      p.points += scorable * RULES.pointsPerBattlefield
      emit({ kind: 'score', player: ap, amount: scorable * RULES.pointsPerBattlefield })
      s = log(s, ap, `Scored ${scorable} point(s) (holding ${scorable} battlefield(s)).`)
    }
  }
  // Hunt XP for every battlefield the active player holds this turn.
  let holdsAny = false
  for (let i = 0; i < s.battlefields.length; i++)
    if (s.battlefields[i].controller === ap) {
      s = grantHunt(s, ap, i)
      holdsAny = true
    }
  // Card "when you hold" (global) + "when I hold" (self, on units at held BFs).
  if (holdsAny) {
    s = fireTriggers(s, collectGlobal(s, ap, 'hold'))
    const heldUnitIids = s.battlefields
      .filter((b) => b.controller === ap)
      .flatMap((b) => b.units.filter((u) => u.owner === ap).map((u) => u.iid))
    s = fireTriggers(s, collectSelf(s, ap, 'hold', heldUnitIids))
  }

  // Battlefield "when you hold here" passives for the active player.
  for (const bf of s.battlefields) {
    if (bf.controller !== ap) continue
    // The Grand Plaza: hold with enough units here → win.
    const win = bfScript(bf.cardId)?.winOnUnitsHere
    if (win && bf.units.filter((u) => u.owner === ap).length >= win)
      return endGame(s, ap)
    const passive = battlefieldPassive(bf.cardId)
    const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
    if (passive.onHold)
      for (const line of applyParsed(s, p, passive.onHold))
        s = log(s, ap, `${bfName} (hold): ${line}`)
    if (passive.buffOnHold) {
      const target = bf.units.find((u) => u.owner === ap)
      if (target) {
        target.buffs = (target.buffs ?? 0) + 1
        s = log(s, ap, `${bfName} (hold): buffed ${getCard(target.cardId)?.name} (+1).`)
      }
    }
    if (passive.manualHold) s = log(s, ap, `${bfName} (hold): resolve its effect manually.`)
  }
  if (p.points >= s.pointsToWin) return endGame(s, ap)

  // First-turn process (Core Rules v1.2 §462–466), by seat in turn order:
  //   • 1v1: the player going SECOND channels +1 on their first turn.
  //   • FFA 3-4: the player going FIRST skips their first Draw; the player going
  //     LAST channels +1 on their first turn.
  const n = s.players.length
  const order = (ap - s.firstPlayer + n) % n // 0 = first player … n-1 = last
  const isPlayersFirstTurn = s.turn === order + 1
  const channelBonus =
    isPlayersFirstTurn &&
    ((n === 2 && order === 1) || (n >= 3 && order === n - 1))
      ? 1
      : 0
  const skipFirstDraw = n >= 3 && order === 0 && isPlayersFirstTurn

  // Channel runes.
  const channelCount = RULES.channelPerTurn + channelBonus
  let channeled = 0
  for (let i = 0; i < channelCount && p.zones.runeDeck.length > 0; i++) {
    const r = p.zones.runeDeck.shift()!
    p.zones.runePool.push({ ...r, exhausted: false })
    channeled++
  }
  if (channeled) s = log(s, ap, `Channeled ${channeled} rune(s).`)

  // Draw — empty deck triggers Burn Out (reshuffle Trash, opponent scores). The
  // FFA first player skips their very first Draw.
  const drawCount = skipFirstDraw ? 0 : RULES.drawPerTurn
  if (skipFirstDraw) s = log(s, ap, `${p.name} skips their first draw (going first).`)
  for (let i = 0; i < drawCount; i++) {
    if (s.players[ap].zones.mainDeck.length === 0) {
      s = burnOut(s, ap)
      if (s.winner !== null) return s
    }
    const deck = s.players[ap].zones.mainDeck
    if (deck.length > 0) {
      s.players[ap].zones.hand.push(deck.shift()!)
      emit({ kind: 'draw', player: ap, amount: 1 })
    }
  }

  // Auto-activate the Legend's ability once per turn (its auto-resolvable parts:
  // draw / channel / recruit). No manual button — abilities resolve themselves.
  if (p.legend && !p.legend.exhausted) {
    const legendCard = getCard(p.legend.cardId)
    if (legendCard) {
      const e = spellEffect(legendCard)
      if (e.draw || e.channel || e.recruits) {
        p.legend.exhausted = true
        for (const line of applyParsed(s, p, e)) s = log(s, ap, `${legendCard.name} (auto): ${line}`)
      }
    }
  }

  s.phase = 'action'
  return s
}

/** Burn Out (empty-deck draw): recycle Trash into the Main Deck, shuffle, and a
 *  chosen opponent scores 1. With no Trash to recycle, that opponent wins. */
function burnOut(state: MatchState, player: PlayerId): MatchState {
  const beneficiary = nextPlayer(state, player)
  const p = state.players[player]
  if (p.zones.trash.length === 0) {
    const s = log(state, player, `${p.name} burned out with no Trash — ${state.players[beneficiary].name} wins!`)
    return endGame(s, beneficiary)
  }
  p.zones.mainDeck = shuffle([...p.zones.mainDeck, ...p.zones.trash])
  p.zones.trash = []
  const s = log(state, player, `${p.name} burned out — Trash reshuffled into the deck.`)
  return awardPoints(s, beneficiary, 1, 'scored from Burn Out', 'hold')
}

function endGame(state: MatchState, winner: PlayerId): MatchState {
  let s = clone(state)
  s.winner = winner
  s.phase = 'gameover'
  s = log(s, winner, `${s.players[winner].name} wins!`)
  return s
}

/** Award point(s) and check for the win. The winning point via Conquer is
 *  restricted: it only counts if the player controls ALL battlefields that
 *  turn — otherwise they draw a card instead of scoring it. Hold/Burn-Out
 *  points are unrestricted. */
function awardPoints(
  s: MatchState,
  player: PlayerId,
  amount: number,
  reason: string,
  kind: 'hold' | 'conquer',
): MatchState {
  const p = s.players[player]
  if (
    kind === 'conquer' &&
    p.points + amount >= s.pointsToWin &&
    !s.battlefields.every((b) => b.controller === player)
  ) {
    if (p.zones.mainDeck.length) p.zones.hand.push(p.zones.mainDeck.shift()!)
    return log(
      s,
      player,
      `${p.name}'s winning point must be a Hold or a full conquer — drew a card instead.`,
    )
  }
  p.points += amount
  emit({ kind: 'score', player, amount })
  if (kind === 'conquer') emit({ kind: 'conquer', player })
  let next = log(s, player, `${p.name} ${reason} (+${amount}).`)
  if (next.players[player].points >= next.pointsToWin) next = endGame(next, player)
  return next
}

// --- combat (simplified total-might model) ---------------------------------

type CombatRole = 'attacker' | 'defender' | null

/** A unit's effective Might in a given combat role, including Assault/Shield
 *  keyword bonuses, attached-gear bonuses, and marked damage. Backline units
 *  don't fight on the frontline (0). */
function mightOf(ci: EngineCard, role: CombatRole = null, xp = 0): number {
  const d = def(ci)
  if (!d || !isUnit(d)) return 0
  const k = parseKeywords(d)
  if (k.backline) return 0
  let m = d.might - ci.damage + gearMight(ci) + (ci.buffs ?? 0) + (ci.tempMight ?? 0)
  if (role === 'attacker') m += k.assault
  if (role === 'defender') m += k.shield
  m += levelBonus(d, xp).might // [Level N] passive while controller has enough XP
  return Math.max(0, m)
}

/** Combat damage a unit DEALS — 0 if Stunned (it still keeps Might to survive). */
function damageOutput(ci: EngineCard, role: CombatRole, xp = 0): number {
  return ci.stunned ? 0 : mightOf(ci, role, xp)
}

/** Mighty: a unit with effective Might >= 5. */
export function isMighty(ci: EngineCard): boolean {
  return mightOf(ci) >= 5
}

/** A unit's current displayed Might (base + buffs + gear + temp + level − damage). */
export function displayMight(ci: EngineCard, xp = 0): number {
  const d = getCard(ci.cardId)
  if (!d || d.type !== 'unit') return 0
  return Math.max(0, d.might + (ci.buffs ?? 0) + (ci.tempMight ?? 0) + gearMight(ci) + levelBonus(d, xp).might - ci.damage)
}

/** A breakdown of a unit's Might for UI ("2 + 1 = 3 (this turn)"). */
export interface MightBreakdown {
  base: number
  buffs: number
  gear: number
  temp: number
  damage: number
  total: number
  hasTemp: boolean
}
export function mightBreakdown(ci: EngineCard, xp = 0): MightBreakdown | null {
  const d = getCard(ci.cardId)
  if (!d || d.type !== 'unit') return null
  const base = d.might
  const buffs = ci.buffs ?? 0
  const gear = gearMight(ci)
  const temp = ci.tempMight ?? 0
  const level = levelBonus(d, xp).might
  const damage = ci.damage
  return {
    base,
    buffs,
    gear: gear + level, // fold Level into the "gear/bonus" line for display
    temp,
    damage,
    total: Math.max(0, base + buffs + gear + level + temp - damage),
    hasTemp: temp !== 0,
  }
}

/** True if any card across the match's zones cares about XP (Hunt / Level), so
 *  the UI only shows the XP meter when it's actually relevant. */
export function matchUsesXp(state: MatchState): boolean {
  for (const p of state.players) {
    if (p.xp > 0) return true
    const piles: EngineCard[][] = [
      p.zones.hand,
      p.zones.base,
      p.zones.mainDeck,
      p.zones.trash,
      ...(p.legend ? [[p.legend]] : []),
      ...(p.champion ? [[p.champion]] : []),
    ]
    for (const pile of piles)
      for (const c of pile) {
        const k = parseKeywords(getCard(c.cardId))
        if (k.hunt > 0 || k.level > 0) return true
      }
  }
  return false
}

/** Combat Might in a role (includes Assault/Shield; Stun zeroes output). */
export function combatMight(ci: EngineCard, role: 'attacker' | 'defender'): number {
  return damageOutput(ci, role)
}

/** Flat +Might from attached gear (for UI badges). */
export function gearBonus(ci: EngineCard): number {
  return gearMight(ci)
}

/** Flat +Might granted by attached gear (parsed from "+N Might" gear text). */
function gearMight(unit: EngineCard): number {
  let bonus = 0
  for (const gid of unit.attached) {
    const g = getCard(gid.split('|')[0]) // attached stored as "cardId|iid"
    const t = g?.text ?? ''
    // Match a flat "+N Might" whether written as the word or the :rb_might: icon,
    // but only when it's a static grant (not a conditional "this turn" pump).
    const m = t.match(/\+(\d+)\s*(?::rb_might:|might)\b/i)
    if (m && !/this turn/i.test(t)) bonus += parseInt(m[1], 10)
  }
  return bonus
}

/** Order units for damage assignment: Tank first (must be killed before
 *  others), then normal, then backline. */
function damageOrder(units: EngineCard[]): EngineCard[] {
  const rank = (u: EngineCard) => {
    const k = parseKeywords(def(u))
    return k.tank ? 0 : k.backline ? 2 : 1
  }
  return [...units].sort((a, b) => rank(a) - rank(b))
}

/** Assign `damage` total across `units` (already in Tank-first order) using
 *  kill-order: fully defeat one unit before moving to the next. `role` is the
 *  role of the units RECEIVING damage (so their Shield/Assault is applied). */
function assignDamage(
  damage: number,
  units: EngineCard[],
  role: CombatRole,
  xpOf: (u: EngineCard) => number = () => 0,
  bonusOf: (u: EngineCard, role: CombatRole) => number = () => 0,
): Set<string> {
  const defeated = new Set<string>()
  let remaining = damage
  for (const u of units) {
    if (remaining <= 0) break
    const hp = mightOf(u, role, xpOf(u)) + bonusOf(u, role)
    if (hp <= 0) continue
    if (remaining >= hp) {
      defeated.add(u.iid)
      remaining -= hp
    } else {
      remaining = 0
    }
  }
  return defeated
}

/** Effective Might (lethal threshold) per receiving unit. */
function hpMap(
  units: EngineCard[],
  role: CombatRole,
  xpOf: (u: EngineCard) => number,
  bonusOf: (u: EngineCard, role: CombatRole) => number = () => 0,
): Record<string, number> {
  const hp: Record<string, number> = {}
  for (const u of units) hp[u.iid] = Math.max(0, mightOf(u, role, xpOf(u)) + bonusOf(u, role))
  return hp
}

/** Build one side's damage-assignment step. `manualAllowed` is false when there
 *  is no single dealer (multi-owner defenders) — then it auto-resolves. */
function buildAssignStep(
  dealer: PlayerId,
  side: 'attackers' | 'defenders',
  receiving: EngineCard[],
  amount: number,
  manualAllowed: boolean,
  xpOf: (u: EngineCard) => number,
  bonusOf: (u: EngineCard, role: CombatRole) => number = () => 0,
): DamageAssignStep {
  const role: CombatRole = side === 'defenders' ? 'defender' : 'attacker'
  const ordered = damageOrder(receiving)
  const hp = hpMap(receiving, role, xpOf, bonusOf)
  const tanks = receiving.filter((u) => parseKeywords(def(u)).tank).map((u) => u.iid)
  const totalHp = Object.values(hp).reduce((a, b) => a + b, 0)
  // A choice only exists with 2+ live targets and damage that won't kill them all.
  const liveTargets = receiving.filter((u) => hp[u.iid] > 0)
  const manual = manualAllowed && amount > 0 && liveTargets.length >= 2 && amount < totalHp
  const defeated = manual ? [] : [...assignDamage(amount, ordered, role, xpOf, bonusOf)]
  return { dealer, side, targets: ordered.map((u) => u.iid), amount, manual, defeated, hp, tanks }
}

/** Flat combat-Might delta a battlefield grants units fighting on it (Trifarian
 *  War Camp +1, Forbidding Waste −2 alone, Black Flame Altar shield). */
function bfCombatBonus(
  s: MatchState,
  bfIndex: number,
  attackersAlone: boolean,
  defendersAlone: boolean,
): (u: EngineCard, role: CombatRole) => number {
  const script = bfScriptAt(s, bfIndex)
  if (!script || (!script.mightHere && !script.shieldHere)) return () => 0
  return (u, role) => {
    const alone = role === 'attacker' ? attackersAlone : role === 'defender' ? defendersAlone : false
    let b = script.mightHere ? script.mightHere(u, role, alone) : 0
    if (role === 'defender' && script.shieldHere) b += script.shieldHere(u)
    return b
  }
}

/** Validate a manual allocation against a step (Tank-first + kill-order). */
export function validateAllocation(step: DamageAssignStep, alloc: Record<string, number>): string | null {
  const totalHp = Object.values(step.hp).reduce((a, b) => a + b, 0)
  const mustAssign = Math.min(step.amount, totalHp)
  let sum = 0
  let sublethal = 0
  for (const iid of Object.keys(alloc)) {
    if (!step.targets.includes(iid)) return 'Damage assigned to a non-target unit.'
    const v = alloc[iid] ?? 0
    if (v < 0) return 'Negative damage.'
    if (v > step.hp[iid]) return 'Cannot assign more than lethal to a unit.'
    sum += v
    if (v > 0 && v < step.hp[iid]) sublethal++
  }
  if (sum !== mustAssign) return `Assign exactly ${mustAssign} damage (you assigned ${sum}).`
  // Kill-order: at most one unit may be left sub-lethal.
  if (sublethal > 1) return 'Assign lethal to a unit before splitting damage to another.'
  // Tank-first: a non-Tank may only take damage once every Tank is lethal.
  const nonTankDamaged = step.targets.some((iid) => !step.tanks.includes(iid) && (alloc[iid] ?? 0) > 0)
  if (nonTankDamaged && step.tanks.some((iid) => (alloc[iid] ?? 0) < step.hp[iid]))
    return 'Tanks must be assigned lethal damage first.'
  return null
}

/** Deflect surcharge (Core Rules §735): an opponent's spell/ability that
 *  CHOOSES a unit with Deflect X costs X more to play. Summed over all chosen
 *  enemy targets. (Modeled here as extra generic cost — see note in autopay.) */
export function deflectSurcharge(
  state: MatchState,
  targets: string[] | undefined,
  caster: PlayerId,
): number {
  if (!targets?.length) return 0
  const find = (iid: string): EngineCard | undefined => {
    for (const bf of state.battlefields) for (const u of bf.units) if (u.iid === iid) return u
    for (const pl of state.players) for (const u of pl.zones.base) if (u.iid === iid) return u
    return undefined
  }
  let total = 0
  for (const iid of targets) {
    const u = find(iid)
    if (u && u.owner !== caster) total += parseKeywords(def(u)).deflect
  }
  return total
}

/** The damage step the given player must assign right now, or null. */
export function pendingAssignment(state: MatchState, player: PlayerId): DamageAssignStep | null {
  const a = state.showdown?.assign
  if (!a) return null
  const step = a.steps[a.current]
  if (!step || !step.manual || step.dealer !== player) return null
  return step
}

/** Kill-order auto-distribution for a step (Tank-first, lethal-before-next). */
export function autoAllocate(step: DamageAssignStep): Record<string, number> {
  const totalHp = Object.values(step.hp).reduce((a, b) => a + b, 0)
  let remaining = Math.min(step.amount, totalHp)
  const out: Record<string, number> = {}
  for (const iid of step.targets) {
    if (remaining <= 0) break
    const give = Math.min(step.hp[iid], remaining)
    if (give > 0) {
      out[iid] = give
      remaining -= give
    }
  }
  return out
}

/** Compute the two damage-assignment steps for a showdown (no mutation). */
function showdownSteps(s: MatchState, bfIndex: number): { moverOwner: PlayerId; steps: DamageAssignStep[] } {
  const bf = s.battlefields[bfIndex]
  const mover = s.showdown?.movedUnit
  const moverOwner = bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer
  const xpOf = (u: EngineCard) => s.players[u.owner]?.xp ?? 0
  const attackers = bf.units.filter((u) => u.owner === moverOwner)
  const defenders = bf.units.filter((u) => u.owner !== moverOwner)
  const bonusOf = bfCombatBonus(s, bfIndex, attackers.length === 1, defenders.length === 1)
  const dealt = (u: EngineCard, role: CombatRole) =>
    u.stunned ? 0 : Math.max(0, mightOf(u, role, xpOf(u)) + bonusOf(u, role))
  const attackMight = attackers.reduce((a, u) => a + dealt(u, 'attacker'), 0)
  const defendMight = defenders.reduce((a, u) => a + dealt(u, 'defender'), 0)
  // Mover's damage hits the defenders; the defending side's damage hits attackers.
  const defOwners = [...new Set(defenders.map((u) => u.owner))]
  const atkDealer = defOwners.length === 1 ? defOwners[0] : moverOwner
  const steps = [
    buildAssignStep(moverOwner, 'defenders', defenders, attackMight, true, xpOf, bonusOf),
    buildAssignStep(atkDealer, 'attackers', attackers, defendMight, defOwners.length === 1, xpOf, bonusOf),
  ]
  return { moverOwner, steps }
}

/**
 * Resolve a combat showdown at a battlefield. Both sides deal damage equal to
 * their total Might SIMULTANEOUSLY. When a side hits 2+ enemy units and has a
 * choice of distribution, combat PAUSES for that player to assign damage
 * (Tank-first); otherwise it auto-resolves in kill-order.
 */
function resolveShowdown(state: MatchState, bfIndex: number): MatchState {
  const s = clone(state)
  const { steps } = showdownSteps(s, bfIndex)
  if (steps.some((st) => st.manual)) {
    const current = steps.findIndex((st) => st.manual)
    s.showdown!.assign = { steps, current }
    s.showdown!.priority = steps[current].dealer
    return s // paused — wait for ASSIGN_DAMAGE
  }
  return finalizeShowdown(s, bfIndex, steps)
}

/** Apply a (now fully-determined) set of assignment steps and finish combat. */
function finalizeShowdown(state: MatchState, bfIndex: number, steps: DamageAssignStep[]): MatchState {
  let s = clone(state)
  const bf = s.battlefields[bfIndex]
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'

  const mover = s.showdown?.movedUnit
  const moverOwner = bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer
  const prevController = s.battlefields[bfIndex].controller

  const xpOf = (u: EngineCard) => s.players[u.owner]?.xp ?? 0
  const attackers = bf.units.filter((u) => u.owner === moverOwner)
  const defenders = bf.units.filter((u) => u.owner !== moverOwner)
  const bonusOf = bfCombatBonus(s, bfIndex, attackers.length === 1, defenders.length === 1)
  const dealt = (u: EngineCard, role: CombatRole) =>
    u.stunned ? 0 : Math.max(0, mightOf(u, role, xpOf(u)) + bonusOf(u, role))
  const attackMight = attackers.reduce((a, u) => a + dealt(u, 'attacker'), 0)
  const defendMight = defenders.reduce((a, u) => a + dealt(u, 'defender'), 0)

  // Defeats from the resolved steps.
  const defendersDefeated = new Set<string>(steps.filter((st) => st.side === 'defenders').flatMap((st) => st.defeated))
  const attackersDefeated = new Set<string>(steps.filter((st) => st.side === 'attackers').flatMap((st) => st.defeated))
  s.showdown!.assign = undefined

  // Attack/Defend triggers fire once per combat (rule 4.7 / T11).
  const combatFired: FiredTrigger[] = []
  for (const u of attackers)
    for (const ab of triggersFor(def(u), 'attack'))
      combatFired.push({ player: u.owner, ability: ab, sourceIid: u.iid })
  for (const u of defenders)
    for (const ab of triggersFor(def(u), 'defend'))
      combatFired.push({ player: u.owner, ability: ab, sourceIid: u.iid })
  s = fireTriggers(s, combatFired)

  // Scripted "when you defend here" (Ravenbloom Conservatory).
  const defendScript = bfScript(bf.cardId)
  if (defendScript?.onDefend)
    for (const owner of new Set(defenders.map((u) => u.owner)))
      defendScript.onDefend(makeBfApi(s), owner, bfIndex)

  const survivors: EngineCard[] = []
  const defeated: EngineCard[] = []
  for (const u of bf.units) {
    const dead =
      (u.owner !== moverOwner && defendersDefeated.has(u.iid)) ||
      (u.owner === moverOwner && attackersDefeated.has(u.iid))
    if (dead) {
      sendToTrash(s.players[u.owner], u)
      emit({ kind: 'defeat', iid: u.iid, cardId: u.cardId })
      defeated.push(u)
    } else survivors.push({ ...u, damage: 0 })
  }
  bf.units = survivors
  const lost = defendersDefeated.size + attackersDefeated.size
  s = log(
    s,
    moverOwner,
    `Showdown at ${bfName}: ${attackMight} vs ${defendMight} Might — ${lost} unit(s) defeated.`,
  )
  // Death triggers (Deathknell + any "when I'm defeated") for every casualty.
  s = fireDeaths(s, defeated)

  recomputeControllers(s)

  // No conquer: if defenders still hold units here, the attacker's surviving
  // units are Recalled to base (damage already cleared).
  const defendersRemain = bf.units.some((u) => u.owner !== moverOwner)
  const moverRemain = bf.units.filter((u) => u.owner === moverOwner)
  if (defendersRemain && moverRemain.length > 0) {
    bf.units = bf.units.filter((u) => u.owner !== moverOwner)
    for (const u of moverRemain)
      s.players[moverOwner].zones.base.push({ ...u, exhausted: true, damage: 0 })
    recomputeControllers(s)
    s = log(s, moverOwner, `No conquer — ${moverRemain.length} attacker(s) recalled to base.`)
  }

  s.showdown = null
  s.phase = 'action'

  // "When I win a combat" — the mover cleared the defenders and still holds units.
  const moverHere = s.battlefields[bfIndex].units.filter((u) => u.owner === moverOwner).map((u) => u.iid)
  const enemyHere = s.battlefields[bfIndex].units.some((u) => u.owner !== moverOwner)
  if (moverHere.length > 0 && !enemyHere)
    s = fireTriggers(s, collectSelf(s, moverOwner, 'winCombat', moverHere))

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    s = grantHunt(s, moverOwner, bfIndex)
    s = applyConquerPassive(s, moverOwner, bfIndex)
    s = fireTriggers(s, collectGlobal(s, moverOwner, 'conquer'))
    s = fireTriggers(s, collectSelf(s, moverOwner, 'conquer', moverHere))
  }
  return s
}

// --- main reducer ----------------------------------------------------------

/** Apply a spell's effects (used by both immediate showdown casts and chain
 *  resolution). Mutates the players in `s`; returns the logged state. */
function resolveSpellEffects(
  s: MatchState,
  controller: PlayerId,
  card: Card,
  targets: string[] | undefined,
): MatchState {
  const p = s.players[controller]
  const e = spellEffect(card)
  // Untargeted parts (draw / channel / recruit) always resolve.
  for (const line of applyParsed(s, p, e)) s = log(s, controller, line)

  // Targeted parts: damage / kill / ±Might-this-turn, applied to each chosen
  // target that's still in play.
  if (hasTargetedPart(e)) {
    const tgts = (targets ?? []).filter((t) => isValidTarget(s, t))
    if (tgts.length === 0 && !hasUntargetedPart(e))
      s = log(s, controller, `${card.name} fizzled — no valid target.`)
    for (const t of tgts) {
      let dead: EngineCard[] = []
      if (e.damage) {
        dead = applyTargetDamage(s, t, e.damage, true)
        s = log(s, controller, `${card.name} dealt ${e.damage}.`)
      } else if (e.kill) {
        dead = killTarget(s, t)
        s = log(s, controller, `${card.name} killed a unit.`)
      }
      if (e.tempMight) {
        const more = applyTempMight(s, t, e.tempMight)
        dead = dead.concat(more)
        s = log(s, controller, `${card.name}: ${e.tempMight > 0 ? '+' : ''}${e.tempMight} Might this turn.`)
      }
      if (dead.length && e.drawOnKill) {
        const drew = drawN(p, e.drawOnKill)
        s = log(s, controller, `${card.name}: drew ${drew} (a unit died).`)
      }
      s = fireDeaths(s, dead)
    }
  }

  if (e.manual && !hasTargetedPart(e) && !hasUntargetedPart(e))
    s = log(s, controller, `Cast ${card.name} — resolve its effect manually.`)
  return s
}

/** Outright kill a unit anywhere by iid (no damage roll). Returns it for death
 *  triggers. */
function killTarget(s: MatchState, iid: string): EngineCard[] {
  for (const bf of s.battlefields) {
    const idx = bf.units.findIndex((u) => u.iid === iid)
    if (idx >= 0) {
      const [u] = bf.units.splice(idx, 1)
      sendToTrash(s.players[u.owner], u)
      emit({ kind: 'defeat', iid, cardId: u.cardId })
      recomputeControllers(s)
      return [u]
    }
  }
  for (const p of s.players) {
    const idx = p.zones.base.findIndex((u) => u.iid === iid)
    if (idx >= 0) {
      const [u] = p.zones.base.splice(idx, 1)
      sendToTrash(p, u)
      emit({ kind: 'defeat', iid, cardId: u.cardId })
      return [u]
    }
  }
  return []
}

/** Apply a signed Might-this-turn modifier to a unit; if its Might drops to 0 it
 *  is defeated. Returns any unit defeated this way. */
function applyTempMight(s: MatchState, iid: string, delta: number): EngineCard[] {
  const u = findUnitAnywhere(s, iid)
  if (!u) return []
  u.tempMight = (u.tempMight ?? 0) + delta
  emit({ kind: delta >= 0 ? 'buff' : 'damage', iid })
  if (mightOf(u) <= 0) {
    for (const bf of s.battlefields) {
      const idx = bf.units.findIndex((x) => x.iid === iid)
      if (idx >= 0) {
        bf.units.splice(idx, 1)
        sendToTrash(s.players[u.owner], u)
        emit({ kind: 'defeat', iid, cardId: u.cardId })
        recomputeControllers(s)
        return [u]
      }
    }
    for (const p of s.players) {
      const idx = p.zones.base.findIndex((x) => x.iid === iid)
      if (idx >= 0) {
        p.zones.base.splice(idx, 1)
        sendToTrash(p, u)
        emit({ kind: 'defeat', iid, cardId: u.cardId })
        return [u]
      }
    }
  }
  return []
}

/** Resolve (or counter) the top item of the Chain. */
function resolveTopOfChain(state: MatchState): MatchState {
  let s = state
  const item = s.chain[s.chain.length - 1]
  s.chain = s.chain.slice(0, -1)
  const p = s.players[item.controller]
  if (item.kind === 'counter') {
    const idx = s.chain.findIndex((c) => c.id === item.countersId)
    if (idx >= 0) {
      const [target] = s.chain.splice(idx, 1)
      sendToTrash(s.players[target.controller], target.instance)
      emit({ kind: 'counter', iid: target.instance.iid, player: item.controller, cardId: target.cardId })
      s = log(s, item.controller, `Countered ${getCard(target.cardId)?.name ?? 'a spell'} — it does not resolve.`)
    } else {
      s = log(s, item.controller, `Counter fizzled — its target left the chain.`)
    }
    sendToTrash(p, item.instance)
    return s
  }
  const card = getCard(item.cardId)
  if (card) s = resolveSpellEffects(s, item.controller, card, item.targets)
  sendToTrash(p, item.instance)
  return s
}

/** Public reducer: resets the feedback-event buffer, applies the action, and
 *  attaches any emitted events to the result. */
/** Finish interactive setup: apply champion picks, build the chosen battlefields
 *  (4-player: the first player's is dropped), set pointsToWin, start the mulligan.
 *  Mutates and returns `s` (caller has already cloned). */
function finalizeSetup(s: MatchState): MatchState {
  const su = s.setup!
  const n = s.players.length
  const first = s.firstPlayer
  const baseName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()
  su.championPick.forEach((id, i) => {
    const p = s.players[i]
    // Set aside the Chosen Champion: pull a matching card out of the (still
    // undrawn) main deck into the Champion Zone, then draw the opening hand.
    if (id) {
      let idx = p.zones.mainDeck.findIndex((c) => c.cardId === id)
      if (idx < 0) {
        const bn = baseName(getCard(id)?.name ?? '')
        idx = p.zones.mainDeck.findIndex((c) => baseName(getCard(c.cardId)?.name ?? '') === bn)
      }
      if (idx >= 0) {
        const pulled = p.zones.mainDeck.splice(idx, 1)[0]
        p.champion = { ...pulled, cardId: id }
      } else if (!p.champion) {
        p.champion = { iid: `${i}:champ:${id}`, cardId: id, owner: i, exhausted: false, damage: 0, attached: [] }
      }
    }
    // Draw the opening hand now (interactive setup deferred it past the roll).
    if (p.zones.hand.length === 0)
      for (let k = 0; k < RULES.openingHand && p.zones.mainDeck.length > 0; k++)
        p.zones.hand.push(p.zones.mainDeck.shift()!)
  })
  const contributors = s.players.map((_, i) => i).filter((i) => !(n === 4 && i === first))
  const bfIds = contributors
    .map((i) => su.battlefieldPick[i])
    .filter((x): x is string => !!x)
    .slice(0, n === 4 ? 3 : n)
  s.battlefields = bfIds.map((cardId) => ({ cardId, units: [], controller: null }))
  s.pointsToWin =
    (n === 2 ? RULES.pointsToWin : RULES.pointsToWinMultiplayer) +
    bfIds.reduce((sum, id) => sum + battlefieldPassive(id).winDelta, 0)
  s.setup = undefined
  s.phase = 'mulligan'
  return log(s, null, 'Setup complete — players mulligan.')
}

/** Advance the setup state to the next pending step, or finalize into mulligan.
 *  A step is pending only where a player has a real choice (2+ options). */
function advanceSetup(s: MatchState): EngineResult {
  const su = s.setup!
  if (su.championOptions.some((o, i) => o.length > 1 && su.championPick[i] === null)) {
    su.step = 'champion'
    return ok(s)
  }
  if (su.battlefieldOptions.some((o, i) => o.length > 1 && su.battlefieldPick[i] === null)) {
    su.step = 'battlefield'
    return ok(s)
  }
  return ok(finalizeSetup(s))
}

export function reduce(state: MatchState, action: Action): EngineResult {
  pendingEvents = []
  const result = reduceInner(state, action)
  // Only attach events on a successful application (no error).
  if (!result.error && pendingEvents.length) result.events = pendingEvents
  return result
}

function reduceInner(state: MatchState, action: Action): EngineResult {
  if (state.winner !== null && action.type !== 'CONCEDE')
    return fail(state, 'The game is over.')

  switch (action.type) {
    case 'ROLL_TURN_ORDER': {
      if (state.phase !== 'setup' || state.setup?.step !== 'roll')
        return fail(state, 'Not the turn-order roll.')
      if (action.rolls.length !== state.players.length) return fail(state, 'Need one roll per player.')
      const s = clone(state)
      const su = s.setup!
      su.rolls = [...action.rolls]
      // Highest roll wins (first max on a tie — the UI re-rolls ties for fairness).
      let winner = 0
      for (let i = 1; i < su.rolls.length; i++) if (su.rolls[i] > su.rolls[winner]) winner = i
      su.winner = winner
      su.step = 'first'
      return ok(log(s, null, `Turn-order roll: ${su.rolls.map((r, i) => `${s.players[i].name} ${r}`).join(', ')} — ${s.players[winner].name} chooses.`))
    }

    case 'CHOOSE_FIRST': {
      if (state.phase !== 'setup' || state.setup?.step !== 'first')
        return fail(state, 'Not the first-player choice.')
      if (state.setup.winner !== action.player) return fail(state, 'Only the roll winner may choose.')
      if (action.firstPlayer < 0 || action.firstPlayer >= state.players.length)
        return fail(state, 'Invalid first player.')
      const s = clone(state)
      s.firstPlayer = action.firstPlayer
      s.activePlayer = action.firstPlayer
      s.setup!.step = 'champion'
      return advanceSetup(s)
    }

    case 'CHOOSE_CHAMPION': {
      if (state.phase !== 'setup' || state.setup?.step !== 'champion')
        return fail(state, 'Not the champion-selection step.')
      const opts = state.setup.championOptions[action.player] ?? []
      if (!opts.includes(action.cardId)) return fail(state, 'That champion is not an option for you.')
      const s = clone(state)
      s.setup!.championPick[action.player] = action.cardId
      return advanceSetup(s)
    }

    case 'CHOOSE_BATTLEFIELD': {
      if (state.phase !== 'setup' || state.setup?.step !== 'battlefield')
        return fail(state, 'Not the battlefield-selection step.')
      const opts = state.setup.battlefieldOptions[action.player] ?? []
      if (!opts.includes(action.cardId)) return fail(state, 'That battlefield is not an option for you.')
      const s = clone(state)
      s.setup!.battlefieldPick[action.player] = action.cardId
      return advanceSetup(s)
    }

    case 'MULLIGAN': {
      if (state.phase !== 'mulligan') return fail(state, 'Not the mulligan step.')
      if (action.toBottom.length > 2)
        return fail(state, 'You may set aside at most 2 cards.')
      let s = clone(state)
      const p = s.players[action.player]
      if (p.mulliganed) return fail(state, 'Already decided your hand.')
      // Set aside the chosen cards to the BOTTOM of the deck (no reshuffle),
      // then draw that many replacements.
      const setAside: EngineCard[] = []
      for (const iid of action.toBottom) {
        const c = removeFromZone(p, 'hand', iid)
        if (c) setAside.push(c)
      }
      p.zones.mainDeck.push(...setAside)
      for (let i = 0; i < setAside.length && p.zones.mainDeck.length > 0; i++)
        p.zones.hand.push(p.zones.mainDeck.shift()!)
      s = log(
        s,
        action.player,
        setAside.length ? `${p.name} mulliganed ${setAside.length}.` : `${p.name} kept.`,
      )
      p.mulliganed = true
      if (s.players.every((pl) => pl.mulliganed)) return ok(beginTurn(s))
      return ok(s)
    }

    case 'ACTIVATE_LEGEND': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      const p = s.players[action.player]
      if (!p.legend) return fail(state, 'No legend in play.')
      if (p.legend.exhausted) return fail(state, 'Legend already used this turn.')
      // Generic activation: exhaust the legend. Specific effects are surfaced
      // for manual resolution (per-legend scripting is out of scope).
      p.legend = { ...p.legend, exhausted: true }
      const legendCard = getCard(p.legend.cardId)
      let s1 = log(s, action.player, `${legendCard?.name ?? 'Legend'} ability used.`)
      if (legendCard) {
        const e = spellEffect(legendCard)
        for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
        if (!e.draw && !e.channel && !e.recruits)
          s1 = log(s1, action.player, `(Resolve the legend's effect manually.)`)
      }
      return ok(s1)
    }

    case 'CREATE_TOKEN': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      const p = s.players[action.player]
      if (!p.tokenPile.includes(action.cardId))
        return fail(state, 'That token is not available to you.')
      const card = getCard(action.cardId)
      if (!card || card.supertype !== 'token')
        return fail(state, 'Not a valid token.')
      // Tokens enter the Base exhausted (like a played unit), Accelerate aside.
      const token: EngineCard = {
        iid: `${action.player}:tok:${card.id}#${(tokenCounter++).toString(36)}`,
        cardId: card.id,
        owner: action.player,
        exhausted: !parseKeywords(card).accelerate,
        damage: 0,
        attached: [],
        enteredTurn: s.turn,
      }
      p.zones.base.push(token)
      return ok(log(s, action.player, `Created token: ${card.name}.`))
    }

    case 'PLAY_UNIT':
    case 'PLAY_GEAR':
    case 'PLAY_SPELL': {
      // Resolve the card first (it might be in hand or the Champion Zone).
      const probe = state.players[action.player]
      const fromChampion = probe.champion?.iid === action.iid
      const handCard = probe.zones.hand.find((c) => c.iid === action.iid)
      const sourceCard = fromChampion ? probe.champion! : handCard
      if (!sourceCard) return fail(state, 'Card not in hand.')
      const card = getCard(sourceCard.cardId)
      if (!card) return fail(state, 'Unknown card.')
      const expected =
        action.type === 'PLAY_UNIT' ? 'unit' : action.type === 'PLAY_GEAR' ? 'gear' : 'spell'
      if (card.type !== expected) return fail(state, `That card is not a ${expected}.`)

      // Timing. Spells can respond to an open Chain (priority holder + Reaction/
      // Action) or to a showdown; everything else needs your open action phase.
      const kwTiming = parseKeywords(card)
      const inShowdown = state.phase === 'showdown' && !!state.showdown
      const chainOpen = state.chain.length > 0
      if (action.type === 'PLAY_SPELL' && chainOpen) {
        if (state.priority !== action.player) return fail(state, 'Not your priority.')
        if (!(kwTiming.reaction || kwTiming.action))
          return fail(state, 'Only Reaction/Action spells can respond to the chain.')
      } else if (action.type === 'PLAY_SPELL' && inShowdown) {
        if (!((kwTiming.reaction || kwTiming.action) && state.showdown!.priority === action.player))
          return fail(state, 'Only a Reaction/Action spell at your priority during a showdown.')
      } else if (action.type === 'PLAY_GEAR' && kwTiming.quickDraw && chainOpen) {
        // Quick-Draw gear plays at Reaction speed (in a Closed State).
        if (state.priority !== action.player) return fail(state, 'Not your priority.')
      } else if (action.type === 'PLAY_GEAR' && kwTiming.quickDraw && inShowdown) {
        if (state.showdown!.priority !== action.player)
          return fail(state, 'Not your priority during the showdown.')
      } else if (action.type === 'PLAY_UNIT' && kwTiming.ambush && (chainOpen || inShowdown)) {
        // Ambush: play a unit at Reaction speed to a battlefield where you have
        // units (it joins the in-progress combat).
        const pr = chainOpen ? state.priority : state.showdown!.priority
        if (pr !== action.player) return fail(state, 'Not your priority for Ambush.')
        if (action.toBattlefield == null) return fail(state, 'Ambush requires a target battlefield.')
        const bf = state.battlefields[action.toBattlefield]
        if (!bf || !bf.units.some((u) => u.owner === action.player))
          return fail(state, 'Ambush must target a battlefield where you have units.')
        if (bfScriptAt(state, action.toBattlefield)?.noPlayHere)
          return fail(state, `Units can't be played at ${getCard(bf.cardId)?.name ?? 'that battlefield'}.`)
      } else {
        const guard = requireActiveAction(state, action.player)
        if (guard) return fail(state, guard)
      }

      const s = clone(state)
      const p = s.players[action.player]
      const ci = fromChampion ? p.champion! : findInZone(p, 'hand', action.iid)!

      // Accelerate is an OPTIONAL extra cost: when the player opts in, fold it
      // into the cost (so the payment must cover it) and the unit enters ready.
      const accelChosen =
        action.type === 'PLAY_UNIT' && !!action.accelerate && !!accelerateCost(card)
      let effCost = accelChosen ? addCost(costOf(card), accelerateCost(card)!) : costOf(card)
      // Deflect: a spell choosing an enemy unit with Deflect X costs X more.
      if (action.type === 'PLAY_SPELL') {
        const surcharge = deflectSurcharge(state, action.targets, action.player)
        if (surcharge > 0) effCost = addCost(effCost, { energy: surcharge, power: {} })
      }
      const err = applyPayment(p, effCost, action.payment)
      if (err) return fail(state, err)

      if (fromChampion) p.champion = null
      else removeFromZone(p, 'hand', action.iid)
      const kw = parseKeywords(card)
      // LEGION is "on" if you already played another Main Deck card this turn.
      const legionActive = (p.cardsPlayedThisTurn ?? 0) >= 1
      p.cardsPlayedThisTurn = (p.cardsPlayedThisTurn ?? 0) + 1

      if (action.type === 'PLAY_UNIT') {
        // Units enter exhausted unless the player paid Accelerate, or an active
        // [Level N] grants "enters ready".
        const levelReady = levelBonus(card, p.xp).ready
        const entersReady = accelChosen || levelReady
        // Ambush: a Reaction unit enters directly at a contested battlefield.
        const ambushBf = kw.ambush && action.toBattlefield != null ? action.toBattlefield : null
        if (ambushBf != null) {
          s.battlefields[ambushBf].units.push({ ...ci, exhausted: false, enteredTurn: s.turn })
          recomputeControllers(s)
        } else {
          p.zones.base.push({ ...ci, exhausted: !entersReady, enteredTurn: s.turn })
        }
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        let s1 = log(
          s,
          action.player,
          `Played ${card.name}${ambushBf != null ? ' (Ambush)' : accelChosen ? ' (ready · Accelerate)' : levelReady ? ' (ready · Level)' : ''}.`,
        )
        const e = onPlayEffect(card)
        const legionGated = kw.legion && !legionActive
        if (!legionGated) {
          for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
        } else {
          s1 = log(s1, action.player, `${card.name}: Legion inactive (no prior card this turn).`)
        }
        // Vision: peek the top of your Main Deck; a decision (keep / recycle)
        // is surfaced to the controller.
        if (kw.vision && p.zones.mainDeck.length > 0) {
          s1 = { ...s1, vision: { player: action.player, cardId: p.zones.mainDeck[0].cardId } }
          s1 = log(s1, action.player, `Vision — look at the top of your deck; you may recycle it.`)
        }
        if (e.manual && !e.draw && !e.channel && !e.recruits && !legionGated)
          s1 = log(s1, action.player, `${card.name}: resolve its ability manually.`)
        // Weaponmaster: auto-attach a piece of gear from your hand on entry.
        if (kw.weaponmaster) {
          const gearCi = p.zones.hand.find((c) => getCard(c.cardId)?.type === 'gear')
          const target = p.zones.base.find((u) => u.iid === ci.iid)
          if (gearCi && target) {
            removeFromZone(p, 'hand', gearCi.iid)
            target.attached = [...target.attached, `${gearCi.cardId}|${gearCi.iid}`]
            emit({ kind: 'buff', iid: target.iid, player: action.player, cardId: gearCi.cardId })
            s1 = log(s1, action.player, `Weaponmaster: attached ${getCard(gearCi.cardId)?.name} to ${card.name}.`)
          } else {
            s1 = log(s1, action.player, `Weaponmaster: no Equipment in hand to attach.`)
          }
        }
        s1 = firePlayTriggers(s1, action.player, ci.iid)
        return ok(s1)
      }

      if (action.type === 'PLAY_GEAR') {
        // Attach to a target unit (granting its bonuses) if given, else base.
        if (action.targetIid) {
          for (const u of p.zones.base.concat(s.battlefields.flatMap((b) => b.units)))
            if (u.iid === action.targetIid && u.owner === action.player) {
              u.attached = [...u.attached, `${card.id}|${ci.iid}`]
              emit({ kind: 'buff', iid: u.iid, player: action.player, cardId: card.id })
              return ok(firePlayTriggers(log(s, action.player, `Equipped ${card.name} to ${getCard(u.cardId)?.name}.`), action.player, ci.iid))
            }
        }
        p.zones.base.push({ ...ci })
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        return ok(firePlayTriggers(log(s, action.player, `Played gear ${card.name} (unattached).`), action.player, ci.iid))
      }

      // Spell. In a showdown we resolve immediately (legacy path). In the
      // action phase the spell goes on the Chain and opens a priority window.
      if (inShowdown) {
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        // "When you play a spell" triggers fire as it's played, before it resolves.
        let s1 = firePlayTriggers(s, action.player, ci.iid)
        s1 = bfSpellPlayed(s1, action.player)
        s1 = resolveSpellEffects(s1, action.player, card, action.targets)
        sendToTrash(s1.players[action.player], ci)
        return ok(s1)
      }
      emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
      s.chain.push({
        id: makeChainId(),
        kind: 'spell',
        controller: action.player,
        cardId: card.id,
        instance: ci,
        payment: action.payment,
        targets: action.targets,
      })
      s.passes = 0
      s.priority = nextPlayer(s, action.player)
      // Play-triggers fire now (before the chain resolves), so they still happen
      // even if this spell is later Countered.
      let sPlayed = firePlayTriggers(s, action.player, ci.iid)
      sPlayed = bfSpellPlayed(sPlayed, action.player)
      return ok(
        log(sPlayed, action.player, `Played ${card.name} — it's on the Chain (opponents may respond).`),
      )
    }

    case 'MOVE_UNIT':
      return moveUnits(state, action.player, [action.iid], action.toBattlefield)

    case 'MOVE_UNITS':
      return moveUnits(state, action.player, action.iids, action.toBattlefield)

    case 'STUN_UNIT': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      const target =
        s.battlefields.flatMap((b) => b.units).find((u) => u.iid === action.iid) ??
        s.players.flatMap((pl) => pl.zones.base).find((u) => u.iid === action.iid)
      if (!target) return fail(state, 'No such unit to stun.')
      target.stunned = true
      emit({ kind: 'stun', iid: target.iid, player: action.player })
      return ok(log(s, action.player, `Stunned ${getCard(target.cardId)?.name}.`))
    }

    case 'DETACH': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      const p = s.players[action.player]
      const unit = findUnitAnywhere(s, action.unitIid)
      if (!unit || unit.owner !== action.player) return fail(state, 'No such unit of yours.')
      const idx = unit.attached.findIndex((a) => a.split('|')[1] === action.gearIid)
      if (idx < 0) return fail(state, 'That gear is not attached.')
      const [ref] = unit.attached.splice(idx, 1)
      const [cardId, iid] = ref.split('|')
      // Detached gear returns to your Base as an unattached piece of gear.
      p.zones.base.push({ iid, cardId, owner: action.player, exhausted: false, damage: 0, attached: [] })
      emit({ kind: 'buff', iid: unit.iid, player: action.player })
      return ok(log(s, action.player, `Detached ${getCard(cardId)?.name}.`))
    }

    case 'USE_GOLD': {
      // Cash in a Gold gear token: kill it (a token, so it ceases to exist) and
      // add 1 Power of the chosen domain to your pool. Reaction-speed (the Gold
      // ability is [Reaction] + [Add], which can't be reacted to).
      const s = clone(state)
      const p = s.players[action.player]
      const idx = p.zones.base.findIndex((g) => g.iid === action.iid)
      if (idx < 0) return fail(state, 'That Gold token is not on your Base.')
      const tok = p.zones.base[idx]
      if (tok.cardId !== GOLD_TOKEN_ID) return fail(state, 'That is not a Gold token.')
      p.zones.base.splice(idx, 1) // token ceases to exist (no Trash)
      if (!p.pool) p.pool = { energy: 0, power: {} }
      p.pool.power[action.domain] = (p.pool.power[action.domain] ?? 0) + 1
      return ok(log(s, action.player, `Cashed in Gold for 1 ${action.domain} Power.`))
    }

    case 'BANISH': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      // Banish removes a unit from play to its OWNER's Banishment — no Deathknell.
      for (const bf of s.battlefields) {
        const idx = bf.units.findIndex((u) => u.iid === action.iid)
        if (idx >= 0) {
          const [u] = bf.units.splice(idx, 1)
          banishCard(s.players[u.owner], u)
          emit({ kind: 'defeat', iid: u.iid, cardId: u.cardId })
          recomputeControllers(s)
          return ok(log(s, action.player, `Banished ${getCard(u.cardId)?.name}.`))
        }
      }
      for (const p of s.players) {
        const idx = p.zones.base.findIndex((u) => u.iid === action.iid)
        if (idx >= 0) {
          const [u] = p.zones.base.splice(idx, 1)
          banishCard(p, u)
          emit({ kind: 'defeat', iid: u.iid, cardId: u.cardId })
          return ok(log(s, action.player, `Banished ${getCard(u.cardId)?.name}.`))
        }
      }
      return fail(state, 'No such unit to banish.')
    }

    case 'HIDE': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      if (action.toBattlefield < 0 || action.toBattlefield >= state.battlefields.length)
        return fail(state, 'Invalid battlefield.')
      if (state.battlefields[action.toBattlefield].controller !== action.player)
        return fail(state, 'You must control a battlefield to Hide a unit there.')
      if (bfScriptAt(state, action.toBattlefield)?.noPlayHere)
        return fail(state, "Units can't be played at that battlefield.")
      const s = clone(state)
      const p = s.players[action.player]
      const unit = p.zones.base.find((u) => u.iid === action.iid)
      if (!unit) return fail(state, 'Unit not at your Base.')
      if (!parseKeywords(def(unit)).hidden)
        return fail(state, 'Only a unit with Hidden can be hidden.')
      const rune = p.zones.runePool.find((r) => r.iid === action.runeIid && !r.exhausted)
      if (!rune) return fail(state, 'Need a ready rune to recycle for Hide.')
      removeFromZone(p, 'base', action.iid)
      const recycled = removeFromZone(p, 'runePool', action.runeIid)!
      p.zones.runeDeck.push({ ...recycled, exhausted: false, damage: 0 })
      s.battlefields[action.toBattlefield].units.push({ ...unit, facedown: true, exhausted: true })
      recomputeControllers(s)
      return ok(log(s, action.player, `Hid a unit facedown at ${getCard(s.battlefields[action.toBattlefield].cardId)?.name ?? 'a battlefield'}.`))
    }

    case 'REVEAL': {
      const s = clone(state)
      for (const bf of s.battlefields) {
        const u = bf.units.find((x) => x.iid === action.iid && x.owner === action.player)
        if (u) {
          if (!u.facedown) return fail(state, 'That unit is already revealed.')
          u.facedown = false
          emit({ kind: 'play', iid: u.iid, player: action.player, cardId: u.cardId })
          return ok(log(s, action.player, `Revealed ${getCard(u.cardId)?.name}.`))
        }
      }
      return fail(state, 'No facedown unit of yours to reveal.')
    }

    case 'RETREAT': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      for (let i = 0; i < s.battlefields.length; i++) {
        const bf = s.battlefields[i]
        const idx = bf.units.findIndex(
          (u) => u.iid === action.iid && u.owner === action.player,
        )
        if (idx >= 0) {
          if (bfScriptAt(s, i)?.noMoveToBase)
            return fail(state, `Units can't move from ${getCard(bf.cardId)?.name ?? 'here'} to base.`)
          const [u] = bf.units.splice(idx, 1)
          bfScriptAt(s, i)?.onMoveFrom?.(u) // Back-Alley Bar: +1 Might this turn
          s.players[action.player].zones.base.push({ ...u, exhausted: true })
          recomputeControllers(s)
          return ok(log(s, action.player, `${def(u)?.name} retreated to base.`))
        }
      }
      return fail(state, 'Unit not found at any battlefield.')
    }

    case 'VISION_DECIDE': {
      if (!state.vision || state.vision.player !== action.player)
        return fail(state, 'No Vision decision pending.')
      const s = clone(state)
      const p = s.players[action.player]
      let out: MatchState
      if (action.recycle && p.zones.mainDeck.length > 0) {
        const top = p.zones.mainDeck.shift()!
        p.zones.mainDeck.push(top) // recycle to the bottom
        out = log(s, action.player, `Vision: recycled ${getCard(top.cardId)?.name ?? 'a card'} to the bottom of the deck.`)
      } else {
        out = log(s, action.player, `Vision: kept the top card.`)
      }
      return ok({ ...out, vision: undefined })
    }

    case 'READY_UNIT': {
      if (!state.readyChoice || state.readyChoice.player !== action.player)
        return fail(state, 'No unit to ready right now.')
      const s = clone(state)
      const u = findUnitAnywhere(s, action.iid)
      if (!u || u.owner !== action.player || !u.exhausted)
        return fail(state, 'Choose one of your exhausted units.')
      u.exhausted = false
      emit({ kind: 'buff', iid: u.iid, player: action.player })
      s.readyChoice = s.readyChoice!.count > 1 ? { player: action.player, count: s.readyChoice!.count - 1 } : undefined
      return ok(log(s, action.player, `Readied ${getCard(u.cardId)?.name}.`))
    }

    case 'ASSIGN_DAMAGE': {
      if (state.phase !== 'showdown' || !state.showdown?.assign)
        return fail(state, 'No damage to assign right now.')
      const asg = state.showdown.assign
      const step = asg.steps[asg.current]
      if (!step || !step.manual) return fail(state, 'No manual assignment pending.')
      if (step.dealer !== action.player) return fail(state, 'Not your damage to assign.')
      const err = validateAllocation(step, action.allocations)
      if (err) return fail(state, err)
      const s = clone(state)
      const sAsg = s.showdown!.assign!
      const cur = sAsg.steps[sAsg.current]
      cur.defeated = cur.targets.filter((iid) => (action.allocations[iid] ?? 0) >= cur.hp[iid])
      cur.manual = false // resolved
      // Advance to the next still-manual step, if any.
      let next = sAsg.current + 1
      while (next < sAsg.steps.length && !sAsg.steps[next].manual) next++
      if (next < sAsg.steps.length) {
        sAsg.current = next
        s.showdown!.priority = sAsg.steps[next].dealer
        return ok(s)
      }
      return ok(finalizeShowdown(s, s.showdown!.battlefield, sAsg.steps))
    }

    case 'PASS': {
      if (state.phase !== 'showdown' || !state.showdown)
        return fail(state, 'Nothing to pass on.')
      if (state.showdown.priority !== action.player)
        return fail(state, 'Not your priority.')
      if (state.showdown.assign) return fail(state, 'Assign combat damage first.')
      const s = clone(state)
      s.showdown!.passes += 1
      s.showdown!.priority = nextPlayer(s, action.player)
      // Resolve once everyone (attacker + all defenders) has passed.
      if (s.showdown!.passes >= s.players.length) {
        return ok(resolveShowdown(s, s.showdown!.battlefield))
      }
      return ok(s)
    }

    case 'PASS_PRIORITY': {
      if (state.chain.length === 0) return fail(state, 'No chain to pass on.')
      if (state.priority !== action.player) return fail(state, 'Not your priority.')
      let s = clone(state)
      s.passes += 1
      s.priority = nextPlayer(s, action.player)
      // All players passed in a row → resolve the top of the chain.
      if (s.passes >= s.players.length) {
        s = resolveTopOfChain(s)
        s.passes = 0
        s.priority = s.chain.length > 0 ? s.activePlayer : null
        if (s.winner !== null) return ok(s)
      }
      return ok(s)
    }

    case 'COUNTER': {
      if (state.chain.length === 0) return fail(state, 'No chain to counter.')
      if (state.priority !== action.player) return fail(state, 'Not your priority.')
      if (!state.chain.some((c) => c.id === action.targetChainId))
        return fail(state, 'No such item on the chain.')
      const sourceCard = state.players[action.player].zones.hand.find((c) => c.iid === action.iid)
      if (!sourceCard) return fail(state, 'Counter card not in hand.')
      const card = getCard(sourceCard.cardId)
      if (!card || card.type !== 'spell') return fail(state, 'A counter must be a spell.')
      if (!parseKeywords(card).reaction && !parseKeywords(card).action)
        return fail(state, 'Only Reaction/Action spells can counter.')
      const s = clone(state)
      const p = s.players[action.player]
      const ci = findInZone(p, 'hand', action.iid)!
      const err = applyPayment(p, costOf(card), action.payment)
      if (err) return fail(state, err)
      removeFromZone(p, 'hand', action.iid)
      p.cardsPlayedThisTurn = (p.cardsPlayedThisTurn ?? 0) + 1
      s.chain.push({
        id: makeChainId(),
        kind: 'counter',
        controller: action.player,
        cardId: card.id,
        instance: ci,
        payment: action.payment,
        countersId: action.targetChainId,
      })
      s.passes = 0
      s.priority = nextPlayer(s, action.player)
      return ok(log(s, action.player, `Played ${card.name} to Counter — it's on the Chain.`))
    }

    case 'END_TURN': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      let s = clone(state)
      // End-of-turn cleanup: clear "this turn" Might modifiers and Stun.
      for (const pl of s.players) {
        for (const z of Object.keys(pl.zones) as ZoneId[])
          pl.zones[z] = pl.zones[z].map((c) => ({ ...c, tempMight: 0, stunned: false }))
      }
      for (const bf of s.battlefields)
        bf.units = bf.units.map((u) => ({ ...u, tempMight: 0, stunned: false }))
      // Empty the ending player's resource pool.
      s.players[state.activePlayer].pool = { energy: 0, power: {} }
      s.activePlayer = nextPlayer(s, state.activePlayer)
      s.turn = state.turn + 1
      return ok(beginTurn(s))
    }

    case 'DRAW': {
      let s = clone(state)
      if (s.players[action.player].zones.mainDeck.length === 0) {
        s = burnOut(s, action.player)
        if (s.winner !== null) return ok(s)
      }
      const deck = s.players[action.player].zones.mainDeck
      if (deck.length > 0) {
        s.players[action.player].zones.hand.push(deck.shift()!)
        emit({ kind: 'draw', player: action.player, amount: 1 })
      }
      return ok(log(s, action.player, `${s.players[action.player].name} drew a card.`))
    }

    case 'ADD': {
      // "Add" puts resources straight into the pool. It resolves instantly and
      // cannot be reacted to — no chain item, no priority window (T14).
      const s = clone(state)
      const p = s.players[action.player]
      if (!p.pool) p.pool = { energy: 0, power: {} }
      const parts: string[] = []
      if (action.energy) {
        p.pool.energy += action.energy
        parts.push(`${action.energy} Energy`)
      }
      for (const [d, n] of Object.entries(action.power ?? {}) as [Domain, number][]) {
        if (!n) continue
        p.pool.power[d] = (p.pool.power[d] ?? 0) + n
        parts.push(`${n} ${d}`)
      }
      if (parts.length === 0) return fail(state, 'Nothing to add.')
      return ok(log(s, action.player, `Added ${parts.join(', ')} to the pool.`))
    }

    case 'BUFF_UNIT': {
      const s = clone(state)
      for (const u of [
        ...s.players[action.player].zones.base,
        ...s.battlefields.flatMap((b) => b.units),
      ]) {
        if (u.iid === action.iid && u.owner === action.player) {
          if ((u.buffs ?? 0) >= 1) return fail(state, 'A unit can have at most 1 Buff.')
          u.buffs = 1
          emit({ kind: 'buff', iid: u.iid, player: action.player })
          return ok(log(s, action.player, `Buffed ${getCard(u.cardId)?.name} (+1 Might).`))
        }
      }
      return fail(state, 'No such friendly unit to buff.')
    }

    case 'RECYCLE_RUNE': {
      const s = clone(state)
      const p = s.players[action.player]
      const rune = removeFromZone(p, 'runePool', action.iid)
      if (!rune) return fail(state, 'Rune not in your pool.')
      p.zones.runeDeck.push({ ...rune, exhausted: false, damage: 0 })
      return ok(log(s, action.player, `Recycled ${getCard(rune.cardId)?.name}.`))
    }

    case 'TRASH_CARD': {
      const s = clone(state)
      const p = s.players[action.player]
      for (const z of ['hand', 'base', 'runePool'] as ZoneId[]) {
        const c = removeFromZone(p, z, action.iid)
        if (c) {
          sendToTrash(p, c)
          return ok(log(s, action.player, `Trashed ${getCard(c.cardId)?.name}.`))
        }
      }
      for (const bf of s.battlefields) {
        const idx = bf.units.findIndex((u) => u.iid === action.iid && u.owner === action.player)
        if (idx >= 0) {
          const [c] = bf.units.splice(idx, 1)
          sendToTrash(p, c)
          recomputeControllers(s)
          return ok(log(s, action.player, `Trashed ${getCard(c.cardId)?.name}.`))
        }
      }
      return fail(state, 'No such card to trash.')
    }

    case 'REVEAL_TOP': {
      const top = state.players[action.player].zones.mainDeck[0]
      if (!top) return fail(state, 'Your deck is empty.')
      return ok(log(clone(state), action.player, `Revealed top of deck: ${getCard(top.cardId)?.name}.`))
    }

    case 'CONCEDE': {
      // The conceding player drops; if one player remains they win, otherwise
      // the current points leader among the rest is declared the winner.
      const remaining = state.players.filter((p) => p.id !== action.player)
      const winner = remaining.reduce((a, b) => (b.points > a.points ? b : a))
      return ok(endGame(state, winner.id))
    }

    default:
      return fail(state, 'Unknown action.')
  }
}

/** Common guard: must be the active player's action phase. */
function requireActiveAction(state: MatchState, player: PlayerId): string | null {
  if (state.chain.length > 0)
    return 'The chain is open — pass priority or respond first.'
  if (state.phase === 'showdown')
    return 'A showdown is open — pass or respond first.'
  if (state.phase !== 'action') return 'Not the action phase.'
  if (state.activePlayer !== player) return 'Not your turn.'
  return null
}

// ---------------------------------------------------------------------------
// Read-only validity API (UI-facing). These mirror the guards inside the PLAY
// handler so the interface can grey out unplayable cards, gate spells that have
// no legal target, and highlight only legal targets — without mutating state.
// The PLAY handler remains the canonical authority; these never diverge in a
// way that lets an illegal play through (they are a superset of its rejections).
// ---------------------------------------------------------------------------

/** Every unit currently in play (all battlefields + every player's base). */
function unitsInPlay(s: MatchState): EngineCard[] {
  return [
    ...s.battlefields.flatMap((b) => b.units),
    ...s.players.flatMap((p) => p.zones.base),
  ]
}

/** True if `iid` is still a unit in play — used to re-validate a spell's chosen
 *  target at resolution (a target may have left play while on the chain). */
export function isValidTarget(state: MatchState, iid: string): boolean {
  return unitsInPlay(state).some((u) => u.iid === iid)
}

/** The unit iids a card may legally target right now, honoring the effect's
 *  target scope (enemy / friendly / any) and whether it must be at a
 *  battlefield. Pass `player` (the caster) to apply enemy/friendly filtering. */
export function getLegalTargets(state: MatchState, card: Card, player?: PlayerId): string[] {
  if (!needsTarget(card)) return []
  const e = spellEffect(card)
  let units = e.battlefieldOnly ? state.battlefields.flatMap((b) => b.units) : unitsInPlay(state)
  if (player != null) {
    if (e.targetScope === 'enemy') units = units.filter((u) => u.owner !== player)
    else if (e.targetScope === 'friendly') units = units.filter((u) => u.owner === player)
  }
  return units.map((u) => u.iid)
}

export interface PlayCheck {
  /** True if the card can be played from its current zone right now. */
  valid: boolean
  /** Why not, when invalid (suitable for a tooltip). */
  reason?: string
  /** True when the card is a spell that will require a target selection. */
  needsTarget?: boolean
  /** True when the spell targets but no target exists, yet it has a non-target
   *  part (e.g. "draw 1") — it can be played to resolve only that part. */
  targetOptional?: boolean
}

/** Can `player` play the card instance `iid` (from hand or Champion Zone) right
 *  now? Mirrors the PLAY handler: zone/type, timing (chain/showdown/action),
 *  affordability, and — for damage spells — that at least one legal target
 *  exists. Read-only. */
export function canPlay(state: MatchState, player: PlayerId, iid: string): PlayCheck {
  const p = state.players[player]
  const fromChampion = p.champion?.iid === iid
  const src = fromChampion ? p.champion : p.zones.hand.find((c) => c.iid === iid)
  if (!src) return { valid: false, reason: 'Not in your hand.' }
  const card = getCard(src.cardId)
  if (!card) return { valid: false, reason: 'Unknown card.' }
  const type = card.type
  if (type !== 'unit' && type !== 'spell' && type !== 'gear')
    return { valid: false, reason: 'Not a playable card.' }

  const kw = parseKeywords(card)
  const inShowdown = state.phase === 'showdown' && !!state.showdown
  const chainOpen = state.chain.length > 0

  // Timing — same branches the PLAY handler enforces.
  if (type === 'spell' && chainOpen) {
    if (state.priority !== player) return { valid: false, reason: 'Not your priority.' }
    if (!(kw.reaction || kw.action))
      return { valid: false, reason: 'Only Reaction/Action spells can respond to the chain.' }
  } else if (type === 'spell' && inShowdown) {
    if (!((kw.reaction || kw.action) && state.showdown!.priority === player))
      return { valid: false, reason: 'Only a Reaction/Action spell at your priority during a showdown.' }
  } else if (type === 'gear' && kw.quickDraw && chainOpen) {
    if (state.priority !== player) return { valid: false, reason: 'Not your priority.' }
  } else if (type === 'gear' && kw.quickDraw && inShowdown) {
    if (state.showdown!.priority !== player)
      return { valid: false, reason: 'Not your priority during the showdown.' }
  } else if (type === 'unit' && kw.ambush && (chainOpen || inShowdown)) {
    // Ambush: playable at Reaction speed if you hold priority and have a
    // battlefield where you already have units.
    const pr = chainOpen ? state.priority : state.showdown!.priority
    if (pr !== player) return { valid: false, reason: 'Not your priority for Ambush.' }
    if (!state.battlefields.some((bf) => bf.units.some((u) => u.owner === player)))
      return { valid: false, reason: 'Ambush needs a battlefield where you have units.' }
  } else {
    const guard = requireActiveAction(state, player)
    if (guard) return { valid: false, reason: guard }
  }

  // Affordability.
  if (!canAfford(p, card)) return { valid: false, reason: 'Not enough resources.' }

  // A spell that targets but has nothing to hit: still playable if it has a
  // non-target part (resolve only that); otherwise it can't be played.
  const wantsTarget = needsTarget(card)
  if (wantsTarget && getLegalTargets(state, card, player).length === 0) {
    if (type === 'spell' && hasUntargetedPart(spellEffect(card)))
      return { valid: true, needsTarget: false, targetOptional: true }
    return { valid: false, reason: 'No legal target in play.' }
  }

  return { valid: true, needsTarget: wantsTarget }
}
