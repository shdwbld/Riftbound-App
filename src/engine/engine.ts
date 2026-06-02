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
import { RULES, shuffle } from './setup'

// ---------------------------------------------------------------------------
// Pure engine: reduce(state, action) -> { state, error? }
//
// Enforces the structural game. Combat is a deliberately simplified
// total-might model (clearly marked) pending finalized comprehensive rules;
// the surrounding flow (phases, payment, zones, scoring, win) is complete.
// ---------------------------------------------------------------------------

// --- immutable helpers -----------------------------------------------------

function clonePlayer(p: PlayerState): PlayerState {
  return {
    ...p,
    legend: p.legend ? { ...p.legend } : null,
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

  const used = new Set<string>()
  // Energy: each exhaust target must be a ready rune in the pool.
  for (const iid of payment.exhaust) {
    if (used.has(iid)) return 'A rune was used twice.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Energy rune not in your pool.'
    if (rune.exhausted) return 'Energy rune is already exhausted.'
    used.add(iid)
  }
  // Power: greedily match recycled runes to colored requirements.
  const recycled: EngineCard[] = []
  for (const iid of payment.recycle) {
    if (used.has(iid)) return 'A rune was used twice.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Power rune not in your pool.'
    if (rune.exhausted) return 'Power rune is already exhausted.'
    used.add(iid)
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

  // Draw.
  let drew = 0
  for (let i = 0; i < RULES.drawPerTurn && p.zones.mainDeck.length > 0; i++) {
    p.zones.hand.push(p.zones.mainDeck.shift()!)
    drew++
  }
  if (drew) s = log(s, ap, `Drew ${drew} card(s).`)

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

/** Award conquer point(s) to a player and check for the win.
 *  NOTE: the special "8th point" restriction is not yet enforced (flagged). */
function awardPoints(
  s: MatchState,
  player: PlayerId,
  amount: number,
  reason: string,
): MatchState {
  s.players[player].points += amount
  let next = log(s, player, `${s.players[player].name} ${reason} (+${amount}).`)
  if (next.players[player].points >= next.pointsToWin) next = endGame(next, player)
  return next
}

// --- combat (simplified total-might model) ---------------------------------

function mightOf(ci: EngineCard): number {
  const d = def(ci)
  const base = d && isUnit(d) ? d.might : 0
  // Attached gear granting flat +might is left for per-card scripting; here we
  // apply only marked damage reduction.
  return Math.max(0, base - ci.damage)
}

/** Assign `damage` total across `units` in kill-order (fill one to lethal,
 *  then the next). Returns the iids that are defeated. */
function assignDamage(damage: number, units: EngineCard[]): Set<string> {
  const defeated = new Set<string>()
  let remaining = damage
  for (const u of units) {
    if (remaining <= 0) break
    const hp = mightOf(u)
    if (hp <= 0) continue
    if (remaining >= hp) {
      defeated.add(u.iid)
      remaining -= hp
    } else {
      // partial damage doesn't defeat; cleared after combat anyway
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
  const attackMight = attackers.reduce((a, u) => a + mightOf(u), 0)
  const defendMight = defenders.reduce((a, u) => a + mightOf(u), 0)

  // Simultaneous: compute defeats from pre-combat might.
  const defendersDefeated = assignDamage(attackMight, defenders)
  const attackersDefeated = assignDamage(defendMight, attackers)

  const survivors: EngineCard[] = []
  for (const u of bf.units) {
    const dead =
      (u.owner !== moverOwner && defendersDefeated.has(u.iid)) ||
      (u.owner === moverOwner && attackersDefeated.has(u.iid))
    if (dead) s.players[u.owner].zones.trash.push({ ...u, damage: 0, exhausted: false })
    else survivors.push({ ...u, damage: 0 })
  }
  bf.units = survivors
  const lost = defendersDefeated.size + attackersDefeated.size
  s = log(
    s,
    moverOwner,
    `Showdown at ${bfName}: ${attackMight} vs ${defendMight} Might — ${lost} unit(s) defeated.`,
  )

  recomputeControllers(s)
  s.showdown = null
  s.phase = 'action'

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`)
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
      let s = clone(state)
      const p = s.players[action.player]
      if (p.mulliganed) return fail(state, 'Already decided your hand.')
      if (action.redraw) {
        p.zones.mainDeck = shuffle([...p.zones.mainDeck, ...p.zones.hand])
        p.zones.hand = p.zones.mainDeck.splice(0, RULES.openingHand)
        s = log(s, action.player, `${p.name} mulliganed.`)
      } else {
        s = log(s, action.player, `${p.name} kept.`)
      }
      p.mulliganed = true
      if (s.players.every((pl) => pl.mulliganed)) {
        return ok(beginTurn(s))
      }
      return ok(s)
    }

    case 'PLAY_UNIT':
    case 'PLAY_GEAR':
    case 'PLAY_SPELL': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const s = clone(state)
      const p = s.players[action.player]
      const ci = findInZone(p, 'hand', action.iid)
      if (!ci) return fail(state, 'Card not in hand.')
      const card = def(ci)
      if (!card) return fail(state, 'Unknown card.')
      const expected =
        action.type === 'PLAY_UNIT'
          ? 'unit'
          : action.type === 'PLAY_GEAR'
            ? 'gear'
            : 'spell'
      if (card.type !== expected) return fail(state, `That card is not a ${expected}.`)

      const err = applyPayment(p, costOf(card), action.payment)
      if (err) return fail(state, err)

      removeFromZone(p, 'hand', action.iid)
      if (action.type === 'PLAY_UNIT') {
        // Units enter exhausted (no Accelerate keyword handling yet).
        p.zones.base.push({ ...ci, exhausted: true })
        return ok(log(s, action.player, `Played ${card.name} to base (exhausted).`))
      }
      if (action.type === 'PLAY_GEAR') {
        // Attach to a target unit if provided, else park at base.
        p.zones.base.push({ ...ci })
        return ok(log(s, action.player, `Played gear ${card.name}.`))
      }
      // Spell: pay, then trash. Card-specific effects are logged for manual
      // resolution (full scripting is out of scope).
      p.zones.trash.push({ ...ci })
      return ok(
        log(s, action.player, `Cast ${card.name}. (Resolve its effect manually.)`),
      )
    }

    case 'MOVE_UNIT': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      if (action.toBattlefield < 0 || action.toBattlefield >= state.battlefields.length)
        return fail(state, 'Invalid battlefield.')
      const prevController = state.battlefields[action.toBattlefield].controller
      const s = clone(state)
      const p = s.players[action.player]
      const unit = removeFromZone(p, 'base', action.iid)
      if (!unit) return fail(state, 'Unit not at your base.')
      if (unit.exhausted) {
        p.zones.base.push(unit)
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
