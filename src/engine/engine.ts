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
import { RULES, TOKEN_PILE_IDS } from './setup'
import { parseKeywords } from './keywords'
import { spellEffect, onPlayEffect, type ParsedEffect } from './effects'

// ---------------------------------------------------------------------------
// Pure engine: reduce(state, action) -> { state, error? }
//
// Enforces the structural game. Combat is a deliberately simplified
// total-might model (clearly marked) pending finalized comprehensive rules;
// the surrounding flow (phases, payment, zones, scoring, win) is complete.
// ---------------------------------------------------------------------------

// --- immutable helpers -----------------------------------------------------

let tokenCounter = 0

function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    legend: p.legend ? { ...p.legend } : null,
    champion: p.champion ? { ...p.champion } : null,
    tokenPile: [...p.tokenPile],
    zones: {
      mainDeck: [...p.zones.mainDeck],
      runeDeck: [...p.zones.runeDeck],
      hand: [...p.zones.hand],
      base: [...p.zones.base],
      runePool: [...p.zones.runePool],
      trash: [...p.zones.trash],
    },
  }
}

function clone(s: MatchState): MatchState {
  return {
    ...s,
    players: s.players.map(clonePlayer),
    battlefields: s.battlefields.map((b) => ({ ...b, units: [...b.units] })),
    showdown: s.showdown ? { ...s.showdown } : null,
    log: s.log,
    seq: s.seq + 1,
  }
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

/** Deal `amount` damage to a target unit anywhere; defeat it if lethal. */
function applyTargetDamage(s: MatchState, targetIid: string, amount: number): void {
  for (let i = 0; i < s.battlefields.length; i++) {
    const bf = s.battlefields[i]
    const u = bf.units.find((x) => x.iid === targetIid)
    if (u) {
      u.damage += amount
      if (u.damage >= mightOf(u)) {
        bf.units = bf.units.filter((x) => x.iid !== targetIid)
        s.players[u.owner].zones.trash.push({ ...u, damage: 0 })
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
        p.zones.trash.push({ ...u, damage: 0 })
      }
      return
    }
  }
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

  // Awaken: ready everything the active player controls.
  if (p.legend) p.legend.exhausted = false
  for (const z of Object.keys(p.zones) as ZoneId[])
    p.zones[z] = p.zones[z].map((c) => ({ ...c, exhausted: false }))
  for (const bf of s.battlefields)
    bf.units = bf.units.map((u) => (u.owner === ap ? { ...u, exhausted: false } : u))
  s = log(s, ap, `— Turn ${s.turn}: ${p.name} · Awaken —`)

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
      for (const u of expired) p.zones.trash.push({ ...u, damage: 0 })
      s = log(s, ap, `${expired.length} Temporary unit(s) expired.`)
    }
  }
  for (const u of p.zones.base.filter(
    (u) => parseKeywords(def(u)).temporary && (u.enteredTurn ?? 0) < s.turn,
  )) {
    p.zones.base = p.zones.base.filter((x) => x.iid !== u.iid)
    p.zones.trash.push({ ...u, damage: 0 })
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

  // Draw — with Burn Out: drawing from an empty deck gives the next player +1.
  for (let i = 0; i < RULES.drawPerTurn; i++) {
    if (p.zones.mainDeck.length > 0) {
      p.zones.hand.push(p.zones.mainDeck.shift()!)
    } else {
      const beneficiary = nextPlayer(s, ap)
      s = log(s, ap, `${p.name} burned out (empty deck).`)
      s = awardPoints(s, beneficiary, 1, 'scored from Burn Out', 'hold')
      if (s.winner !== null) return s
    }
  }

  s.phase = 'action'
  return s
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
  let m = d.might - ci.damage + gearMight(ci)
  if (role === 'attacker') m += k.assault
  if (role === 'defender') m += k.shield
  return Math.max(0, m)
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
  const attackMight = attackers.reduce((a, u) => a + mightOf(u, 'attacker'), 0)
  const defendMight = defenders.reduce((a, u) => a + mightOf(u, 'defender'), 0)

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
      s.players[u.owner].zones.trash.push({ ...u, damage: 0, exhausted: false })
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
  s.showdown = null
  s.phase = 'action'

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
  }
  return s
}

