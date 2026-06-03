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
import { RULES, TOKEN_PILE_IDS, GOLD_TOKEN_ID, TOKEN_BY_NAME, shuffle } from './setup'
import { parseKeywords, keywordsAt, accelerateCost, repeatCost, levelBonus } from './keywords'
import { addCost, costOf, effectiveCostOf, autoPayEff, autoPay, costIsFree } from './autopay'
import { bfScript, bfScriptAt, battlefieldOf, type BfApi } from './battlefieldScripts'

/** How many turns the given player has taken (incl. the current one). */
function playerTurnOrdinal(s: MatchState, player: PlayerId): number {
  const rank = (player - s.firstPlayer + s.players.length) % s.players.length
  return Math.floor((s.turn - 1 - rank) / s.players.length) + 1
}
import { spellEffect, onPlayEffect, endOfTurnEffect, needsTarget, hasUntargetedPart, hasTargetedPart, isCopySpell, parseEffectText, type ParsedEffect } from './effects'
import { triggersFor, parseTriggers, orderTriggers, type TriggerEvent, type FiredTrigger } from './triggers'
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

/** Next seat in turn order (wraps around the table), skipping players who are
 *  out of the match (conceded / eliminated). */
const nextPlayer = (s: MatchState, p: PlayerId): PlayerId => {
  const n = s.players.length
  let q = (p + 1) % n
  for (let i = 0; i < n && s.players[q].out; i++) q = (q + 1) % n
  return q
}

/** Number of players still in the match (a chain resolves once all of them pass). */
const aliveCount = (s: MatchState): number =>
  s.players.reduce((n, p) => n + (p.out ? 0 : 1), 0)

/** Seats taking part in a showdown: the combatants (owners of units at the
 *  battlefield) plus any invited helpers who accepted. Unlike a chain — where
 *  ANY player may react — a showdown is private to its combatants, so only
 *  these players get a priority window. */
function showdownParticipants(s: MatchState): PlayerId[] {
  const sd = s.showdown
  if (!sd) return []
  const combatants = s.battlefields[sd.battlefield].units.map((u) => u.owner)
  return [...new Set([...combatants, ...(sd.helpers ?? [])])].filter((p) => !s.players[p].out)
}

/** Next showdown participant in seat order after `p` (wraps the table). */
function nextShowdownPriority(s: MatchState, p: PlayerId): PlayerId {
  const parts = showdownParticipants(s)
  if (parts.length === 0) return p
  const sorted = [...parts].sort((a, b) => a - b)
  return sorted.find((x) => x > p) ?? sorted[0]
}
const def = (ci: EngineCard): Card | undefined => getCard(ci.cardId)

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
  // ALSO appear in `recycle` â€” exhaust for energy, then recycle for power.)
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

function channelN(p: PlayerState, n: number, exhausted = false): number {
  let ch = 0
  for (let i = 0; i < n && p.zones.runeDeck.length > 0; i++) {
    p.zones.runePool.push({ ...p.zones.runeDeck.shift()!, exhausted })
    ch++
  }
  return ch
}

/** Send a card to a player's Trash as it leaves play. Tokens cease to exist
 *  (they don't go to the Trash), and buffs/temp modifiers are cleared. */
function sendToTrash(p: PlayerState, card: EngineCard): void {
  if (getCard(card.cardId)?.supertype === 'token' || card.token) return // tokens cease to exist
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

/** Create N copies of a named unit token (Sprite / Sand Soldier / Bird / Mech).
 *  Pushes onto `dest` (a battlefield's unit list for "… here") or the player's
 *  Base by default. Returns how many were actually created. */
function spawnNamedToken(
  p: PlayerState,
  name: string,
  n: number,
  turn: number,
  exhausted: boolean,
  temporary = false,
  dest?: EngineCard[],
): number {
  const id = TOKEN_BY_NAME[name.toLowerCase()]
  if (!id) return 0
  const pile = dest ?? p.zones.base
  for (let i = 0; i < n; i++)
    pile.push({
      iid: `${p.id}:tok:${id}#${(tokenCounter++).toString(36)}`,
      cardId: id,
      owner: p.id,
      exhausted,
      damage: 0,
      attached: [],
      enteredTurn: turn,
      ...(temporary ? { temporary: true } : {}),
    })
  return n
}

/** The battlefield index a unit instance sits on, or -1 if at base / not found. */
function bfIndexOfUnit(s: MatchState, iid: string | undefined): number {
  if (!iid) return -1
  return s.battlefields.findIndex((b) => b.units.some((u) => u.iid === iid))
}

/** Whether a parsed effect's gating condition (if any) is satisfied for `p`.
 *  `bfIndex` is the relevant battlefield for "units at that battlefield"
 *  conditions (supplied by conquer triggers); without it such a condition
 *  cannot be satisfied. */
function conditionMet(s: MatchState, p: PlayerState, e: ParsedEffect, bfIndex?: number, excess = 0): boolean {
  if (!e.condition) return true
  if (e.condition.kind === 'unitsHereAtLeast') {
    if (bfIndex == null) return false
    const count = s.battlefields[bfIndex]?.units.filter((u) => u.owner === p.id).length ?? 0
    return count >= e.condition.value
  }
  // "if you assigned N+ excess damage" — supplied by the conquer trigger site.
  if (e.condition.kind === 'excessAtLeast') return excess >= e.condition.value
  // [Level N][>] gate — the controller must have N+ XP (Wuju Apprentice).
  if (e.condition.kind === 'xpAtLeast') return p.xp >= e.condition.value
  const hand = p.zones.hand.length
  return e.condition.kind === 'handAtMost' ? hand <= e.condition.value : hand >= e.condition.value
}

/** Make a Reflection token that copies `source`: a fresh instance pointing at
 *  the source's card (so stats/keywords/abilities resolve live via getCard),
 *  flagged as a token (ceases to exist) and Temporary (dies next Beginning
 *  Phase before scoring). Enters fresh — no copied damage/buffs/gear. */
function makeReflection(source: EngineCard, owner: PlayerId, turn: number, ready: boolean): EngineCard {
  return {
    iid: `${owner}:refl:${source.cardId}#${(tokenCounter++).toString(36)}`,
    cardId: source.cardId,
    owner,
    exhausted: !ready,
    damage: 0,
    attached: [],
    enteredTurn: turn,
    token: true,
    temporary: true,
  }
}

/** Auto-resolve a parsed "buff" effect (the +1 Might token). Self-buffs land on
 *  the source unit; targeted buffs ("buff a/another friendly unit") auto-pick the
 *  controller's highest-base-Might un-buffed unit — buffs can't stack, so already
 *  buffed units gain nothing, and a fat target also turns on Lee Sin's auras. No
 *  manual prompt (abilities auto-resolve). */
function applyBuff(s: MatchState, p: PlayerState, e: ParsedEffect, sourceIid?: string): string[] {
  if (!e.buff) return []
  const lines: string[] = []
  const give = (u: EngineCard | undefined) => {
    if (!u || u.owner !== p.id || (u.buffs ?? 0) >= 1) return false
    u.buffs = 1
    emit({ kind: 'buff', iid: u.iid, player: p.id })
    lines.push(`Buffed ${getCard(u.cardId)?.name} (+1 Might).`)
    for (const l of fireBuffReactions(s, p, u.iid)) lines.push(l)
    return true
  }
  if (e.buffSelf) {
    give(sourceIid ? findUnitAnywhere(s, sourceIid) : undefined)
    return lines
  }
  const candidates = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
    .filter((u) => u.owner === p.id && def(u)?.type === 'unit' && (u.buffs ?? 0) < 1)
    .filter((u) => !(e.buffExcludesSelf && u.iid === sourceIid))
    .sort((a, b) => (def(b)?.type === 'unit' ? (def(b) as { might: number }).might : 0) - (def(a)?.type === 'unit' ? (def(a) as { might: number }).might : 0))
  for (let i = 0; i < e.buff && i < candidates.length; i++) give(candidates[i])
  return lines
}

/** Permanent reactions to buffing a friendly unit. Mistfall (gear): "When you
 *  buff a friendly unit, you may pay :rb_rune_body: and exhaust this to ready
 *  it." Auto-paid when the gear is ready, a body rune is available, and the
 *  buffed unit is exhausted (readying it is the whole point — tempo). */
function fireBuffReactions(s: MatchState, p: PlayerState, buffedIid: string): string[] {
  const lines: string[] = []
  const buffed = findUnitAnywhere(s, buffedIid)
  if (!buffed || !buffed.exhausted) return lines // nothing worth readying
  const mistfall = p.zones.base.find(
    (g) => !g.exhausted && /when you buff a friendly unit[^.]*exhaust this to ready it/i.test(def(g)?.text ?? ''),
  )
  if (!mistfall) return lines
  // Pay 1 body Power: recycle a ready body-producing rune from the pool.
  const idx = p.zones.runePool.findIndex(
    (r) => !r.exhausted && ((def(r) as { produces?: Domain[] })?.produces ?? []).includes('body'),
  )
  if (idx < 0) return lines
  const [rune] = p.zones.runePool.splice(idx, 1)
  p.zones.runeDeck.push({ ...rune, exhausted: false, damage: 0 })
  mistfall.exhausted = true
  buffed.exhausted = false
  emit({ kind: 'buff', iid: buffed.iid, player: p.id })
  lines.push(`Mistfall: paid a body Power and readied ${getCard(buffed.cardId)?.name}.`)
  return lines
}

/** Apply the auto-resolvable parts of a parsed effect to `p`; returns log text.
 *  `bfIndex` scopes any "units at that battlefield" condition (conquer triggers).
 *  `sourceIid` is the unit the effect emanates from (for self-buff / ready-me). */
function applyParsed(s: MatchState, p: PlayerState, e: ParsedEffect, bfIndex?: number, sourceIid?: string, excess = 0): string[] {
  const lines: string[] = []
  // A gated effect does nothing when its condition isn't met.
  if (!conditionMet(s, p, e, bfIndex, excess)) return lines
  if (e.draw) lines.push(`Drew ${drawN(p, e.draw)}.`)
  if (e.drawPerBattlefield) {
    // "draw 1 for each battlefield you control" (Right of Conquest).
    const held = s.battlefields.filter((b) => b.controller === p.id).length
    if (held > 0) lines.push(`Drew ${drawN(p, e.drawPerBattlefield * held)} (per battlefield held).`)
  }
  if (e.channel) lines.push(`Channeled ${channelN(p, e.channel)}.`)
  // "Channel N rune(s) exhausted" (Soaring Scout) — the channeled runes enter exhausted.
  if (e.channelExhausted) lines.push(`Channeled ${channelN(p, e.channelExhausted, true)} (exhausted).`)
  if (e.recruits) lines.push(`Created ${spawnRecruits(p, e.recruits, s.turn)} Recruit(s).`)
  if (e.goldTokens) lines.push(`Created ${spawnGold(p, e.goldTokens, s.turn)} Gold token(s).`)
  if (e.namedToken) {
    // "… here" plays the token at the source unit's battlefield; otherwise base.
    const hereBf = e.namedToken.here ? bfIndexOfUnit(s, sourceIid) : -1
    const dest = hereBf >= 0 ? s.battlefields[hereBf].units : undefined
    const made = spawnNamedToken(p, e.namedToken.name, e.namedToken.count, s.turn, e.namedToken.exhausted, e.namedToken.temporary, dest)
    if (made) {
      if (hereBf >= 0) recomputeControllers(s)
      const label = getCard(TOKEN_BY_NAME[e.namedToken.name.toLowerCase()])?.name?.split(/\s*\(/)[0] ?? e.namedToken.name
      lines.push(`Created ${made} ${label} token(s)${e.namedToken.temporary ? ' (Temporary)' : ''}${hereBf >= 0 ? ' here' : ''}.`)
    }
  }
  if (e.returnFromTrash) {
    // Return card(s) from your Trash to your hand (Morbid Return, Cemetery
    // Attendant, …). Auto-resolves to the highest-cost match(es) — pure benefit;
    // Override can adjust the pick.
    const { type, count } = e.returnFromTrash
    const cost = (c: EngineCard): number => {
      const d = getCard(c.cardId) as { energy?: number; power?: Record<string, number> } | undefined
      const pw = d?.power ? Object.values(d.power).reduce((a, b) => a + (b || 0), 0) : 0
      return (d?.energy ?? 0) + pw
    }
    const matches = p.zones.trash
      .filter((c) => type === 'card' || getCard(c.cardId)?.type === type)
      .sort((a, b) => cost(b) - cost(a))
      .slice(0, count)
    let n = 0
    for (const c of matches) {
      const i = p.zones.trash.findIndex((x) => x.iid === c.iid)
      if (i >= 0) { p.zones.hand.push(p.zones.trash.splice(i, 1)[0]); n++ }
    }
    if (n) lines.push(`Returned ${n} ${type === 'card' ? 'card' : type}(s) from trash to hand.`)
  }
  if (e.playUnitFromTrash) {
    // Play a unit from your trash into base, ignoring its cost (Soulgorger,
    // Glasc Mixologist, …). Auto-picks the highest-cost qualifier.
    const { maxEnergy, maxPower } = e.playUnitFromTrash
    const stats = (c: EngineCard) => {
      const d = getCard(c.cardId) as { type?: string; energy?: number; power?: Record<string, number> } | undefined
      const pw = d?.power ? Object.values(d.power).reduce((a, b) => a + (b || 0), 0) : 0
      return { isUnit: d?.type === 'unit', energy: d?.energy ?? 0, power: pw }
    }
    const pick = p.zones.trash
      .filter((c) => { const st = stats(c); return st.isUnit && (maxEnergy == null || st.energy <= maxEnergy) && (maxPower == null || st.power <= maxPower) })
      .sort((a, b) => (stats(b).energy + stats(b).power) - (stats(a).energy + stats(a).power))[0]
    if (pick) {
      const i = p.zones.trash.findIndex((x) => x.iid === pick.iid)
      const [card] = p.zones.trash.splice(i, 1)
      p.zones.base.push({ ...card, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn })
      lines.push(`Played ${getCard(card.cardId)?.name ?? 'a unit'} from trash (ignoring cost).`)
    }
  }
  if (e.revealPlayFromDeck) {
    // Reveal from the top until a unit; play it free (base, exhausted); recycle
    // the non-units passed over to the bottom of the deck (Dazzling Aurora).
    const deck = p.zones.mainDeck
    const passed: EngineCard[] = []
    let unit: EngineCard | undefined
    while (deck.length) {
      const top = deck.shift()!
      if (getCard(top.cardId)?.type === 'unit') { unit = top; break }
      passed.push(top)
    }
    for (const c of passed) deck.push(c) // recycle the rest to the bottom
    if (unit) {
      p.zones.base.push({ ...unit, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn })
      lines.push(`Revealed & played ${getCard(unit.cardId)?.name ?? 'a unit'} from deck (free); recycled ${passed.length}.`)
    }
  }
  if (e.tempMightAll) {
    // Board-wide temp Might to all the controller's units (Grand Strategem).
    const units = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner === p.id && getCard(u.cardId)?.type === 'unit',
    )
    for (const u of units) u.tempMight = (u.tempMight ?? 0) + e.tempMightAll
    if (units.length) lines.push(`${e.tempMightAll > 0 ? '+' : ''}${e.tempMightAll} Might this turn to ${units.length} unit(s).`)
  }
  if (e.readyUnits) {
    // Surface a "choose which unit(s) to ready" prompt for the player.
    const exhausted = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner === p.id && u.exhausted && getCard(u.cardId)?.type === 'unit',
    )
    const cnt = Math.min(e.readyUnits, exhausted.length)
    if (cnt > 0) {
      s.readyChoice = { player: p.id, count: (s.readyChoice?.player === p.id ? s.readyChoice.count : 0) + cnt }
      lines.push(`Ready ${cnt} unit(s) â€” choose which.`)
    }
  }
  if (e.grantAssaultHere && sourceIid != null) {
    // "give your other units here [Assault] this turn" (Lord Broadmane).
    const bi = battlefieldOf(s, sourceIid)
    let n = 0
    if (bi >= 0)
      for (const u of s.battlefields[bi].units)
        if (u.owner === p.id && u.iid !== sourceIid) { u.grantAssault = (u.grantAssault ?? 0) + e.grantAssaultHere; n++ }
    if (n) lines.push(`Gave [Assault ${e.grantAssaultHere}] to ${n} other unit(s) here this turn.`)
  }
  // "spend a buff to buff me and ready me" (Wildclaw Shaman): pay the cost by
  // removing a buff from one of your OTHER buffed units. If none is available,
  // the optional self-buff/ready doesn't happen.
  let costPaid = true
  if (e.spendBuff && (e.buffSelf || e.readySelf)) {
    const donor = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].find(
      (u) => u.owner === p.id && (u.buffs ?? 0) > 0 && u.iid !== sourceIid,
    )
    if (donor) {
      donor.buffs = (donor.buffs ?? 0) - 1
      lines.push(`Spent a buff from ${getCard(donor.cardId)?.name}.`)
    } else {
      costPaid = false
    }
  }
  if (costPaid && e.readySelf && sourceIid) {
    const u = findUnitAnywhere(s, sourceIid)
    if (u && u.owner === p.id && u.exhausted) {
      u.exhausted = false
      emit({ kind: 'buff', iid: u.iid, player: p.id })
      lines.push(`Readied ${getCard(u.cardId)?.name}.`)
    }
  }
  // Skip applyBuff when a spend-buff self-buff couldn't pay its cost.
  if (costPaid) for (const l of applyBuff(s, p, e, sourceIid)) lines.push(l)
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

