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
  ok,
  fail,
} from './types'
import { RULES, TOKEN_PILE_IDS, shuffle } from './setup'
import { parseKeywords } from './keywords'
import { spellEffect, onPlayEffect, type ParsedEffect } from './effects'
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
  const requiredEnergy = cost.energy
  const requiredPower: Partial<Record<Domain, number>> = { ...cost.power }
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

/** Apply the auto-resolvable parts of a parsed effect to `p`; returns log text. */
function applyParsed(s: MatchState, p: PlayerState, e: ParsedEffect): string[] {
  const lines: string[] = []
  if (e.draw) lines.push(`Drew ${drawN(p, e.draw)}.`)
  if (e.channel) lines.push(`Channeled ${channelN(p, e.channel)}.`)
  if (e.recruits) lines.push(`Created ${spawnRecruits(p, e.recruits, s.turn)} Recruit(s).`)
  return lines
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
  return s
}

/** Deal `amount` damage to a target unit anywhere; defeat it if lethal. */
function applyTargetDamage(s: MatchState, targetIid: string, amount: number): void {
  for (let i = 0; i < s.battlefields.length; i++) {
    const bf = s.battlefields[i]
    const u = bf.units.find((x) => x.iid === targetIid)
    if (u) {
      u.damage += amount
      if (u.damage >= mightOf(u)) {
        bf.units = bf.units.filter((x) => x.iid !== targetIid)
        sendToTrash(s.players[u.owner], u)
      }
      recomputeControllers(s)
      return
    }
  }
  for (const p of s.players) {
    const u = p.zones.base.find((x) => x.iid === targetIid)
    if (u) {
      u.damage += amount
      if (u.damage >= mightOf(u)) {
        p.zones.base = p.zones.base.filter((x) => x.iid !== targetIid)
        sendToTrash(p, u)
      }
      return
    }
  }
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
          if (!parseKeywords(def(s.battlefields[i].units[idx])).ganking)
            return fail(state, 'Only units with Ganking can move between battlefields.')
          unit = s.battlefields[i].units.splice(idx, 1)[0]
          break
        }
      }
    }
    if (!unit) return fail(state, 'Unit not found at your base.')
    if (unit.exhausted) return fail(state, `${def(unit)?.name} is exhausted.`)
    unit.exhausted = true
    s.battlefields[toBattlefield].units.push(unit)
    moved.push(unit)
  }
  recomputeControllers(s)
  const bf = s.battlefields[toBattlefield]
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
  let s2 = log(s, player, `Moved ${moved.length} unit(s) to ${bfName}.`)
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
    s2 = applyConquerPassive(s2, player, toBattlefield)
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

  // Reset per-turn counters (LEGION).
  p.cardsPlayedThisTurn = 0

  // Awaken: ready everything the active player controls.
  if (p.legend) p.legend.exhausted = false
  for (const z of Object.keys(p.zones) as ZoneId[])
    p.zones[z] = p.zones[z].map((c) => ({ ...c, exhausted: false }))
  for (const bf of s.battlefields)
    bf.units = bf.units.map((u) => (u.owner === ap ? { ...u, exhausted: false } : u))
  s = log(s, ap, `— Turn ${s.turn}: ${p.name} · Awaken —`)

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

  // Score: 1 point per held battlefield (skip the very first turn).
  recomputeControllers(s)
  if (s.turn > 1) {
    const held = s.battlefields.filter((b) => b.controller === ap).length
    if (held > 0) {
      p.points += held * RULES.pointsPerBattlefield
      s = log(s, ap, `Scored ${held} point(s) (holding ${held} battlefield(s)).`)
    }
  }

  // Battlefield "when you hold here" passives for the active player.
  for (const bf of s.battlefields) {
    if (bf.controller !== ap) continue
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

  // Channel runes. In 1v1, the player going second channels +1 on turn 1.
  const isSecondPlayersFirstTurn =
    s.players.length === 2 && ap !== s.firstPlayer && s.turn <= 2
  const channelCount = isSecondPlayersFirstTurn
    ? RULES.channelSecondPlayerFirstTurn
    : RULES.channelPerTurn
  let channeled = 0
  for (let i = 0; i < channelCount && p.zones.runeDeck.length > 0; i++) {
    const r = p.zones.runeDeck.shift()!
    p.zones.runePool.push({ ...r, exhausted: false })
    channeled++
  }
  if (channeled) s = log(s, ap, `Channeled ${channeled} rune(s).`)

  // Draw — empty deck triggers Burn Out (reshuffle Trash, opponent scores).
  for (let i = 0; i < RULES.drawPerTurn; i++) {
    if (s.players[ap].zones.mainDeck.length === 0) {
      s = burnOut(s, ap)
      if (s.winner !== null) return s
    }
    const deck = s.players[ap].zones.mainDeck
    if (deck.length > 0) s.players[ap].zones.hand.push(deck.shift()!)
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
  let next = log(s, player, `${p.name} ${reason} (+${amount}).`)
  if (next.players[player].points >= next.pointsToWin) next = endGame(next, player)
  return next
}

// --- combat (simplified total-might model) ---------------------------------

type CombatRole = 'attacker' | 'defender' | null

/** A unit's effective Might in a given combat role, including Assault/Shield
 *  keyword bonuses, attached-gear bonuses, and marked damage. Backline units
 *  don't fight on the frontline (0). */
function mightOf(ci: EngineCard, role: CombatRole = null): number {
  const d = def(ci)
  if (!d || !isUnit(d)) return 0
  const k = parseKeywords(d)
  if (k.backline) return 0
  let m = d.might - ci.damage + gearMight(ci) + (ci.buffs ?? 0) + (ci.tempMight ?? 0)
  if (role === 'attacker') m += k.assault
  if (role === 'defender') m += k.shield
  return Math.max(0, m)
}

/** Combat damage a unit DEALS — 0 if Stunned (it still keeps Might to survive). */
function damageOutput(ci: EngineCard, role: CombatRole): number {
  return ci.stunned ? 0 : mightOf(ci, role)
}

/** Mighty: a unit with effective Might >= 5. */
export function isMighty(ci: EngineCard): boolean {
  return mightOf(ci) >= 5
}

/** A unit's current displayed Might (base + buffs + gear + temp − damage). */
export function displayMight(ci: EngineCard): number {
  const d = getCard(ci.cardId)
  if (!d || d.type !== 'unit') return 0
  return Math.max(0, d.might + (ci.buffs ?? 0) + (ci.tempMight ?? 0) + gearMight(ci) - ci.damage)
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
    const m = t.match(/\+(\d+)\s*Might/i)
    if (m) bonus += parseInt(m[1], 10)
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
): Set<string> {
  const defeated = new Set<string>()
  let remaining = damage
  for (const u of units) {
    if (remaining <= 0) break
    const hp = mightOf(u, role)
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

/**
 * Resolve a combat showdown at a battlefield. Both sides deal damage equal to
 * their total Might SIMULTANEOUSLY, assigned in kill-order; units with lethal
 * damage are defeated to the trash. Control then resolves by presence; the
 * mover conquers (and scores) if they end up sole controller.
 * (Tank/keyword-driven assignment order is not yet modeled — flagged.)
 */
function resolveShowdown(state: MatchState, bfIndex: number): MatchState {
  let s = clone(state)
  const bf = s.battlefields[bfIndex]
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'

  const mover = s.showdown?.movedUnit
  const moverOwner = bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer
  const prevController = state.battlefields[bfIndex].controller

  // Free-for-all: the mover is the attacker; everyone else at the battlefield
  // defends as a combined force.
  const attackers = bf.units.filter((u) => u.owner === moverOwner)
  const defenders = bf.units.filter((u) => u.owner !== moverOwner)
  // Damage DEALT uses damageOutput (Stun → 0); survival uses mightOf (in assignDamage).
  const attackMight = attackers.reduce((a, u) => a + damageOutput(u, 'attacker'), 0)
  const defendMight = defenders.reduce((a, u) => a + damageOutput(u, 'defender'), 0)

  // Simultaneous: compute defeats from pre-combat might, Tank-first ordering.
  const defendersDefeated = assignDamage(attackMight, damageOrder(defenders), 'defender')
  const attackersDefeated = assignDamage(defendMight, damageOrder(attackers), 'attacker')

  const survivors: EngineCard[] = []
  const deathknells: EngineCard[] = []
  for (const u of bf.units) {
    const dead =
      (u.owner !== moverOwner && defendersDefeated.has(u.iid)) ||
      (u.owner === moverOwner && attackersDefeated.has(u.iid))
    if (dead) {
      sendToTrash(s.players[u.owner], u)
      if (parseKeywords(def(u)).deathknell) deathknells.push(u)
    } else survivors.push({ ...u, damage: 0 })
  }
  bf.units = survivors
  const lost = defendersDefeated.size + attackersDefeated.size
  s = log(
    s,
    moverOwner,
    `Showdown at ${bfName}: ${attackMight} vs ${defendMight} Might — ${lost} unit(s) defeated.`,
  )
  // Deathknell: auto-resolve recruit-spawning death triggers.
  for (const u of deathknells) {
    const dcard = def(u)
    const e = dcard ? spellEffect(dcard) : null
    if (e?.recruits) {
      spawnRecruits(s.players[u.owner], e.recruits, s.turn)
      s = log(s, u.owner, `Deathknell: ${dcard?.name} created ${e.recruits} Recruit(s).`)
    } else {
      s = log(s, u.owner, `Deathknell: ${dcard?.name} — resolve its dying effect.`)
    }
  }

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

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    s = applyConquerPassive(s, moverOwner, bfIndex)
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
  for (const line of applyParsed(s, p, e)) s = log(s, controller, line)
  if (e.damage) {
    const t = targets?.[0]
    if (t) {
      applyTargetDamage(s, t, e.damage)
      s = log(s, controller, `${card.name} dealt ${e.damage} to a unit.`)
    } else {
      s = log(s, controller, `${card.name}: choose a target (resolve manually).`)
    }
  }
  if (e.manual && !e.draw && !e.channel && !e.damage && !e.recruits)
    s = log(s, controller, `Cast ${card.name} — resolve its effect manually.`)
  return s
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

export function reduce(state: MatchState, action: Action): EngineResult {
  if (state.winner !== null && action.type !== 'CONCEDE')
    return fail(state, 'The game is over.')

  switch (action.type) {
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
      } else {
        const guard = requireActiveAction(state, action.player)
        if (guard) return fail(state, guard)
      }

      const s = clone(state)
      const p = s.players[action.player]
      const ci = fromChampion ? p.champion! : findInZone(p, 'hand', action.iid)!

      const err = applyPayment(p, costOf(card), action.payment)
      if (err) return fail(state, err)

      if (fromChampion) p.champion = null
      else removeFromZone(p, 'hand', action.iid)
      const kw = parseKeywords(card)
      // LEGION is "on" if you already played another Main Deck card this turn.
      const legionActive = (p.cardsPlayedThisTurn ?? 0) >= 1
      p.cardsPlayedThisTurn = (p.cardsPlayedThisTurn ?? 0) + 1

      if (action.type === 'PLAY_UNIT') {
        // Accelerate units enter ready; others enter exhausted.
        p.zones.base.push({ ...ci, exhausted: !kw.accelerate, enteredTurn: s.turn })
        let s1 = log(
          s,
          action.player,
          `Played ${card.name}${kw.accelerate ? ' (ready · Accelerate)' : ''}.`,
        )
        const e = onPlayEffect(card)
        const legionGated = kw.legion && !legionActive
        if (!legionGated) {
          for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
        } else {
          s1 = log(s1, action.player, `${card.name}: Legion inactive (no prior card this turn).`)
        }
        if (kw.vision) s1 = log(s1, action.player, `Vision — may recycle the top of your deck (manual).`)
        if (e.manual && !e.draw && !e.channel && !e.recruits && !legionGated)
          s1 = log(s1, action.player, `${card.name}: resolve its ability manually.`)
        return ok(s1)
      }

      if (action.type === 'PLAY_GEAR') {
        // Attach to a target unit (granting its bonuses) if given, else base.
        if (action.targetIid) {
          for (const u of p.zones.base.concat(s.battlefields.flatMap((b) => b.units)))
            if (u.iid === action.targetIid && u.owner === action.player) {
              u.attached = [...u.attached, `${card.id}|${ci.iid}`]
              return ok(log(s, action.player, `Equipped ${card.name} to ${getCard(u.cardId)?.name}.`))
            }
        }
        p.zones.base.push({ ...ci })
        return ok(log(s, action.player, `Played gear ${card.name} (unattached).`))
      }

      // Spell. In a showdown we resolve immediately (legacy path). In the
      // action phase the spell goes on the Chain and opens a priority window.
      if (inShowdown) {
        let s1 = resolveSpellEffects(s, action.player, card, action.targets)
        sendToTrash(s1.players[action.player], ci)
        return ok(s1)
      }
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
      return ok(
        log(s, action.player, `Played ${card.name} — it's on the Chain (opponents may respond).`),
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
      return ok(log(s, action.player, `Stunned ${getCard(target.cardId)?.name}.`))
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
          const [u] = bf.units.splice(idx, 1)
          s.players[action.player].zones.base.push({ ...u, exhausted: true })
          recomputeControllers(s)
          return ok(log(s, action.player, `${def(u)?.name} retreated to base.`))
        }
      }
      return fail(state, 'Unit not found at any battlefield.')
    }

    case 'PASS': {
      if (state.phase !== 'showdown' || !state.showdown)
        return fail(state, 'Nothing to pass on.')
      if (state.showdown.priority !== action.player)
        return fail(state, 'Not your priority.')
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
      if (deck.length > 0) s.players[action.player].zones.hand.push(deck.shift()!)
      return ok(log(s, action.player, `${s.players[action.player].name} drew a card.`))
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