// --- main reducer ----------------------------------------------------------

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

      // Timing: normal plays need your action phase. Reaction/Action spells may
      // be played during a showdown by the player holding priority.
      const kwTiming = parseKeywords(card)
      const inShowdown = state.phase === 'showdown' && state.showdown
      const mayReact =
        action.type === 'PLAY_SPELL' &&
        inShowdown &&
        (kwTiming.reaction || kwTiming.action) &&
        state.showdown!.priority === action.player
      if (!mayReact) {
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

      if (action.type === 'PLAY_UNIT') {
        // Accelerate units enter ready; others enter exhausted.
        p.zones.base.push({ ...ci, exhausted: !kw.accelerate, enteredTurn: s.turn })
        let s1 = log(
          s,
          action.player,
          `Played ${card.name}${kw.accelerate ? ' (ready · Accelerate)' : ''}.`,
        )
        const e = onPlayEffect(card)
        for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
        if (kw.vision) s1 = log(s1, action.player, `Vision — may recycle the top of your deck (manual).`)
        if (e.manual && !e.draw && !e.channel && !e.recruits)
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

      // Spell: apply common effects, then trash.
      const e = spellEffect(card)
      let s1 = s
      for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
      if (e.damage) {
        const target = action.targets?.[0]
        if (target) {
          applyTargetDamage(s1, target, e.damage)
          s1 = log(s1, action.player, `${card.name} dealt ${e.damage} to a unit.`)
        } else {
          s1 = log(s1, action.player, `${card.name}: choose a target (resolve manually).`)
        }
      }
      if (e.manual && !e.draw && !e.channel && !e.damage && !e.recruits)
        s1 = log(s1, action.player, `Cast ${card.name} — resolve its effect manually.`)
      p.zones.trash.push({ ...ci })
      return ok(s1)
    }

    case 'MOVE_UNIT': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      if (action.toBattlefield < 0 || action.toBattlefield >= state.battlefields.length)
        return fail(state, 'Invalid battlefield.')
      const prevController = state.battlefields[action.toBattlefield].controller
      const s = clone(state)
      const p = s.players[action.player]
      // Move from base, or from another battlefield if the unit has Ganking.
      let unit = removeFromZone(p, 'base', action.iid)
      let fromBattlefield = -1
      if (!unit) {
        for (let i = 0; i < s.battlefields.length; i++) {
          if (i === action.toBattlefield) continue
          const idx = s.battlefields[i].units.findIndex(
            (u) => u.iid === action.iid && u.owner === action.player,
          )
          if (idx >= 0) {
            if (!parseKeywords(def(s.battlefields[i].units[idx])).ganking)
              return fail(state, 'Only units with Ganking can move between battlefields.')
            unit = s.battlefields[i].units.splice(idx, 1)[0]
            fromBattlefield = i
            break
          }
        }
      }
      if (!unit) return fail(state, 'Unit not found at your base.')
      if (unit.exhausted) {
        if (fromBattlefield >= 0) s.battlefields[fromBattlefield].units.push(unit)
        else p.zones.base.push(unit)
        return fail(state, 'Unit is exhausted.')
      }
      unit.exhausted = true
      const bf = s.battlefields[action.toBattlefield]
      bf.units.push(unit)
      recomputeControllers(s)
      const contested = bf.units.some((u) => u.owner !== action.player)
      let s2 = log(
        s,
        action.player,
        `Moved ${def(unit)?.name} to ${getCard(bf.cardId)?.name ?? 'battlefield'}.`,
      )
      if (contested) {
        s2.phase = 'showdown'
        s2.showdown = {
          battlefield: action.toBattlefield,
          priority: nextPlayer(s2, action.player),
          passes: 0,
          movedUnit: unit.iid,
        }
        s2 = log(s2, action.player, 'Showdown opened — opponents may respond.')
      } else if (
        s2.battlefields[action.toBattlefield].controller === action.player &&
        prevController !== action.player
      ) {
        // Uncontested takeover of a battlefield you didn't hold = Conquer.
        s2 = awardPoints(
          s2,
          action.player,
          RULES.pointsPerConquer,
          `conquered ${getCard(bf.cardId)?.name ?? 'battlefield'}`,
          'conquer',
        )
      }
      return ok(s2)
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

    case 'END_TURN': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      let s = clone(state)
      s.activePlayer = nextPlayer(s, state.activePlayer)
      s.turn = state.turn + 1
      return ok(beginTurn(s))
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
  if (state.phase === 'showdown')
    return 'A showdown is open — pass or respond first.'
  if (state.phase !== 'action') return 'Not the action phase.'
  if (state.activePlayer !== player) return 'Not your turn.'
  return null
}