/** Remove the card with `iid` from wherever it currently sits (any battlefield,
 *  any player's zones / banished / legend / champion) and return it. Used by the
 *  sandbox `move` override to relocate any card freely. */
function pluckCardAnywhere(s: MatchState, iid: string): EngineCard | undefined {
  for (const bf of s.battlefields) {
    const i = bf.units.findIndex((u) => u.iid === iid)
    if (i >= 0) return bf.units.splice(i, 1)[0]
  }
  for (const pl of s.players) {
    for (const z of Object.keys(pl.zones) as ZoneId[]) {
      const i = pl.zones[z].findIndex((c) => c.iid === iid)
      if (i >= 0) return pl.zones[z].splice(i, 1)[0]
    }
    const bi = pl.banished.findIndex((c) => c.iid === iid)
    if (bi >= 0) return pl.banished.splice(bi, 1)[0]
    if (pl.legend?.iid === iid) { const c = pl.legend; pl.legend = null; return c }
    if (pl.champion?.iid === iid) { const c = pl.champion; pl.champion = null; return c }
  }
  return undefined
}

/** Count a player's in-play units (battlefields + base) carrying a keyword.
 *  Used by cost-reduction clauses like Lillia - Bashful Bloom's "costs 1 less
 *  for each friendly unit with [Temporary]". For Temporary, also honours the
 *  instance flag carried by Reflection/token copies, not just the printed keyword. */
function countFriendlyUnitsWithKeyword(s: MatchState, player: PlayerId, kw: string): number {
  const has = (u: EngineCard): boolean => {
    const c = getCard(u.cardId)
    if (c && c.type === 'unit') {
      const k = parseKeywords(c) as unknown as Record<string, unknown>
      if (k[kw]) return true
    }
    if (kw === 'temporary' && u.temporary) return true
    return false
  }
  let n = 0
  for (const bf of s.battlefields) for (const u of bf.units) if (u.owner === player && has(u)) n++
  for (const u of s.players[player].zones.base) if (u.owner === player && has(u)) n++
  return n
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

/** Collect a player's GLOBAL ("when you â€¦") triggers for an event. */
function collectGlobal(s: MatchState, player: PlayerId, event: TriggerEvent): FiredTrigger[] {
  const out: FiredTrigger[] = []
  for (const u of controlledPermanents(s, player))
    for (const ab of triggersFor(def(u), event))
      if (ab.scope === 'global') out.push({ player, ability: ab, sourceIid: u.iid })
  return out
}

/** Self-scope triggers ("when I â€¦") for a player's units, optionally limited to
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
function fireTriggers(s: MatchState, fired: FiredTrigger[], bfIndex?: number, excess = 0): MatchState {
  if (fired.length === 0) return s
  const ordered = orderTriggers(fired, s.activePlayer, s.players.length)
  for (const { player, ability, sourceIid } of ordered) {
    const label = ability.event === 'death' ? 'Deathknell' : `Trigger (${ability.event})`
    const p = s.players[player]
    const e = ability.effect
    let did = false
    const isConquer = ability.event === 'conquer'
    // `bfIndex`/`excess` only scope conquer triggers ("units at that battlefield",
    // "if you assigned N+ excess damage"); `sourceIid` lets self-buff / ready-me
    // resolve. A conquer effect that's gated (excess/units) and unmet is skipped.
    const gated = e.condition && !conditionMet(s, p, e, isConquer ? bfIndex : undefined, isConquer ? excess : 0)
    for (const line of applyParsed(s, p, e, isConquer ? bfIndex : undefined, sourceIid, isConquer ? excess : 0)) {
      s = log(s, player, `${label}: ${line}`)
      did = true
    }
    // "you may exhaust me to …" (Vi - Piltover Enforcer) — exhaust the source when
    // the gated effect actually resolved.
    if (did && !gated && sourceIid && /\bexhaust me\b/i.test(ability.text)) {
      const su = findUnitAnywhere(s, sourceIid) ?? (s.players[player].legend?.iid === sourceIid ? s.players[player].legend : undefined)
      if (su) su.exhausted = true
    }
    // "give me +1 Might this turn" â€” temporary Might on the source unit.
    if (e.tempMightSelf && sourceIid) {
      const u = findUnitAnywhere(s, sourceIid)
      if (u) {
        u.tempMight = (u.tempMight ?? 0) + e.tempMightSelf
        emit({ kind: 'buff', iid: sourceIid, player })
        s = log(s, player, `${label}: ${e.tempMightSelf > 0 ? '+' : ''}${e.tempMightSelf} Might this turn.`)
        did = true
      }
    }
    // Stun from a trigger ("When I attack, [Stun] an enemy unit here" — Vi -
    // Peacekeeper): auto-stun an enemy unit at the source's battlefield.
    if (e.stun && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const target = bi >= 0 ? s.battlefields[bi].units.find((u) => u.owner !== player && !u.stunned) : undefined
      if (target) {
        target.stunned = true
        emit({ kind: 'stun', iid: target.iid, player })
        s = log(s, player, `${label}: stunned ${getCard(target.cardId)?.name}.`)
        did = true
      }
    }
    if (e.damage) s = log(s, player, `${label}: deal ${e.damage} â€” choose a target (resolve manually).`)
    else if (!did) s = log(s, player, `${label}: ${ability.text} â€” resolve manually.`)
  }
  return s
}

/** Fire the self death triggers (Deathknell) of a set of defeated units. */
function fireDeaths(s: MatchState, defeated: EngineCard[]): MatchState {
  const isRecruit = (u: EngineCard) => (getCard(u.cardId)?.tags ?? []).includes('Recruit')
  const fired: FiredTrigger[] = []
  for (const u of defeated) {
    // Self death triggers (Deathknell).
    for (const ab of triggersFor(def(u), 'death'))
      if (ab.scope !== 'global') fired.push({ player: u.owner, ability: ab, sourceIid: u.iid })
    // Global "when a unit you control dies" triggers (Viktor - Leader), on the
    // dead unit's controller's other permanents.
    for (const perm of controlledPermanents(s, u.owner)) {
      if (perm.iid === u.iid) continue // "another" — not the dying unit itself
      for (const ab of triggersFor(def(perm), 'death')) {
        if (ab.scope !== 'global') continue
        // "non-Recruit" gate (the qualifier sits in the trigger phrase, so check
        // the source card's full text, not the parsed clause).
        if (/non-recruit/i.test(getCard(perm.cardId)?.text ?? '') && isRecruit(u)) continue
        fired.push({ player: u.owner, ability: ab, sourceIid: perm.iid })
      }
    }
  }
  return fireTriggers(s, fired)
}

/** Whether a "when you play a <X>" trigger matches the card actually played.
 *  `text` is the trigger's clause (after "when you play a/an/another"), so the
 *  filter is its leading noun phrase (e.g. "token unit", "spell", "gear",
 *  "[Mighty] unit"). Gates the common card-type filters and a "that costs N or
 *  more / or less" cost threshold (e.g. Lux — spells costing 5+). `cost` is the
 *  effective Energy cost paid; when a threshold is present but `cost` is unknown
 *  the trigger does NOT fire (better to under- than over-trigger). Filters we
 *  still can't parse (opponent's turn, from Hidden) are left ungated. */
function playTriggerMatches(text: string, card: Card, cost?: number): boolean {
  const lc = text.toLowerCase()
  const f = (lc.match(/^\s*([a-z[\] ]*?)(?:\s+(?:on|from|with|that|this|here|cost)\b|[.,;]|$)/)?.[1] ?? '').trim()
  let typeOk = true
  if (f && f !== 'card') {
    if (f.includes('token')) typeOk = card.supertype === 'token'
    else if (f.includes('spell')) typeOk = card.type === 'spell'
    else if (f.includes('gear')) typeOk = card.type === 'gear'
    else if (f.includes('mighty')) typeOk = isUnit(card) && card.might >= 5
    else if (f.includes('unit')) typeOk = card.type === 'unit'
  }
  if (!typeOk) return false
  // Cost threshold: "that costs :rb_energy_5: or more" / "… or less".
  const moreM = lc.match(/costs?\s*(?::rb_energy_)?(\d+):?\s*or more/)
  if (moreM && (cost == null || cost < parseInt(moreM[1], 10))) return false
  const lessM = lc.match(/costs?\s*(?::rb_energy_)?(\d+):?\s*or less/)
  if (lessM && (cost == null || cost > parseInt(lessM[1], 10))) return false
  return true
}

/** Token UNITS in a parsed effect (Recruit + named Sprite/Sand Soldier/etc.). */
function tokenUnitsIn(e: ParsedEffect): number {
  return e.recruits + (e.namedToken?.count ?? 0)
}

/** Fire "when you play a token unit" global triggers (e.g. Lillia - Protector of
 *  Dreams: +1 Might this turn), once per token unit created. Tokens are created
 *  rather than played from hand, so this is invoked at creation sites. No-op
 *  unless such a trigger is in play. */
function fireTokenPlay(s: MatchState, player: PlayerId, count: number): MatchState {
  if (count <= 0) return s
  const tokenUnit = { type: 'unit', supertype: 'token' } as Card
  const fired = collectGlobal(s, player, 'play').filter((f) => playTriggerMatches(f.ability.text, tokenUnit))
  for (let i = 0; i < count; i++) s = fireTriggers(s, fired)
  return s
}

/** Fire a player's GLOBAL "when you play â€¦" triggers as a card is played. Fires
 *  at play time regardless of whether the played card later resolves (a spell
 *  countered on the chain still triggers these â€” rule 4.x / T2). Excludes the
 *  card just played so it doesn't react to its own entry, and skips triggers
 *  whose "when you play a <type>" filter the played card doesn't match. */
function firePlayTriggers(s: MatchState, player: PlayerId, exceptIid: string, playedCard?: Card, playedCost?: number): MatchState {
  let fired = collectGlobal(s, player, 'play').filter((f) => f.sourceIid !== exceptIid)
  // Triggers that pay by exhausting their own source ("…exhaust me to…") are
  // cost-gated and handled explicitly (Chemtech Cask), not auto-resolved here —
  // otherwise they'd fire for free on every spell.
  fired = fired.filter((f) => !/exhaust me\b|exhaust this\b/i.test(f.ability.text))
  if (playedCard) fired = fired.filter((f) => playTriggerMatches(f.ability.text, playedCard, playedCost))
  return fireTriggers(s, fired)
}

/** Chemtech Cask: "When you play a spell on an opponent's turn, you may exhaust
 *  me to play a Gold gear token exhausted." Pure upside, so auto-fired — one ready
 *  Cask per spell. No-op on the controller's own turn or with no ready Cask. */
function fireChemtechCask(s: MatchState, player: PlayerId): MatchState {
  if (s.activePlayer === player) return s // only on an opponent's turn
  const baseName = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, '').trim()
  for (const g of s.players[player].zones.base) {
    if (g.exhausted || baseName(getCard(g.cardId)?.name ?? '') !== 'Chemtech Cask') continue
    g.exhausted = true
    spawnGold(s.players[player], 1, s.turn)
    return log(s, player, `Chemtech Cask: exhausted to create a Gold token.`)
  }
  return s
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
        note(player, `Revealed a spell â€” added it to hand.`)
      } else {
        p.zones.mainDeck.push(top)
        note(player, `Revealed a non-spell â€” recycled it.`)
      }
    },
    tempMightToUnitHere(player, bfIndex, n) {
      const u = s.battlefields[bfIndex]?.units.find((x) => x.owner === player && getCard(x.cardId)?.type === 'unit')
      if (u) {
        u.tempMight = (u.tempMight ?? 0) + n
        note(player, `+${n} Might this turn to ${getCard(u.cardId)?.name}.`)
      }
    },
    payEnergy(player, n) {
      const p = s.players[player]
      const poolE = Math.min(n, p.pool?.energy ?? 0)
      const need = n - poolE
      const ready = p.zones.runePool.filter((r) => !r.exhausted)
      if (ready.length < need) return false
      if (p.pool) p.pool.energy -= poolE
      for (let i = 0; i < need; i++) ready[i].exhausted = true
      return true
    },
    payPowerAny(player, n) {
      const p = s.players[player]
      const ready = p.zones.runePool.filter((r) => !r.exhausted)
      if (ready.length < n) return false
      for (let i = 0; i < n; i++) {
        const idx = p.zones.runePool.findIndex((r) => r.iid === ready[i].iid)
        const [r] = p.zones.runePool.splice(idx, 1)
        p.zones.runeDeck.push({ ...r, exhausted: false, damage: 0 })
      }
      return true
    },
    draw(player, n) {
      const drew = drawN(s.players[player], n)
      if (drew) note(player, `Drew ${drew}.`)
    },
    millTop(player, n) {
      const p = s.players[player]
      let milled = 0
      for (let i = 0; i < n && p.zones.mainDeck.length > 0; i++) {
        p.zones.trash.push(p.zones.mainDeck.shift()!)
        milled++
      }
      if (milled) note(player, `Milled ${milled} card(s) to the trash.`)
    },
    drawPerOtherControlledBF(player, bfIndex) {
      const count = s.battlefields.filter((b, i) => i !== bfIndex && b.controller === player).length
      if (count > 0) {
        drawN(s.players[player], count)
        note(player, `Drew ${count} (one per other battlefield held).`)
      }
    },
    readyLegend(player) {
      const lg = s.players[player].legend
      if (lg) {
        lg.exhausted = false
        note(player, `Readied legend.`)
      }
    },
    playGoldToken(player) {
      spawnGold(s.players[player], 1, s.turn)
      note(player, `Created a Gold token.`)
    },
    spendBuffHere(player, bfIndex) {
      const u = s.battlefields[bfIndex]?.units.find((x) => x.owner === player && (x.buffs ?? 0) > 0)
      if (!u) return false
      u.buffs = (u.buffs ?? 0) - 1
      note(player, `Spent a buff.`)
      return true
    },
    hasMightyHere(player, bfIndex) {
      return !!s.battlefields[bfIndex]?.units.some((x) => x.owner === player && mightOf(x) >= 5)
    },
    score(player, n) {
      s.players[player].points += n
      emit({ kind: 'score', player, amount: n })
      note(player, `Scored ${n} point(s).`)
    },
    predict(player) {
      const top = s.players[player].zones.mainDeck[0]
      if (!top) return
      s.vision = { player, cardId: top.cardId }
      note(player, `Predict â€” look at the top of your deck; you may recycle it.`)
    },
    readyGear(player) {
      const p = s.players[player]
      const gear = p.zones.base.find((c) => c.exhausted && getCard(c.cardId)?.type === 'gear')
      if (!gear) return false
      gear.exhausted = false
      note(player, `Readied ${getCard(gear.cardId)?.name ?? 'a gear'}.`)
      return true
    },
    log: (text) => note(null, text),
  }
}

/** Fire battlefield "when a player plays a spell" scripts (Abandoned Hall,
 *  Forgotten Library). `spentEnergy` is the Energy paid for the spell. */
function bfSpellPlayed(s: MatchState, player: PlayerId, spentEnergy = 0): MatchState {
  for (let i = 0; i < s.battlefields.length; i++) {
    const script = bfScriptAt(s, i)
    if (script?.onSpellPlayed) script.onSpellPlayed(makeBfApi(s), player, i, spentEnergy)
  }
  return s
}

/** Apply a battlefield's "when you conquer here" passive to the conqueror. A
 *  per-battlefield script (if any) takes precedence over the generic parser. */
function applyConquerPassive(s: MatchState, player: PlayerId, bfIndex: number, excess = 0): MatchState {
  if (s.winner !== null) return s
  const bf = s.battlefields[bfIndex]
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
  // Trapping Grounds: conquering with 3+ excess combat damage plays a Bird here.
  if (bfBaseNameAt(s, bfIndex) === 'Trapping Grounds') {
    if (excess >= 3) {
      const tokId = TOKEN_BY_NAME['bird']
      if (tokId) {
        bf.units.push({ iid: `${player}:tok:${tokId}#${(tokenCounter++).toString(36)}`, cardId: tokId, owner: player, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn })
        recomputeControllers(s)
        s = log(s, player, `Trapping Grounds: ${excess} excess damage — played a Bird.`)
      }
    }
    return s
  }
  const script = bfScript(bf.cardId)
  if (script?.onConquer) {
    script.onConquer(makeBfApi(s), player, bfIndex)
    return s
  }
  // Emperor's Dais is a multi-step optional ("pay 1 + return a unit here â†’ play
  // a Sand Soldier here"), so it's handled as a choice prompt, taking precedence
  // over the generic parser (which would otherwise just make the token).
  if (bfBaseNameAt(s, bfIndex) === "Emperor's Dais") {
    if (canPayEnergy(s, player, 1)) {
      const opts = bf.units.filter((u) => u.owner === player).map((u) => unitOpt(u))
      offerChoice(s, { player, kind: 'daisReturn', bfIndex, prompt: "Emperor's Dais â€” pay 1 and return a unit here to hand to play a Sand Soldier here?", options: opts })
    }
    return s
  }
  const passive = battlefieldPassive(bf.cardId)
  if (passive.onConquer)
    for (const line of applyParsed(s, s.players[player], passive.onConquer))
      s = log(s, player, `${bfName} (conquer): ${line}`)
  else if (passive.manualConquer)
    s = log(s, player, `${bfName} (conquer): resolve its effect manually.`)
  return s
}

/** Base name of the battlefield at index i (art-variant suffix stripped). */
function bfBaseNameAt(s: MatchState, i: number): string {
  return (getCard(s.battlefields[i]?.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** Whether `player` controls a battlefield with the given base name. */
function controlsBFNamed(s: MatchState, player: PlayerId, name: string): boolean {
  return s.battlefields.some((b, i) => b.controller === player && bfBaseNameAt(s, i) === name)
}

/** Whether `player` has a unit in play (base or any battlefield) whose base name
 *  matches (art-variant suffix stripped). */
function controlsUnitNamed(s: MatchState, player: PlayerId, name: string): boolean {
  const baseNm = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)].some(
    (u) => u.owner === player && baseNm(getCard(u.cardId)?.name ?? '') === name,
  )
}

/** State-aware [Tank]: the printed keyword, or a token unit while its controller
 *  has Lillia - Protector of Dreams in play ("Your token units have [Tank]"). */
function hasTank(s: MatchState, u: EngineCard): boolean {
  if (parseKeywords(def(u)).tank) return true
  return getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Lillia - Protector of Dreams')
}

/** State-aware static Might auras a controller grants its own units. Soul
 *  Shepherd: "Your token units have +1 Might." Added on top of printed/role
 *  Might wherever combat Might is computed. */
function auraMightBonus(s: MatchState, u: EngineCard): number {
  let b = 0
  if (getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Soul Shepherd')) b += 1
  return b
}

/** The effective [Repeat] cost when `player` plays `card`: the printed keyword
 *  cost, or — if The Academy granted Repeat this turn — the spell's base cost;
 *  then reduced by 1 Energy (min 0) while the player controls Marai Spire.
 *  Null when the spell has no Repeat (keyword or granted). */
export function repeatCostFor(s: MatchState, player: PlayerId, card: Card): ResolvedCost | null {
  let cost: ResolvedCost | null = repeatCost(card)
  if (!cost && s.players[player]?.grantRepeatNextSpell && card.type === 'spell') cost = costOf(card)
  if (!cost) return null
  if (controlsBFNamed(s, player, 'Marai Spire')) cost = { energy: Math.max(0, cost.energy - 1), power: cost.power }
  return cost
}

/** Whether a player can pay N Energy (pool first, then ready runes). */
function canPayEnergy(s: MatchState, player: PlayerId, n: number): boolean {
  const p = s.players[player]
  const ready = p.zones.runePool.filter((r) => !r.exhausted).length
  return (p.pool?.energy ?? 0) + ready >= n
}

/** Move a unit (at any battlefield) to its owner's base, exhausted. Returns
 *  success. Mirrors RETREAT's bookkeeping (onMoveFrom + controller recompute). */
function sendUnitToBase(s: MatchState, iid: string): boolean {
  for (let i = 0; i < s.battlefields.length; i++) {
    const idx = s.battlefields[i].units.findIndex((u) => u.iid === iid)
    if (idx >= 0) {
      const [u] = s.battlefields[i].units.splice(idx, 1)
      bfScriptAt(s, i)?.onMoveFrom?.(u) // Back-Alley Bar: +1 Might this turn
      s.players[u.owner].zones.base.push({ ...u, exhausted: true })
      recomputeControllers(s)
      return true
    }
  }
  return false
}

/** Offer an optional battlefield choice. Single-slot: ignored if one is already
 *  pending or there are no valid options (the "you may" simply doesn't fire). */
function offerChoice(s: MatchState, spec: NonNullable<MatchState['pendingChoice']>): void {
  if (s.pendingChoice || spec.options.length === 0) return
  s.pendingChoice = spec
}

/** A gear instance that is an Equipment (has [Equip]) sitting unattached in a
 *  player's base — a valid Forge of the Fluft attach source. */
function isEquipment(c: EngineCard): boolean {
  const d = getCard(c.cardId)
  return d?.type === 'gear' && parseKeywords(d).equip
}

/** Units a player controls (base + battlefields). */
function unitsControlledBy(s: MatchState, player: PlayerId): EngineCard[] {
  return [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
    (u) => u.owner === player && getCard(u.cardId)?.type === 'unit',
  )
}

export type GrantedAbility =
  | { kind: 'gainXP' | 'forgeAttach'; label: string }
  /** A card's own printed ":exhaust:" ability. `amount` is parsed from the text. */
  | { kind: 'addEnergySpells' | 'minusMightTarget'; label: string; amount: number }

/** A permanent the player controls (unit at a battlefield or in base, or a gear
 *  in base), by iid — the carrier of a printed ":exhaust:" activated ability. */
function controlledInstance(s: MatchState, player: PlayerId, iid: string): EngineCard | undefined {
  const p = s.players[player]
  return (
    p?.zones.base.find((c) => c.iid === iid) ??
    s.battlefields.flatMap((b) => b.units).find((u) => u.iid === iid && u.owner === player) ??
    // The legend carries its own ":exhaust:" activated ability too (Lee Sin,
    // Yasuo, Teemo, …); let it be activated through the same path as units.
    (p?.legend?.iid === iid ? p.legend : undefined)
  )
}

/** A card's OWN printed ":exhaust:" activated ability, if we recognize it. Kept
 *  separate from battlefield-granted abilities so both surface the same way. */
function printedActivated(card: Card | undefined): GrantedAbility | null {
  const t = (card?.text ?? '').toLowerCase()
  if (!t.includes(':rb_exhaust:')) return null
  // Lux - Crownguard: ":exhaust:: [Reaction] — [Add] :energy_2:. Use only to play spells."
  const addM = t.match(/\[?add\]?\s*:rb_energy_(\d+):/)
  if (addM && /play spells?/.test(t)) return { kind: 'addEnergySpells', label: `Add ${addM[1]} Energy (spells)`, amount: parseInt(addM[1], 10) }
  // Orb of Regret: ":exhaust:: Give a unit -1 :might: this turn, to a minimum of 1."
  const minusM = t.match(/give a unit -(\d+)\s*(?::rb_might:|might) this turn/)
  if (minusM) return { kind: 'minusMightTarget', label: `Give a unit -${minusM[1]} Might`, amount: parseInt(minusM[1], 10) }
  return null
}

/** Any unit currently in play (any owner), for "give a unit …" targeting. */
function allUnitsInPlay(s: MatchState): EngineCard[] {
  return [
    ...s.battlefields.flatMap((b) => b.units),
    ...s.players.flatMap((p) => p.zones.base.filter((c) => getCard(c.cardId)?.type === 'unit')),
  ]
}

export interface UnitAbility {
  exhaust: boolean
  energy: number
  power: Partial<Record<Domain, number>>
  /** Cards to recycle from your trash as a cost (Vi - Destructive). */
  recycleTrash: number
  /** "Kill this" sacrifice cost (Divining Shells). */
  killThis: boolean
  /** Usable only while the source is at a battlefield (Xerath - Freed). */
  requiresBattlefield: boolean
  /** "Double my Might this turn" — a state-dependent self pump (Vi - Hotheaded). */
  doubleMight: boolean
  effect: ParsedEffect
  effectText: string
  label: string
}

/** A unit's own printed activated ability ("<cost>: <effect>"), or null. Parses
 *  the cost glyphs (exhaust / energy / runes / recycle-from-trash / kill-this)
 *  and the effect clause. Used to offer an Activate option and resolve it. */
export function unitActivatedAbility(card: Card | undefined): UnitAbility | null {
  const text = card?.text ?? ''
  let sepEnd = -1
  let costStr = ''
  // The cost↔effect separator is the FIRST "::" followed by whitespace. Matching
  // the space avoids two traps: consecutive cost glyphs (":rb_energy_2::rb_rune_
  // fury:" — Vi-Hotheaded) create a spurious "::" with no space, and a later
  // reminder-text "::" (Pyke quotes a token's "…:rb_exhaust:: [Add]…") would
  // fool lastIndexOf.
  const sepM = text.match(/::\s/)
  const dbl = sepM ? sepM.index! : -1
  if (dbl >= 0) {
    sepEnd = dbl + 2
    const before = text.slice(0, dbl + 1) // keep the glyph's closing colon
    costStr = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(')')) + 1)
  } else {
    const wm = text.match(/(?:from your trash|kill this)\s*:/i)
    if (!wm) return null
    sepEnd = (wm.index ?? 0) + wm[0].length
    const before = text.slice(0, sepEnd - 1)
    costStr = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(')')) + 1)
  }
  const cl = costStr.toLowerCase()
  if (!/:rb_exhaust:|:rb_energy_\d+:|:rb_rune_[a-z]+:|recycle \d+ from your trash|kill this/.test(cl)) return null
  const rest = text.slice(sepEnd).replace(/^\s+/, '')
  const pIdx = rest.indexOf('.')
  const effectText = (pIdx >= 0 ? rest.slice(0, pIdx) : rest).trim()
  const power: Partial<Record<Domain, number>> = {}
  for (const rm of cl.matchAll(/:rb_rune_([a-z]+):/g)) power[rm[1] as Domain] = (power[rm[1] as Domain] ?? 0) + 1
  return {
    exhaust: /:rb_exhaust:/.test(cl),
    energy: parseInt((cl.match(/:rb_energy_(\d+):/) || [])[1] || '0', 10),
    power,
    recycleTrash: parseInt((cl.match(/recycle (\d+) from your trash/) || [])[1] || '0', 10),
    killThis: /\bkill this\b/.test(cl),
    requiresBattlefield: /only while (?:i'm|i am) at a battlefield/i.test(text),
    doubleMight: /double my might/i.test(effectText),
    effect: parseEffectText(effectText),
    effectText,
    label: effectText.replace(/\s*:rb_[a-z_0-9]+:\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
  }
}

/** "Use only if …" gates printed on an activated ability. Currently: Azir's
 *  "Use only if you've played an Equipment this turn." Returns false when a gate
 *  is present and unmet, true otherwise. */
function abilityUsableNow(card: Card | undefined, p: PlayerState): boolean {
  const t = (card?.text ?? '').toLowerCase()
  if (/use only if you('ve| have) played an equipment this turn/.test(t))
    return !!p.playedEquipmentThisTurn
  return true
}

/** Whether `player` can activate the unit `iid`'s own ability right now (controls
 *  it, not exhausted if exhaust-cost, at a battlefield if required, can pay). */
export function canActivateUnit(s: MatchState, player: PlayerId, iid: string): UnitAbility | null {
  const u = controlledInstance(s, player, iid)
  if (!u) return null
  if (!abilityUsableNow(getCard(u.cardId), s.players[player])) return null
  // Abilities the dedicated printed-activated path already handles (Orb of
  // Regret, Lux - Crownguard) go through ACTIVATE_ABILITY instead.
  if (printedActivated(getCard(u.cardId))) return null
  const ab = unitActivatedAbility(getCard(u.cardId))
  if (!ab) return null
  if (ab.exhaust && u.exhausted) return null
  if (ab.requiresBattlefield && battlefieldOf(s, iid) < 0) return null
  if (ab.recycleTrash > s.players[player].zones.trash.length) return null
  const cost = { energy: ab.energy, power: ab.power }
  if (!costIsFree(cost) && !autoPay(s.players[player], cost)) return null
  return ab
}

/** The battlefield-granted activated ability available on a unit/legend right
 *  now, or null. Pure function of state — the UI uses it to show an Activate
 *  affordance; the reducer uses it to validate ACTIVATE_ABILITY. */
export function grantedAbilityFor(s: MatchState, player: PlayerId, iid: string): GrantedAbility | null {
  const p = s.players[player]
  if (!p) return null
  // Forge of the Fluft: your legend gains ":exhaust: attach an Equipment you
  // control to a unit you control."
  if (p.legend && p.legend.iid === iid && !p.legend.exhausted && controlsBFNamed(s, player, 'Forge of the Fluft')) {
    if (p.zones.base.some(isEquipment) && unitsControlledBy(s, player).length > 0)
      return { kind: 'forgeAttach', label: 'Attach an Equipment to a unit' }
  }
  // Gardens of Becoming: a unit here (yours, unexhausted) gains ":exhaust: gain 1 XP."
  for (let i = 0; i < s.battlefields.length; i++) {
    if (bfBaseNameAt(s, i) !== 'Gardens of Becoming') continue
    if (s.battlefields[i].units.some((x) => x.iid === iid && x.owner === player && !x.exhausted))
      return { kind: 'gainXP', label: 'Gain 1 XP' }
  }
  // A card's own printed ":exhaust:" ability (Lux - Crownguard, Orb of Regret).
  const inst = controlledInstance(s, player, iid)
  if (inst && !inst.exhausted) {
    const pa = printedActivated(getCard(inst.cardId))
    // "Give a unit …" needs at least one unit on the board to target.
    if (pa && (pa.kind !== 'minusMightTarget' || allUnitsInPlay(s).length > 0)) return pa
  }
  return null
}

/** LeBlanc - Deceiver: on conquer/hold, offer to discard 1 + exhaust LeBlanc to
 *  play a Reflection copy of a unit at the battlefield (Temporary). */
function offerLeblanc(s: MatchState, player: PlayerId, bfIndex: number): void {
  const lg = s.players[player]?.legend
  if (!lg || lg.exhausted) return
  if ((getCard(lg.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() !== 'LeBlanc - Deceiver') return
  if (s.players[player].zones.hand.length === 0) return // need a card to discard
  const opts = s.battlefields[bfIndex].units.map((u) => unitOpt(u)) // "another unit there"
  offerChoice(s, { player, kind: 'leblancCopy', bfIndex, prompt: 'LeBlanc — discard 1 and exhaust LeBlanc to copy a unit here (Temporary)?', options: opts })
}

/** Fire "when a unit is played here" battlefield effects for a unit that just
 *  entered a battlefield (only happens via Ambush). */
function bfUnitPlayedHere(s: MatchState, player: PlayerId, bfIndex: number, iid: string): void {
  const name = bfBaseNameAt(s, bfIndex)
  if (name === 'Valley of Idols') {
    // "you may pay 1 to [Buff] it" — pure benefit, auto-pay when affordable.
    const u = s.battlefields[bfIndex].units.find((x) => x.iid === iid)
    if (u && (u.buffs ?? 0) < 1 && makeBfApi(s).payEnergy(player, 1)) {
      u.buffs = (u.buffs ?? 0) + 1
      s.log.push({ turn: s.turn, player, text: `Valley of Idols: paid 1 to Buff ${getCard(u.cardId)?.name}.` })
    }
  } else if (name === 'Star Spring' && getCard(s.battlefields[bfIndex].units.find((x) => x.iid === iid)?.cardId ?? '')?.supertype !== 'token') {
    // "you may move another unit you control here to its base."
    const opts = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner === player && u.iid !== iid).map((u) => unitOpt(u))
    offerChoice(s, { player, kind: 'moveAnyToBase', bfIndex, prompt: 'Star Spring — move another unit you control to its base?', options: opts })
  }
}

/** Return a unit at a battlefield to its owner's hand, firing Ripper's Bay if it
 *  was there. Returns the removed instance (already in hand), or null. */
function returnUnitToHand(s: MatchState, bfIndex: number, iid: string): EngineCard | null {
  const bf = s.battlefields[bfIndex]
  const idx = bf.units.findIndex((u) => u.iid === iid)
  if (idx < 0) return null
  const rippersBay = bfBaseNameAt(s, bfIndex) === "Ripper's Bay"
  const [u] = bf.units.splice(idx, 1)
  s.players[u.owner].zones.hand.push({ iid: u.iid, cardId: u.cardId, owner: u.owner, exhausted: false, damage: 0, attached: [] })
  recomputeControllers(s)
  if (rippersBay && makeBfApi(s).payEnergy(u.owner, 1)) {
    // "may pay 1 to channel 1 rune exhausted" — auto-pay when affordable.
    const r = s.players[u.owner].zones.runeDeck.shift()
    if (r) {
      s.players[u.owner].zones.runePool.push({ ...r, exhausted: true })
      s.log.push({ turn: s.turn, player: u.owner, text: `Ripper's Bay: paid 1 to channel a rune (exhausted).` })
    }
  }
  return u
}

/** Bounce a unit (at any battlefield or in base) to its owner's hand, then have
 *  that owner channel `channelExhausted` runes exhausted (Retreat). Tokens cease
 *  to exist rather than return. Returns the updated state. */
function bounceUnitToHand(s: MatchState, iid: string, by: PlayerId, spellName: string, channelExhausted: number): MatchState {
  const u = findUnitAnywhere(s, iid)
  if (!u) return s
  const owner = u.owner
  const isToken = getCard(u.cardId)?.supertype === 'token' || u.token
  // Attached gear loses its host — return it to the owner's Base, unattached
  // (same as a manual Detach), rather than letting it vanish with the unit.
  for (const ref of u.attached) {
    const [gCardId, gIid] = ref.split('|')
    if (!gCardId) continue
    s.players[owner].zones.base.push({ iid: gIid || `${owner}:gear:${gCardId}`, cardId: gCardId, owner, exhausted: false, damage: 0, attached: [] })
    s = log(s, owner, `${spellName}: ${getCard(gCardId)?.name ?? 'Gear'} detached to base.`)
  }
  const bfi = s.battlefields.findIndex((b) => b.units.some((x) => x.iid === iid))
  if (bfi >= 0) {
    if (isToken) {
      s.battlefields[bfi].units = s.battlefields[bfi].units.filter((x) => x.iid !== iid)
      recomputeControllers(s)
    } else {
      returnUnitToHand(s, bfi, iid)
    }
  } else {
    const base = s.players[owner].zones.base
    const idx = base.findIndex((x) => x.iid === iid)
    if (idx < 0) return s
    const [bu] = base.splice(idx, 1)
    if (!isToken) s.players[owner].zones.hand.push({ iid: bu.iid, cardId: bu.cardId, owner, exhausted: false, damage: 0, attached: [] })
  }
  emit({ kind: 'play', iid, player: owner })
  s = log(s, by, `${spellName}: returned ${getCard(u.cardId)?.name}${isToken ? ' (token — it ceases to exist)' : ` to ${owner === by ? 'your' : "its owner's"} hand`}.`)
  // The bounced unit's owner channels N runes exhausted.
  let ch = 0
  for (let i = 0; i < channelExhausted && s.players[owner].zones.runeDeck.length > 0; i++) {
    s.players[owner].zones.runePool.push({ ...s.players[owner].zones.runeDeck.shift()!, exhausted: true })
    ch++
  }
  if (ch) s = log(s, owner, `${spellName}: channeled ${ch} rune(s) exhausted.`)
  return s
}

const unitOpt = (u: EngineCard) => ({ iid: u.iid, label: getCard(u.cardId)?.name ?? u.iid })

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
      // mightOf already subtracts accrued damage, so a unit is defeated when its
      // remaining Might hits 0 (NOT when damage >= remaining, which double-counts).
      if (mightOf(u) <= 0) {
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
      if (mightOf(u) <= 0) {
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
          // Ganking from the keyword (possibly [Level N]-gated, e.g. Master Yi
          // - Tempered) OR granted by the source battlefield (Windswept
          // Hillock). The destination must also allow it.
          const gankU = s.battlefields[i].units[idx]
          const hasGank = unitHasGanking(s, gankU) || !!bfScriptAt(s, i)?.grantsGanking
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
      priority: player, // fixed up to the first defending participant below
      passes: 0,
      movedUnit: moved[0].iid,
    }
    // Priority opens on the first combatant after the mover (skips uninvolved
    // seats in a 3-4 player game — they only join if invited).
    s2.showdown.priority = nextShowdownPriority(s2, player)
    s2 = log(s2, player, 'Showdown opened â€” opponents may respond.')
  } else if (
    s2.battlefields[toBattlefield].controller === player &&
    prevController !== player
  ) {
    s2 = awardPoints(s2, player, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    s2 = grantHunt(s2, player, toBattlefield)
    s2 = applyConquerPassive(s2, player, toBattlefield)
    s2 = fireTriggers(s2, collectGlobal(s2, player, 'conquer'), toBattlefield)
    const here = s2.battlefields[toBattlefield].units.filter((u) => u.owner === player).map((u) => u.iid)
    s2 = fireTriggers(s2, collectSelf(s2, player, 'conquer', here), toBattlefield)
    offerLeblanc(s2, player, toBattlefield) // LeBlanc - Deceiver: copy a unit here
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
  // carry between turns â€” emptied at end of the Draw step / end of turn).
  p.cardsPlayedThisTurn = 0
  p.playedEquipmentThisTurn = false
  p.pool = { energy: 0, power: {} }
  p.unitCostBump = 0 // recomputed below by holding Vaults of Helia
  p.grantRepeatNextSpell = false

  // Awaken: ready everything the active player controls.
  if (p.legend) p.legend.exhausted = false
  for (const z of Object.keys(p.zones) as ZoneId[])
    p.zones[z] = p.zones[z].map((c) => ({ ...c, exhausted: false }))
  for (const bf of s.battlefields)
    bf.units = bf.units.map((u) => (u.owner === ap ? { ...u, exhausted: false } : u))
  s = log(s, ap, `â€” Turn ${s.turn}: ${p.name} Â· Awaken â€”`)

  // Start-of-turn triggered abilities (card text "at the start of your turn â€¦").
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
        (parseKeywords(def(u)).temporary || u.temporary) &&
        (u.enteredTurn ?? 0) < s.turn,
    )
    if (expired.length) {
      bf.units = bf.units.filter((u) => !expired.includes(u))
      for (const u of expired) sendToTrash(p, u)
      s = log(s, ap, `${expired.length} Temporary unit(s) expired.`)
    }
  }
  for (const u of p.zones.base.filter(
    (u) => (parseKeywords(def(u)).temporary || u.temporary) && (u.enteredTurn ?? 0) < s.turn,
  )) {
    p.zones.base = p.zones.base.filter((x) => x.iid !== u.iid)
    sendToTrash(p, u)
  }

  // Hidden cleanup: a facedown card whose owner no longer controls its
  // battlefield is revealed and sent to its owner's Trash (rule 421.4).
  recomputeControllers(s)
  for (const bf of s.battlefields) {
    if (bf.facedown && bf.controller !== bf.facedown.owner) {
      sendToTrash(s.players[bf.facedown.owner], bf.facedown)
      s = log(s, ap, `Unsupported Hidden card revealed and trashed.`)
      bf.facedown = null
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

  // Dusk Rose Lab: "you may kill a unit you control here to draw 1 — before
  // scoring." It's a sacrifice, so it prompts; pause the Beginning Phase here
  // (phase 'score' blocks normal actions) and resume via RESOLVE_CHOICE →
  // finishBeginning, so the kill lands before the scoring step below.
  recomputeControllers(s)
  for (let i = 0; i < s.battlefields.length; i++) {
    if (bfBaseNameAt(s, i) !== 'Dusk Rose Lab' || s.battlefields[i].controller !== ap) continue
    const opts = s.battlefields[i].units.filter((u) => u.owner === ap).map((u) => unitOpt(u))
    if (opts.length) {
      offerChoice(s, { player: ap, kind: 'duskRoseSacrifice', bfIndex: i, prompt: 'Dusk Rose Lab — kill a unit you control here to draw 1?', options: opts })
      s.phase = 'score'
      return s // paused before scoring; RESOLVE_CHOICE resumes finishBeginning
    }
  }
  return finishBeginning(s)
}

/** The back half of the Beginning Phase (scoring → Hunt/hold → channel → draw →
 *  legend → action). Split out of `beginTurn` so Dusk Rose Lab's pre-scoring
 *  sacrifice prompt can pause and resume here. */
function finishBeginning(s: MatchState): MatchState {
  const ap = s.activePlayer
  const p = s.players[ap]

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
      offerLeblanc(s, ap, i) // LeBlanc - Deceiver: "when you hold" copy a unit here
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
    // The Grand Plaza: hold with enough units here â†’ win.
    const script = bfScript(bf.cardId)
    if (script?.winOnUnitsHere && bf.units.filter((u) => u.owner === ap).length >= script.winOnUnitsHere)
      return endGame(s, ap)
    // Scripted "when you hold here" takes precedence over the generic parser.
    if (script?.onHold) {
      script.onHold(makeBfApi(s), ap, s.battlefields.indexOf(bf))
      continue
    }
    // Amateur Recital: on hold, you may move any unit at a battlefield to base.
    if (bfBaseNameAt(s, s.battlefields.indexOf(bf)) === 'Amateur Recital') {
      const opts = s.battlefields.flatMap((b) => b.units).map((u) => unitOpt(u))
      offerChoice(s, { player: ap, kind: 'moveAnyToBase', bfIndex: s.battlefields.indexOf(bf), prompt: 'Amateur Recital â€” move a unit at a battlefield to its base?', options: opts })
      continue
    }
    // Vaults of Helia: your non-token units cost 1 more to play this turn.
    if (bfBaseNameAt(s, s.battlefields.indexOf(bf)) === 'Vaults of Helia') {
      p.unitCostBump = (p.unitCostBump ?? 0) + 1
      s = log(s, ap, `Vaults of Helia (hold): your units cost 1 more this turn.`)
      continue
    }
    // The Academy: give your next spell this turn [Repeat] equal to its base cost.
    if (bfBaseNameAt(s, s.battlefields.indexOf(bf)) === 'The Academy') {
      p.grantRepeatNextSpell = true
      s = log(s, ap, `The Academy (hold): your next spell gains [Repeat] this turn.`)
      continue
    }
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

  // First-turn process (Core Rules v1.2 Â§462â€“466), by seat in turn order:
  //   â€¢ 1v1: the player going SECOND channels +1 on their first turn.
  //   â€¢ FFA 3-4: the player going FIRST skips their first Draw; the player going
  //     LAST channels +1 on their first turn.
  const n = s.players.length
  const order = (ap - s.firstPlayer + n) % n // 0 = first player â€¦ n-1 = last
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

  // Draw â€” empty deck triggers Burn Out (reshuffle Trash, opponent scores). The
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
  // draw / channel / recruit). No manual button â€” abilities resolve themselves.
  // Skip legends whose ability is a TRIGGERED ability (conquer / start-of-turn /
  // death / â€¦): those fire on their own event, so auto-resolving the parsed
  // "draw N" here would wrongly fire it every turn (e.g. Garen - Might of
  // Demacia drawing 2 each turn; Jinx already handled via the trigger system).
  if (p.legend && !p.legend.exhausted) {
    const legendCard = getCard(p.legend.cardId)
    if (legendCard && parseTriggers(legendCard).length === 0 && abilityUsableNow(legendCard, p)) {
      const e = spellEffect(legendCard)
      // An ability with an :rb_exhaust: cost is an ACTIVATED ability — optional,
      // the player chooses if/when to use it (via the ⚡ Activate button). Never
      // auto-fire those (e.g. Viktor's Recruit, Lillia's Sprite drained resources
      // every turn unprompted). Only a legend ability with NO exhaust cost (a free
      // passive start-of-turn effect) auto-resolves.
      const isActivated = !!legendActivationCost(legendCard)
      if (!isActivated && (e.draw || e.channel || e.recruits || e.goldTokens || e.namedToken)) {
        p.legend.exhausted = true
        for (const line of applyParsed(s, p, e)) s = log(s, ap, `${legendCard.name} (auto): ${line}`)
      }
    }
  }

  s.phase = 'action'
  return s
}

/** The Energy cost of a legend's costed activated ability (":rb_energy_N:,
 *  :rb_exhaust:: â€¦"), or null when the legend isn't an exhaust-activated ability.
 *  When `s`/`player` are supplied, applies any "costs :rb_energy_N: less for each
 *  friendly unit with [Keyword]" reduction (Lillia - Bashful Bloom). */
function legendActivationCost(card: Card, s?: MatchState, player?: PlayerId): { energy: number } | null {
  const t = (card.text ?? '').toLowerCase()
  if (!t.includes(':rb_exhaust:')) return null
  const m = t.slice(0, t.indexOf(':rb_exhaust:')).match(/:rb_energy_(\d+):/)
  let energy = m ? parseInt(m[1], 10) : 0
  if (s && player !== undefined) {
    const redM = (card.text ?? '').match(/costs? :rb_energy_(\d+): less for each friendly unit with \[(\w+)\]/i)
    if (redM)
      energy = Math.max(0, energy - parseInt(redM[1], 10) * countFriendlyUnitsWithKeyword(s, player, redM[2].toLowerCase()))
  }
  return { energy }
}

/** Burn Out (empty-deck draw): recycle Trash into the Main Deck, shuffle, and a
 *  chosen opponent scores 1. With no Trash to recycle, that opponent wins. */
function burnOut(state: MatchState, player: PlayerId): MatchState {
  const beneficiary = nextPlayer(state, player)
  const p = state.players[player]
  if (p.zones.trash.length === 0) {
    // No Trash to recycle: the burned-out player drops. In 1v1 the lone opponent
    // wins; in a 3-4 player game the match continues among the survivors.
    return eliminate(state, player, 'burned out with no Trash')
  }
  p.zones.mainDeck = shuffle([...p.zones.mainDeck, ...p.zones.trash])
  p.zones.trash = []
  const s = log(state, player, `${p.name} burned out â€” Trash reshuffled into the deck.`)
  return awardPoints(s, beneficiary, 1, 'scored from Burn Out', 'hold')
}

function endGame(state: MatchState, winner: PlayerId): MatchState {
  let s = clone(state)
  s.winner = winner
  s.phase = 'gameover'
  s = log(s, winner, `${s.players[winner].name} wins!`)
  return s
}

/** Drop a player from the match (concede / elimination). Their units leave every
 *  battlefield (to their Trash) and their board zones are cleared, so they no
 *  longer contest control or score. With one player left, that player wins;
 *  otherwise play continues. Does NOT fix turn/priority pointers — the caller is
 *  responsible for advancing past the departed seat. */
function eliminate(state: MatchState, player: PlayerId, reason: string): MatchState {
  let s = clone(state)
  const p = s.players[player]
  if (p.out) return s
  p.out = true
  // Pull their units off every battlefield into their Trash.
  for (const bf of s.battlefields) {
    const leaving = bf.units.filter((u) => u.owner === player)
    bf.units = bf.units.filter((u) => u.owner !== player)
    for (const u of leaving) sendToTrash(p, u)
  }
  // Clear their board presence so nothing they own keeps affecting the game.
  for (const u of [...p.zones.base]) sendToTrash(p, u)
  p.zones.base = []
  p.pool = { energy: 0, power: {} }
  if (p.legend) p.legend.exhausted = true
  s = log(s, player, `${p.name} is out of the match (${reason}).`)
  recomputeControllers(s)
  // Anyone holding an accepted invite from / to the departed player is moot —
  // a stale showdown invite is dropped by the caller's pointer repair.
  const alive = s.players.filter((pl) => !pl.out)
  if (alive.length === 1) return endGame(s, alive[0].id)
  return s
}

/** Award point(s) and check for the win. The winning point via Conquer is
 *  restricted: it only counts if the player controls ALL battlefields that
 *  turn â€” otherwise they draw a card instead of scoring it. Hold/Burn-Out
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
      `${p.name}'s winning point must be a Hold or a full conquer â€” drew a card instead.`,
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
  if (role === 'attacker') m += k.assault + (ci.grantAssault ?? 0) // [Assault] granted this turn
  if (role === 'defender') m += k.shield
  m += levelBonus(d, xp).might // [Level N] passive while controller has enough XP
  return Math.max(0, m)
}

/** Combat damage a unit DEALS â€” 0 if Stunned (it still keeps Might to survive). */
function damageOutput(ci: EngineCard, role: CombatRole, xp = 0): number {
  return ci.stunned ? 0 : mightOf(ci, role, xp)
}

/** Mighty: a unit with effective Might >= 5. */
export function isMighty(ci: EngineCard): boolean {
  return mightOf(ci) >= 5
}

/** A unit's current displayed Might (base + buffs + gear + temp + level âˆ’ damage). */
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

/** A unit's full state-aware combat Might at a battlefield: its printed/buff/gear
 *  Might plus conditional self-bonuses ("while buffed", "while alone"), unit auras
 *  (Lee Sin - Centered), battlefield scripts, and legend buffs. "Alone" means u's
 *  side fields exactly one unit here. */
export function combatMightAt(s: MatchState, bfIndex: number, u: EngineCard, role: 'attacker' | 'defender'): number {
  const bf = s.battlefields[bfIndex]
  if (!bf) return 0
  const alone = bf.units.filter((x) => x.owner === u.owner).length === 1
  const bonusOf = bfCombatBonus(s, bfIndex, role === 'attacker' && alone, role === 'defender' && alone)
  return Math.max(0, mightOf(u, role, s.players[u.owner]?.xp ?? 0) + bonusOf(u, role) + auraMightBonus(s, u))
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
 *  others), then normal, then backline. `isTank` is state-aware (granted Tank
 *  from Lillia counts, not just the printed keyword). */
function damageOrder(units: EngineCard[], isTank: (u: EngineCard) => boolean): EngineCard[] {
  const rank = (u: EngineCard) => (isTank(u) ? 0 : parseKeywords(def(u)).backline ? 2 : 1)
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
 *  is no single dealer (multi-owner defenders) â€” then it auto-resolves. */
function buildAssignStep(
  dealer: PlayerId,
  side: 'attackers' | 'defenders',
  receiving: EngineCard[],
  amount: number,
  manualAllowed: boolean,
  xpOf: (u: EngineCard) => number,
  bonusOf: (u: EngineCard, role: CombatRole) => number = () => 0,
  isTank: (u: EngineCard) => boolean = (u) => parseKeywords(def(u)).tank,
): DamageAssignStep {
  const role: CombatRole = side === 'defenders' ? 'defender' : 'attacker'
  const ordered = damageOrder(receiving, isTank)
  const hp = hpMap(receiving, role, xpOf, bonusOf)
  const tanks = receiving.filter(isTank).map((u) => u.iid)
  const totalHp = Object.values(hp).reduce((a, b) => a + b, 0)
  // A choice only exists with 2+ live targets and damage that won't kill them all.
  const liveTargets = receiving.filter((u) => hp[u.iid] > 0)
  const manual = manualAllowed && amount > 0 && liveTargets.length >= 2 && amount < totalHp
  const defeated = manual ? [] : [...assignDamage(amount, ordered, role, xpOf, bonusOf)]
  return { dealer, side, targets: ordered.map((u) => u.iid), amount, manual, defeated, hp, tanks }
}

/** Conditional / legend-granted combat Might for a unit (not from its printed
 *  stats): rune-count self buffs and global legend buffs. */
function conditionalMight(s: MatchState, u: EngineCard, role: CombatRole, alone: boolean): number {
  const d = def(u)
  const owner = s.players[u.owner]
  if (!d || !owner) return 0
  let b = 0
  const text = (d.text ?? '').toLowerCase()
  // Self: "While you have N+ runes, I have +X Might." (Master Yi - Meditative)
  const runeM = text.match(/while you have (\d+)\+? (?:or more )?runes?, i have \+(\d+)\s*(?::rb_might:|might)/)
  if (runeM && owner.zones.runePool.length >= parseInt(runeM[1], 10)) b += parseInt(runeM[2], 10)
  // Self: "While I'm buffed, I have an additional +N Might." (Wizened Elder)
  if ((u.buffs ?? 0) > 0) {
    const bm = text.match(/while (?:i'm|i am) buffed,? i have (?:an? )?(?:additional )?\+(\d+)\s*(?::rb_might:|might)/)
    if (bm) b += parseInt(bm[1], 10)
  }
  // Self: "While I'm attacking or defending alone, I have +N Might." (Wielder of Water)
  if (alone && (role === 'attacker' || role === 'defender')) {
    const am = text.match(/while (?:i'm|i am) attacking (?:or defending )?alone,? i have \+(\d+)\s*(?::rb_might:|might)/)
    if (am) b += parseInt(am[1], 10)
    // Controller's gear: Mask of Foresight — "When a friendly unit attacks or
    // defends alone, give it +N Might this turn." Modeled as a lone-combatant aura.
    for (const g of owner.zones.base) {
      const gm = (getCard(g.cardId)?.text ?? '').toLowerCase().match(/when a friendly unit attacks or defends alone,? give it \+(\d+)\s*(?::rb_might:|might)/)
      if (gm) b += parseInt(gm[1], 10)
    }
  }
  // Self: "I have +N Might while I'm attacking with another unit." (Crimson
  // Pigeons) — attacker and NOT alone.
  if (role === 'attacker' && !alone) {
    const wm = text.match(/(?:i have )?\+(\d+)\s*(?::rb_might:|might) while (?:i'm|i am) attacking with another unit/)
    if (wm) b += parseInt(wm[1], 10)
  }
  // Legend-granted global buffs.
  const lt = (getCard(owner.legend?.cardId ?? '')?.text ?? '').toLowerCase()
  if (lt) {
    // "While a friendly unit defends alone, it gets +N Might." (Wuju Bladesman)
    if (role === 'defender' && alone) {
      const m = lt.match(/while a friendly unit defends alone,? it gets \+(\d+)\s*(?::rb_might:|might)/)
      if (m) b += parseInt(m[1], 10)
    }
    // "[Level N] Your units have +M Might." while the controller has N+ XP. (Wuju Master)
    const lvlM = lt.match(/\[level\s*(\d+)\][^.]*?your units have \+(\d+)\s*(?::rb_might:|might)/)
    if (lvlM && owner.xp >= parseInt(lvlM[1], 10)) b += parseInt(lvlM[2], 10)
  }
  return b
}

/** Whether a unit can Gank (move battlefield-to-battlefield) right now. Honors
 *  conditional grants like Bilgewater Bully's "While I'm buffed, I have [Ganking]"
 *  — the keyword scanner reads the bracket unconditionally, so re-gate it here. */
function unitHasGanking(s: MatchState, u: EngineCard): boolean {
  if (u.grantGanking) return true // [Ganking] granted this turn (Vault Breaker)
  const t = (def(u)?.text ?? '').toLowerCase()
  if (/while (?:i'm|i am) buffed,?[^.]*\[ganking\]/.test(t)) return (u.buffs ?? 0) > 0
  return keywordsAt(def(u), s.players[u.owner]?.xp ?? 0).ganking
}

/** Unit-granted auras among units sharing a battlefield. Lee Sin - Centered:
 *  "Other buffed friendly units at my battlefield have +2 Might." applies to
 *  each OTHER friendly buffed unit standing with him. */
function auraMightHere(here: EngineCard[], u: EngineCard): number {
  let b = 0
  for (const src of here) {
    if (src.iid === u.iid || src.owner !== u.owner) continue // OTHER friendly units only
    const t = (def(src)?.text ?? '').toLowerCase()
    const m = t.match(/other buffed friendly units at my battlefield have \+(\d+)\s*(?::rb_might:|might)/)
    if (m && (u.buffs ?? 0) > 0) b += parseInt(m[1], 10)
  }
  return b
}

/** Flat combat-Might delta granted to a unit fighting at a battlefield: the
 *  battlefield's own bonus (Trifarian War Camp +1, Forbidding Waste âˆ’2 alone,
 *  Black Flame Altar shield) plus any conditional / legend Might buffs. */
function bfCombatBonus(
  s: MatchState,
  bfIndex: number,
  attackersAlone: boolean,
  defendersAlone: boolean,
): (u: EngineCard, role: CombatRole) => number {
  const script = bfScriptAt(s, bfIndex)
  const here = s.battlefields[bfIndex]?.units ?? []
  return (u, role) => {
    const alone = role === 'attacker' ? attackersAlone : role === 'defender' ? defendersAlone : false
    let b = 0
    if (script?.mightHere) b += script.mightHere(u, role, alone)
    if (role === 'defender' && script?.shieldHere) b += script.shieldHere(u)
    b += conditionalMight(s, u, role, alone)
    b += auraMightHere(here, u)
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

/** Deflect surcharge (Core Rules Â§735): an opponent's spell/ability that
 *  CHOOSES a unit with Deflect X costs X more to play. Summed over all chosen
 *  enemy targets. (Modeled here as extra generic cost â€” see note in autopay.) */
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
    // Deflect may be granted by a [Level N] clause (Master Yi - Tempered), so
    // resolve keywords against the unit owner's XP.
    if (u && u.owner !== caster) total += keywordsAt(def(u), state.players[u.owner]?.xp ?? 0).deflect
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

/** Who assigns the defending side's pooled counter-damage. Prefers the
 *  battlefield's defending controller; otherwise the defender owner with the most
 *  units present. Always a defender (never the attacker). */
function pickDefenseAssigner(
  s: MatchState,
  bfIndex: number,
  defenders: EngineCard[],
  defOwners: PlayerId[],
  moverOwner: PlayerId,
): PlayerId {
  if (defOwners.length === 0) return moverOwner
  if (defOwners.length === 1) return defOwners[0]
  const controller = s.battlefields[bfIndex].controller
  if (controller != null && defOwners.includes(controller)) return controller
  const count = (owner: PlayerId) => defenders.filter((u) => u.owner === owner).length
  return [...defOwners].sort((a, b) => count(b) - count(a) || a - b)[0]
}

/** Compute the two damage-assignment steps for a showdown (no mutation). */
function showdownSteps(s: MatchState, bfIndex: number): { moverOwner: PlayerId; steps: DamageAssignStep[] } {
  const bf = s.battlefields[bfIndex]
  const mover = s.showdown?.movedUnit
  const moverOwner = bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer
  const xpOf = (u: EngineCard) => s.players[u.owner]?.xp ?? 0
  const attackers = bf.units.filter((u) => u.owner === moverOwner)
  const defenders = bf.units.filter((u) => u.owner !== moverOwner)
  const bfBonus = bfCombatBonus(s, bfIndex, attackers.length === 1, defenders.length === 1)
  const bonusOf = (u: EngineCard, role: CombatRole) => bfBonus(u, role) + auraMightBonus(s, u)
  const dealt = (u: EngineCard, role: CombatRole) =>
    u.stunned ? 0 : Math.max(0, mightOf(u, role, xpOf(u)) + bonusOf(u, role))
  const attackMight = attackers.reduce((a, u) => a + dealt(u, 'attacker'), 0)
  const defendMight = defenders.reduce((a, u) => a + dealt(u, 'defender'), 0)
  // Mover's damage hits the defenders; the defending side's damage hits attackers.
  // The defending side pools its Might (total-might model); one defender assigns
  // the combined counter-damage on the side's behalf. When two opponents defend
  // the same battlefield, the assigner is the defending controller (else the
  // owner fielding the most units) — so a defender, never the attacker, chooses.
  const defOwners = [...new Set(defenders.map((u) => u.owner))]
  const atkDealer = pickDefenseAssigner(s, bfIndex, defenders, defOwners, moverOwner)
  const isTank = (u: EngineCard) => hasTank(s, u)
  const steps = [
    buildAssignStep(moverOwner, 'defenders', defenders, attackMight, true, xpOf, bonusOf, isTank),
    buildAssignStep(atkDealer, 'attackers', attackers, defendMight, true, xpOf, bonusOf, isTank),
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
    return s // paused â€” wait for ASSIGN_DAMAGE
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
  const bfBonus = bfCombatBonus(s, bfIndex, attackers.length === 1, defenders.length === 1)
  const bonusOf = (u: EngineCard, role: CombatRole) => bfBonus(u, role) + auraMightBonus(s, u)
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
  // Reaver's Row: a defender here may move a friendly unit here to base.
  if (bfBaseNameAt(s, bfIndex) === "Reaver's Row") {
    const owner = bf.controller
    if (owner != null) {
      const opts = bf.units.filter((u) => u.owner === owner).map((u) => unitOpt(u))
      offerChoice(s, { player: owner, kind: 'moveHereToBase', bfIndex, prompt: "Reaver's Row â€” move a friendly unit here to base?", options: opts })
    }
  }

  // Altar of Blood: "If a unit here would die during combat, its controller may
  // pay 3 [any] to heal it, exhaust it, and recall it instead." Pure rescue, so
  // auto-paid when affordable; the saved unit is recalled (exhausted) to base.
  const altarOfBlood = bfBaseNameAt(s, bfIndex) === 'Altar of Blood'
  const rescued = new Set<string>()
  const survivors: EngineCard[] = []
  const defeated: EngineCard[] = []
  for (const u of bf.units) {
    const dead =
      (u.owner !== moverOwner && defendersDefeated.has(u.iid)) ||
      (u.owner === moverOwner && attackersDefeated.has(u.iid))
    if (dead && altarOfBlood && getCard(u.cardId)?.supertype !== 'token' && makeBfApi(s).payPowerAny(u.owner, 3)) {
      s.players[u.owner].zones.base.push({ ...u, exhausted: true, damage: 0 })
      emit({ kind: 'buff', iid: u.iid, player: u.owner })
      rescued.add(u.iid)
      s = log(s, u.owner, `Altar of Blood: paid 3 to heal, exhaust, and recall ${getCard(u.cardId)?.name} to base.`)
    } else if (dead) {
      sendToTrash(s.players[u.owner], u)
      emit({ kind: 'defeat', iid: u.iid, cardId: u.cardId })
      defeated.push(u)
    } else survivors.push({ ...u, damage: 0 })
  }
  bf.units = survivors
  const lost = defendersDefeated.size + attackersDefeated.size - rescued.size
  s = log(
    s,
    moverOwner,
    `Showdown at ${bfName}: ${attackMight} vs ${defendMight} Might â€” ${lost} unit(s) defeated.`,
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
    s = log(s, moverOwner, `No conquer â€” ${moverRemain.length} attacker(s) recalled to base.`)
  }

  s.showdown = null
  s.phase = 'action'

  // "When I win a combat" â€” the mover cleared the defenders and still holds units.
  const moverHere = s.battlefields[bfIndex].units.filter((u) => u.owner === moverOwner).map((u) => u.iid)
  const enemyHere = s.battlefields[bfIndex].units.some((u) => u.owner !== moverOwner)
  if (moverHere.length > 0 && !enemyHere)
    s = fireTriggers(s, collectSelf(s, moverOwner, 'winCombat', moverHere))

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    // Excess (overkill) the mover assigned to the defenders this combat — the
    // attack damage beyond the defenders' total Might (Trapping Grounds).
    const defStep = steps.find((st) => st.side === 'defenders')
    const totalDefHp = defStep ? Object.values(defStep.hp).reduce((a, b) => a + b, 0) : 0
    const excess = Math.max(0, attackMight - totalDefHp)
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    s = grantHunt(s, moverOwner, bfIndex)
    s = applyConquerPassive(s, moverOwner, bfIndex, excess)
    s = fireTriggers(s, collectGlobal(s, moverOwner, 'conquer'), bfIndex, excess)
    s = fireTriggers(s, collectSelf(s, moverOwner, 'conquer', moverHere), bfIndex, excess)
    offerLeblanc(s, moverOwner, bfIndex) // LeBlanc - Deceiver: copy a unit here
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

  // Copy-a-unit spell (Mirror Image): play a ready Reflection copy of the chosen
  // unit to your base, Temporary. The parser can't express "copy", so handle it
  // here from the chosen target.
  if (isCopySpell(card)) {
    const src = (targets ?? []).map((t) => findUnitAnywhere(s, t)).find(Boolean)
    if (src) {
      p.zones.base.push(makeReflection(src, controller, s.turn, true))
      return log(s, controller, `${card.name}: played a Reflection copy of ${getCard(src.cardId)?.name}.`)
    }
    return log(s, controller, `${card.name} fizzled — no unit to copy.`)
  }

  // Untargeted parts (draw / channel / recruit) always resolve.
  for (const line of applyParsed(s, p, e)) s = log(s, controller, line)
  s = fireTokenPlay(s, controller, tokenUnitsIn(e)) // Lillia: token-unit play synergy

  // "Each player kills one of their units" (Cull the Weak): every player loses
  // their lowest-Might unit (a faithful auto-pick; firing death triggers).
  if (e.cullEachPlayer) {
    const dead: EngineCard[] = []
    for (const pl of s.players) {
      const own = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
        (u) => u.owner === pl.id && getCard(u.cardId)?.type === 'unit',
      )
      if (!own.length) continue
      const victim = own.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
      dead.push(...killTarget(s, victim.iid))
    }
    if (dead.length) s = log(s, controller, `${card.name}: each player killed a unit.`)
    s = fireDeaths(s, dead)
  }

  // Targeted parts: damage / kill / Â±Might-this-turn, applied to each chosen
  // target that's still in play.
  if (hasTargetedPart(e)) {
    const tgts = (targets ?? []).filter((t) => isValidTarget(s, t))
    if (tgts.length === 0 && !hasUntargetedPart(e))
      s = log(s, controller, `${card.name} fizzled â€” no valid target.`)
    for (const t of tgts) {
      let dead: EngineCard[] = []
      if (e.damage) {
        dead = applyTargetDamage(s, t, e.damage, true)
        s = log(s, controller, `${card.name} dealt ${e.damage}.`)
      } else if (e.kill) {
        // "with N Might or less" restriction (Soul Harvest): skip if too big.
        const tu = findUnitAnywhere(s, t)
        if (e.killMightMax != null && tu && mightOf(tu) > e.killMightMax) {
          s = log(s, controller, `${card.name}: ${getCard(tu.cardId)?.name} has too much Might to kill.`)
        } else {
          dead = killTarget(s, t)
          s = log(s, controller, `${card.name} killed a unit.`)
          // "Its controller draws N" (Hidden Blade): the killed unit's owner draws.
          if (e.controllerDrawOnKill && dead.length) {
            const drew = drawN(s.players[dead[0].owner], e.controllerDrawOnKill)
            s = log(s, dead[0].owner, `${card.name}: drew ${drew} (a unit was killed).`)
          }
        }
      }
      if (e.stun) {
        const u = findUnitAnywhere(s, t)
        if (u) {
          u.stunned = true
          emit({ kind: 'stun', iid: t, player: controller })
          s = log(s, controller, `${card.name} stunned ${getCard(u.cardId)?.name}.`)
        }
      }
      if (e.grantAssault || e.grantGanking) {
        const u = findUnitAnywhere(s, t)
        if (u) {
          if (e.grantAssault) u.grantAssault = (u.grantAssault ?? 0) + e.grantAssault
          if (e.grantGanking) u.grantGanking = true
          emit({ kind: 'buff', iid: t, player: controller })
          s = log(s, controller, `${card.name}: ${getCard(u.cardId)?.name} gains ${e.grantAssault ? `[Assault ${e.grantAssault}]` : ''}${e.grantAssault && e.grantGanking ? ' and ' : ''}${e.grantGanking ? '[Ganking]' : ''} this turn.`)
        }
      }
      if (e.tempMight) {
        const more = applyTempMight(s, t, e.tempMight, e.tempMightFloor)
        dead = dead.concat(more)
        s = log(s, controller, `${card.name}: ${e.tempMight > 0 ? '+' : ''}${e.tempMight} Might this turn.`)
      }
      if (e.bounce) s = bounceUnitToHand(s, t, controller, card.name, e.channelExhausted)
      if (dead.length && e.drawOnKill) {
        const drew = drawN(p, e.drawOnKill)
        s = log(s, controller, `${card.name}: drew ${drew} (a unit died).`)
      }
      s = fireDeaths(s, dead)
    }
  }

  // Vision / Predict spells: peek the top of your Main Deck; the controller may
  // recycle it. Surfaced as a pending decision (same look as the keyword).
  const kw = parseKeywords(card)
  if ((kw.vision || kw.predict) && p.zones.mainDeck.length > 0) {
    s = { ...s, vision: { player: controller, cardId: p.zones.mainDeck[0].cardId } }
    s = log(s, controller, `${kw.predict ? 'Predict' : 'Vision'} â€” look at the top of your deck; you may recycle it.`)
  }

  if (e.manual && !hasTargetedPart(e) && !hasUntargetedPart(e))
    s = log(s, controller, `Cast ${card.name} â€” resolve its effect manually.`)
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
function applyTempMight(s: MatchState, iid: string, delta: number, floor = 0): EngineCard[] {
  const u = findUnitAnywhere(s, iid)
  if (!u) return []
  // A "to a minimum of N Might" debuff can't push the unit below the floor.
  if (delta < 0 && floor > 0) delta = Math.max(delta, floor - mightOf(u))
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
      s = log(s, item.controller, `Countered ${getCard(target.cardId)?.name ?? 'a spell'} â€” it does not resolve.`)
    } else {
      s = log(s, item.controller, `Counter fizzled â€” its target left the chain.`)
    }
    sendToTrash(p, item.instance)
    return s
  }
  const card = getCard(item.cardId)
  if (card) {
    s = resolveSpellEffects(s, item.controller, card, item.targets)
    // [Repeat]: resolve the effect an extra time per paid repeat.
    for (let r = 0; r < (item.repeat ?? 0); r++) {
      s = log(s, item.controller, `${card.name}: Repeat â€” resolving its effect again.`)
      s = resolveSpellEffects(s, item.controller, card, item.targets)
    }
  }
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
  return log(s, null, 'Setup complete â€” players mulligan.')
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
      // Highest roll wins (first max on a tie â€” the UI re-rolls ties for fairness).
      let winner = 0
      for (let i = 1; i < su.rolls.length; i++) if (su.rolls[i] > su.rolls[winner]) winner = i
      su.winner = winner
      su.step = 'first'
      return ok(log(s, null, `Turn-order roll: ${su.rolls.map((r, i) => `${s.players[i].name} ${r}`).join(', ')} â€” ${s.players[winner].name} chooses.`))
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
      const legendCard = getCard(p.legend.cardId)
      // Pay the activated ability's Energy cost ("1, exhaust: …" — Lee Sin's
      // buff), applying any "costs N less per friendly [Keyword] unit" reduction
      // (Lillia - Bashful Bloom). The exhaust half is the legend tapping below.
      const act = legendCard ? legendActivationCost(legendCard, s, action.player) : null
      if (act && act.energy > 0 && !makeBfApi(s).payEnergy(action.player, act.energy))
        return fail(state, `Not enough Energy to use ${legendCard?.name ?? 'the legend'}.`)
      // Generic activation: exhaust the legend, then auto-resolve its parsed
      // effect (draw/channel/buff/…); anything we can't parse is surfaced.
      p.legend = { ...p.legend, exhausted: true }
      let s1 = log(s, action.player, `${legendCard?.name ?? 'Legend'} ability used.`)
      if (legendCard) {
        const e = spellEffect(legendCard)
        for (const line of applyParsed(s1, p, e)) s1 = log(s1, action.player, line)
        if (!e.draw && !e.channel && !e.recruits && !e.goldTokens && !e.namedToken && !e.buff && !e.readySelf)
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
      let s2 = log(s, action.player, `Created token: ${card.name}.`)
      if (card.type === 'unit') s2 = fireTokenPlay(s2, action.player, 1) // Lillia synergy
      return ok(s2)
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
      const baseCost = effectiveCostOf(s, action.player, card)
      let effCost = accelChosen ? addCost(baseCost, accelerateCost(card)!) : baseCost
      // Deflect: a spell choosing an enemy unit with Deflect X costs X more.
      if (action.type === 'PLAY_SPELL') {
        const surcharge = deflectSurcharge(state, action.targets, action.player)
        if (surcharge > 0) effCost = addCost(effCost, { energy: surcharge, power: {} })
      }
      // Repeat: an OPTIONAL additional cost on a spell to resolve its effect
      // again. When the player opts in, fold it into the cost to be paid. The
      // cost may come from the keyword or from The Academy's grant, and is
      // discounted by Marai Spire (all handled by repeatCostFor).
      const repeatAvail = action.type === 'PLAY_SPELL' ? repeatCostFor(s, action.player, card) : null
      const repeatChosen = action.type === 'PLAY_SPELL' && !!action.repeat && !!repeatAvail
      if (repeatChosen) effCost = addCost(effCost, repeatAvail!)
      const err = applyPayment(p, effCost, action.payment)
      if (err) return fail(state, err)
      // A card's "cost" for threshold triggers (Lux — "a spell that costs 5+") is
      // total Energy + Power, not just Energy.
      const effTotal = effCost.energy + Object.values(effCost.power).reduce((a, b) => a + (b ?? 0), 0)

      if (fromChampion) p.champion = null
      else removeFromZone(p, 'hand', action.iid)
      const kw = parseKeywords(card)
      // LEGION is "on" if you already played another Main Deck card this turn.
      const legionActive = (p.cardsPlayedThisTurn ?? 0) >= 1
      p.cardsPlayedThisTurn = (p.cardsPlayedThisTurn ?? 0) + 1
      // The Academy grant applies to one spell, consumed when that spell is played.
      if (card.type === 'spell') p.grantRepeatNextSpell = false

      if (action.type === 'PLAY_UNIT') {
        // Units enter exhausted unless the player paid Accelerate, an active
        // [Level N] grants "enters ready", a base "I enter ready" ability (Master
        // Yi - Honed), or the controller's legend grants it (Wuju Master L11).
        const levelReady = levelBonus(card, p.xp).ready
        const baseReady = /\bi enters? ready\b/i.test(card.text ?? '')
        // Wuju Master: "[Level 11] Your units enter ready." while the controller has 11+ XP.
        const legText = (getCard(p.legend?.cardId ?? '')?.text ?? '').toLowerCase()
        const legReadyM = legText.match(/\[level\s*(\d+)\][^.]*?your units enter(?:s)? ready/)
        const legendReady = !!legReadyM && p.xp >= parseInt(legReadyM[1], 10)
        const entersReady = accelChosen || levelReady || baseReady || legendReady
        // Ambush: a Reaction unit enters directly at a contested battlefield.
        const ambushBf = kw.ambush && action.toBattlefield != null ? action.toBattlefield : null
        if (ambushBf != null) {
          s.battlefields[ambushBf].units.push({ ...ci, exhausted: false, enteredTurn: s.turn })
          recomputeControllers(s)
          bfUnitPlayedHere(s, action.player, ambushBf, ci.iid) // Valley of Idols / Star Spring
        } else {
          p.zones.base.push({ ...ci, exhausted: !entersReady, enteredTurn: s.turn })
        }
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        let s1 = log(
          s,
          action.player,
          `Played ${card.name}${ambushBf != null ? ' (Ambush)' : accelChosen ? ' (ready Â· Accelerate)' : levelReady ? ' (ready Â· Level)' : ''}.`,
        )
        const e = onPlayEffect(card)
        const legionGated = kw.legion && !legionActive
        if (!legionGated) {
          for (const line of applyParsed(s1, p, e, undefined, ci.iid)) s1 = log(s1, action.player, line)
          s1 = fireTokenPlay(s1, action.player, tokenUnitsIn(e)) // Lillia: token-unit play synergy
        } else {
          s1 = log(s1, action.player, `${card.name}: Legion inactive (no prior card this turn).`)
        }
        // Keeper of Masks: when played, play two Reflection copies of itself here.
        if (card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Keeper of Masks' && !legionGated) {
          const dest = ambushBf != null ? s1.battlefields[ambushBf].units : s1.players[action.player].zones.base
          for (let i = 0; i < 2; i++) dest.push(makeReflection(ci, action.player, s1.turn, false))
          if (ambushBf != null) recomputeControllers(s1)
          s1 = log(s1, action.player, `Keeper of Masks: played two Reflection copies.`)
        }
        // Vision / Predict: peek the top of your Main Deck; a decision (keep /
        // recycle) is surfaced to the controller (same look, both keywords).
        if ((kw.vision || kw.predict) && p.zones.mainDeck.length > 0) {
          s1 = { ...s1, vision: { player: action.player, cardId: p.zones.mainDeck[0].cardId } }
          s1 = log(s1, action.player, `${kw.predict ? 'Predict' : 'Vision'} â€” look at the top of your deck; you may recycle it.`)
        }
        if (e.manual && !e.draw && !e.channel && !e.recruits && !e.goldTokens && !e.namedToken && !legionGated)
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
        s1 = firePlayTriggers(s1, action.player, ci.iid, card, effTotal)
        return ok(s1)
      }

      if (action.type === 'PLAY_GEAR') {
        // Track Equipment plays this turn (Azir - Emperor of the Sands gate).
        if (parseKeywords(card).equip) p.playedEquipmentThisTurn = true
        // Attach to a target unit (granting its bonuses) if given, else base.
        if (action.targetIid) {
          for (const u of p.zones.base.concat(s.battlefields.flatMap((b) => b.units)))
            if (u.iid === action.targetIid && u.owner === action.player) {
              u.attached = [...u.attached, `${card.id}|${ci.iid}`]
              emit({ kind: 'buff', iid: u.iid, player: action.player, cardId: card.id })
              return ok(firePlayTriggers(log(s, action.player, `Equipped ${card.name} to ${getCard(u.cardId)?.name}.`), action.player, ci.iid, card, effTotal))
            }
        }
        p.zones.base.push({ ...ci })
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        return ok(firePlayTriggers(log(s, action.player, `Played gear ${card.name} (unattached).`), action.player, ci.iid, card, effTotal))
      }

      // Spell. In a showdown we resolve immediately (legacy path). In the
      // action phase the spell goes on the Chain and opens a priority window.
      if (inShowdown) {
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        // "When you play a spell" triggers fire as it's played, before it resolves.
        let s1 = firePlayTriggers(s, action.player, ci.iid, card, effTotal)
        s1 = fireChemtechCask(s1, action.player)
        s1 = bfSpellPlayed(s1, action.player, effCost.energy)
        s1 = resolveSpellEffects(s1, action.player, card, action.targets)
        if (repeatChosen) {
          s1 = log(s1, action.player, `${card.name}: Repeat â€” resolving its effect again.`)
          s1 = resolveSpellEffects(s1, action.player, card, action.targets)
        }
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
        repeat: repeatChosen ? 1 : undefined,
      })
      s.passes = 0
      s.priority = nextPlayer(s, action.player)
      // Play-triggers fire now (before the chain resolves), so they still happen
      // even if this spell is later Countered.
      let sPlayed = firePlayTriggers(s, action.player, ci.iid, card, effTotal)
      sPlayed = fireChemtechCask(sPlayed, action.player)
      sPlayed = bfSpellPlayed(sPlayed, action.player, effCost.energy)
      return ok(
        log(sPlayed, action.player, `Played ${card.name} â€” it's on the Chain (opponents may respond).`),
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
      // Banish removes a unit from play to its OWNER's Banishment â€” no Deathknell.
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
      const bfi = action.toBattlefield
      if (bfi < 0 || bfi >= state.battlefields.length) return fail(state, 'Invalid battlefield.')
      if (state.battlefields[bfi].controller !== action.player)
        return fail(state, 'You must control a battlefield to Hide a card there.')
      if (state.battlefields[bfi].facedown) return fail(state, 'A card is already hidden at that battlefield.')
      const s = clone(state)
      const p = s.players[action.player]
      // Any [Hidden] card (unit / spell / gear) is hidden from HAND.
      const card = p.zones.hand.find((c) => c.iid === action.iid)
      if (!card) return fail(state, 'Card not in your hand.')
      if (!parseKeywords(getCard(card.cardId)).hidden) return fail(state, 'Only a card with [Hidden] can be hidden.')
      const rune = p.zones.runePool.find((r) => r.iid === action.runeIid && !r.exhausted)
      if (!rune) return fail(state, 'Need a ready rune to pay the Hide cost.')
      removeFromZone(p, 'hand', action.iid)
      // Teemo - Swift Scout: "pay :rb_energy_1: to hide instead of :rb_rune_rainbow:"
      // → exhaust the rune (Energy) and KEEP it, rather than recycling it.
      const legendName = getCard(p.legend?.cardId ?? '')?.name?.replace(/\s*\([^)]*\)\s*$/, '').trim()
      if (legendName === 'Teemo - Swift Scout') {
        rune.exhausted = true
      } else {
        const recycled = removeFromZone(p, 'runePool', action.runeIid)!
        p.zones.runeDeck.push({ ...recycled, exhausted: false, damage: 0 })
      }
      s.battlefields[bfi].facedown = { ...card, facedown: true, hiddenTurn: s.turn }
      return ok(log(s, action.player, `Hid a card facedown at ${getCard(s.battlefields[bfi].cardId)?.name ?? 'a battlefield'}${legendName === 'Teemo - Swift Scout' ? ' (Teemo: paid 1 Energy)' : ''}.`))
    }

    case 'REVEAL': {
      let s = clone(state)
      const bfi = s.battlefields.findIndex((b) => b.facedown?.iid === action.iid && b.facedown.owner === action.player)
      if (bfi < 0) return fail(state, 'No facedown card of yours to reveal.')
      const fd = s.battlefields[bfi].facedown!
      if ((fd.hiddenTurn ?? -1) >= s.turn) return fail(state, "You can't reveal a card the turn you hid it.")
      const card = getCard(fd.cardId)
      if (!card) return fail(state, 'Unknown card.')
      s.battlefields[bfi].facedown = null
      const ci: EngineCard = { ...fd, facedown: false, hiddenTurn: undefined }
      emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: ci.cardId })
      // Reveal = play for 0, at the battlefield where it was hidden.
      if (card.type === 'unit') {
        s.battlefields[bfi].units.push({ ...ci, exhausted: true, enteredTurn: s.turn })
        recomputeControllers(s)
        s = log(s, action.player, `Revealed ${card.name} — entered play.`)
        for (const line of applyParsed(s, s.players[action.player], onPlayEffect(card), bfi, ci.iid)) s = log(s, action.player, line)
        s = firePlayTriggers(s, action.player, ci.iid, card, 0)
      } else if (card.type === 'gear') {
        s.players[action.player].zones.base.push({ ...ci, exhausted: false })
        s = log(s, action.player, `Revealed ${card.name} — gear entered play.`)
        s = firePlayTriggers(s, action.player, ci.iid, card, 0)
      } else {
        s = log(s, action.player, `Revealed ${card.name} — resolving.`)
        s = resolveSpellEffects(s, action.player, card, [])
        s = firePlayTriggers(s, action.player, ci.iid, card, 0)
        sendToTrash(s.players[action.player], ci)
      }
      return ok(s)
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

    case 'RESOLVE_CHOICE': {
      const pc = state.pendingChoice
      if (!pc || pc.player !== action.player) return fail(state, 'No choice to resolve right now.')
      let s = clone(state)
      s.pendingChoice = undefined
      if (action.iid !== null && !pc.options.some((o) => o.iid === action.iid))
        return fail(state, 'That is not a valid choice.')

      // Dusk Rose Lab pauses the Beginning Phase before scoring; resolving it
      // (pick or decline) resumes via finishBeginning.
      if (pc.kind === 'duskRoseSacrifice') {
        if (action.iid !== null) {
          const nm = getCard(findUnitAnywhere(s, action.iid)?.cardId ?? '')?.name ?? 'a unit'
          s = fireDeaths(s, killTarget(s, action.iid))
          drawN(s.players[action.player], 1)
          s = log(s, action.player, `Dusk Rose Lab — killed ${nm} to draw 1.`)
        } else {
          s = log(s, action.player, 'Dusk Rose Lab — declined.')
        }
        return ok(finishBeginning(s))
      }

      // Decline the optional effect (non-resuming kinds).
      if (action.iid === null) return ok(log(s, action.player, 'Declined the battlefield effect.'))
      const name = getCard(findUnitAnywhere(s, action.iid)?.cardId ?? '')?.name ?? 'a unit'
      switch (pc.kind) {
        case 'moveHereToBase':
        case 'moveAnyToBase':
          sendUnitToBase(s, action.iid)
          return ok(log(s, action.player, `Moved ${name} to base.`))
        case 'leblancCopy': {
          // Discard 1 + exhaust LeBlanc to play a ready Reflection copy of the
          // chosen unit at the battlefield, Temporary.
          const lg = s.players[action.player].legend
          if (!lg || lg.exhausted) return fail(state, 'LeBlanc is unavailable.')
          if (s.players[action.player].zones.hand.length === 0) return fail(state, 'No card to discard.')
          const src = s.battlefields[pc.bfIndex].units.find((u) => u.iid === action.iid)
          if (!src) return fail(state, 'That unit is no longer here.')
          const discarded = s.players[action.player].zones.hand.shift()!
          s.players[action.player].zones.trash.push(discarded)
          lg.exhausted = true
          s.battlefields[pc.bfIndex].units.push(makeReflection(src, action.player, s.turn, true))
          recomputeControllers(s)
          return ok(log(s, action.player, `LeBlanc — copied ${name} (Temporary); discarded a card.`))
        }
        case 'daisReturn': {
          // Pay 1, return the chosen unit here to its owner's hand, then play a
          // Sand Soldier token at this battlefield.
          if (!makeBfApi(s).payEnergy(action.player, 1)) return fail(state, "Can't pay for Emperor's Dais.")
          const bf = s.battlefields[pc.bfIndex]
          if (!returnUnitToHand(s, pc.bfIndex, action.iid)) return fail(state, 'That unit is no longer here.')
          const tokId = TOKEN_BY_NAME['sand soldier']
          if (tokId) bf.units.push({ iid: `${action.player}:tok:${tokId}#${(tokenCounter++).toString(36)}`, cardId: tokId, owner: action.player, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn })
          recomputeControllers(s)
          return ok(log(s, action.player, `Emperor's Dais â€” returned ${name} to hand and played a Sand Soldier.`))
        }
        case 'forgePickEquip': {
          // Stored the chosen Equipment; now prompt for the target unit.
          const units = unitsControlledBy(s, action.player).map((u) => unitOpt(u))
          s.pendingChoice = { player: action.player, kind: 'forgePickTarget', bfIndex: -1, prompt: 'Forge of the Fluft — choose a unit to attach it to.', options: units, payload: action.iid }
          return ok(s)
        }
        case 'forgePickTarget': {
          // Attach the carried Equipment to the chosen unit.
          const equipIid = pc.payload
          const target = findUnitAnywhere(s, action.iid)
          if (!equipIid || !target || target.owner !== action.player) return fail(state, 'Invalid attach target.')
          const gi = s.players[action.player].zones.base.findIndex((c) => c.iid === equipIid)
          if (gi < 0) return fail(state, 'That Equipment is no longer available.')
          const [gear] = s.players[action.player].zones.base.splice(gi, 1)
          target.attached = [...target.attached, `${gear.cardId}|${gear.iid}`]
          return ok(log(s, action.player, `Forge of the Fluft: attached ${getCard(gear.cardId)?.name} to ${getCard(target.cardId)?.name}.`))
        }
        case 'orbMinusMight': {
          // Orb of Regret: -N Might this turn, to a minimum of 1 current Might.
          const u = findUnitAnywhere(s, action.iid)
          if (!u) return fail(state, 'That unit is no longer in play.')
          const amt = parseInt(pc.payload ?? '1', 10)
          applyTempMight(s, action.iid, -amt, 1)
          return ok(log(s, action.player, `Orb of Regret: ${name} -${amt} Might this turn (min 1).`))
        }
      }
      return ok(s)
    }

    case 'ACTIVATE_ABILITY': {
      const ga = grantedAbilityFor(state, action.player, action.iid)
      if (!ga) return fail(state, 'No activated ability available there.')
      const s = clone(state)
      const p = s.players[action.player]
      if (ga.kind === 'gainXP') {
        const u = findUnitAnywhere(s, action.iid)!
        u.exhausted = true
        p.xp += 1
        return ok(log(s, action.player, `${getCard(u.cardId)?.name}: exhausted to gain 1 XP (now ${p.xp}).`))
      }
      // Lux - Crownguard: exhaust to add Energy to the pool (for playing spells).
      // The "spells only" restriction isn't tracked on pooled Energy; logged as a
      // reminder, consistent with how other resource-add effects are modeled.
      if (ga.kind === 'addEnergySpells') {
        const u = controlledInstance(s, action.player, action.iid)!
        u.exhausted = true
        p.pool = p.pool ?? { energy: 0, power: {} }
        p.pool.energy += ga.amount
        emit({ kind: 'buff', iid: u.iid, player: action.player })
        return ok(log(s, action.player, `${getCard(u.cardId)?.name}: added ${ga.amount} Energy (use only to play spells).`))
      }
      // Orb of Regret: exhaust, then choose a unit to give -N Might this turn.
      if (ga.kind === 'minusMightTarget') {
        const u = controlledInstance(s, action.player, action.iid)!
        u.exhausted = true
        const opts = allUnitsInPlay(s).map((x) => unitOpt(x))
        offerChoice(s, { player: action.player, kind: 'orbMinusMight', bfIndex: -1, prompt: `${getCard(u.cardId)?.name} — give a unit -${ga.amount} Might this turn (min 1).`, options: opts, payload: String(ga.amount) })
        return ok(log(s, action.player, `${getCard(u.cardId)?.name}: exhausted — choose a unit to weaken.`))
      }
      // forgeAttach: exhaust the legend, then prompt to pick an Equipment.
      p.legend!.exhausted = true
      const equips = p.zones.base.filter(isEquipment).map((c) => ({ iid: c.iid, label: getCard(c.cardId)?.name ?? c.iid }))
      offerChoice(s, { player: action.player, kind: 'forgePickEquip', bfIndex: -1, prompt: 'Forge of the Fluft — choose an Equipment to attach.', options: equips })
      return ok(log(s, action.player, `Forge of the Fluft: exhausted your legend to attach an Equipment.`))
    }

    case 'ACTIVATE_UNIT': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      const ab = canActivateUnit(state, action.player, action.iid)
      if (!ab) return fail(state, 'That ability can\'t be activated right now.')
      const s = clone(state)
      const p = s.players[action.player]
      const u = controlledInstance(s, action.player, action.iid)!
      const name = getCard(u.cardId)?.name ?? 'a unit'
      const mightNow = mightOf(u) // for "double my Might" before any change
      // Pay the cost: energy/runes, recycle-from-trash, exhaust, kill-this.
      const cost = { energy: ab.energy, power: ab.power }
      if (!costIsFree(cost)) {
        const pay = autoPay(p, cost)
        if (!pay || applyPayment(p, cost, pay)) return fail(state, 'Not enough resources.')
      }
      for (let i = 0; i < ab.recycleTrash && p.zones.trash.length > 0; i++) p.zones.mainDeck.push(p.zones.trash.shift()!)
      if (ab.exhaust && !ab.killThis) u.exhausted = true
      let s1 = log(s, action.player, `${name}: activated — ${ab.effectText}.`)
      // "Attach an Equipment you control to a unit you control" (Jax) — a
      // two-step pick-equip → pick-target, reusing the Forge choice flow.
      if (/attach\b[^.]*\bequipment\b[^.]*\bto a unit/i.test(ab.effectText)) {
        const equips = p.zones.base.filter(isEquipment).map((c) => ({ iid: c.iid, label: getCard(c.cardId)?.name ?? c.iid }))
        if (!equips.length) return fail(state, 'No detached Equipment you control to attach.')
        offerChoice(s1, { player: action.player, kind: 'forgePickEquip', bfIndex: -1, prompt: `${name} — choose an Equipment to attach.`, options: equips })
        return ok(s1)
      }
      // Resolve the effect.
      if (ab.doubleMight) {
        u.tempMight = (u.tempMight ?? 0) + mightNow
        emit({ kind: 'buff', iid: u.iid, player: action.player })
      } else if (ab.effect.tempMightSelf) {
        u.tempMight = (u.tempMight ?? 0) + ab.effect.tempMightSelf
        emit({ kind: 'buff', iid: u.iid, player: action.player })
      } else {
        // Targeted parts (deal N / give a unit +N Might this turn / Buff a unit).
        for (const t of action.targets ?? []) {
          if (!isValidTarget(s1, t)) continue
          if (ab.effect.damage) s1 = fireDeaths(s1, applyTargetDamage(s1, t, ab.effect.damage, true))
          if (ab.effect.tempMight) s1 = fireDeaths(s1, applyTempMight(s1, t, ab.effect.tempMight, ab.effect.tempMightFloor))
          // "Buff a friendly unit" (Lee Sin) — a permanent +1 Might counter.
          if (ab.effect.buff) {
            const tu = findUnitAnywhere(s1, t)
            if (tu) { tu.buffs = (tu.buffs ?? 0) + ab.effect.buff; emit({ kind: 'buff', iid: tu.iid, player: action.player }) }
          }
          // "Move a friendly unit … to its base" (The Syren, Yasuo pull-back).
          if (/\bmove\b/i.test(ab.effectText) && /\bbase\b/i.test(ab.effectText) && battlefieldOf(s1, t) >= 0)
            sendUnitToBase(s1, t)
          // "Return / Put a unit … to (its owner's) hand" (Teemo, Pyke). Tokens
          // cease to exist; attached gear detaches to base (bounceUnitToHand).
          if (/(return|put|bounce)/i.test(ab.effectText) && /\bhand\b/i.test(ab.effectText))
            s1 = bounceUnitToHand(s1, t, action.player, name, 0)
        }
      }
      // Untargeted resource parts (Garbage Grabber: "Draw 1"; channel variants).
      if (ab.effect.draw) drawN(p, ab.effect.draw)
      if (ab.effect.channel) channelN(p, ab.effect.channel)
      // Recruit token(s) (Viktor - Herald of the Arcane: "Play a 1 Might Recruit").
      if (ab.effect.recruits) {
        spawnRecruits(p, ab.effect.recruits, s1.turn)
        s1 = fireTokenPlay(s1, action.player, ab.effect.recruits) // Lillia-style synergy
      }
      // Named unit token (Azir: "Play a 2 Might Sand Soldier unit token to your
      // base"). For an unscoped "here" we default to the player's base.
      if (ab.effect.namedToken) {
        const nt = ab.effect.namedToken
        const bfHere = nt.here ? battlefieldOf(s1, u.iid) : -1
        const dest = bfHere >= 0 ? s1.battlefields[bfHere].units : p.zones.base
        spawnNamedToken(p, nt.name, nt.count, s1.turn, nt.exhausted, nt.temporary, dest)
        s1 = fireTokenPlay(s1, action.player, nt.count)
      }
      // Pyke - Bloodharbor Ripper: "… Play a Gold gear token exhausted." (the
      // second sentence isn't captured in effectText, so read the source text).
      const srcText = getCard(u.cardId)?.text ?? ''
      if (/gold gear token/i.test(srcText)) spawnGold(s1.players[action.player], 1, s1.turn)
      // Predict (Scryer's Bloom): peek the top of your deck; you may recycle it.
      if (/\bpredict\b/i.test(srcText) && p.zones.mainDeck.length > 0)
        s1.vision = { player: action.player, cardId: p.zones.mainDeck[0].cardId }
      // "Gain N XP" (Scryer's Bloom's trailing sentence, not in effectText).
      const xpM = srcText.match(/gain (\d+)\s*(?::rb_xp:|xp)/i)
      if (xpM) p.xp += parseInt(xpM[1], 10)
      // "Kill this" cost resolves after the effect (the source is sacrificed).
      if (ab.killThis) s1 = fireDeaths(s1, killTarget(s1, u.iid))
      return ok(s1)
    }

    case 'SET_SANDBOX': {
      const s = clone(state)
      s.sandbox = action.on
      return ok(log(s, action.player, `Manual overrides ${action.on ? 'enabled' : 'disabled'}.`))
    }

    case 'OVERRIDE': {
      if (!state.sandbox) return fail(state, 'Manual overrides are off.')
      let s = clone(state)
      const u = action.iid ? findUnitAnywhere(s, action.iid) : undefined
      const nm = u ? getCard(u.cardId)?.name ?? 'a unit' : ''
      switch (action.op) {
        case 'stun': if (u) u.stunned = true; break
        case 'unstun': if (u) u.stunned = false; break
        case 'ready': if (u) u.exhausted = false; break
        case 'exhaust': if (u) u.exhausted = true; break
        case 'buff': if (u) u.buffs = (u.buffs ?? 0) + 1; break
        case 'unbuff': if (u) u.buffs = Math.max(0, (u.buffs ?? 0) - 1); break
        case 'mightUp': if (u) u.tempMight = (u.tempMight ?? 0) + 1; break
        case 'mightDown': if (u) u.tempMight = (u.tempMight ?? 0) - 1; break
        case 'kill': if (action.iid) s = fireDeaths(s, killTarget(s, action.iid)); break
        case 'toBase': if (action.iid) sendUnitToBase(s, action.iid); break
        case 'banish':
        case 'trash': {
          if (!action.iid) break
          for (const bf of s.battlefields) {
            const i = bf.units.findIndex((x) => x.iid === action.iid)
            if (i >= 0) { const [x] = bf.units.splice(i, 1); (action.op === 'banish' ? s.players[x.owner].banished : s.players[x.owner].zones.trash).push(x); break }
          }
          for (const pl of s.players)
            for (const z of Object.keys(pl.zones) as ZoneId[]) {
              const i = pl.zones[z].findIndex((x) => x.iid === action.iid)
              if (i >= 0) { const [x] = pl.zones[z].splice(i, 1); (action.op === 'banish' ? pl.banished : pl.zones.trash).push(x); break }
            }
          break
        }
        case 'draw': drawN(s.players[action.player], 1); break
        case 'channel': channelN(s.players[action.player], 1); break
        case 'move': {
          if (!action.iid) break
          const card = pluckCardAnywhere(s, action.iid)
          if (!card) break
          if (action.toBattlefield != null && s.battlefields[action.toBattlefield]) {
            card.exhausted = false
            card.facedown = false
            s.battlefields[action.toBattlefield].units.push(card)
          } else if (action.toZone === 'banished') {
            s.players[card.owner].banished.push(card)
          } else if (action.toZone === 'mainDeck' || action.toZone === 'runeDeck') {
            // Decks draw from the front, so "to deck" puts the card on top.
            s.players[card.owner].zones[action.toZone].unshift(card)
          } else if (action.toZone) {
            s.players[card.owner].zones[action.toZone].push(card)
          } else {
            // No valid destination — put it back in its owner's base.
            s.players[card.owner].zones.base.push(card)
          }
          break
        }
      }
      recomputeControllers(s)
      return ok(log(s, action.player, `Override: ${action.op}${nm ? ` ${nm}` : ''}.`))
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
      if (state.showdown.invite) return fail(state, 'An invitation is awaiting a response.')
      const s = clone(state)
      s.showdown!.passes += 1
      s.showdown!.priority = nextShowdownPriority(s, action.player)
      // Resolve once every participant (combatants + accepted helpers) has passed.
      if (s.showdown!.passes >= showdownParticipants(s).length) {
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
      // All players still in the match passed in a row â†’ resolve the top of the chain.
      if (s.passes >= aliveCount(s)) {
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
      const err = applyPayment(p, effectiveCostOf(s, action.player, card), action.payment)
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
      return ok(log(s, action.player, `Played ${card.name} to Counter â€” it's on the Chain.`))
    }

    case 'END_TURN': {
      const guard = requireActiveAction(state, action.player)
      if (guard) return fail(state, guard)
      let s = clone(state)
      // End-of-turn cleanup: clear "this turn" Might modifiers and Stun.
      for (const pl of s.players) {
        for (const z of Object.keys(pl.zones) as ZoneId[])
          pl.zones[z] = pl.zones[z].map((c) => ({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false }))
      }
      for (const bf of s.battlefields)
        bf.units = bf.units.map((u) => ({ ...u, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false }))
      // "At the end of your turn, …" effects for the ending player's permanents
      // (Dazzling Aurora's free-unit engine). Base gear + units + battlefield units.
      const ender = state.activePlayer
      const perms = [...s.players[ender].zones.base, ...s.battlefields.flatMap((b) => b.units.filter((u) => u.owner === ender))]
      for (const perm of perms) {
        const def = getCard(perm.cardId)
        if (!def) continue
        const eot = endOfTurnEffect(def)
        if (hasUntargetedPart(eot))
          for (const line of applyParsed(s, s.players[ender], eot, undefined, perm.iid)) s = log(s, ender, `${def.name}: ${line}`)
      }
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
      // cannot be reacted to â€” no chain item, no priority window (T14).
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
      if (state.players[action.player]?.out) return fail(state, 'You are already out of the match.')
      const wasActive = state.activePlayer === action.player
      let s = eliminate(state, action.player, 'conceded')
      // One survivor → eliminate() already declared them the winner.
      if (s.winner !== null) return ok(s)
      s = clone(s)
      // Repair any priority/turn pointers that referenced the departed seat.
      if (s.showdown) {
        if (s.showdown.invite && (s.showdown.invite.from === action.player || s.showdown.invite.to === action.player))
          s.showdown.invite = undefined
        // Their units left the battlefield. The combat fizzles if a side is now
        // empty (fewer than two participants) or the attacker who opened it left.
        const bfUnits = s.battlefields[s.showdown.battlefield].units
        const moverGone = !bfUnits.some((u) => u.iid === s.showdown!.movedUnit)
        if (showdownParticipants(s).length < 2 || moverGone) {
          s.showdown = null
          s.phase = 'action'
        } else if (s.showdown && s.showdown.priority === action.player) {
          s.showdown.priority = nextShowdownPriority(s, action.player)
        }
      }
      if (s.chain.length > 0 && s.priority === action.player)
        s.priority = nextPlayer(s, action.player)
      // If it was the conceder's turn (and no combat/chain is mid-resolution),
      // hand the turn to the next surviving player.
      if (wasActive && s.phase !== 'showdown' && s.chain.length === 0) {
        s.activePlayer = nextPlayer(s, action.player)
        s.turn += 1
        return ok(beginTurn(s))
      }
      // Otherwise keep the active pointer valid for when combat/chain resolves.
      if (wasActive) s.activePlayer = nextPlayer(s, action.player)
      return ok(s)
    }

    case 'INVITE': {
      if (state.phase !== 'showdown' || !state.showdown)
        return fail(state, 'You can only invite during a showdown.')
      if (state.showdown.assign) return fail(state, 'Combat damage is being assigned.')
      if (state.showdown.invite) return fail(state, 'An invitation is already pending.')
      const parts = showdownParticipants(state)
      if (!parts.includes(action.player))
        return fail(state, 'Only a combatant may invite a helper.')
      const invitee = action.invitee
      if (state.players[invitee]?.out) return fail(state, 'That player is out of the match.')
      if (parts.includes(invitee)) return fail(state, 'That player is already in the showdown.')
      const s = clone(state)
      // The invitee responds next.
      s.showdown!.invite = { from: action.player, to: invitee }
      s.showdown!.priority = invitee
      return ok(log(s, action.player, `${s.players[action.player].name} invited ${s.players[invitee].name} to join the showdown.`))
    }

    case 'INVITE_RESPOND': {
      if (state.phase !== 'showdown' || !state.showdown?.invite)
        return fail(state, 'No invitation to respond to.')
      if (state.showdown.invite.to !== action.player)
        return fail(state, 'This invitation is not for you.')
      const s = clone(state)
      const inv = s.showdown!.invite!
      s.showdown!.invite = undefined
      if (action.accept) {
        s.showdown!.helpers = [...(s.showdown!.helpers ?? []), action.player]
        // The new helper acts now; everyone re-passes before combat resolves.
        s.showdown!.priority = action.player
        s.showdown!.passes = 0
        return ok(log(s, action.player, `${s.players[action.player].name} joined the showdown to help ${s.players[inv.from].name}.`))
      }
      // Declined — priority returns to the inviter.
      s.showdown!.priority = inv.from
      return ok(log(s, action.player, `${s.players[action.player].name} declined the invitation.`))
    }

    default:
      return fail(state, 'Unknown action.')
  }
}

/** Common guard: must be the active player's action phase. */
function requireActiveAction(state: MatchState, player: PlayerId): string | null {
  if (state.chain.length > 0)
    return 'The chain is open â€” pass priority or respond first.'
  if (state.phase === 'showdown')
    return 'A showdown is open â€” pass or respond first.'
  if (state.phase !== 'action') return 'Not the action phase.'
  if (state.activePlayer !== player) return 'Not your turn.'
  return null
}

// ---------------------------------------------------------------------------
// Read-only validity API (UI-facing). These mirror the guards inside the PLAY
// handler so the interface can grey out unplayable cards, gate spells that have
// no legal target, and highlight only legal targets â€” without mutating state.
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

/** True if `iid` is still a unit in play â€” used to re-validate a spell's chosen
 *  target at resolution (a target may have left play while on the chain). */
export function isValidTarget(state: MatchState, iid: string): boolean {
  return unitsInPlay(state).some((u) => u.iid === iid)
}

/** Whether a unit can't be chosen by an enemy's spells/abilities right now —
 *  e.g. Master Yi - Unstoppable "[Level 16] I can't be chosen by enemy spells
 *  and abilities" while its controller has 16+ XP. */
function untargetableByEnemy(state: MatchState, u: EngineCard): boolean {
  const m = (getCard(u.cardId)?.text ?? '').toLowerCase().match(/\[level\s*(\d+)\][^.]*?can'?t be chosen by enemy spells/)
  return !!m && (state.players[u.owner]?.xp ?? 0) >= parseInt(m[1], 10)
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
    // Enemy units that can't be chosen by enemy spells (Unstoppable [Level 16]).
    units = units.filter((u) => u.owner === player || !untargetableByEnemy(state, u))
  }
  // "kill a unit with N Might or less" (Soul Harvest) — only offer small units.
  if (e.kill > 0 && e.killMightMax != null) units = units.filter((u) => mightOf(u) <= e.killMightMax!)
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
   *  part (e.g. "draw 1") â€” it can be played to resolve only that part. */
  targetOptional?: boolean
}

/** Can `player` play the card instance `iid` (from hand or Champion Zone) right
 *  now? Mirrors the PLAY handler: zone/type, timing (chain/showdown/action),
 *  affordability, and â€” for damage spells â€” that at least one legal target
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

  // Timing â€” same branches the PLAY handler enforces.
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

  // Affordability (state-aware: applies "I cost X less" / battlefield modifiers).
  if (!autoPayEff(state, player, card)) return { valid: false, reason: 'Not enough resources.' }

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
