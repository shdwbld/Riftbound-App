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
import { parseKeywords, keywordsAt, accelerateCost, repeatCost, levelBonus, optionalPlayCost } from './keywords'
import { addCost, costOf, effectiveCostOf, autoPayEff, autoPay, costIsFree } from './autopay'
import { bfScript, bfScriptAt, battlefieldOf, type BfApi } from './battlefieldScripts'

/** How many turns the given player has taken (incl. the current one). */
function playerTurnOrdinal(s: MatchState, player: PlayerId): number {
  const rank = (player - s.firstPlayer + s.players.length) % s.players.length
  return Math.floor((s.turn - 1 - rank) / s.players.length) + 1
}
import { spellEffect, onPlayEffect, paidBonusEffect, endOfTurnEffect, needsTarget, hasUntargetedPart, hasTargetedPart, isCopySpell, parseEffectText, EMPTY_EFFECT, type ParsedEffect } from './effects'
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
    asheBanishPending: s.asheBanishPending?.map((e) => ({ ...e })), // persists across actions; deep-copied for immutability
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
  // ALSO appear in `recycle` — exhaust for energy, then recycle for power.)
  const exhaustSet = new Set<string>()
  for (const iid of payment.exhaust) {
    if (exhaustSet.has(iid)) return 'A rune was listed twice for energy.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Energy rune not in your pool.'
    if (rune.exhausted) return 'Energy rune is already exhausted.'
    exhaustSet.add(iid)
  }
  // Power: any rune in the pool may be recycled for Power. Recycling returns the rune
  // to the Rune Deck (Rule 159 / 403) — it does NOT require the rune to be ready, so an
  // already-exhausted rune (tapped earlier for Energy this turn) is still recyclable.
  const recycleSet = new Set<string>()
  const recycled: EngineCard[] = []
  for (const iid of payment.recycle) {
    if (recycleSet.has(iid)) return 'A rune was listed twice for power.'
    const rune = p.zones.runePool.find((c) => c.iid === iid)
    if (!rune) return 'Power rune not in your pool.'
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

/** Auto-pay an [Equip] ability's cost (Energy + specific-domain Power + anyPower
 *  rainbow) from a player's ready runes and pool. Validates affordability FIRST and
 *  only mutates on success — so a caller that already cloned state can `fail` with
 *  the untouched original when this returns false. Energy uses the pool first, then
 *  exhausts ready runes; specific Power recycles a domain-matched ready rune; rainbow
 *  recycles any ready rune. Runes are never reused across requirements. */
function payEquipCost(s: MatchState, player: PlayerId, ec: { energy: number; power: Partial<Record<Domain, number>>; anyPower: number }): boolean {
  const p = s.players[player]
  const used = new Set<string>()
  const recycle: string[] = []
  // Specific-domain Power: a ready rune that produces that domain.
  for (const [dom, n] of Object.entries(ec.power) as [Domain, number][]) {
    for (let i = 0; i < (n ?? 0); i++) {
      const rune = p.zones.runePool.find((r) => !r.exhausted && !used.has(r.iid) && def(r)?.type === 'rune' && (def(r) as { produces: Domain[] }).produces.includes(dom))
      if (!rune) return false
      used.add(rune.iid); recycle.push(rune.iid)
    }
  }
  // Rainbow Power: any ready rune.
  for (let i = 0; i < ec.anyPower; i++) {
    const rune = p.zones.runePool.find((r) => !r.exhausted && !used.has(r.iid))
    if (!rune) return false
    used.add(rune.iid); recycle.push(rune.iid)
  }
  // Energy: pool first, then exhaust ready runes not already claimed for Power.
  const poolPay = Math.min(ec.energy, p.pool?.energy ?? 0)
  const exhaust: string[] = []
  for (let i = 0; i < ec.energy - poolPay; i++) {
    const rune = p.zones.runePool.find((r) => !r.exhausted && !used.has(r.iid))
    if (!rune) return false
    used.add(rune.iid); exhaust.push(rune.iid)
  }
  // Commit (everything above is satisfiable).
  if (p.pool) p.pool.energy -= poolPay
  for (const iid of exhaust) { const r = p.zones.runePool.find((x) => x.iid === iid); if (r) r.exhausted = true }
  for (const iid of recycle) { const r = removeFromZone(p, 'runePool', iid); if (r) p.zones.runeDeck.push({ ...r, exhausted: false, damage: 0 }) }
  return true
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
/** A unit leaving play (death/banish) sheds its attached Equipment back to its
 *  owner's base — gear is NEVER trashed/banished with the unit (Riftbound rule).
 *  No-op for non-units / no gear; token gear ceases to exist. `p` is the unit's
 *  owner. Mutates `card.attached` to []. (Recall/bounce keep gear on the unit and
 *  detach via their own paths.) */
function detachGearToBase(p: PlayerState, card: EngineCard): void {
  if (!card.attached?.length) return
  for (const ref of card.attached) {
    const [gCardId, gIid] = ref.split('|')
    if (!gCardId || getCard(gCardId)?.supertype === 'token') continue
    p.zones.base.push({ iid: gIid || `${p.id}:gear:${gCardId}`, cardId: gCardId, owner: p.id, exhausted: false, damage: 0, attached: [] })
  }
  card.attached = []
}

function sendToTrash(p: PlayerState, card: EngineCard): void {
  detachGearToBase(p, card) // gear survives the unit's death — return it to base
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
  detachGearToBase(p, card) // gear survives a banished unit — return it to base
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
function spawnRecruits(p: PlayerState, n: number, turn: number, ready = false, dest?: EngineCard[]): number {
  const id = TOKEN_PILE_IDS[0]
  if (!id) return 0
  const pile = dest ?? p.zones.base
  for (let i = 0; i < n; i++)
    pile.push({
      iid: `${p.id}:tok:${id}#${(tokenCounter++).toString(36)}`,
      cardId: id,
      owner: p.id,
      exhausted: !ready, // Renata Glasc - Industrialist: "Your tokens enter ready."
      damage: 0,
      attached: [],
      enteredTurn: turn,
    })
  return n
}

/** Create N Gold gear tokens onto a player's Base, exhausted (from card effects).
 *  A Gold token can be cashed in (killed) for 1 Power of any domain. */
function spawnGold(p: PlayerState, n: number, turn: number, ready = false): number {
  if (!GOLD_TOKEN_ID) return 0
  for (let i = 0; i < n; i++)
    p.zones.base.push({
      iid: `${p.id}:tok:${GOLD_TOKEN_ID}#${(tokenCounter++).toString(36)}`,
      cardId: GOLD_TOKEN_ID,
      owner: p.id,
      exhausted: !ready, // Renata Glasc - Industrialist: "Your tokens enter ready."
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
const TRIBE_TAGS = ['Bird', 'Cat', 'Dog', 'Poro']
/** Distinct tribe tags (Bird/Cat/Dog/Poro) among a player's units (0-4). */
function tribeTagCount(s: MatchState, player: PlayerId): number {
  const present = new Set<string>()
  for (const u of [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]) {
    if (u.owner !== player) continue
    for (const tag of getCard(u.cardId)?.tags ?? []) if (TRIBE_TAGS.includes(tag)) present.add(tag)
  }
  return present.size
}
/** Whether a player controls a unit carrying `tag` (case-insensitive). */
function controlsTribeTag(s: MatchState, player: PlayerId, tag: string): boolean {
  return [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)].some(
    (u) => u.owner === player && (getCard(u.cardId)?.tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase()),
  )
}

function conditionMet(s: MatchState, p: PlayerState, e: ParsedEffect, bfIndex?: number, excess = 0): boolean {
  if (!e.condition) return true
  // Death-state gates are pre-evaluated at death time in fireDeaths; pass here.
  if (e.condition.kind === 'wasMighty' || e.condition.kind === 'diedAlone' || e.condition.kind === 'diedNotAlone') return true
  if (e.condition.kind === 'controlsTribe') return controlsTribeTag(s, p.id, e.condition.tag ?? '')
  if (e.condition.kind === 'allTribeTags') return tribeTagCount(s, p.id) >= 4
  if (e.condition.kind === 'unitsHereAtLeast') {
    if (bfIndex == null) return false
    const count = s.battlefields[bfIndex]?.units.filter((u) => u.owner === p.id).length ?? 0
    return count >= e.condition.value
  }
  // "if you assigned N+ excess damage" — supplied by the conquer trigger site.
  if (e.condition.kind === 'excessAtLeast') return excess >= e.condition.value
  // "if an opponent's score is within N of the Victory Score" (Poppy - Paragon).
  if (e.condition.kind === 'oppScoreWithin') return opponentScoreWithin(s, p.id, e.condition.value)
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
  if (!e.buff && !e.buffAll) return []
  const lines: string[] = []
  const give = (u: EngineCard | undefined) => {
    if (!u || u.owner !== p.id || (u.buffs ?? 0) >= 1) return false
    u.buffs = 1
    emit({ kind: 'buff', iid: u.iid, player: p.id })
    lines.push(`Buffed ${getCard(u.cardId)?.name} (+1 Might).`)
    for (const l of fireBuffReactions(s, p, u.iid)) lines.push(l)
    for (const l of fireBuffTriggers(s, p, u.iid)) lines.push(l)
    return true
  }
  if (e.buffSelf) give(sourceIid ? findUnitAnywhere(s, sourceIid) : undefined)
  // Area buff: every friendly unit ('all'), or those at the source's battlefield
  // ('here'). Each is still capped at one buff by `give`. (Peak Guardian also has
  // buffSelf above; the cap makes the overlap a no-op.)
  if (e.buffAll) {
    const hereBf = e.buffAll === 'here' && sourceIid ? bfIndexOfUnit(s, sourceIid) : -1
    const pool = hereBf >= 0 ? (s.battlefields[hereBf]?.units ?? []) : [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
    for (const u of pool) if (u.owner === p.id && def(u)?.type === 'unit' && u.iid !== sourceIid) give(u)
  }
  if (!e.buffSelf && !e.buffAll && e.buff) {
    const candidates = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
      .filter((u) => u.owner === p.id && def(u)?.type === 'unit' && (u.buffs ?? 0) < 1)
      .filter((u) => !(e.buffExcludesSelf && u.iid === sourceIid))
      .sort((a, b) => (def(b)?.type === 'unit' ? (def(b) as { might: number }).might : 0) - (def(a)?.type === 'unit' ? (def(a) as { might: number }).might : 0))
    for (let i = 0; i < e.buff && i < candidates.length; i++) give(candidates[i])
  }
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

/** Fire a buffed unit's own "when you buff me, …" self-triggers (Simian Ancestor:
 *  "When you buff me, ready me"). Resolves the parsed effect inline on the source. */
function fireBuffTriggers(s: MatchState, p: PlayerState, buffedIid: string): string[] {
  const lines: string[] = []
  const u = findUnitAnywhere(s, buffedIid)
  if (!u) return lines
  for (const ab of triggersFor(getCard(u.cardId), 'buff')) {
    if (ab.scope !== 'self') continue
    const bfi = bfIndexOfUnit(s, u.iid)
    for (const l of applyParsed(s, p, ab.effect, bfi >= 0 ? bfi : undefined, u.iid)) lines.push(l)
  }
  return lines
}

/** Fire a chosen unit's own "when you choose me with a spell, …" self-triggers
 *  (Jae Medarda → draw, Irelia - Fervent → +1 Might this turn). Only fires when the
 *  unit's own controller is the chooser ("you"). Returns the threaded state. */
function fireTargetedSelf(s: MatchState, chooser: PlayerId, iid: string): MatchState {
  const u = findUnitAnywhere(s, iid)
  if (!u || u.owner !== chooser) return s
  for (const ab of triggersFor(getCard(u.cardId), 'targeted')) {
    if (ab.scope !== 'self') continue
    const bfi = bfIndexOfUnit(s, u.iid)
    for (const l of applyParsed(s, s.players[u.owner], ab.effect, bfi >= 0 ? bfi : undefined, u.iid)) s = log(s, u.owner, l)
  }
  return s
}

/** Apply the auto-resolvable parts of a parsed effect to `p`; returns log text.
 *  `bfIndex` scopes any "units at that battlefield" condition (conquer triggers).
 *  `sourceIid` is the unit the effect emanates from (for self-buff / ready-me). */
function applyParsed(s: MatchState, p: PlayerState, e: ParsedEffect, bfIndex?: number, sourceIid?: string, excess = 0): string[] {
  const lines: string[] = []
  // A gated effect does nothing when its condition isn't met.
  if (!conditionMet(s, p, e, bfIndex, excess)) return lines
  // Discard resolves BEFORE the draw so "discard N, then draw N" doesn't toss a
  // freshly-drawn card. Auto-discards the N lowest-cost cards from hand.
  if (e.discard) {
    const hand = p.zones.hand
    const n = Math.min(e.discard, hand.length)
    if (n > 0) {
      const toGo = [...hand].sort((a, b) => cardCost(a) - cardCost(b)).slice(0, n)
      for (const c of toGo) {
        const i = hand.findIndex((x) => x.iid === c.iid)
        if (i >= 0) sendToTrash(p, hand.splice(i, 1)[0])
      }
      lines.push(`Discarded ${n} card(s).`)
      fireDiscard(s, p.id, toGo) // Jinx - Rebel reacts; mutations land on shared state
    }
  }
  if (e.draw) lines.push(`Drew ${drawN(p, e.draw)}.`)
  if (e.drawPerBattlefield) {
    // "draw 1 for each battlefield you control" (Right of Conquest).
    const held = s.battlefields.filter((b) => b.controller === p.id).length
    if (held > 0) lines.push(`Drew ${drawN(p, e.drawPerBattlefield * held)} (per battlefield held).`)
  }
  if (e.drawPerMighty) {
    // "draw 1 for each of your [Mighty] units" (Kadregrin, Show of Strength) — counts
    // EFFECTIVE-Mighty units in play (base + buffs + temp + gear + level).
    const n = [...s.battlefields.flatMap((b) => b.units), ...p.zones.base].filter((u) => u.owner === p.id && stateActive(s, u, 'mighty')).length
    if (n > 0) lines.push(`Drew ${drawN(p, e.drawPerMighty * n)} (per [Mighty] unit).`)
  }
  if (e.channel) lines.push(`Channeled ${channelN(p, e.channel)}.`)
  // "Channel N rune(s) exhausted" (Soaring Scout) — the channeled runes enter exhausted.
  if (e.channelExhausted) lines.push(`Channeled ${channelN(p, e.channelExhausted, true)} (exhausted).`)
  // "Recycle N from your trash" (Dr. Mundo - Expert, start of Beginning Phase): move
  // N cards from trash to the bottom of the Main Deck (auto-picks the oldest N).
  if (e.recycleFromTrash) {
    const n = Math.min(e.recycleFromTrash, p.zones.trash.length)
    for (let i = 0; i < n; i++) p.zones.mainDeck.push({ ...p.zones.trash.shift()!, exhausted: false, damage: 0, attached: [] })
    if (n > 0) lines.push(`Recycled ${n} card(s) from trash to deck.`)
  }
  // Direct scoring ("you score N point" — Ahri, Draven - Audacious). Mutates in
  // place (applyParsed can't reassign s), so the win is flagged inline.
  if (e.score) {
    p.points += e.score
    emit({ kind: 'score', player: p.id, amount: e.score })
    fireOpponentScore(s, p.id) // Sumpworks Map: opponents draw when you score
    lines.push(`Scored ${e.score} point(s).`)
    if (s.winner == null && p.points >= s.pointsToWin) { s.winner = p.id; s.phase = 'gameover' }
  }
  // Direct XP gain ("gain N XP" — Scuttle Crab Deathknell, Right of Conquest).
  if (e.gainXp) { p.xp = (p.xp ?? 0) + e.gainXp; p.xpGainedThisTurn = true; lines.push(`Gained ${e.gainXp} XP (now ${p.xp}).`) }
  // Recruit / named tokens are token UNITS — Zilean doubles the count (once/turn)
  // and Renata makes them enter ready. Gold are gear tokens (Renata-ready only).
  if (e.recruits) {
    // "… Recruit token here" (Noxian Drummer, Corina Veraza) enters at the source
    // unit's battlefield; otherwise recruits enter the controller's Base.
    const recBf = e.recruitsHere ? bfIndexOfUnit(s, sourceIid) : -1
    const recDest = recBf >= 0 ? s.battlefields[recBf].units : undefined
    const madeR = spawnRecruits(p, zileanDouble(s, p.id, e.recruits), s.turn, tokensEnterReady(s, p.id), recDest)
    if (recBf >= 0) recomputeControllers(s)
    lines.push(`Created ${madeR} Recruit(s)${recBf >= 0 ? ' here' : ''}.`)
  }
  if (e.killGear) {
    const res = applyKillGear(s, p.id, e.killGear, e.gearKillControllerDraw)
    for (const ln of res.lines) lines.push(ln)
    // Pickpocket: "If you do, play a Gold gear token exhausted." Gate the gold on the kill.
    if (res.killed && e.goldTokens) lines.push(`Created ${spawnGold(p, e.goldTokens, s.turn, false)} Gold token(s).`)
    // Jayce - Man of Progress: "If you do, you may play a gear (Energy ≤ N) from hand,
    // ignoring its Energy cost (still pay Power)." Auto-plays the highest-Energy eligible
    // gear; Power is paid from ready runes (approximated via payPowerAny).
    if (res.killed && e.playGearFromHand) {
      const cap = e.playGearFromHand.maxEnergy
      const cand = p.zones.hand
        .filter((c) => getCard(c.cardId)?.type === 'gear' && (cap == null || gearEnergyOf(c) <= cap))
        .sort((a, b) => gearEnergyOf(b) - gearEnergyOf(a))[0]
      if (cand) {
        const cardDef = getCard(cand.cardId)
        const powerPips = cardDef ? Object.values(costOf(cardDef).power).reduce((a, b) => a + (b ?? 0), 0) : 0
        if (powerPips === 0 || makeBfApi(s).payPowerAny(p.id, powerPips)) {
          removeFromZone(p, 'hand', cand.iid)
          p.zones.base.push({ ...cand, exhausted: false, damage: 0, attached: [] })
          lines.push(`Played ${cardDef?.name ?? 'a gear'} from hand (Energy ignored).`)
        }
      }
    }
  }
  if (e.bounceGear) {
    const gears = allGearInPlay(s).filter((g) => g.owner === p.id)
    if (gears.length) {
      const pick = gears.reduce((lo, g) => (gearEnergyOf(g) <= gearEnergyOf(lo) ? g : lo))
      const nm = getCard(pick.cardId)?.name ?? 'a gear'
      bounceGearByIid(s, pick.iid)
      lines.push(`Returned ${nm} to its owner's hand.`)
    }
  }
  if (e.goldTokens && !e.killGear) lines.push(`Created ${spawnGold(p, e.goldTokens, s.turn, tokensEnterReady(s, p.id))} Gold token(s).`)
  if (e.namedToken) {
    // "choose an opponent. They play a … token" (Walking Roost) → spawn into the
    // chosen opponent's Base (auto-pick the first opponent still in the match).
    if (e.namedToken.opponent) {
      const foe = s.players.find((pl) => pl.id !== p.id && !pl.out)
      if (foe) {
        const made = spawnNamedToken(foe, e.namedToken.name, e.namedToken.count, s.turn, e.namedToken.exhausted, e.namedToken.temporary)
        if (made) {
          const label = getCard(TOKEN_BY_NAME[e.namedToken.name.toLowerCase()])?.name?.split(/\s*\(/)[0] ?? e.namedToken.name
          lines.push(`Opponent created ${made} ${label} token(s)${e.namedToken.temporary ? ' (Temporary)' : ''}.`)
        }
      }
    } else {
      // "… here" plays the token at the source unit's battlefield; otherwise base.
      const hereBf = e.namedToken.here ? bfIndexOfUnit(s, sourceIid) : -1
      const dest = hereBf >= 0 ? s.battlefields[hereBf].units : undefined
      const exh = e.namedToken.exhausted && !tokensEnterReady(s, p.id)
      const made = spawnNamedToken(p, e.namedToken.name, zileanDouble(s, p.id, e.namedToken.count), s.turn, exh, e.namedToken.temporary, dest)
      if (made) {
        if (hereBf >= 0) recomputeControllers(s)
        const label = getCard(TOKEN_BY_NAME[e.namedToken.name.toLowerCase()])?.name?.split(/\s*\(/)[0] ?? e.namedToken.name
        lines.push(`Created ${made} ${label} token(s)${e.namedToken.temporary ? ' (Temporary)' : ''}${hereBf >= 0 ? ' here' : ''}.`)
      }
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
  if (e.opponentHandStrip) {
    // Opponent reveals hand; you strip the highest-cost (non-unit, for Sabotage)
    // card to trash / deck (recycle) / banish (Mindsplitter, Sabotage, Ashe). Auto-
    // picks the opponent holding the most cards. A forced discard cascades the victim's
    // own "when you discard" reactions via fireDiscard — mutations land on shared state,
    // exactly like the e.discard path above (line ~583).
    const { to, nonUnit } = e.opponentHandStrip
    const foe = s.players
      .filter((pl) => pl.id !== p.id && !pl.out && pl.zones.hand.length > 0)
      .sort((a, b) => b.zones.hand.length - a.zones.hand.length)[0]
    if (foe) {
      const pick = foe.zones.hand
        .filter((c) => !nonUnit || getCard(c.cardId)?.type !== 'unit')
        .sort((a, b) => cardCost(b) - cardCost(a))[0]
      if (pick) {
        const i = foe.zones.hand.findIndex((x) => x.iid === pick.iid)
        const [card] = foe.zones.hand.splice(i, 1)
        const nm = getCard(card.cardId)?.name ?? 'a card'
        if (to === 'deck') { foe.zones.mainDeck.push({ ...card, exhausted: false, damage: 0, attached: [] }); lines.push(`Opponent revealed hand — recycled ${nm}.`) }
        else if (to === 'banish') {
          foe.banished.push(card)
          lines.push(`Opponent revealed hand — banished ${nm}.`)
          // Ashe - Focused: "When they hold, return it to their hand (even if I'm no
          // longer on the board)." Record the banished card for return on the victim's hold.
          const srcCard = sourceIid ? getCard(findUnitAnywhere(s, sourceIid)?.cardId ?? '') : undefined
          if (/when they hold, return it/i.test(srcCard?.text ?? '')) {
            s.asheBanishPending = s.asheBanishPending ?? []
            s.asheBanishPending.push({ banishedIid: card.iid, owner: p.id, victimId: foe.id })
          }
        }
        else { sendToTrash(foe, card); foe.discardedThisTurn = true; lines.push(`Opponent revealed hand — discarded ${nm}.`); fireDiscard(s, foe.id, [card]) }
      } else {
        lines.push('Opponent revealed hand — nothing to take.')
      }
    }
  }
  if (e.opponentDiscards) {
    // "They discard N" — the opponent loses N cards of their choice (auto: lowest-cost).
    const foe = s.players
      .filter((pl) => pl.id !== p.id && !pl.out && pl.zones.hand.length > 0)
      .sort((a, b) => b.zones.hand.length - a.zones.hand.length)[0]
    if (foe) {
      const n = Math.min(e.opponentDiscards, foe.zones.hand.length)
      const discardedCards: EngineCard[] = []
      for (let k = 0; k < n; k++) {
        const lowest = [...foe.zones.hand].sort((a, b) => cardCost(a) - cardCost(b))[0]
        const [d] = foe.zones.hand.splice(foe.zones.hand.findIndex((x) => x.iid === lowest.iid), 1)
        sendToTrash(foe, d)
        discardedCards.push(d)
      }
      if (n > 0) { foe.discardedThisTurn = true; lines.push(`Opponent discarded ${n}.`); fireDiscard(s, foe.id, discardedCards) }
    }
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
      // "ignoring its ENERGY cost" still charges the unit's Power cost (The
      // Harrowing, Soulgorger); the full-cost variant (Last Rites — "you still pay
      // its costs") pays BOTH Energy and Power from the pool; "ignoring its cost"
      // is free. Pre-check affordability so we never half-pay; if unaffordable, the
      // play doesn't happen.
      const st = stats(pick)
      const energyDue = e.playUnitFromTrash.fullCost ? st.energy : 0
      const powerDue = e.playUnitFromTrash.fullCost || e.playUnitFromTrash.energyOnly ? st.power : 0
      const readyRunes = p.zones.runePool.filter((r) => !r.exhausted).length
      const poolE = p.pool?.energy ?? 0
      const canPay = powerDue + Math.max(0, energyDue - poolE) <= readyRunes
      if ((powerDue > 0 || energyDue > 0) && !canPay) {
        lines.push(`Couldn't play ${getCard(pick.cardId)?.name ?? 'a unit'} from trash — can't pay its cost.`)
      } else {
        const api = makeBfApi(s)
        if (powerDue > 0) api.payPowerAny(p.id, powerDue)
        if (energyDue > 0) api.payEnergy(p.id, energyDue)
        const i = p.zones.trash.findIndex((x) => x.iid === pick.iid)
        const [card] = p.zones.trash.splice(i, 1)
        p.zones.base.push({ ...card, exhausted: !controlsBreacherAura(s, p.id), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher: non-hand plays enter ready
        const note = e.playUnitFromTrash.fullCost ? `paid ${energyDue} Energy${powerDue ? ` + ${powerDue} Power` : ''}` : powerDue > 0 ? `ignoring Energy, paid ${powerDue} Power` : 'free'
        lines.push(`Played ${getCard(card.cardId)?.name ?? 'a unit'} from trash (${note}).`)
      }
    }
  }
  if (e.playUnitFromHand) {
    // Play the highest-cost unit from your hand, ignoring its (Energy) cost —
    // Rift Herald's [Deathknell]. "ignoring its ENERGY cost" still charges Power.
    const powerOf = (c: EngineCard) => {
      const d = getCard(c.cardId) as { power?: Record<string, number> } | undefined
      return d?.power ? Object.values(d.power).reduce((a, b) => a + (b || 0), 0) : 0
    }
    const pick = p.zones.hand.filter((c) => getCard(c.cardId)?.type === 'unit').sort((a, b) => cardCost(b) - cardCost(a))[0]
    if (pick) {
      const powerDue = e.playUnitFromHand.energyOnly ? powerOf(pick) : 0
      if (powerDue > 0 && !makeBfApi(s).payPowerAny(p.id, powerDue)) {
        lines.push(`Couldn't play ${getCard(pick.cardId)?.name ?? 'a unit'} from hand — can't pay its Power cost.`)
      } else {
        const i = p.zones.hand.findIndex((x) => x.iid === pick.iid)
        const [card] = p.zones.hand.splice(i, 1)
        p.zones.base.push({ ...card, exhausted: !controlsBreacherAura(s, p.id), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher
        lines.push(`Played ${getCard(card.cardId)?.name ?? 'a unit'} from hand (ignoring ${powerDue > 0 ? 'Energy' : ''} cost${powerDue > 0 ? `, paid ${powerDue} Power` : ''}).`)
      }
    }
  }
  if (e.revealPlayFromDeck) {
    // Reveal from the top until a unit; play it free (base, exhausted); recycle
    // the non-units passed over to the bottom of the deck (Dazzling Aurora).
    const deck = p.zones.mainDeck
    for (const l of hatchlingPrePeek(s, p.id, deck, 'unit')) lines.push(l) // Void Hatchling
    const passed: EngineCard[] = []
    let unit: EngineCard | undefined
    while (deck.length) {
      const top = deck.shift()!
      if (getCard(top.cardId)?.type === 'unit') { unit = top; break }
      passed.push(top)
    }
    for (const c of passed) deck.push(c) // recycle the rest to the bottom
    if (unit) {
      p.zones.base.push({ ...unit, exhausted: !controlsBreacherAura(s, p.id), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher
      lines.push(`Revealed & played ${getCard(unit.cardId)?.name ?? 'a unit'} from deck (free); recycled ${passed.length}.`)
    }
  }
  if (e.peekDraw) {
    // "Look at the top N; (you may) draw a <type>; recycle the rest." Auto-draws the
    // highest-cost matching card to hand and recycles the rest to the bottom (Ornn,
    // Ivern, Rift Herald, Fate Weaver, Apprentice Smith).
    const { n, type, energyMin, thenBuffIfTribe } = e.peekDraw
    const deck = p.zones.mainDeck
    for (const l of hatchlingPrePeek(s, p.id, deck, type !== 'card' ? type : undefined)) lines.push(l) // Void Hatchling
    const top = deck.splice(0, Math.min(n, deck.length))
    const matches = top.filter((c) => {
      const d = getCard(c.cardId)
      if (!d) return false
      if (type !== 'card' && d.type !== type) return false
      if (energyMin != null && ((d as { energy?: number }).energy ?? 0) < energyMin) return false
      return true
    })
    let drawn: EngineCard | undefined
    if (matches.length) {
      drawn = matches.reduce((b, c) => (cardCost(c) > cardCost(b) ? c : b))
      p.zones.hand.push(drawn)
    }
    for (const c of top) if (c !== drawn) deck.push(c) // recycle the rest to the bottom
    if (drawn) lines.push(`Looked at top ${top.length}; drew ${getCard(drawn.cardId)?.name}; recycled ${top.length - 1}.`)
    else if (top.length) lines.push(`Looked at top ${top.length}; no ${type} to draw; recycled ${top.length}.`)
    // Ivern - Nurturer: "if you revealed a Bird/Cat/Dog/Poro, [Buff] a friendly unit."
    if (thenBuffIfTribe && top.some((c) => (getCard(c.cardId)?.tags ?? []).some((tg) => thenBuffIfTribe.includes(tg)))) {
      const friendly = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
        (u) => u.owner === p.id && getCard(u.cardId)?.type === 'unit' && !(u.buffs ?? 0),
      )
      if (friendly.length) {
        const tgt = friendly.reduce((b, u) => (mightOf(u) > mightOf(b) ? u : b))
        tgt.buffs = 1
        emit({ kind: 'buff', iid: tgt.iid, player: p.id })
        lines.push(`Revealed a Bird/Cat/Dog/Poro — buffed ${getCard(tgt.cardId)?.name} (+1 Might).`)
      }
    }
  }
  if (e.peekToHand) {
    // "Look at the top N; put 1 into your hand; recycle the rest" (Stacked Deck,
    // Called Shot). This is a genuine selection (and a private look), so offer an
    // interactive pick: the top N stay on the deck while a pendingChoice — visible only
    // to the controller — lets them choose which to keep; the rest recycle to the bottom
    // on resolve. With ≤1 card to look at (or a choice already pending) auto-take it.
    const deck = p.zones.mainDeck
    const n = Math.min(e.peekToHand.n, deck.length)
    if (n <= 1 || s.pendingChoice) {
      const drawn = n >= 1 ? deck.shift() : undefined
      if (drawn) { p.zones.hand.push(drawn); lines.push('Looked at the top card and put it in hand.') }
    } else {
      const cand = deck.slice(0, n)
      offerChoice(s, {
        player: p.id, kind: 'peekToHand', bfIndex: -1,
        prompt: `Look at the top ${n} cards — put 1 into your hand, recycle the rest.`,
        options: cand.map((c) => ({ iid: c.iid, label: getCard(c.cardId)?.name ?? 'a card' })),
        payload: JSON.stringify({ candIids: cand.map((c) => c.iid) }),
      })
      lines.push(`Looking at the top ${n} cards — choose one to keep.`)
    }
  }
  if (e.peekBanishPlay) {
    // "Look at/reveal the top N; banish one (a unit), then play it (free / discounted
    // to 0); recycle (or draw) the rest." Auto-plays the highest-cost playable unit.
    const { n, from, discount, here, drawRest } = e.peekBanishPlay
    const playable = (c: EngineCard) => {
      const d = getCard(c.cardId)
      return !!d && d.type === 'unit' && (discount == null || cardCost(c) <= discount)
    }
    if (from === 'opponent') {
      // Blind Fury: reveal each opponent's top card; play the best unit under your
      // control (free); recycle the rest to their owners' decks.
      const revealed: { card: EngineCard; deck: EngineCard[] }[] = []
      for (const op of s.players) {
        if (op.id === p.id) continue
        const top = op.zones.mainDeck.shift()
        if (top) revealed.push({ card: top, deck: op.zones.mainDeck })
      }
      const units = revealed.filter((r) => playable(r.card))
      const chosen = units.length ? units.reduce((b, r) => (cardCost(r.card) > cardCost(b.card) ? r : b)) : undefined
      if (chosen) {
        p.zones.base.push({ ...chosen.card, owner: p.id, exhausted: !controlsBreacherAura(s, p.id), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher
        lines.push(`Banished & played ${getCard(chosen.card.cardId)?.name} from an opponent's deck (free).`)
      }
      for (const r of revealed) if (r !== chosen) r.deck.push(r.card) // recycle to owner's deck
      if (!chosen && revealed.length) lines.push(`Revealed ${revealed.length} opponent card(s); none playable — recycled.`)
    } else {
      const deck = p.zones.mainDeck
      for (const l of hatchlingPrePeek(s, p.id, deck, 'unit')) lines.push(l) // Void Hatchling (self-reveal only)
      const top = deck.splice(0, Math.min(n, deck.length))
      const units = top.filter(playable)
      const chosen = units.length ? units.reduce((b, c) => (cardCost(c) > cardCost(b) ? c : b)) : undefined
      if (chosen) {
        const bi = here && sourceIid ? bfIndexOfUnit(s, sourceIid) : -1
        const dest = bi >= 0 ? s.battlefields[bi].units : p.zones.base
        dest.push({ ...chosen, exhausted: !controlsBreacherAura(s, p.id), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher
        if (bi >= 0) recomputeControllers(s)
        lines.push(`Banished & played ${getCard(chosen.cardId)?.name} from deck (free)${bi >= 0 ? ' here' : ''}.`)
      }
      for (const c of top) if (c !== chosen) { if (drawRest) p.zones.hand.push(c); else deck.push(c) }
      if (!chosen && top.length) lines.push(`Looked at top ${top.length}; no playable unit — ${drawRest ? 'drew' : 'recycled'} ${top.length}.`)
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
  if (e.tempMightAllEnemy) {
    // Board-wide temp Might to all ENEMY units (Thousand-Tailed Watcher: -3, min 1).
    const enemies = [...s.players.flatMap((pl) => pl.zones.base), ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner !== p.id && getCard(u.cardId)?.type === 'unit',
    )
    let n = 0
    for (const u of enemies) { applyTempMight(s, u.iid, e.tempMightAllEnemy, e.tempMightFloor); n++ }
    if (n) lines.push(`${e.tempMightAllEnemy > 0 ? '+' : ''}${e.tempMightAllEnemy} Might this turn to ${n} enemy unit(s).`)
  }
  if (e.tempMightTag) {
    // Tag-scoped temp Might to your tagged units (Danger Zone: "your Mechs +1").
    const { tag, amount } = e.tempMightTag
    const units = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner === p.id && (getCard(u.cardId)?.tags ?? []).includes(tag),
    )
    for (const u of units) u.tempMight = (u.tempMight ?? 0) + amount
    if (units.length) lines.push(`${amount > 0 ? '+' : ''}${amount} Might this turn to ${units.length} ${tag}(s).`)
  }
  if (e.readyAllUnits) {
    // "ready your units" (Shurelya's Requiem) — pure benefit, auto-ready them all.
    let n = 0
    for (const u of [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)])
      if (u.owner === p.id && u.exhausted && !unitCantBeReadied(u) && !enemyWardenAtBf(s, p.id) && getCard(u.cardId)?.type === 'unit') { u.exhausted = false; n++ }
    if (n > 0) lines.push(`Readied ${n} unit(s).`)
  }
  if (e.readyOrExhaustLegend) {
    // Royal Entourage: "ready or exhaust a legend." Auto — exhaust an opponent's
    // ready legend (deny their ability); else ready your own exhausted legend.
    const foe = s.players.find((pl) => pl.id !== p.id && !pl.out && pl.legend && !pl.legend.exhausted)
    if (foe?.legend) { foe.legend.exhausted = true; lines.push(`Exhausted an opponent's legend.`) }
    else if (p.legend?.exhausted) { p.legend.exhausted = false; lines.push(`Readied your legend.`) }
  }
  if (e.readyUnits) {
    // Surface a "choose which unit(s) to ready" prompt for the player. "ready
    // ANOTHER unit" (First Mate) excludes the source unit from the choices.
    const excludeIid = e.readyExcludesSelf ? sourceIid : undefined
    const exhausted = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
      (u) => u.owner === p.id && u.exhausted && !unitCantBeReadied(u) && !enemyWardenAtBf(s, p.id) && getCard(u.cardId)?.type === 'unit' && u.iid !== excludeIid,
    )
    const cnt = Math.min(e.readyUnits, exhausted.length)
    if (cnt > 0) {
      s.readyChoice = { player: p.id, count: (s.readyChoice?.player === p.id ? s.readyChoice.count : 0) + cnt, excludeIid }
      lines.push(`Ready ${cnt} unit(s) — choose which.`)
    }
  }
  if (e.readyRunes) {
    // "ready up to N (friendly) runes" (Sona - Harmonious, Annie - Dark Child) —
    // pure benefit, auto-readied (no prompt).
    const before = p.zones.runePool.filter((r) => r.exhausted).length
    makeBfApi(s).readyRunes(p.id, e.readyRunes)
    const readied = before - p.zones.runePool.filter((r) => r.exhausted).length
    if (readied > 0) lines.push(`Readied ${readied} rune(s).`)
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
  if (e.grantShieldHere && sourceIid != null) {
    // "give your other units here [Shield] this turn" (Chakram Dancer).
    const bi = battlefieldOf(s, sourceIid)
    let n = 0
    if (bi >= 0)
      for (const u of s.battlefields[bi].units)
        if (u.owner === p.id && u.iid !== sourceIid) { u.grantShield = (u.grantShield ?? 0) + e.grantShieldHere; n++ }
    if (n) lines.push(`Gave [Shield ${e.grantShieldHere}] to ${n} other unit(s) here this turn.`)
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
      for (const l of fireSpendBuffInline(s, p.id)) lines.push(l) // Fae Dragon
    } else {
      costPaid = false
    }
  }
  if (costPaid && e.readySelf && sourceIid) {
    // The source may be a legend (Sivir - Battle Mistress: "… ready me").
    const u = findUnitAnywhere(s, sourceIid) ?? (p.legend?.iid === sourceIid ? p.legend : undefined)
    if (u && u.owner === p.id && u.exhausted && !unitCantBeReadied(u) && !enemyWardenAtBf(s, p.id)) {
      u.exhausted = false
      emit({ kind: 'buff', iid: u.iid, player: p.id })
      lines.push(`Readied ${getCard(u.cardId)?.name}.`)
    }
  }
  if (e.moveSourceToBf && sourceIid && bfIndex != null && bfIndex >= 0) {
    // "you may move me there" (Loyal Pup): relocate the source unit to bfIndex.
    const src = findUnitAnywhere(s, sourceIid)
    if (src && src.owner === p.id && battlefieldOf(s, sourceIid) !== bfIndex) {
      const fromBf = battlefieldOf(s, sourceIid)
      if (fromBf >= 0) {
        const fi = s.battlefields[fromBf].units.findIndex((u) => u.iid === sourceIid)
        if (fi >= 0) s.battlefields[fromBf].units.splice(fi, 1)
      } else {
        const bi = p.zones.base.findIndex((c) => c.iid === sourceIid)
        if (bi >= 0) p.zones.base.splice(bi, 1)
      }
      s.battlefields[bfIndex].units.push({ ...src, exhausted: true })
      recomputeControllers(s)
      lines.push(`Moved ${getCard(src.cardId)?.name} to battlefield ${bfIndex + 1}.`)
    }
  }
  // "give me +N Might this turn" — temporary Might on the source (Teemo - Scout's
  // on-play, Eclipse Herald's on-stun, …). Handled here so EVERY applyParsed site
  // (on-play, reveal, end-of-turn) applies it, not just fireTriggers/ACTIVATE_UNIT.
  if (e.tempMightSelf && sourceIid) {
    const u = findUnitAnywhere(s, sourceIid) ?? (p.legend?.iid === sourceIid ? p.legend : undefined)
    if (u && u.owner === p.id) {
      u.tempMight = (u.tempMight ?? 0) + e.tempMightSelf
      emit({ kind: 'buff', iid: u.iid, player: p.id })
      lines.push(`${e.tempMightSelf > 0 ? '+' : ''}${e.tempMightSelf} Might this turn.`)
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

/** A card's total cost (Energy + all Power pips) — for "draw/play the best card"
 *  auto-picks in deck-digs and trash recursion. */
function cardCost(c: EngineCard): number {
  const d = getCard(c.cardId) as { energy?: number; power?: Record<string, number> } | undefined
  const pw = d?.power ? Object.values(d.power).reduce((a, b) => a + (b || 0), 0) : 0
  return (d?.energy ?? 0) + pw
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

/** Permanents a player controls that can carry triggered abilities. Includes gear
 *  ATTACHED to a unit — stored as a "cardId|iid" ref on the unit, not an EngineCard
 *  in any zone — surfaced here as a virtual permanent so its triggered/passive
 *  abilities (Vanguard Helm, etc.) are collected, not just unattached base gear. */
function controlledPermanents(s: MatchState, player: PlayerId): EngineCard[] {
  const units = [...s.battlefields.flatMap((b) => b.units.filter((u) => u.owner === player)), ...s.players[player].zones.base]
  const out: EngineCard[] = [...units]
  if (s.players[player].legend) out.push(s.players[player].legend!)
  for (const u of units) {
    for (const ref of u.attached) {
      const [cid, iid] = ref.split('|')
      if (cid && getCard(cid)?.type === 'gear') out.push({ iid: iid || `${player}:gear:${cid}`, cardId: cid, owner: player, exhausted: false, damage: 0, attached: [] })
    }
  }
  return out
}

/** Jax - Unmatched: "Your Equipment everywhere have [Quick-Draw]" — a played gear
 *  auto-attaches to a unit you control. */
export function controlsQuickDrawAura(s: MatchState, player: PlayerId): boolean {
  return controlledPermanents(s, player).some((perm) => /your equipment everywhere have \[quick-?draw\]/i.test(getCard(perm.cardId)?.text ?? ''))
}

/** Rek'Sai - Breacher: "Friendly units played from anywhere other than a player's
 *  hand have [Accelerate]" — such units enter ready. */
function controlsBreacherAura(s: MatchState, player: PlayerId): boolean {
  return controlledPermanents(s, player).some((perm) => /friendly units played from anywhere other than a player's hand have \[accelerate\]/i.test(getCard(perm.cardId)?.text ?? ''))
}

/** Collect a player's GLOBAL ("when you â€¦") triggers for an event. */
function collectGlobal(s: MatchState, player: PlayerId, event: TriggerEvent): FiredTrigger[] {
  const out: FiredTrigger[] = []
  for (const u of controlledPermanents(s, player))
    for (const ab of triggersFor(def(u), event))
      if (ab.scope === 'global') out.push({ player, ability: ab, sourceIid: u.iid, sourceCardId: u.cardId })
  return out
}

/** Self-scope triggers ("when I â€¦") for a player's units, optionally limited to
 *  specific source iids (e.g. the units that just moved / conquered). */
function collectSelf(s: MatchState, player: PlayerId, event: TriggerEvent, iids?: string[]): FiredTrigger[] {
  const only = iids ? new Set(iids) : null
  const out: FiredTrigger[] = []
  // Collect a unit's own self-triggers for `ev`, plus those of any gear attached to it.
  // Gear triggers resolve with the HOST as source (sourceIid) so "here"/"me" target the
  // unit and its battlefield, while sourceCardId stays the gear (its text supplies the
  // effect). Gear is only folded in for the filtered (host-event) case — the unfiltered
  // path already surfaces gear under its own iid via controlledPermanents.
  const pushFor = (u: EngineCard, ev: TriggerEvent) => {
    for (const ab of triggersFor(def(u), ev))
      if (ab.scope === 'self') out.push({ player, ability: ab, sourceIid: u.iid, sourceCardId: u.cardId })
    if (only && u.attached?.length)
      for (const ref of u.attached) {
        const gCard = getCard(ref.split('|')[0])
        if (!gCard) continue
        // Svellsongur: "copy that unit's text to this Equipment's effect text for as long
        // as this is attached." Its effective text is a live copy of the host unit's text,
        // so the host's self-triggers fire an additional time via the gear. (FLAGGED
        // snapshot approximation: combat attack/defend + activated-ability forwarding are
        // deferred — only self-trigger forwarding here.)
        const effGear = (gCard.name ?? '').replace(/\s*\([^)]*\)\s*$/, '') === 'Svellsongur'
          ? { ...gCard, text: getCard(u.cardId)?.text ?? '' }
          : gCard
        for (const ab of triggersFor(effGear, ev))
          if (ab.scope === 'self') out.push({ player, ability: ab, sourceIid: u.iid, sourceCardId: gCard.id })
      }
  }
  for (const u of controlledPermanents(s, player)) {
    if (only && !only.has(u.iid)) continue
    pushFor(u, event)
  }
  // Skyfall (sfd-030): "My hold effects are also conquer effects, and vice versa." A
  // unit carrying this clause (printed or via attached gear) also fires the OTHER
  // event's self-triggers on a hold/conquer collection.
  const alias = event === 'conquer' ? 'hold' : event === 'hold' ? 'conquer' : null
  if (only && alias) {
    const hasSkyfall = (u: EngineCard) =>
      /hold effects are also conquer effects/i.test(getCard(u.cardId)?.text ?? '') ||
      (u.attached ?? []).some((ref) => /hold effects are also conquer effects/i.test(getCard(ref.split('|')[0])?.text ?? ''))
    for (const u of controlledPermanents(s, player)) {
      if (!only.has(u.iid) || !hasSkyfall(u)) continue
      pushFor(u, alias)
    }
  }
  return out
}

/** Apply fired triggers' auto-resolvable effects (ordered turn-player first,
 *  rule 4.6); log the remainder for manual resolution. */
function fireTriggers(s: MatchState, fired: FiredTrigger[], bfIndex?: number, excess = 0, wasUncontrolled = false): MatchState {
  if (fired.length === 0) return s
  const ordered = orderTriggers(fired, s.activePlayer, s.players.length)
  for (const { player, ability, sourceIid, sourceCardId, bfIndex: deathBf } of ordered) {
    const label = ability.event === 'death' ? 'Deathknell' : `Trigger (${ability.event})`
    const p = s.players[player]
    const e = ability.effect
    let did = false
    const isConquer = ability.event === 'conquer'
    const isGlobalDefend = ability.event === 'defend' && ability.scope === 'global'
    const srcName = (getCard(sourceCardId ?? '')?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '')
    // Once-per-turn gate ("The first time … each turn"): at most once per turn per
    // source card. oncePerTurnUsed is cleared in beginTurn / sandbox clearTurnState.
    if (ability.oncePerTurn) {
      const otKey = sourceCardId ?? sourceIid ?? 'unknown'
      if (!p.oncePerTurnUsed) p.oncePerTurnUsed = {}
      if (p.oncePerTurnUsed[otKey]) continue
      p.oncePerTurnUsed[otKey] = true
    }
    // Fully hand-coded cards whose trigger CLAUSE contains parseable fragments the
    // generic parser would mis-fire (Twisted Fate's per-domain "Draw 1 / Deal 2 /
    // Stun"; Teemo - Strategist's "Deal 1 … for each [Hidden]"). Skip the generic
    // apply for these — their dedicated handler below does the real work.
    const skipGenericApply = srcName === 'Twisted Fate - Gambler' || srcName === 'Teemo - Strategist'
      || (srcName === 'Sivir - Battle Mistress' && ability.event === 'recycleRune')
      || (srcName === 'Ivern - Green Father' && (ability.event === 'conquer' || ability.event === 'hold'))
      || srcName === 'Volibear - Furious' || srcName === 'Sivir - Ambitious'
      || srcName === 'Adaptatron' // its bespoke conquer handler owns the gear-kill + buff
      || (srcName === 'Draven - Vanquisher' && (ability.event === 'attack' || ability.event === 'defend')) // pay-gated +2, handled bespoke
      || (srcName === 'Atakhan' && ability.event === 'attack') // defender-must-kill, handled bespoke
      || (srcName === 'Ava Achiever' && ability.event === 'attack') // pay-Mind play-Hidden, handled bespoke
      || (srcName === 'Dramatic Visionary' && ability.event === 'death') // [Predict 2] Deathknell, handled bespoke
    // `bfIndex`/`excess` only scope conquer triggers ("units at that battlefield",
    // "if you assigned N+ excess damage"); `sourceIid` lets self-buff / ready-me
    // resolve. A conquer effect that's gated (excess/units) and unmet is skipped.
    const gated = e.condition && !conditionMet(s, p, e, isConquer ? bfIndex : undefined, isConquer ? excess : 0)
    // Kha'Zix - Mutating Horror: "When I attack or defend, IF AN ENEMY UNIT IS ALONE
    // HERE, …" — only fires when the source's battlefield has exactly one enemy unit
    // (previously fired unconditionally).
    const enemyAloneOk = !/if an enemy unit is alone here/i.test(ability.text) || (() => {
      const bi = battlefieldOf(s, sourceIid ?? '')
      return bi >= 0 && s.battlefields[bi].units.filter((u) => u.owner !== player).length === 1
    })()
    // Vex - Mocking: a stun trigger's "you may move me to that battlefield" needs the
    // stunned enemy's bfIndex threaded into applyParsed (moveSourceToBf) — the same way
    // conquer / global-defend triggers receive their battlefield.
    const passBfToApply = isConquer || isGlobalDefend || (ability.event === 'stun' && !!e.moveSourceToBf)
    if (!skipGenericApply && enemyAloneOk) for (const line of applyParsed(s, p, e, passBfToApply ? bfIndex : undefined, sourceIid, isConquer ? excess : 0)) {
      s = log(s, player, `${label}: ${line}`)
      did = true
    }
    // "you may exhaust me to …" (Vi - Piltover Enforcer) — exhaust the source when
    // the gated effect actually resolved.
    if (did && !gated && sourceIid && /\bexhaust me\b/i.test(ability.text)) {
      const su = findUnitAnywhere(s, sourceIid) ?? (s.players[player].legend?.iid === sourceIid ? s.players[player].legend : undefined)
      if (su) su.exhausted = true
    }
    // ("give me +N Might this turn" is applied inside applyParsed above.)
    // Stun from a trigger ("When I attack, [Stun] an enemy unit here" — Vi -
    // Peacekeeper): auto-stun an enemy unit at the source's battlefield. Respects a
    // gating condition (Daisy! — only "while your units have all 4 tags").
    if (e.stun && sourceIid && !gated) {
      const bi = battlefieldOf(s, sourceIid)
      const target = bi >= 0 ? s.battlefields[bi].units.find((u) => u.owner !== player && !u.stunned) : undefined
      if (target) {
        target.stunned = true
        emit({ kind: 'stun', iid: target.iid, player })
        s = log(s, player, `${label}: stunned ${getCard(target.cardId)?.name}.`)
        s = fireStun(s, player, bi) // "when you stun an enemy unit" (Eclipse Herald, Leona); bi = stunned enemy's bf (Vex - Mocking move)
        did = true
      }
    }
    // "You may play a spell from your trash, then recycle it" (Kai'Sa -
    // Evolutionary on conquer). State-threaded replay with auto-targets at the
    // relevant battlefield.
    if (e.playSpellFromTrash && !gated) {
      const bi = isConquer ? (bfIndex ?? -1) : sourceIid ? battlefieldOf(s, sourceIid) : -1
      s = replaySpellFromTrash(s, player, e.playSpellFromTrash, bi)
      did = true
    }
    // --- Hand-coded champion/legend handlers (the parser can't express these
    // unique abilities; per-card code keeps the marquee cards correct). ---
    let handled = false
    // Combat attack triggers that modify the board pre-math (fired in
    // fireCombatTriggers before showdownSteps).
    if (ability.event === 'attack' && sourceIid && (srcName === 'Yasuo - Remorseful' || srcName === "Kha'Zix - Evolving Hunter")) {
      // "When I attack, deal damage equal to my Might to an enemy unit here."
      // (Kha'Zix - Evolving Hunter: optional, costs 3 XP — auto-paid if affordable.)
      const bi = battlefieldOf(s, sourceIid)
      const self = bi >= 0 ? s.battlefields[bi].units.find((u) => u.iid === sourceIid) : undefined
      const canPay = srcName !== "Kha'Zix - Evolving Hunter" || p.xp >= 3
      if (self && canPay) {
        const amt = combatMightAt(s, bi, self, 'attacker')
        const target = pickEnemyToDamage(s.battlefields[bi].units, player, amt)
        if (target && amt > 0) {
          if (srcName === "Kha'Zix - Evolving Hunter") p.xp -= 3
          const dead = applyTargetDamage(s, target.iid, amt, true, player)
          s = log(s, player, `${label}: ${srcName} dealt ${amt} to ${getCard(target.cardId)?.name}.`)
          s = fireDeaths(s, dead)
        }
      }
      handled = true
    }
    // Generic self-dealer "deal damage equal to my Might/[Assault] to an enemy here"
    // on attack OR defend (Ezreal - Dashing; Lucian - Gunslinger uses [Assault]).
    // Yasuo/Kha'Zix are handled by name above (handled=true), so they don't re-fire.
    if (!handled && sourceIid && (ability.event === 'attack' || ability.event === 'defend') && ability.effect.dealMight?.dealer === 'self') {
      const dm = ability.effect.dealMight
      const bi = battlefieldOf(s, sourceIid)
      const self = bi >= 0 ? s.battlefields[bi].units.find((u) => u.iid === sourceIid) : undefined
      if (self) {
        const amt = dm.useStat === 'assault'
          ? parseKeywords(getCard(self.cardId)).assault + (self.grantAssault ?? 0)
          : combatMightAt(s, bi, self, ability.event === 'attack' ? 'attacker' : 'defender')
        const target = pickEnemyToDamage(s.battlefields[bi].units, player, amt)
        if (target && amt > 0) {
          s = log(s, player, `${label}: ${srcName} dealt ${amt} to ${getCard(target.cardId)?.name}.`)
          s = fireDeaths(s, applyTargetDamage(s, target.iid, amt, true, player))
        }
      }
      handled = true
    }
    if (ability.event === 'attack' && sourceIid && srcName === 'Warwick - Hunter') {
      // "When I attack, kill all damaged enemy units here."
      const bi = battlefieldOf(s, sourceIid)
      const victims = bi >= 0 ? s.battlefields[bi].units.filter((u) => u.owner !== player && (u.damage ?? 0) > 0).map((u) => u.iid) : []
      const dead: EngineCard[] = []
      for (const iid of victims) dead.push(...killTarget(s, iid))
      if (victims.length) s = log(s, player, `${label}: ${srcName} killed ${victims.length} damaged enemy unit(s).`)
      s = fireDeaths(s, dead)
      handled = true
    }
    if ((ability.event === 'attack' || ability.event === 'defend') && sourceIid && srcName === 'Ahri - Inquisitive') {
      // "When I attack or defend, give an enemy unit here −2 Might this turn (min 1)."
      const bi = battlefieldOf(s, sourceIid)
      const target = bi >= 0 ? pickStrongestEnemy(s.battlefields[bi].units, player) : undefined
      if (target) {
        applyTempMight(s, target.iid, -2, 1)
        s = log(s, player, `${label}: ${srcName} gave ${getCard(target.cardId)?.name} −2 Might this turn (min 1).`)
      }
      handled = true
    }
    if ((ability.event === 'attack' || ability.event === 'defend') && sourceIid && srcName === 'Draven - Vanquisher') {
      // "When I attack or defend, you may pay :rb_rune_fury:. If you do, give me +2
      // Might this turn." Auto-pay 1 Power if affordable (per the auto-resolve preference).
      if (makeBfApi(s).payPowerAny(player, 1)) {
        const self = findUnitAnywhere(s, sourceIid)
        if (self) { self.tempMight = (self.tempMight ?? 0) + 2; emit({ kind: 'buff', iid: self.iid, player }) }
        s = log(s, player, `${label}: ${srcName} paid 1 Power for +2 Might this turn.`)
      }
      handled = true
    }
    if (ability.event === 'attack' && srcName === 'Azir - Sovereign' && sourceIid) {
      // "When I attack, you may move any number of your token units to this battlefield."
      // Auto-move all friendly token units from elsewhere to Azir's battlefield.
      const bi = battlefieldOf(s, sourceIid)
      if (bi >= 0) {
        const tokens = [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]
          .filter((u) => u.owner === player && u.iid !== sourceIid && (getCard(u.cardId)?.supertype === 'token' || u.token) && battlefieldOf(s, u.iid) !== bi)
        let n = 0
        for (const tok of tokens) { const pl = pluckCardAnywhere(s, tok.iid); if (pl) { s.battlefields[bi].units.push(pl); n++ } }
        if (n) { recomputeControllers(s); s = log(s, player, `${label}: Azir - Sovereign moved ${n} token unit(s) here.`) }
      }
      handled = true
    }
    // Twisted Fate - Gambler: "When I attack, reveal the top rune of your rune deck,
    // then recycle it. Do one of the following based on its domain: Fury → 2 to an
    // enemy here + 1 to all others; Mind → draw 1; Order → stun an enemy here."
    if (ability.event === 'attack' && srcName === 'Twisted Fate - Gambler' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const rune = p.zones.runeDeck.shift()
      if (rune && bi >= 0) {
        const domains = (getCard(rune.cardId) as { produces?: string[] } | undefined)?.produces ?? []
        p.zones.runeDeck.push({ ...rune, exhausted: false, damage: 0 }) // recycle to bottom
        const here = [...s.battlefields[bi].units]
        if (domains.includes('fury')) {
          const main = pickEnemyToDamage(here, player, 2)
          const dead: EngineCard[] = []
          if (main) dead.push(...applyTargetDamage(s, main.iid, 2, true, player))
          for (const u of here) if (u.owner !== player && u.iid !== main?.iid) dead.push(...applyTargetDamage(s, u.iid, 1, true, player))
          s = fireDeaths(s, dead)
          s = log(s, player, `${label}: Twisted Fate (Fury) dealt 2 + 1 to enemies here.`)
        } else if (domains.includes('mind')) {
          drawN(p, 1)
          s = log(s, player, `${label}: Twisted Fate (Mind) drew 1.`)
        } else if (domains.includes('order')) {
          const tgt = pickStrongestEnemy(here, player)
          if (tgt && !tgt.stunned) {
            tgt.stunned = true
            emit({ kind: 'stun', iid: tgt.iid, player })
            s = fireStun(s, player, bi)
            s = log(s, player, `${label}: Twisted Fate (Order) stunned ${getCard(tgt.cardId)?.name}.`)
          }
        }
      }
      handled = true
    }
    // Teemo - Strategist: "When I defend, … reveal the top 5 of your Main Deck, deal 1
    // to an enemy unit here for each card with [Hidden], then recycle them." (Errata:
    // defend-only — the played-from-Hidden trigger was removed.)
    if (ability.event === 'defend' && srcName === 'Teemo - Strategist' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const target = bi >= 0 ? pickStrongestEnemy(s.battlefields[bi].units, player) : undefined
      const top5 = p.zones.mainDeck.slice(0, 5)
      const hiddenCount = top5.filter((c) => /\[hidden\]/i.test(getCard(c.cardId)?.text ?? '')).length
      const revealed = p.zones.mainDeck.splice(0, 5) // recycle the revealed 5 to the bottom
      p.zones.mainDeck.push(...revealed.map((c) => ({ ...c, damage: 0, exhausted: false })))
      if (target && hiddenCount > 0) {
        s = fireDeaths(s, applyTargetDamage(s, target.iid, hiddenCount, true, player))
        s = log(s, player, `${label}: Teemo dealt ${hiddenCount} (Hidden revealed) to ${getCard(target.cardId)?.name}.`)
      } else {
        s = log(s, player, `${label}: Teemo revealed ${top5.length} (${hiddenCount} Hidden).`)
      }
      handled = true
    }
    // Yone - Blademaster: "When I conquer a battlefield that was uncontrolled, deal
    // damage equal to my Might to an enemy unit in a base."
    if (ability.event === 'conquer' && srcName === 'Yone - Blademaster' && sourceIid && wasUncontrolled) {
      const self = findUnitAnywhere(s, sourceIid)
      const amt = self ? mightOf(self, null, p.xp ?? 0) : 0
      const enemiesInBase = s.players.flatMap((pl) => pl.id !== player ? pl.zones.base.filter((u) => getCard(u.cardId)?.type === 'unit') : [])
      const target = enemiesInBase.sort((a, b) => mightOf(b) - mightOf(a))[0]
      if (target && amt > 0) {
        s = fireDeaths(s, applyTargetDamage(s, target.iid, amt, true, player))
        s = log(s, player, `${label}: Yone dealt ${amt} to ${getCard(target.cardId)?.name} in base.`)
      }
      handled = true
    }
    // Adaptatron: "When I conquer, you may kill a gear. If you do, buff me." The
    // generic apply already placed the self-buff; keep it only if a (detached, lowest-
    // cost) gear is sacrificed, otherwise revert it.
    // Volibear - Furious: "When I attack, deal 5 damage split among any number of
    // enemy units here." Auto-split greedily, killing the weakest enemies first.
    if (ability.event === 'attack' && srcName === 'Volibear - Furious' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      if (bi >= 0) {
        let remaining = 5
        const enemies = s.battlefields[bi].units.filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit').sort((a, b) => mightOf(a) - mightOf(b))
        const dead: EngineCard[] = []
        for (const en of enemies) {
          if (remaining <= 0) break
          const dmg = Math.min(remaining, Math.max(1, mightOf(en)))
          remaining -= dmg
          dead.push(...applyTargetDamage(s, en.iid, dmg, true, player))
        }
        if (remaining < 5) s = log(s, player, `${label}: Volibear - Furious dealt 5 split among enemies here.`)
        s = fireDeaths(s, dead, player)
      }
      handled = true
    }
    // Sivir - Ambitious: "When I conquer after an attack, if you assigned 5+ excess
    // damage to enemy units, you may deal that much to an enemy unit." (auto: strongest.)
    if (ability.event === 'conquer' && srcName === 'Vayne - Hunter' && sourceIid) {
      // "When I conquer, you may pay :rb_energy_1: to return me to my owner's hand."
      // Auto-pay 1 if affordable (per the auto-resolve preference).
      if (makeBfApi(s).payEnergy(player, 1)) {
        s = bounceUnitToHand(s, sourceIid, player, 'Vayne - Hunter', 0)
        s = log(s, player, `${label}: Vayne - Hunter paid 1 to return to hand.`)
      }
      handled = true
    }
    if (ability.event === 'conquer' && srcName === 'Sivir - Ambitious' && excess >= 5) {
      const enemies = [...s.battlefields.flatMap((b) => b.units), ...s.players.flatMap((pl) => pl.zones.base)].filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit')
      if (enemies.length) {
        const target = enemies.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi))
        s = log(s, player, `${label}: Sivir - Ambitious dealt ${excess} to ${getCard(target.cardId)?.name}.`)
        s = fireDeaths(s, applyTargetDamage(s, target.iid, excess, true, player), player)
      }
      handled = true
    }
    if (ability.event === 'conquer' && srcName === 'Adaptatron' && sourceIid) {
      const self = findUnitAnywhere(s, sourceIid)
      const gear = p.zones.base.filter((g) => getCard(g.cardId)?.type === 'gear').sort((a, b) => cardCost(a) - cardCost(b))[0]
      if (gear && self) {
        removeFromZone(p, 'base', gear.iid)
        sendToTrash(p, gear)
        if ((self.buffs ?? 0) < 1) { self.buffs = 1; emit({ kind: 'buff', iid: self.iid, player }) }
        s = log(s, player, `${label}: Adaptatron killed ${getCard(gear.cardId)?.name} to buff itself.`)
      } else if (self && (self.buffs ?? 0) > 0) {
        self.buffs = 0 // no gear to pay → revert any generic self-buff
        s = log(s, player, `${label}: Adaptatron found no gear to kill — no buff.`)
      }
      handled = true
    }
    // Blitzcrank - Impassive: "When I hold, return me to my owner's hand." (Its
    // "play me to a battlefield → pull an enemy" half is handled in the PLAY_UNIT path.)
    if (ability.event === 'hold' && srcName === 'Blitzcrank - Impassive' && sourceIid) {
      s = bounceUnitToHand(s, sourceIid, player, 'Blitzcrank - Impassive', 0)
      s = log(s, player, `${label}: Blitzcrank returned to hand (held).`)
      handled = true
    }
    // Iascylla: "When I hold, at the start of your next Main Phase, you may move an
    // enemy unit to this battlefield." Queue the pull (drained in beginTurn).
    if (ability.event === 'hold' && srcName === 'Iascylla' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      if (bi >= 0) {
        const pp = s.players[player]
        if (!pp.pendingPullsNextTurn) pp.pendingPullsNextTurn = []
        pp.pendingPullsNextTurn.push({ bfIndex: bi, queuedTurn: s.turn })
        s = log(s, player, `${label}: Iascylla will pull an enemy here at the start of your next Main Phase.`)
      }
      handled = true
    }
    // Irresistible Faefolk: "When I move to a battlefield, you may move an enemy unit
    // to here." Auto-pulls the strongest enemy from elsewhere to Faefolk's new home.
    if (ability.event === 'move' && srcName === 'Irresistible Faefolk' && sourceIid) {
      const destBf = battlefieldOf(s, sourceIid)
      if (destBf >= 0) s = pullEnemyToBf(s, player, destBf, 'Irresistible Faefolk')
      handled = true
    }
    // Kato the Arm: "When I move to a battlefield, give another friendly unit my keywords
    // and +Might equal to my Might this turn." Auto-picks the strongest OTHER friendly
    // unit anywhere and copies Kato's mechanical keywords + a this-turn Might bump.
    if (ability.event === 'move' && srcName === 'Kato the Arm' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const kato = findUnitAnywhere(s, sourceIid)
      if (bi >= 0 && kato) {
        const kw = parseKeywords(getCard(kato.cardId))
        const katoMight = mightOf(kato)
        const allies = [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]
          .filter((u) => u.owner === player && u.iid !== sourceIid && getCard(u.cardId)?.type === 'unit')
        const target = allies.length ? allies.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi)) : undefined
        if (target) {
          if (kw.deflect > 0) target.grantDeflect = (target.grantDeflect ?? 0) + kw.deflect
          if (kw.ganking) target.grantGanking = true
          if (kw.assault > 0) target.grantAssault = (target.grantAssault ?? 0) + kw.assault
          if (kw.shield > 0) target.grantShield = (target.grantShield ?? 0) + kw.shield
          if (kw.tank) target.grantTank = true
          if (katoMight > 0) target.tempMight = (target.tempMight ?? 0) + katoMight
          emit({ kind: 'buff', iid: target.iid, player })
          s = log(s, player, `${label}: Kato gave ${getCard(target.cardId)?.name} his keywords and +${katoMight} Might this turn.`)
        }
      }
      handled = true
    }
    // Imposing Challenger: "When I move, you may move an enemy unit here with less Might
    // than me to a different battlefield." Auto-pushes the weakest qualifying enemy at
    // its battlefield to another (preferring an empty/uncontested) battlefield.
    if (ability.event === 'move' && srcName === 'Imposing Challenger' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const self = findUnitAnywhere(s, sourceIid)
      if (bi >= 0 && self) {
        const myMight = mightOf(self)
        const targets = s.battlefields[bi].units.filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit' && mightOf(u) < myMight)
        if (targets.length) {
          const victim = targets.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
          const destIdx = (() => {
            const empty = s.battlefields.findIndex((b, i) => i !== bi && b.units.length === 0)
            if (empty >= 0) return empty
            return s.battlefields.findIndex((_, i) => i !== bi)
          })()
          if (destIdx >= 0) {
            const pulled = pluckCardAnywhere(s, victim.iid)
            if (pulled) {
              const priorCtrl = s.battlefields[destIdx].controller
              s.battlefields[destIdx].units.push(pulled)
              recomputeControllers(s)
              s = log(s, player, `${label}: Imposing Challenger pushed ${getCard(pulled.cardId)?.name} to battlefield ${destIdx + 1}.`)
              s = showdownOrConquerAfterEffectMove(s, destIdx, pulled.iid, priorCtrl)
            }
          }
        }
      }
      handled = true
    }
    // Sivir - Battle Mistress: "When you recycle a rune, you may exhaust me to play
    // a Gold gear token exhausted." Auto-paid only while Sivir (legend) is ready.
    if (ability.event === 'recycleRune' && srcName === 'Sivir - Battle Mistress' && sourceIid) {
      const src = findUnitAnywhere(s, sourceIid) ?? (s.players[player].legend?.iid === sourceIid ? s.players[player].legend : undefined)
      if (src && !src.exhausted) {
        src.exhausted = true
        spawnGold(s.players[player], 1, s.turn)
        s = log(s, player, `${label}: Sivir exhausted to play a Gold token.`)
      }
      handled = true
    }
    // Rell - Magnetic: "When I attack, you may play an Equipment (Energy ≤ 2),
    // ignoring its cost. If you do, attach it to me." Auto-played (pure benefit).
    if (ability.event === 'attack' && srcName === 'Rell - Magnetic' && sourceIid) {
      const self = findUnitAnywhere(s, sourceIid)
      const gearCi = p.zones.hand.find((c) => getCard(c.cardId)?.type === 'gear' && ((getCard(c.cardId) as { energy?: number } | undefined)?.energy ?? 0) <= 2)
      if (self && gearCi) {
        removeFromZone(p, 'hand', gearCi.iid)
        self.attached = [...self.attached, `${gearCi.cardId}|${gearCi.iid}`]
        emit({ kind: 'buff', iid: self.iid, player, cardId: gearCi.cardId })
        s = fireAttachEquip(s, player, self)
        s = log(s, player, `${label}: Rell played & attached ${getCard(gearCi.cardId)?.name} (free).`)
      }
      handled = true
    }
    // Sinister Poro: "When I attack, you may pay 1 to move an enemy unit here to its
    // base." Auto-paid + auto-targets the weakest enemy at Poro's battlefield. Fires in
    // the attack step (before damage), so the removed defender drops out of combat.
    if (ability.event === 'attack' && srcName === 'Sinister Poro' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      if (bi >= 0) {
        const enemies = s.battlefields[bi].units.filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit')
        if (enemies.length && makeBfApi(s).payEnergy(player, 1)) {
          const victim = enemies.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
          if (sendUnitToBase(s, victim.iid))
            s = log(s, player, `${label}: Sinister Poro paid 1 to send ${getCard(victim.cardId)?.name} to its base.`)
        }
      }
      handled = true
    }
    // Atakhan: "When I attack, the defender must kill one of their units here." Each
    // opposing player with units at Atakhan's battlefield culls their weakest one there
    // (auto-resolve; the forced choice is the defender's, lowest-Might per the policy).
    if (ability.event === 'attack' && srcName === 'Atakhan' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      if (bi >= 0) {
        const dead: EngineCard[] = []
        const defenders = new Set(s.battlefields[bi].units.filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit').map((u) => u.owner))
        for (const owner of defenders) {
          const theirs = s.battlefields[bi].units.filter((u) => u.owner === owner && getCard(u.cardId)?.type === 'unit')
          if (!theirs.length) continue
          const victim = theirs.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
          s = log(s, player, `${label}: Atakhan forces ${s.players[owner].name} to kill ${getCard(victim.cardId)?.name ?? 'a unit'}.`)
          dead.push(...killTarget(s, victim.iid))
        }
        if (dead.length) s = fireDeaths(s, dead, player)
      }
      handled = true
    }
    // Ava Achiever: "When I attack, you may pay :rb_rune_mind: to play a card with
    // [Hidden] from your hand, ignoring its cost. If it's a unit, play it here." Auto-pays
    // 1 Mind Power when available and a [Hidden] card is in hand; auto-picks the strongest
    // [Hidden] unit (else the first [Hidden] card). Plays from hand directly (not hidden).
    if (ability.event === 'attack' && srcName === 'Ava Achiever' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const hidden = p.zones.hand.filter((c) => parseKeywords(getCard(c.cardId)).hidden)
      const mindRune = p.zones.runePool.find((r) => !r.exhausted && (def(r) as { produces?: string[] } | undefined)?.produces?.includes('mind'))
      if (bi >= 0 && hidden.length && mindRune) {
        const ri = p.zones.runePool.findIndex((r) => r.iid === mindRune.iid)
        const [recycled] = p.zones.runePool.splice(ri, 1)
        p.zones.runeDeck.push({ ...recycled, exhausted: false, damage: 0 })
        const units = hidden.filter((c) => getCard(c.cardId)?.type === 'unit')
        const pick = units.length ? units.reduce((hi, c) => (mightOf(c) >= mightOf(hi) ? c : hi)) : hidden[0]
        const pickDef = getCard(pick.cardId)
        removeFromZone(p, 'hand', pick.iid)
        const newCi: EngineCard = { ...pick, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn }
        emit({ kind: 'play', iid: newCi.iid, player, cardId: newCi.cardId })
        if (pickDef?.type === 'unit') {
          s.battlefields[bi].units.push(newCi)
          recomputeControllers(s)
          s = log(s, player, `${label}: Ava played ${pickDef.name} from hand (free, here).`)
          for (const line of applyParsed(s, p, onPlayEffect(pickDef), bi, newCi.iid)) s = log(s, player, line)
          s = firePlayTriggers(s, player, newCi.iid, pickDef, 0, false)
        } else if (pickDef?.type === 'gear') {
          p.zones.base.push({ ...newCi, exhausted: false })
          s = log(s, player, `${label}: Ava played ${pickDef.name} from hand (free).`)
          s = firePlayTriggers(s, player, newCi.iid, pickDef, 0, false)
        } else if (pickDef) {
          s = log(s, player, `${label}: Ava played ${pickDef.name} from hand (free).`)
          s = resolveSpellEffects(s, player, pickDef, [])
          s = firePlayTriggers(s, player, newCi.iid, pickDef, 0, false)
          sendToTrash(p, newCi)
        }
      }
      handled = true
    }
    // Yuumi - Magical Cat: "When I attack or defend, give one of your other units here
    // +3 Might and [Tank] this turn." Auto-picks a friendly other unit at the bf.
    if ((ability.event === 'attack' || ability.event === 'defend') && srcName === 'Yuumi - Magical Cat' && sourceIid) {
      const bi = battlefieldOf(s, sourceIid)
      const ally = bi >= 0 ? s.battlefields[bi].units.find((u) => u.owner === player && u.iid !== sourceIid && getCard(u.cardId)?.type === 'unit') : undefined
      if (ally) {
        ally.tempMight = (ally.tempMight ?? 0) + 3
        ally.grantTank = true
        emit({ kind: 'buff', iid: ally.iid, player })
        s = log(s, player, `${label}: Yuumi gave ${getCard(ally.cardId)?.name} +3 Might and [Tank] this turn.`)
      }
      handled = true
    }
    // Rumble - Hotheaded: "When I conquer, you may recycle another friendly unit to
    // play a Mech from your trash, reducing its Energy cost by the recycled unit's
    // Might." Auto-resolved conservatively — only when recycling a spare unit makes a
    // STRONGER Mech free (net board gain), so it never carelessly sacrifices a unit.
    if (ability.event === 'conquer' && srcName === 'Rumble - Hotheaded' && sourceIid) {
      const isMech = (c: EngineCard) => (getCard(c.cardId)?.tags ?? []).includes('Mech')
      const mechs = p.zones.trash.filter((c) => getCard(c.cardId)?.type === 'unit' && isMech(c))
      const mech = mechs.length ? mechs.reduce((a, b) => (mightOf(b) > mightOf(a) ? b : a)) : undefined
      if (mech) {
        const cost = cardCost(mech) // recycled Might must cover the whole cost (free)
        const spare = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
          .filter((x) => x.owner === player && x.iid !== sourceIid && !x.token && getCard(x.cardId)?.supertype !== 'token' && getCard(x.cardId)?.type === 'unit' && mightOf(x) >= cost && mightOf(x) < mightOf(mech))
          .sort((a, b) => mightOf(a) - mightOf(b))[0]
        if (spare) {
          for (const bf of s.battlefields) { const i = bf.units.findIndex((x) => x.iid === spare.iid); if (i >= 0) bf.units.splice(i, 1) }
          const bi = p.zones.base.findIndex((x) => x.iid === spare.iid); if (bi >= 0) p.zones.base.splice(bi, 1)
          p.zones.mainDeck.push({ ...spare, exhausted: false, damage: 0, attached: [] }) // recycle to deck bottom
          const ti = p.zones.trash.findIndex((x) => x.iid === mech.iid)
          const [m] = p.zones.trash.splice(ti, 1)
          p.zones.base.push({ ...m, exhausted: true, damage: 0, attached: [], enteredTurn: s.turn })
          recomputeControllers(s)
          s = log(s, player, `${label}: ${srcName} recycled ${getCard(spare.cardId)?.name} to play ${getCard(m.cardId)?.name} from trash (free).`)
        }
      }
      handled = true
    }
    // Ivern - Green Father: "When you conquer or hold, you may exhaust me to replace
    // that battlefield with a Brush battlefield token." Auto-resolved (pure benefit):
    // if Ivern (the legend) is ready, exhaust it and swap the battlefield. Conquer
    // passes bfIndex; hold has none, so pick the first controlled non-Brush bf.
    if ((ability.event === 'conquer' || ability.event === 'hold') && srcName === 'Ivern - Green Father') {
      const legend = s.players[player].legend
      if (legend && !legend.exhausted) {
        const BRUSH_ID = 'unl-t03-219'
        let targetBf: number | undefined
        if (ability.event === 'conquer' && bfIndex != null) targetBf = bfIndex
        else {
          const found = s.battlefields.findIndex((b) => b.controller === player && b.cardId !== BRUSH_ID)
          if (found >= 0) targetBf = found
        }
        if (targetBf != null && s.battlefields[targetBf]) {
          legend.exhausted = true
          const bf = s.battlefields[targetBf]
          if (bf.cardId !== BRUSH_ID) bf.originalCardId = bf.cardId
          bf.cardId = BRUSH_ID
          recomputeControllers(s)
          s = log(s, player, `${label}: Ivern exhausted — replaced battlefield ${targetBf + 1} with Brush.`)
        }
      }
      handled = true
    }
    // (Kha'Zix - Voidreaver's "When you win a combat, gain 1 XP" is now handled by
    // the generic gainXp parse in applyParsed above.)
    if (ability.event === 'death' && sourceCardId) {
      const baseName = srcName
      if (baseName === "Kog'Maw - Caustic" && deathBf != null && s.battlefields[deathBf]) {
        // "[Deathknell] Deal 4 to all units at my battlefield." AoE — no target
        // choice. Fired once per copy, so Karthus - Eternal doubles it (4 → 8).
        const amt = e.damage || 4
        const dead: EngineCard[] = []
        for (const tu of [...s.battlefields[deathBf].units]) dead.push(...applyTargetDamage(s, tu.iid, amt, true, player))
        s = log(s, player, `${label}: ${baseName} dealt ${amt} to all units at its battlefield.`)
        s = fireDeaths(s, dead)
        handled = true
      } else if (baseName === 'Ekko - Recurrent') {
        // "[Deathknell] Recycle me to ready your runes." Recycle Ekko into the
        // rune deck and un-exhaust the controller's rune pool.
        const ti = p.zones.trash.findIndex((c) => c.iid === sourceIid)
        if (ti >= 0) { const [ek] = p.zones.trash.splice(ti, 1); p.zones.runeDeck.push({ ...ek, exhausted: false, damage: 0 }) }
        let readied = 0
        for (const r of p.zones.runePool) if (r.exhausted) { r.exhausted = false; readied++ }
        s = log(s, player, `${label}: recycled ${baseName} and readied ${readied} rune(s).`)
        handled = true
      } else if (baseName === 'Dramatic Visionary') {
        // "[Deathknell] [Predict 2]: look at the top two cards of your Main Deck. Recycle
        // any of them and put the rest back in any order." Auto-resolved per the
        // auto-resolve preference: keep both and order the higher-cost card on top (a
        // faithful no-recycle Predict). Full player-chosen recycle/reorder is deferred
        // (a mid-death pendingChoice would risk re-entrancy during combat resolution).
        const deck = p.zones.mainDeck
        if (deck.length >= 2) {
          const costOfTop = (c: EngineCard) => (getCard(c.cardId) as { energy?: number } | undefined)?.energy ?? 0
          if (costOfTop(deck[1]) > costOfTop(deck[0])) { const tmp = deck[0]; deck[0] = deck[1]; deck[1] = tmp }
          s = log(s, player, `${label}: Predict 2 — looked at the top two cards and set the order.`)
        } else {
          s = log(s, player, `${label}: Predict 2 — too few cards in deck.`)
        }
        handled = true
      }
    }
    if (!handled) {
      if (e.damage) s = log(s, player, `${label}: deal ${e.damage} — choose a target (resolve manually).`)
      else if (!did) s = log(s, player, `${label}: ${ability.text} — resolve manually.`)
    }
  }
  return s
}

/** How many times a player's [Deathknell] effects fire: 1 plus one per controlled
 *  permanent reading "your [Deathknell] effects trigger an additional time"
 *  (Karthus - Eternal). */
function deathknellMultiplier(s: MatchState, player: PlayerId): number {
  return 1 + controlledPermanents(s, player).filter(
    (p) => /your \[?deathknell\]? effects trigger an additional time/i.test(getCard(p.cardId)?.text ?? ''),
  ).length
}

/** Fire the death triggers of a set of defeated units: each unit's own
 *  [Deathknell] (×N if its controller has Karthus - Eternal), the controller's
 *  global "when a unit you control dies" triggers (Viktor), and every OTHER
 *  player's "when an enemy unit dies" triggers (Pyke - Returned, Sivir). */
function fireDeaths(s: MatchState, defeated: EngineCard[], caster?: PlayerId): MatchState {
  if (defeated.length) s.unitDiedThisTurn = true // gates conditional enter-ready
  const isRecruit = (u: EngineCard) => (getCard(u.cardId)?.tags ?? []).includes('Recruit')
  // At-death snapshots for Deathknell state gates (the dying unit's stats are still
  // intact). "Mighty" ignores the lethal damage (its Might stat was 5+). "Alone" =
  // no other friendly units at its battlefield (survivors + same-batch casualties).
  const mightyAtDeath = (u: EngineCard) => {
    const d = getCard(u.cardId)
    return !!d && d.type === 'unit' && d.might + (u.buffs ?? 0) + (u.tempMight ?? 0) + gearMight(u, s.players[u.owner]?.xp ?? 0) + levelBonus(d, s.players[u.owner]?.xp ?? 0).might >= 5
  }
  const aloneAtDeath = (u: EngineCard) => {
    const bf = u.diedAtBf != null ? s.battlefields[u.diedAtBf] : null
    const survivors = bf ? bf.units.filter((x) => x.owner === u.owner && x.iid !== u.iid).length : 0
    const otherDead = defeated.filter((x) => x.iid !== u.iid && x.owner === u.owner && x.diedAtBf === u.diedAtBf).length
    return survivors + otherDead === 0
  }
  const fired: FiredTrigger[] = []
  for (const u of defeated) {
    // Self death triggers (Deathknell) — fired an extra time per Karthus - Eternal.
    const mult = deathknellMultiplier(s, u.owner)
    for (const ab of triggersFor(def(u), 'death')) {
      if (ab.scope === 'global') continue
      const ck = ab.effect.condition?.kind // Unsung Hero / Lonely & Loyal Poro gates
      if (ck === 'wasMighty' && !mightyAtDeath(u)) continue
      if (ck === 'diedAlone' && !aloneAtDeath(u)) continue
      if (ck === 'diedNotAlone' && aloneAtDeath(u)) continue
      for (let i = 0; i < mult; i++) fired.push({ player: u.owner, ability: ab, sourceIid: u.iid, sourceCardId: u.cardId, bfIndex: u.diedAtBf })
    }
    // Global "when a unit you control dies" triggers (Viktor - Leader), on the
    // dead unit's controller's other permanents.
    for (const perm of controlledPermanents(s, u.owner)) {
      if (perm.iid === u.iid) continue // "another" — not the dying unit itself
      for (const ab of triggersFor(def(perm), 'death')) {
        if (ab.scope !== 'global') continue
        // "non-Recruit" / "buffed" gates (the qualifier sits in the trigger phrase,
        // so check the source card's full text, not the parsed clause).
        const srcText = getCard(perm.cardId)?.text ?? ''
        if (/non-recruit/i.test(srcText) && isRecruit(u)) continue
        if (/buffed [^.]*?units?[^.]*?(?:dies|defeated)/i.test(srcText) && !(u.buffs ?? 0)) continue // Vanguard Helm
        fired.push({ player: u.owner, ability: ab, sourceIid: perm.iid })
      }
    }
    // Enemy-death triggers: OTHER players reacting to this unit dying (Pyke -
    // Returned, Sivir - Battle Mistress). "while I'm at a battlefield" gates the
    // source to a battlefield (Pyke).
    for (let pl = 0; pl < s.players.length; pl++) {
      if (pl === u.owner) continue
      for (const perm of controlledPermanents(s, pl)) {
        for (const ab of triggersFor(def(perm), 'enemyDeath')) {
          if (/while i'?m at a battlefield/i.test(getCard(perm.cardId)?.text ?? '') && battlefieldOf(s, perm.iid) < 0) continue
          fired.push({ player: pl, ability: ab, sourceIid: perm.iid })
        }
      }
    }
  }
  // Immortal Phoenix (ogn-037-298): "When you kill a unit with a spell, you may pay
  // 1 Energy + Fury to play me from your trash." Auto-paid when the caster affords it.
  if (caster != null && defeated.some((u) => u.killedBySpell)) {
    const phoenix = s.players[caster].zones.trash.find((c) => c.cardId === 'ogn-037-298')
    if (phoenix) s = playFromTrashPayingCost(s, caster, phoenix.iid, { energy: 1, power: { fury: 1 } })
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
function playTriggerMatches(text: string, card: Card, cost?: number, mighty?: boolean): boolean {
  const lc = text.toLowerCase()
  const f = (lc.match(/^\s*([a-z[\] ]*?)(?:\s+(?:on|from|with|that|this|here|cost)\b|[.,;]|$)/)?.[1] ?? '').trim()
  let typeOk = true
  if (f && f !== 'card') {
    if (f.includes('token')) typeOk = card.supertype === 'token'
    else if (f.includes('spell')) typeOk = card.type === 'spell'
    else if (f.includes('gear')) typeOk = card.type === 'gear'
    // [Mighty] = 5+ EFFECTIVE Might: prefer the played instance's live state
    // (`mighty`); fall back to base Might only when no instance exists (tokens).
    else if (f.includes('mighty')) typeOk = isUnit(card) && (mighty ?? card.might >= 5)
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
  // Opponent-directed tokens (Walking Roost) don't count toward YOUR token synergy.
  return e.recruits + (e.namedToken && !e.namedToken.opponent ? e.namedToken.count : 0)
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
 *  countered on the chain still triggers these — rule 4.x / T2). Excludes the
 *  card just played so it doesn't react to its own entry, and skips triggers
 *  whose "when you play a <type>" filter the played card doesn't match. */
function firePlayTriggers(s: MatchState, player: PlayerId, exceptIid: string, playedCard?: Card, playedCost?: number, fromHidden = false): MatchState {
  let fired = collectGlobal(s, player, 'play').filter((f) => f.sourceIid !== exceptIid)
  // Triggers that pay by exhausting their own source ("…exhaust me to…") are
  // cost-gated and handled explicitly (Chemtech Cask), not auto-resolved here —
  // otherwise they'd fire for free on every spell.
  fired = fired.filter((f) => !/exhaust me\b|exhaust this\b/i.test(f.ability.text))
  // "When you play a card on an opponent's turn" (Viktor - Innovator) — only fires
  // while it's NOT the controller's turn.
  fired = fired.filter((f) => !/on an opponent'?s turn/i.test(f.ability.text) || s.activePlayer !== player)
  // "When you play a card from [Hidden]" (Ember Monk) — only on a reveal-play.
  fired = fired.filter((f) => /\bfrom \[?hidden\]?/i.test(f.ability.text) ? fromHidden : true)
  if (playedCard) {
    // For a "play a [Mighty] unit" filter, test the live state of the played
    // instance (effective Might, incl. buffs/gear), not its base stat.
    const inst = isUnit(playedCard) ? findUnitAnywhere(s, exceptIid) : undefined
    const mighty = inst ? stateActive(s, inst, 'mighty') : undefined
    fired = fired.filter((f) => playTriggerMatches(f.ability.text, playedCard, playedCost, mighty))
  }
  return fireTriggers(s, fired)
}

/** Fire OPPONENTS' "when an opponent plays a unit while I'm at a battlefield"
 *  triggers as `player` plays a unit (`playedIid`). Vex - Apathetic: stun the
 *  just-played unit and bar it from moving this turn. Mandatory and untargeted
 *  (it names the played unit directly), so Deflect/protection don't apply. The
 *  responder's Vex must be AT A BATTLEFIELD (in a battlefield's units, not base). */
function fireOpponentUnitPlay(s: MatchState, player: PlayerId, playedIid: string): MatchState {
  const played = findUnitAnywhere(s, playedIid)
  if (!played) return s
  for (let pid = 0; pid < s.players.length; pid++) {
    if (pid === player || s.players[pid]?.out) continue
    // Responder's units that are AT A BATTLEFIELD with the matching trigger text.
    const atBf = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner === pid)
    for (const vex of atBf) {
      const t = (getCard(vex.cardId)?.text ?? '').toLowerCase()
      if (!/when an opponent plays a unit[^.]*?\bstun\b|when an opponent plays a unit[^.]*?\[stun\]/.test(t)) continue
      if (played.stunned) continue // already stunned (e.g. two Vexes) — no double log
      played.stunned = true
      emit({ kind: 'stun', iid: played.iid, player: pid })
      s = log(s, pid, `${getCard(vex.cardId)?.name}: stunned ${getCard(played.cardId)?.name} (played at a battlefield).`)
      if (/can'?t move it this turn/.test(t)) played.cantMoveTurn = s.turn
    }
  }
  return s
}

/** Fire OPPONENTS' "when an opponent scores, draw N" gear as `scorer` scores
 *  (Sumpworks Map). Mutates `s` in place (draws + logs), so it can be called right
 *  after each score emit without the caller reassigning its state. */
function fireOpponentScore(s: MatchState, scorer: PlayerId): void {
  for (let pid = 0; pid < s.players.length; pid++) {
    if (pid === scorer || s.players[pid]?.out) continue
    for (const g of allGearInPlay(s).filter((x) => x.owner === pid)) {
      const m = (getCard(g.cardId)?.text ?? '').toLowerCase().match(/when an opponent scores,?\s*draw (\d+)/)
      if (!m) continue
      const n = parseInt(m[1], 10) || 1
      drawN(s.players[pid], n)
      s.log.push({ turn: s.turn, player: pid, text: `${getCard(g.cardId)?.name}: drew ${n} (an opponent scored).` })
    }
  }
}

/** Darius - Trifarian: "When you play your second card in a turn, give me +N Might
 *  this turn and ready me." Call right after `cardsPlayedThisTurn` is incremented;
 *  fires only on the transition to the 2nd card. Mutates `s` in place. */
function fireSecondCardPlayed(s: MatchState, player: PlayerId): void {
  if (s.players[player]?.cardsPlayedThisTurn !== 2) return
  for (const u of [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]) {
    if (u.owner !== player) continue
    const tx = (getCard(u.cardId)?.text ?? '').toLowerCase()
    if (!/when you play your second card in a turn/.test(tx)) continue
    const bm = tx.match(/give me \+(\d+)\s*(?::rb_might:|might) this turn/)
    if (bm) u.tempMight = (u.tempMight ?? 0) + parseInt(bm[1], 10)
    if (/ready me/.test(tx)) u.exhausted = false
    emit({ kind: 'buff', iid: u.iid, player })
  }
}

/** Fire "when you stun an enemy unit" global triggers (Eclipse Herald — ready me
 *  + give me +1 Might; Leona - Radiant Dawn — buff a friendly unit). Invoked once
 *  per stun resolution in which the controller stunned ≥1 enemy unit (so a
 *  "one or more" trigger fires exactly once). No-op unless such a trigger is in
 *  play. Triggers that pay by moving/exhausting their own source (Vex - Mocking,
 *  "you may move me") are left for manual resolution by fireTriggers. */
function fireStun(s: MatchState, player: PlayerId, bfIndex?: number): MatchState {
  return fireTriggers(s, collectGlobal(s, player, 'stun'), bfIndex)
}

/** Fire "when a unit becomes [<state>]" triggers (self + global) for the unit that
 *  just crossed into `stateName`. Handles the two real becomes-[Mighty] payoffs:
 *  Fiora - Grand Duelist ("exhaust me to channel N exhausted" — pure upside, auto)
 *  and Fiora - Worthy ("pay <cost> to ready it" — a pendingChoice). `becameIid` is
 *  the unit that gained the state; `owner` controls it. */
function fireBecomesState(s: MatchState, owner: PlayerId, becameIid: string, stateName: StateName): MatchState {
  const fired = [
    ...collectSelf(s, owner, 'becomesState', [becameIid]),
    ...collectGlobal(s, owner, 'becomesState'),
  ].filter((f) => (f.ability.stateName ?? 'mighty') === stateName)
  for (const f of fired) {
    const txt = f.ability.text
    const srcName = getCard(f.sourceCardId ?? '')?.name ?? 'A unit'
    // "exhaust me to channel N rune(s) exhausted" (Grand Duelist) — auto.
    const chM = txt.match(/exhaust me to channel (\d+|a|an|one) rune/i)
    if (chM) {
      const src = findUnitAnywhere(s, f.sourceIid ?? '') ?? (s.players[owner].legend?.iid === f.sourceIid ? s.players[owner].legend! : undefined)
      if (src && !src.exhausted) {
        src.exhausted = true
        const n = channelN(s.players[owner], /\d/.test(chM[1]) ? parseInt(chM[1], 10) : 1, true)
        s = log(s, owner, `${srcName}: a unit became [${stateName}] — exhausted to channel ${n} (exhausted).`)
      }
      continue
    }
    // "pay <cost> to ready it" (Fiora - Worthy) — offer to pay + ready the unit.
    const prM = txt.match(/pay ([^.]*?) to ready it/i)
    if (prM && !s.pendingChoice) {
      const cost = parseCostGlyphs(prM[1])
      const unit = findUnitAnywhere(s, becameIid)
      if (unit && unit.exhausted && canAffordFixed(s, owner, cost.energy, cost.power)) {
        offerChoice(s, {
          player: owner, kind: 'becomesStateReady', bfIndex: -1,
          prompt: `${srcName} — a unit became [${stateName}]. Pay ${costGlyphLabel(cost)} to ready it?`,
          options: [{ iid: becameIid, label: `Pay ${costGlyphLabel(cost)} & ready` }],
          payload: JSON.stringify(cost),
        })
      }
      continue
    }
  }
  return s
}

/** Transition layer: after each action, recompute every in-play unit's states and
 *  fire becomes-<state> triggers for newly-gained states. A unit seen for the first
 *  time (no snapshot) only establishes a baseline — it does NOT fire (so game-start
 *  and entering already-[Mighty] don't false-trigger; buff/temp crossings do). */
function refreshStates(s: MatchState): MatchState {
  const units = [...s.battlefields.flatMap((b) => b.units), ...s.players.flatMap((p) => p.zones.base)]
    .filter((u) => getCard(u.cardId)?.type === 'unit')
  for (const u of units) {
    const now = unitStateNames(s, u)
    const first = u.stateSnapshot === undefined
    const prev = u.stateSnapshot ?? []
    u.stateSnapshot = now
    if (first) continue
    for (const st of now) {
      if (prev.includes(st)) continue
      s = fireBecomesState(s, u.owner, u.iid, st)
      if (s.pendingChoice) return s // pause on the first offered choice
    }
  }
  return s
}

/** In-place "When you spend a buff, …" reaction (Fae Dragon → play a Gold gear
 *  token exhausted). Called at each buff-spend site; returns log lines. */
function fireSpendBuffInline(s: MatchState, player: PlayerId): string[] {
  const lines: string[] = []
  for (const u of controlledPermanents(s, player)) {
    if (/when(?:ever)?\s+you\s+spend\s+a\s+buff/i.test(getCard(u.cardId)?.text ?? '')) {
      spawnGold(s.players[player], 1, s.turn) // Fae Dragon: Gold gear token (exhausted)
      lines.push(`Spent a buff: played a Gold gear token.`)
    }
  }
  return lines
}

/** Fire "When you use an activated ability of a gear, give me +N Might this turn"
 *  (Prize of Progress). Call after a GEAR's activated ability resolves. */
function fireGearAbilityUse(s: MatchState, player: PlayerId): MatchState {
  for (const u of [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]) {
    if (u.owner !== player) continue
    const m = (getCard(u.cardId)?.text ?? '').toLowerCase().match(/when you use an activated ability of a gear,? give me \+(\d+)\s*(?::rb_might:|might) this turn/)
    if (m) {
      u.tempMight = (u.tempMight ?? 0) + parseInt(m[1], 10)
      emit({ kind: 'buff', iid: u.iid, player })
      s = log(s, player, `${getCard(u.cardId)?.name}: +${m[1]} Might this turn (gear ability used).`)
    }
  }
  return s
}

/** Parse the cost glyphs in a fragment (":rb_energy_N:" + ":rb_rune_X:") into a
 *  fixed {energy, power} cost — used by triggered "pay X to play me" effects. */
function parseCostGlyphs(frag: string): { energy: number; power: Partial<Record<Domain, number>> } {
  const energy = parseInt((frag.match(/:rb_energy_(\d+):/) || [])[1] || '0', 10)
  const power: Partial<Record<Domain, number>> = {}
  for (const m of frag.matchAll(/:rb_rune_([a-z]+):/g)) power[m[1] as Domain] = (power[m[1] as Domain] ?? 0) + 1
  return { energy, power }
}

const costGlyphLabel = (c: { energy: number; power: Partial<Record<Domain, number>> }): string =>
  [c.energy ? `${c.energy} Energy` : '', ...Object.entries(c.power).map(([d, n]) => `${n} ${d[0].toUpperCase()}${d.slice(1)} Power`)].filter(Boolean).join(' + ') || 'no cost'

/** Whether `player` can afford a FIXED alternate cost from pool + ready runes —
 *  power must be paid in its colour, energy by pool then any ready rune. No mutation. */
function canAffordFixed(s: MatchState, player: PlayerId, energy: number, power: Partial<Record<Domain, number>>): boolean {
  const p = s.players[player]
  const ready = p.zones.runePool.filter((r) => !r.exhausted)
  const producesD = (r: EngineCard, d: Domain) => ((def(r) as { produces?: Domain[] })?.produces ?? []).includes(d)
  const used = new Set<string>()
  for (const [d, n] of Object.entries(power) as [Domain, number][]) {
    let need = (n ?? 0) - (p.pool?.power[d] ?? 0)
    for (const r of ready) { if (need <= 0) break; if (!used.has(r.iid) && producesD(r, d)) { used.add(r.iid); need-- } }
    if (need > 0) return false
  }
  const energyRunes = energy - Math.min(energy, p.pool?.energy ?? 0)
  return energyRunes <= ready.filter((r) => !used.has(r.iid)).length
}

/** Auto-pay a FIXED alternate cost from `player`'s pool + ready runes (power in its
 *  colour, energy by pool then exhausting any ready rune). Returns true if paid;
 *  false (no mutation) if unaffordable. */
function payFixedCost(s: MatchState, player: PlayerId, energy: number, power: Partial<Record<Domain, number>>): boolean {
  if (!canAffordFixed(s, player, energy, power)) return false
  const p = s.players[player]
  if (!p.pool) p.pool = { energy: 0, power: {} }
  const producesD = (r: EngineCard, d: Domain) => ((def(r) as { produces?: Domain[] })?.produces ?? []).includes(d)
  for (const [d, n] of Object.entries(power) as [Domain, number][]) {
    let need = n ?? 0
    const fromPool = Math.min(need, p.pool.power[d] ?? 0)
    p.pool.power[d] = (p.pool.power[d] ?? 0) - fromPool
    if ((p.pool.power[d] ?? 0) <= 0) delete p.pool.power[d]
    need -= fromPool
    while (need > 0) {
      const idx = p.zones.runePool.findIndex((r) => !r.exhausted && producesD(r, d))
      if (idx < 0) break
      const [r] = p.zones.runePool.splice(idx, 1)
      p.zones.runeDeck.push({ ...r, exhausted: false, damage: 0 })
      need--
    }
  }
  const fromPoolE = Math.min(energy, p.pool.energy)
  p.pool.energy -= fromPoolE
  let needE = energy - fromPoolE
  for (const r of p.zones.runePool) { if (needE <= 0) break; if (!r.exhausted) { r.exhausted = true; needE-- } }
  return true
}

/** Play a specific card from `player`'s trash, paying a fixed alternate cost
 *  instead of its printed cost (Flame Chompers, Immortal Phoenix). No-op if the
 *  card isn't in trash or the cost can't be paid. */
function playFromTrashPayingCost(s: MatchState, player: PlayerId, iid: string, cost: { energy: number; power: Partial<Record<Domain, number>> }): MatchState {
  const p = s.players[player]
  const idx = p.zones.trash.findIndex((c) => c.iid === iid)
  if (idx < 0) return s
  const name = getCard(p.zones.trash[idx].cardId)?.name ?? 'a card'
  if (!payFixedCost(s, player, cost.energy, cost.power)) return log(s, player, `Couldn't play ${name} from trash — can't pay ${costGlyphLabel(cost)}.`)
  const [card] = p.zones.trash.splice(idx, 1)
  p.zones.base.push({ ...card, exhausted: !controlsBreacherAura(s, player), damage: 0, attached: [], enteredTurn: s.turn }) // Rek'Sai - Breacher
  return log(s, player, `Played ${name} from trash (paid ${costGlyphLabel(cost)}).`)
}

/** "When you discard me, you may pay <cost> to play me" (Flame Chompers) → the
 *  alternate cost, or null if the card has no such trigger. */
function discardSelfReplayCost(card: Card | undefined): { energy: number; power: Partial<Record<Domain, number>> } | null {
  const m = (card?.text ?? '').match(/when you discard me,? you may pay (.*?) to play me/i)
  return m ? parseCostGlyphs(m[1]) : null
}

/** Fire "when you discard one or more cards" global triggers (Jinx - Rebel —
 *  ready me + +1 Might this turn). Call once per discard event for `player`.
 *  `discarded` (the cards just discarded) lets "when you discard me, pay X to play
 *  me" self-triggers (Flame Chompers) offer their optional replay. */
function fireDiscard(s: MatchState, player: PlayerId, discarded: EngineCard[] = []): MatchState {
  if (s.players[player]) s.players[player].discardedThisTurn = true // gates Raging Soul
  s = fireTriggers(s, collectGlobal(s, player, 'discard'))
  for (const c of discarded) {
    const cost = discardSelfReplayCost(getCard(c.cardId))
    if (cost && s.players[player].zones.trash.some((x) => x.iid === c.iid) && canAffordFixed(s, player, cost.energy, cost.power)) {
      offerChoice(s, {
        player, kind: 'discardReplay', bfIndex: -1,
        prompt: `${getCard(c.cardId)?.name} — pay ${costGlyphLabel(cost)} to play it from your trash?`,
        options: [{ iid: c.iid, label: `Pay ${costGlyphLabel(cost)} & play` }],
        payload: JSON.stringify(cost),
      })
      break // only one pendingChoice at a time
    }
  }
  return s
}

/** "When you conquer, you may discard 1 to return this from your trash to your
 *  hand" (Super Mega Death Rocket!) — a trigger that fires while the card sits in
 *  the trash. Offered after a conquer if the player has a card to discard. */
function offerTrashConquerReturn(s: MatchState, player: PlayerId): MatchState {
  if (s.pendingChoice || s.players[player].zones.hand.length === 0) return s
  const card = s.players[player].zones.trash.find((c) =>
    /when you conquer,?[\s\S]*?discard[\s\S]*?return this from your trash to your hand/i.test(getCard(c.cardId)?.text ?? ''),
  )
  if (!card) return s
  offerChoice(s, {
    player, kind: 'trashConquerReturn', bfIndex: -1,
    prompt: `${getCard(card.cardId)?.name} — discard 1 to return it from your trash to your hand?`,
    options: [{ iid: card.iid, label: 'Discard 1 & return to hand' }],
  })
  return s
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
      for (const l of fireSpendBuffInline(s, player)) note(player, l) // Fae Dragon
      return true
    },
    hasMightyHere(player, bfIndex) {
      return !!s.battlefields[bfIndex]?.units.some((x) => x.owner === player && mightOf(x) >= 5)
    },
    score(player, n) {
      s.players[player].points += n
      emit({ kind: 'score', player, amount: n })
      fireOpponentScore(s, player) // Sumpworks Map
      note(player, `Scored ${n} point(s).`)
    },
    predict(player) {
      const top = s.players[player].zones.mainDeck[0]
      if (!top) return
      s.vision = { player, cardId: top.cardId }
      note(player, `Predict — look at the top of your deck; you may recycle it.`)
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
  // Running tally of Energy spent on spells this turn (Prepared Neophyte, Jhin).
  s.players[player].energySpentOnSpellsThisTurn = (s.players[player].energySpentOnSpellsThisTurn ?? 0) + spentEnergy
  s.players[player].spellPlayedThisTurn = true // Crescent Guardian gate (0-cost spells count too)
  for (let i = 0; i < s.battlefields.length; i++) {
    const script = bfScriptAt(s, i)
    if (script?.onSpellPlayed) script.onSpellPlayed(makeBfApi(s), player, i, spentEnergy)
  }
  return s
}

/** Minotaur Reckoner: "Units can't move to base." — a global aura (affects both
 *  players) while any such unit is in play. */
function globalNoMoveToBaseActive(s: MatchState): boolean {
  const has = (u: EngineCard) => /units? can'?t move to base/i.test(getCard(u.cardId)?.text ?? '')
  return s.battlefields.some((b) => b.units.some(has)) || s.players.some((p) => p.zones.base.some(has))
}

/** Determined Sentry: "I can't move to base." — a per-unit self restriction. */
function unitCantMoveToBase(u: EngineCard): boolean {
  return /\bi can'?t move to base/i.test(getCard(u.cardId)?.text ?? '')
}

/** Maduli the Gatekeeper: "I can't be readied." — skipped by every ready path. */
function unitCantBeReadied(u: EngineCard): boolean {
  return /\bi can'?t be readied/i.test(getCard(u.cardId)?.text ?? '')
}

/** Mageseeker Warden's auras are active only while it (owned by `owner`) is at a battlefield. */
function mageseekerWardenAtBf(s: MatchState, owner: PlayerId): boolean {
  return s.battlefields.some((b) => b.units.some((u) => u.owner === owner && getCard(u.cardId)?.name === 'Mageseeker Warden'))
}

/** True if an ENEMY of `player` has a Mageseeker Warden at a battlefield — locks
 *  `player` to playing units-to-base only, and blocks effect-readies of their units. */
function enemyWardenAtBf(s: MatchState, player: PlayerId): boolean {
  return s.players.some((_, i) => i !== player && mageseekerWardenAtBf(s, i))
}

/** Magma Wurm: "Other friendly units enter ready." — an aura while it's in play. */
function friendlyUnitsEnterReadyAura(s: MatchState, player: PlayerId): boolean {
  return [...s.battlefields.flatMap((b) => b.units), ...s.players[player].zones.base]
    .some((u) => u.owner === player && /other friendly units enter ready/i.test(getCard(u.cardId)?.text ?? ''))
}

/** Auto-pull the strongest enemy unit from *another* location to battlefield
 *  `destBf` (Blitzcrank, Irresistible Faefolk, Evelynn, Iascylla). "You may move
 *  an enemy unit to here" — the destination is fixed, so the only choice is which
 *  enemy; per the auto-resolve preference we pick the strongest. Triggers a
 *  showdown/conquer if the pull contests the destination. Returns threaded state. */
function pullEnemyToBf(s: MatchState, player: PlayerId, destBf: number, label: string): MatchState {
  if (destBf < 0 || destBf >= s.battlefields.length) return s
  const enemies = s.battlefields.flatMap((b, bi) =>
    bi === destBf ? [] : b.units.filter((u) => u.owner !== player && getCard(u.cardId)?.type === 'unit'),
  )
  if (!enemies.length) return s
  const target = enemies.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi))
  const pulled = pluckCardAnywhere(s, target.iid)
  if (!pulled) return s
  const priorCtrl = s.battlefields[destBf].controller
  s.battlefields[destBf].units.push(pulled)
  recomputeControllers(s)
  s = log(s, player, `${label}: pulled ${getCard(pulled.cardId)?.name} to battlefield ${destBf + 1}.`)
  s = blastConeOnEnemyMove(s, player, pulled.iid)
  return showdownOrConquerAfterEffectMove(s, destBf, pulled.iid, priorCtrl)
}

/** Blast Cone (gear): "When you move an enemy unit, you may exhaust this to [Stun]
 *  it." Auto-fired after `mover` moves an enemy unit — exhausts one ready Blast Cone
 *  the mover controls (in their base) and stuns the moved unit. */
function blastConeOnEnemyMove(s: MatchState, mover: PlayerId, enemyIid: string): MatchState {
  const enemy = findUnitAnywhere(s, enemyIid)
  if (!enemy || enemy.owner === mover || enemy.stunned) return s
  const cone = s.players[mover].zones.base.find((c) => getCard(c.cardId)?.name === 'Blast Cone' && !c.exhausted)
  if (!cone) return s
  cone.exhausted = true
  enemy.stunned = true
  emit({ kind: 'stun', iid: enemy.iid, player: mover })
  s = log(s, mover, `Blast Cone: exhausted to Stun ${getCard(enemy.cardId)?.name}.`)
  return fireStun(s, mover, battlefieldOf(s, enemyIid))
}

/** A gear card's printed Energy cost (the Card union's BattlefieldCard arm has no
 *  `energy`, so narrow via cast). */
function gearEnergyOf(c: EngineCard): number {
  return (getCard(c.cardId) as { energy?: number } | undefined)?.energy ?? 0
}

/** Every gear currently in play: unattached gear in all bases, plus attached gear
 *  reconstructed from `unit.attached` "cardId|iid" refs (Disarming Rake, Detonate,
 *  Legion Quartermaster, etc.). */
function allGearInPlay(s: MatchState): EngineCard[] {
  const out: EngineCard[] = []
  for (const pl of s.players) {
    for (const c of pl.zones.base) if (getCard(c.cardId)?.type === 'gear') out.push(c)
    const units = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id && getCard(u.cardId)?.type === 'unit')
    for (const u of units)
      for (const ref of u.attached ?? []) {
        const [cid, iid] = ref.split('|')
        if (cid && getCard(cid)?.type === 'gear')
          out.push({ iid: iid || `${pl.id}:gear:${cid}`, cardId: cid, owner: pl.id, exhausted: false, damage: 0, attached: [] })
      }
  }
  return out
}

/** Kill a gear by iid — removes it from wherever it lives (unattached base gear or
 *  attached to a unit) and sends it to the gear's OWNER's trash (Rule 107.1.d). Gold
 *  gear tokens cease to exist (sendToTrash drops tokens). Returns the owner whose
 *  gear was killed, or null if not found. */
function killGearByIid(s: MatchState, gearIid: string): PlayerId | null {
  for (const pl of s.players) {
    const bi = pl.zones.base.findIndex((c) => c.iid === gearIid && getCard(c.cardId)?.type === 'gear')
    if (bi >= 0) { const [g] = pl.zones.base.splice(bi, 1); sendToTrash(pl, g); return pl.id }
    const units = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id)
    for (const u of units) {
      const ri = (u.attached ?? []).findIndex((ref) => ref.split('|')[1] === gearIid)
      if (ri >= 0) {
        const [ref] = u.attached.splice(ri, 1)
        const [cid, iid] = ref.split('|')
        sendToTrash(s.players[u.owner], { iid: iid || `${u.owner}:gear:${cid}`, cardId: cid, owner: u.owner, exhausted: false, damage: 0, attached: [] })
        return u.owner
      }
    }
  }
  return null
}

/** Tideturner: "you may choose a unit you control at ANOTHER location. Move me to its
 *  location and it to my original location." Auto-picks the strongest friendly unit at a
 *  different location (per the auto-resolve preference) and swaps the two — preserving
 *  ready/exhausted/damage (the swap is not a standard move) — then recomputes control and
 *  opens any showdown the relocation creates. No-op if no friendly unit is elsewhere. */
function tideturnerSwap(s: MatchState, player: PlayerId, tideIid: string): MatchState {
  const tideBf = battlefieldOf(s, tideIid)
  const allies = [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]
    .filter((u) => u.owner === player && u.iid !== tideIid && getCard(u.cardId)?.type === 'unit' && battlefieldOf(s, u.iid) !== tideBf)
  if (!allies.length) return s
  const partner = allies.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi))
  const tide = findUnitAnywhere(s, tideIid)
  if (!tide) return s
  const partnerBf = battlefieldOf(s, partner.iid)
  const tidePriorCtrl = tideBf >= 0 ? s.battlefields[tideBf].controller : null
  const partnerPriorCtrl = partnerBf >= 0 ? s.battlefields[partnerBf].controller : null
  const pull = (inst: EngineCard, bi: number) => {
    if (bi >= 0) s.battlefields[bi].units.splice(s.battlefields[bi].units.findIndex((x) => x.iid === inst.iid), 1)
    else s.players[player].zones.base.splice(s.players[player].zones.base.findIndex((x) => x.iid === inst.iid), 1)
  }
  pull(tide, tideBf)
  pull(partner, partnerBf)
  ;(partnerBf >= 0 ? s.battlefields[partnerBf].units : s.players[player].zones.base).push(tide)
  ;(tideBf >= 0 ? s.battlefields[tideBf].units : s.players[player].zones.base).push(partner)
  recomputeControllers(s)
  s = log(s, player, `Tideturner: swapped locations with ${getCard(partner.cardId)?.name}.`)
  if (partnerBf >= 0) s = showdownOrConquerAfterEffectMove(s, partnerBf, tide.iid, partnerPriorCtrl)
  if (tideBf >= 0) s = showdownOrConquerAfterEffectMove(s, tideBf, partner.iid, tidePriorCtrl)
  return s
}

/** Whether `player` controls a Void Hatchling (its pre-reveal peek is active). */
function hatchlingActive(s: MatchState, player: PlayerId): boolean {
  return controlledPermanents(s, player).some((u) => (getCard(u.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '') === 'Void Hatchling')
}

/** Void Hatchling: "If you would reveal cards from a deck, look at the top card first.
 *  You may recycle it. Then reveal those cards." Mutates `deck` in place. Auto-recycles
 *  the top card ONLY when it cannot satisfy a type-seeking reveal (so the reveal digs one
 *  card deeper for a match — never losing a card it would have used). No-op for untyped
 *  reveals, where recycling would be a blind gamble. Returns log lines. (The recycleCard
 *  trigger, e.g. Karma - Channeler, is not fired from this pre-peek — minor, flagged.) */
function hatchlingPrePeek(s: MatchState, player: PlayerId, deck: EngineCard[], seeksType: string | undefined): string[] {
  if (!seeksType || !deck.length || !hatchlingActive(s, player)) return []
  const top = deck[0]
  if (getCard(top.cardId)?.type === seeksType) return [] // top already matches — keep it
  deck.shift()
  deck.push(top) // recycle to the bottom
  return [`Void Hatchling: looked at the top and recycled ${getCard(top.cardId)?.name ?? 'a card'} before revealing.`]
}

/** Return a gear by iid to its owner's hand (Legion Quartermaster). Mirrors
 *  killGearByIid but routes to the hand. Returns the owner, or null. */
function bounceGearByIid(s: MatchState, gearIid: string): PlayerId | null {
  for (const pl of s.players) {
    const bi = pl.zones.base.findIndex((c) => c.iid === gearIid && getCard(c.cardId)?.type === 'gear')
    if (bi >= 0) { const [g] = pl.zones.base.splice(bi, 1); pl.zones.hand.push({ ...g, exhausted: false, damage: 0, attached: [] }); return pl.id }
    const units = [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id)
    for (const u of units) {
      const ri = (u.attached ?? []).findIndex((ref) => ref.split('|')[1] === gearIid)
      if (ri >= 0) {
        const [ref] = u.attached.splice(ri, 1)
        const [cid, iid] = ref.split('|')
        s.players[u.owner].zones.hand.push({ iid: iid || `${u.owner}:gear:${cid}`, cardId: cid, owner: u.owner, exhausted: false, damage: 0, attached: [] })
        return u.owner
      }
    }
  }
  return null
}

/** Auto-pick + kill the lowest-cost gear matching a killGear spec (scope + maxEnergy),
 *  applying "its controller draws N" if set. Returns log lines. */
function applyKillGear(s: MatchState, player: PlayerId, spec: { scope: 'friendly' | 'enemy' | 'any'; maxEnergy: number | null }, controllerDraw = 0): { killed: boolean; lines: string[] } {
  const gears = allGearInPlay(s).filter((g) => {
    if (spec.scope === 'friendly' && g.owner !== player) return false
    if (spec.scope === 'enemy' && g.owner === player) return false
    if (spec.maxEnergy != null && gearEnergyOf(g) > spec.maxEnergy) return false
    return true
  })
  if (!gears.length) return { killed: false, lines: ['No valid gear to kill.'] }
  const pick = gears.reduce((lo, g) => (gearEnergyOf(g) <= gearEnergyOf(lo) ? g : lo))
  const nm = getCard(pick.cardId)?.name ?? 'a gear'
  const owner = killGearByIid(s, pick.iid)
  const lines = [`Killed ${nm}.`]
  if (controllerDraw > 0 && owner != null) { drawN(s.players[owner], controllerDraw); lines.push(`Its controller drew ${controllerDraw}.`) }
  return { killed: true, lines }
}

/** Record a conquered battlefield for the turn (Perched Grimwyrm's placement
 *  predicate). Deduped; cleared at turn start. */
function markConquered(s: MatchState, player: PlayerId, bfIndex: number): void {
  const p = s.players[player]
  if (!p) return
  if (!p.conqueredThisTurn) p.conqueredThisTurn = []
  if (!p.conqueredThisTurn.includes(bfIndex)) p.conqueredThisTurn.push(bfIndex)
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
      offerChoice(s, { player, kind: 'daisReturn', bfIndex, prompt: "Emperor's Dais — pay 1 and return a unit here to hand to play a Sand Soldier here?", options: opts })
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

/** Aphelios - Exalted: "When you attach an Equipment to me, choose one that hasn't
 *  been chosen this turn — Ready 2 runes / Channel 1 rune exhausted / Buff a friendly
 *  unit." Auto-resolves the next un-chosen mode (in order); no-op after all 3. */
function fireAttachEquip(s: MatchState, player: PlayerId, target: EngineCard): MatchState {
  if (target.owner !== player) return s
  const name = (getCard(target.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  // Generic "When you attach an Equipment to me, you may pay N Energy to draw M"
  // self-trigger (Jax - Unrelenting). Auto-paid when affordable (pure benefit).
  const tt = (getCard(target.cardId)?.text ?? '').toLowerCase()
  const drawM = tt.match(/when you attach an equipment to me,? you may pay :rb_energy_(\d+): to draw (\d+)/)
  if (drawM) {
    const cost = { energy: parseInt(drawM[1], 10), power: {} }
    const pp = s.players[player]
    const pay = autoPay(pp, cost)
    if (pay && !applyPayment(pp, cost, pay)) {
      const drew = drawN(pp, parseInt(drawM[2], 10))
      s = log(s, player, `${name}: paid ${cost.energy} Energy to draw ${drew} (Equipment attached).`)
    }
  }
  if (name !== 'Aphelios - Exalted') return s
  const p = s.players[player]
  const used = p.apheliosModesThisTurn ?? 0
  if (used >= 3) return s
  p.apheliosModesThisTurn = used + 1
  if (used === 0) {
    const before = p.zones.runePool.filter((r) => r.exhausted).length
    makeBfApi(s).readyRunes(player, 2)
    const readied = before - p.zones.runePool.filter((r) => r.exhausted).length
    return log(s, player, `Aphelios - Exalted: readied ${readied} rune(s).`)
  }
  if (used === 1) {
    const n = channelN(p, 1, true)
    return log(s, player, `Aphelios - Exalted: channeled ${n} rune (exhausted).`)
  }
  const friendly = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter(
    (u) => u.owner === player && getCard(u.cardId)?.type === 'unit' && !(u.buffs ?? 0),
  )
  if (!friendly.length) return s
  const tgt = friendly.reduce((b, u) => (mightOf(u) > mightOf(b) ? u : b))
  tgt.buffs = 1
  emit({ kind: 'buff', iid: tgt.iid, player })
  return log(s, player, `Aphelios - Exalted: buffed ${getCard(tgt.cardId)?.name}.`)
}

/** Evaluate a CONDITIONAL "I enter ready" guard (the clause containing "I enter
 *  ready" had an "if …"). Recognized guards: "if you control another <Tag>"
 *  (Direwing→Dragon, Breakneck→Mech), "if an opponent controls a battlefield"
 *  (Vayne - Hunter), "if a/friendly unit died this turn" (Towering Pairofant,
 *  Shadow Watcher), "if you have N or fewer cards in your hand" (Dunebreaker),
 *  "if you have N or more other units in your base" (Xin Zhao - Vigilant), and
 *  "if you play me to a battlefield" (Shadow). Unrecognized → false (stay exhausted). */
function enterReadyConditionMet(s: MatchState, p: PlayerState, clause: string, toBattlefield: number | null): boolean {
  const t = clause.toLowerCase()
  const NW: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }
  const toN = (w: string) => NW[w] ?? (parseInt(w, 10) || 0)
  const controlsTag = (tag: string) =>
    [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].some(
      (u) => u.owner === p.id && (getCard(u.cardId)?.tags ?? []).some((x) => x.toLowerCase() === tag),
    )
  let m = t.match(/if you control (?:another |an? )?([a-z][a-z' -]*?)(?:\.|,| then|$)/)
  if (m) return controlsTag(m[1].trim())
  if (/if an opponent controls a battlefield/.test(t)) return s.battlefields.some((b) => b.controller != null && b.controller !== p.id)
  if (/if a(?:ny)?(?: friendly)? unit died[^.]*this turn/.test(t)) return !!s.unitDiedThisTurn
  m = t.match(/if you have (\d+|a|an|one|two|three|four|five) or fewer cards? in your hand/)
  if (m) return p.zones.hand.length <= toN(m[1])
  m = t.match(/if you have (\d+|a|an|one|two|three|four|five) or more other units? in your base/)
  if (m) return p.zones.base.filter((u) => getCard(u.cardId)?.type === 'unit').length >= toN(m[1])
  if (/if you play me to a battlefield/.test(t)) return toBattlefield != null
  return false
}

/** Renata Glasc - Industrialist: "Your tokens enter ready." */
function tokensEnterReady(s: MatchState, player: PlayerId): boolean {
  return controlsUnitNamed(s, player, 'Renata Glasc - Industrialist')
}

/** Zilean - Time Mage: "Once each turn, if you would play a token UNIT while I'm at
 *  a battlefield, you may play that token and an additional copy instead." Returns
 *  the (possibly doubled) count and marks the once-per-turn use. Gold (gear) tokens
 *  don't count — only token units. */
function zileanDouble(s: MatchState, player: PlayerId, n: number): number {
  const p = s.players[player]
  if (p.zileanDoubledThisTurn || n <= 0) return n
  const baseNm = (x: string | undefined) => (x ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  const atBf = s.battlefields.some((b) => b.units.some((u) => u.owner === player && baseNm(getCard(u.cardId)?.name) === 'Zilean - Time Mage'))
  if (!atBf) return n
  p.zileanDoubledThisTurn = true
  return n * 2
}

/** Whether `player`'s Legend's base name matches (art-variant suffix stripped). */
function playerHasLegend(s: MatchState, player: PlayerId, name: string): boolean {
  const lg = s.players[player]?.legend
  return !!lg && (getCard(lg.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() === name
}

/** The highest-Might enemy unit at a battlefield (for "an enemy unit here" auto-
 *  targeting). Undefined if there are none. */
function pickStrongestEnemy(units: EngineCard[], player: PlayerId): EngineCard | undefined {
  const enemies = units.filter((u) => u.owner !== player)
  if (!enemies.length) return undefined
  return enemies.reduce((best, u) => (mightOf(u) > mightOf(best) ? u : best))
}

/** Auto-target for "deal damage to an enemy unit here": prefer the highest-Might
 *  enemy the damage would kill (remaining Might ≤ amount); else the highest-Might
 *  enemy (soften the biggest threat / set up Warwick). */
function pickEnemyToDamage(units: EngineCard[], player: PlayerId, amount: number): EngineCard | undefined {
  const enemies = units.filter((u) => u.owner !== player)
  if (!enemies.length) return undefined
  const killable = enemies.filter((u) => mightOf(u) <= amount)
  const pool = killable.length ? killable : enemies
  return pool.reduce((best, u) => (mightOf(u) > mightOf(best) ? u : best))
}

/** State-aware [Tank]: the printed keyword, or a token unit while its controller
 *  has Lillia - Protector of Dreams in play ("Your token units have [Tank]"). */
function hasTank(s: MatchState, u: EngineCard): boolean {
  if (parseKeywords(def(u)).tank) return true
  if (u.grantTank) return true // [Tank] granted this turn (Yuumi - Magical Cat, Block)
  return getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Lillia - Protector of Dreams')
}

/** State-aware static Might auras a controller grants its own units. Soul
 *  Shepherd: "Your token units have +1 Might." Added on top of printed/role
 *  Might wherever combat Might is computed. */
function auraMightBonus(s: MatchState, u: EngineCard): number {
  let b = 0
  if (getCard(u.cardId)?.supertype === 'token' && controlsUnitNamed(s, u.owner, 'Soul Shepherd')) b += 1
  // Rumble - Scrapper: "Your Mechs have +1 Might (including me)."
  if ((getCard(u.cardId)?.tags ?? []).includes('Mech') && controlsUnitNamed(s, u.owner, 'Rumble - Scrapper')) b += 1
  // Baron Nashor: "Other friendly units have +2 Might." (global friendly aura.)
  if (getCard(u.cardId)?.name !== 'Baron Nashor' && controlsUnitNamed(s, u.owner, 'Baron Nashor')) b += 2
  // (Master Yi - Wuju Master's "[Level 6] Your units have +1" is already handled in
  // conditionalMight's legend-granted-buffs block — no duplicate here.)
  // Self-scaling champions whose Might tracks a game value (state-aware, so the
  // bonus updates live and is consulted by combat — showdownSteps/combatMightAt).
  const name = (getCard(u.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '')
  if (name === 'Draven - Showboat') b += s.players[u.owner]?.points ?? 0 // "increased by your points"
  if (name === 'Dr. Mundo - Expert') b += s.players[u.owner]?.zones.trash.length ?? 0 // "by cards in your trash"
  return b
}

/** The effective [Repeat] cost when `player` plays `card`: the printed keyword
 *  cost, or — if The Academy granted Repeat this turn — the spell's base cost;
 *  then reduced by 1 Energy (min 0) while the player controls Marai Spire.
 *  Null when the spell has no Repeat (keyword or granted). */
export function repeatCostFor(s: MatchState, player: PlayerId, card: Card): ResolvedCost | null {
  let cost: ResolvedCost | null = repeatCost(card)
  if (!cost && s.players[player]?.grantRepeatNextSpell && card.type === 'spell') cost = costOf(card)
  // Syndra - Transcendent: "While I'm in a showdown, your spells have [Repeat] 2 Energy
  // + 1 Chaos." Grants Repeat to any of your spells while she's at the open showdown.
  if (!cost && card.type === 'spell' && s.showdown) {
    const sb = s.battlefields[s.showdown.battlefield]?.units ?? []
    if (sb.some((u) => u.owner === player && /while (?:i'?m|i am) in a showdown, your spells have \[repeat\]/i.test(getCard(u.cardId)?.text ?? '')))
      cost = { energy: 2, power: { chaos: 1 } }
  }
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

/** Every Equipment a player controls — detached in base AND already attached to
 *  their units — as attach-choice options. Lets "attach an Equipment you control
 *  to a unit" re-seat already-attached gear (Jax - Grandmaster's 2nd ability). */
function controlledEquipOptions(s: MatchState, player: PlayerId): { iid: string; label: string }[] {
  const out: { iid: string; label: string }[] = []
  for (const c of s.players[player].zones.base) if (isEquipment(c)) out.push({ iid: c.iid, label: getCard(c.cardId)?.name ?? c.iid })
  for (const u of [...s.players[player].zones.base, ...s.battlefields.flatMap((b) => b.units)]) {
    if (u.owner !== player) continue
    for (const ref of u.attached) {
      const [cid, iid] = ref.split('|')
      if (getCard(cid)?.type === 'gear') out.push({ iid, label: `${getCard(cid)?.name ?? cid} (on ${getCard(u.cardId)?.name})` })
    }
  }
  return out
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
  /** Cards to discard from hand as an additional cost (Gutter Palace). */
  discard: number
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
    const wm = text.match(/(?:from your trash|kill this|discard (?:\d+|an?)(?: cards?)?)\s*:/i)
    if (!wm) return null
    sepEnd = (wm.index ?? 0) + wm[0].length
    const before = text.slice(0, sepEnd - 1)
    costStr = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(')')) + 1)
  }
  const cl = costStr.toLowerCase()
  if (!/:rb_exhaust:|:rb_energy_\d+:|:rb_rune_[a-z]+:|recycle (?:\d+|an?) (?:\w+ )?from your trash|kill this|discard (?:\d+|an?)\b/.test(cl)) return null
  const rest = text.slice(sepEnd).replace(/^\s+/, '')
  const pIdx = rest.indexOf('.')
  const effectText = (pIdx >= 0 ? rest.slice(0, pIdx) : rest).trim()
  const power: Partial<Record<Domain, number>> = {}
  for (const rm of cl.matchAll(/:rb_rune_([a-z]+):/g)) power[rm[1] as Domain] = (power[rm[1] as Domain] ?? 0) + 1
  // Most activated abilities are one sentence, but deck-dig / play-from-zone ones
  // span sentences (Baited Hook: "Kill a friendly unit. Look at the top 5 …") and
  // the first-sentence `effectText` drops the play step. Graft those fields from a
  // full-clause parse so they resolve — without disturbing single-sentence cards or
  // the ones whose later sentence is handled via srcText.
  const effect = parseEffectText(effectText)
  const full = parseEffectText(rest)
  if (!effect.peekBanishPlay && full.peekBanishPlay) effect.peekBanishPlay = full.peekBanishPlay
  if (!effect.peekDraw && full.peekDraw) effect.peekDraw = full.peekDraw
  if (!effect.peekToHand && full.peekToHand) effect.peekToHand = full.peekToHand
  if (!effect.playUnitFromTrash && full.playUnitFromTrash) effect.playUnitFromTrash = full.playUnitFromTrash
  if (!effect.playUnitFromHand && full.playUnitFromHand) effect.playUnitFromHand = full.playUnitFromHand
  if (!effect.returnFromTrash && full.returnFromTrash) effect.returnFromTrash = full.returnFromTrash
  if (!effect.revealPlayFromDeck && full.revealPlayFromDeck) effect.revealPlayFromDeck = true
  return {
    exhaust: /:rb_exhaust:/.test(cl),
    energy: parseInt((cl.match(/:rb_energy_(\d+):/) || [])[1] || '0', 10),
    power,
    // "recycle N from your trash" (Vi) or "recycle a unit/card from your trash"
    // (Assembly Rig → counts as 1).
    recycleTrash: (() => {
      const rm = cl.match(/recycle (\d+|an?) (?:\w+ )?from your trash/)
      return rm ? (/^\d+$/.test(rm[1]) ? parseInt(rm[1], 10) : 1) : 0
    })(),
    // "Discard N" / "discard a card" additional cost (Gutter Palace).
    discard: (() => {
      const dm = cl.match(/discard (\d+|an?)\b/)
      return dm ? (/^\d+$/.test(dm[1]) ? parseInt(dm[1], 10) : 1) : 0
    })(),
    killThis: /\bkill this\b/.test(cl),
    requiresBattlefield: /only while (?:i'm|i am) at a battlefield/i.test(text),
    doubleMight: /double my might/i.test(effectText),
    effect,
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
  // "Use only once per turn." — Azir - Ascendant's swap ability.
  const cardName = (card?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (/use only once per turn/.test(t) && cardName === 'Azir - Ascendant')
    return !p.azirSwappedThisTurn
  return true
}

/** Whether `player` can activate the unit `iid`'s own ability right now (controls
 *  it, not exhausted if exhaust-cost, at a battlefield if required, can pay). */
export function canActivateUnit(s: MatchState, player: PlayerId, iid: string): UnitAbility | null {
  const u = controlledInstance(s, player, iid)
  if (!u) return null
  // Heimerdinger - Inventor has no printed "::" ability of its own; instead it
  // borrows any friendly [Exhaust] ability. Surface a synthetic, no-target
  // ability so the UI shows an Activate affordance; the reducer opens a
  // pendingChoice (heimerBorrow) to pick which ability to use.
  if (isHeimerdinger(getCard(u.cardId))) {
    if (!canActivateHeimer(s, player, iid)) return null
    return {
      exhaust: true, energy: 0, power: {}, recycleTrash: 0, discard: 0,
      killThis: false, requiresBattlefield: false, doubleMight: false,
      effect: parseEffectText(''), effectText: 'borrow an ability', label: 'Borrow an ability',
    }
  }
  if (!abilityUsableNow(getCard(u.cardId), s.players[player])) return null
  // Abilities the dedicated printed-activated path already handles (Orb of
  // Regret, Lux - Crownguard) go through ACTIVATE_ABILITY instead.
  if (printedActivated(getCard(u.cardId))) return null
  const ab = unitActivatedAbility(getCard(u.cardId))
  if (!ab) return null
  if (ab.exhaust && u.exhausted) return null
  if (ab.requiresBattlefield && battlefieldOf(s, iid) < 0) return null
  if (ab.recycleTrash > s.players[player].zones.trash.length) return null
  if (ab.discard > s.players[player].zones.hand.length) return null
  const cost = { energy: ab.energy, power: ab.power }
  if (!costIsFree(cost) && !autoPay(s.players[player], cost)) return null
  return ab
}

/** Heimerdinger - Inventor: "I have all :rb_exhaust: abilities of all friendly
 *  legends, units, and gear." */
function isHeimerdinger(card: Card | undefined): boolean {
  return (card?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Heimerdinger - Inventor'
}

/** A friendly permanent (unit / gear / legend, NOT Heimerdinger itself) whose
 *  printed activated ability is an [Exhaust]-cost ability — a Heimerdinger borrow
 *  source. Returns {iid → ability} entries the controller could currently afford
 *  to invoke (ignoring the source's own exhausted state, since Heimerdinger pays
 *  the exhaust instead of the source). */
function heimerBorrowSources(s: MatchState, player: PlayerId): { src: EngineCard; ab: UnitAbility }[] {
  const out: { src: EngineCard; ab: UnitAbility }[] = []
  for (const perm of controlledPermanents(s, player)) {
    const card = getCard(perm.cardId)
    if (isHeimerdinger(card)) continue // Heimerdinger doesn't borrow its own text
    if (printedActivated(card)) continue // handled via ACTIVATE_ABILITY, not the borrow flow
    const ab = unitActivatedAbility(card)
    if (!ab || !ab.exhaust) continue // only [Exhaust]-cost abilities are granted
    if (!abilityUsableNow(card, s.players[player])) continue
    if (ab.requiresBattlefield && battlefieldOf(s, perm.iid) < 0) continue
    if (ab.recycleTrash > s.players[player].zones.trash.length) continue
    if (ab.discard > s.players[player].zones.hand.length) continue
    const cost = { energy: ab.energy, power: ab.power }
    if (!costIsFree(cost) && !autoPay(s.players[player], cost)) continue
    out.push({ src: perm, ab })
  }
  return out
}

/** Whether `player`'s Heimerdinger `iid` can be activated to borrow some friendly
 *  permanent's [Exhaust] ability right now (Heimerdinger ready + ≥1 borrow source). */
function canActivateHeimer(s: MatchState, player: PlayerId, iid: string): boolean {
  const u = controlledInstance(s, player, iid)
  if (!u || u.exhausted || !isHeimerdinger(getCard(u.cardId))) return false
  return heimerBorrowSources(s, player).length > 0
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
    // "The first time a player plays a non-token unit here each turn, they may move
    //  another unit they control here to its base." Gate once per turn per player.
    const pp = s.players[player]
    const ssKey = `star-spring-bf${bfIndex}`
    if (!pp.oncePerTurnUsed) pp.oncePerTurnUsed = {}
    if (!pp.oncePerTurnUsed[ssKey]) {
      pp.oncePerTurnUsed[ssKey] = true
      const opts = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner === player && u.iid !== iid).map((u) => unitOpt(u))
      if (opts.length) offerChoice(s, { player, kind: 'moveAnyToBase', bfIndex, prompt: 'Star Spring — move another unit you control to its base?', options: opts })
    }
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
  // Attached gear can't go to hand with the unit — detach each to its owner's base
  // (a card returning to hand sheds its Equipment, same as a manual Detach).
  for (const ref of u.attached) {
    const [gCardId, gIid] = ref.split('|')
    if (gCardId) s.players[u.owner].zones.base.push({ iid: gIid || `${u.owner}:gear:${gCardId}`, cardId: gCardId, owner: u.owner, exhausted: false, damage: 0, attached: [] })
  }
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
  let u = findUnitAnywhere(s, iid)
  // Champion Zone: a unit may sit in a player's Champion Zone (Teemo - Swift Scout
  // can return a Teemo from there to hand).
  let fromChampion = -1
  if (!u) {
    fromChampion = s.players.findIndex((pl) => pl.champion?.iid === iid)
    if (fromChampion >= 0) u = s.players[fromChampion].champion!
  }
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
  u.attached = [] // already detached above — prevent returnUnitToHand from re-detaching
  const bfi = s.battlefields.findIndex((b) => b.units.some((x) => x.iid === iid))
  if (bfi >= 0) {
    if (isToken) {
      s.battlefields[bfi].units = s.battlefields[bfi].units.filter((x) => x.iid !== iid)
      recomputeControllers(s)
    } else {
      returnUnitToHand(s, bfi, iid)
    }
  } else if (fromChampion >= 0) {
    s.players[fromChampion].champion = null
    if (!isToken) s.players[owner].zones.hand.push({ iid: u.iid, cardId: u.cardId, owner, exhausted: false, damage: 0, attached: [] })
  } else {
    const base = s.players[owner].zones.base
    const idx = base.findIndex((x) => x.iid === iid)
    if (idx < 0) return s
    const [bu] = base.splice(idx, 1)
    if (!isToken) s.players[owner].zones.hand.push({ iid: bu.iid, cardId: bu.cardId, owner, exhausted: false, damage: 0, attached: [] })
  }
  if (bfi >= 0) emit({ kind: 'move', iid, player: owner, cardId: u.cardId, retreat: 'hand' })
  else emit({ kind: 'play', iid, player: owner })
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
    s.players[player].xpGainedThisTurn = true
    s = log(s, player, `Hunt: +${xp} XP (${s.players[player].xp} total).`)
  }
  return s
}

/** Deal `amount` damage to a target unit anywhere; defeat it if lethal. Returns
 *  the defeated units (so the caller can fire their death triggers). */
/** A "if a friendly unit would die, … instead" replacement for `u`: a one-shot
 *  deathShield, an attached Zhonya's Hourglass ("kill this instead"), a Soraka -
 *  Wanderer aura, or a Sett - The Boss pay-to-save. Consumes the source and
 *  returns true → the caller recalls the unit (heal + exhaust → base) instead of
 *  trashing it. `bfIndex` (the dying unit's battlefield, when it died at one)
 *  scopes the location-bound saves ("…you control here"). */
function tryRecallInsteadOfDeath(s: MatchState, u: EngineCard, bfIndex?: number): boolean {
  if (u.deathShield) { u.deathShield = false; return true }
  // Self-sacrificing attached gear that saves the equipped unit: Zhonya's Hourglass
  // ("if a friendly unit would die, kill this instead") and Guardian Angel ("if I
  // would die, kill Guardian Angel instead. Heal me, exhaust me, and recall me."). The
  // gear kills itself (→ its owner's trash) and the host is recalled by the caller.
  const saver = u.attached.find((ref) => {
    const gc = getCard(ref.split('|')[0])
    const txt = (gc?.text ?? '').toLowerCase()
    return /would die/.test(txt) && (txt.includes('kill this') || (gc != null && txt.includes(`kill ${gc.name.toLowerCase()}`)))
  })
  if (saver) {
    const [gid, giid] = saver.split('|')
    u.attached = u.attached.filter((r) => r !== saver)
    s.players[u.owner].zones.trash.push({ iid: giid || `${u.owner}:gear:${gid}`, cardId: gid, owner: u.owner, exhausted: false, damage: 0, attached: [] })
    return true
  }
  // Soraka - Wanderer: "If another unit you control here would die, if it has less
  // Might than me, instead heal it, exhaust it, and recall it." A free rescue,
  // scoped to her battlefield. (mightOf is post-damage, but combat — the common
  // case — kills by assignment, not damage counters, so the comparison is intact.)
  if (bfIndex != null) {
    const soraka = s.battlefields[bfIndex]?.units.find(
      (x) => x.owner === u.owner && x.iid !== u.iid &&
        /if another unit you control here would die/i.test(getCard(x.cardId)?.text ?? ''),
    )
    if (soraka && mightOf(u) < mightOf(soraka)) return true
  }
  // Sett - The Boss: "If a buffed unit you control would die, you may pay
  // [rainbow], exhaust me, and spend its buff to heal it, exhaust it, and recall
  // it instead." Pure rescue → auto-paid when ready and affordable (like Altar).
  if ((u.buffs ?? 0) > 0) {
    const sett = controlledPermanents(s, u.owner).find(
      (x) => x.iid !== u.iid && !x.exhausted &&
        /if a buffed unit you control would die/i.test(getCard(x.cardId)?.text ?? ''),
    )
    if (sett && makeBfApi(s).payPowerAny(u.owner, 1)) {
      sett.exhausted = true
      u.buffs = (u.buffs ?? 0) - 1 // spend its buff
      return true
    }
  }
  return false
}

/** Trash a defeated unit — or banish it instead when it carries a one-shot
 *  banish-instead replacement (Smite). Returns true if it was banished (the
 *  death is replaced, so no Deathknell / death-trigger should fire). */
function trashOrBanish(s: MatchState, u: EngineCard): boolean {
  if (u.banishShield) { banishCard(s.players[u.owner], u); return true }
  sendToTrash(s.players[u.owner], u)
  return false
}

/** Heal (clear damage), exhaust, and recall `u` to its owner's base (the standard
 *  "… heal it, exhaust it, and recall it instead" payload). The caller has already
 *  removed `u` from its prior location. */
function recallToBase(s: MatchState, u: EngineCard): void {
  s.players[u.owner].zones.base.push({ ...u, exhausted: true, damage: 0 })
  emit({ kind: 'buff', iid: u.iid, player: u.owner })
}

function applyTargetDamage(s: MatchState, targetIid: string, amount: number, spellLike = false, caster?: PlayerId): EngineCard[] {
  // Annie - Fiery: "Your spells and abilities deal 1 Bonus Damage." +1 per instance
  // of spell/ability damage dealt by a controller of Annie - Fiery.
  if (spellLike && caster != null && controlsUnitNamed(s, caster, 'Annie - Fiery')) amount += 1
  // Elder Dragon (unl-118-219): "Any amount of your damage is enough to kill enemy
  // units." Its controller's nonzero damage is lethal to enemy units.
  const elderLethal = amount > 0 && caster != null && controlsUnitNamed(s, caster, 'Elder Dragon')
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
      if (mightOf(u) <= 0 || (elderLethal && u.owner !== caster)) {
        u.diedAtBf = i // for location-scoped death triggers (Kog'Maw)
        bf.units = bf.units.filter((x) => x.iid !== targetIid)
        if (tryRecallInsteadOfDeath(s, u, i)) {
          recallToBase(s, u)
        } else if (trashOrBanish(s, u)) {
          // Banished instead of dying — death replaced, no death trigger.
        } else {
          if (spellLike && caster != null) u.killedBySpell = true
          emit({ kind: 'defeat', iid: targetIid, cardId: u.cardId })
          dead = [u]
        }
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
      if (mightOf(u) <= 0 || (elderLethal && u.owner !== caster)) {
        p.zones.base = p.zones.base.filter((x) => x.iid !== targetIid)
        if (tryRecallInsteadOfDeath(s, u)) { recallToBase(s, u); return [] }
        if (trashOrBanish(s, u)) return []
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
  // Mageseeker Investigator: "Opponents must pay :rb_rune_rainbow: for each unit beyond
  // the first to move multiple units to my battlefield at the same time." Each opposing
  // Investigator at the destination stacks the surcharge (1 rainbow per extra unit each).
  if (iids.length > 1) {
    const invCount = s.battlefields[toBattlefield].units.filter(
      (u) => u.owner !== player && (getCard(u.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '') === 'Mageseeker Investigator',
    ).length
    if (invCount > 0 && !makeBfApi(s).payPowerAny(player, (iids.length - 1) * invCount))
      return fail(state, `Mageseeker Investigator: must pay ${(iids.length - 1) * invCount} rainbow Power to move ${iids.length} units there.`)
  }
  const moved: EngineCard[] = []
  const sourceBfs = new Set<number>() // battlefields a moved unit left (Stealthy Pursuer follow)
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
          const hasGank = unitHasGanking(s, gankU) || !!bfScriptAt(s, i)?.grantsGanking || !!bfScriptAt(s, toBattlefield)?.grantsGankingDest
          if (!hasGank)
            return fail(state, 'Only units with Ganking can move between battlefields.')
          unit = s.battlefields[i].units.splice(idx, 1)[0]
          sourceBfs.add(i) // Stealthy Pursuer: a friendly unit left battlefield i
          bfScriptAt(s, i)?.onMoveFrom?.(unit) // Back-Alley Bar: +1 Might this turn
          break
        }
      }
    }
    if (!unit) return fail(state, 'Unit not found at your base.')
    if (unit.exhausted) return fail(state, `${def(unit)?.name} is exhausted.`)
    if (unit.cantMoveTurn === s.turn) return fail(state, `${def(unit)?.name} can't move this turn.`)
    unit.exhausted = true
    s.battlefields[toBattlefield].units.push(unit)
    moved.push(unit)
    emit({ kind: 'move', iid: unit.iid, player, cardId: unit.cardId })
  }
  // Stealthy Pursuer: "When a friendly unit moves from my location, I may be moved
  // with it." Auto-follow — relocate friendly Pursuers from each vacated bf to dest.
  for (const src of sourceBfs) {
    for (const pur of s.battlefields[src].units.filter((u) => u.owner === player && !moved.includes(u) && /when a friendly unit moves from my location, i may be moved with it/i.test(getCard(u.cardId)?.text ?? ''))) {
      s.battlefields[src].units = s.battlefields[src].units.filter((u) => u.iid !== pur.iid)
      s.battlefields[toBattlefield].units.push(pur)
      moved.push(pur)
      emit({ kind: 'move', iid: pur.iid, player, cardId: pur.cardId })
    }
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
      priorController: prevController, // who held it BEFORE the showdown (for conquer detection)
      movedUnit: moved[0].iid,
    }
    // Priority opens on the first combatant after the mover (skips uninvolved
    // seats in a 3-4 player game — they only join if invited).
    s2.showdown.priority = nextShowdownPriority(s2, player)
    s2 = log(s2, player, 'Showdown opened — opponents may respond.')
  } else if (
    s2.battlefields[toBattlefield].controller === player &&
    prevController !== player
  ) {
    s2 = awardPoints(s2, player, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    markConquered(s2, player, toBattlefield)
    s2 = grantHunt(s2, player, toBattlefield)
    s2 = applyConquerPassive(s2, player, toBattlefield)
    s2 = fireTriggers(s2, collectGlobal(s2, player, 'conquer'), toBattlefield, 0, prevController == null)
    const here = s2.battlefields[toBattlefield].units.filter((u) => u.owner === player).map((u) => u.iid)
    s2 = fireTriggers(s2, collectSelf(s2, player, 'conquer', here), toBattlefield, 0, prevController == null)
    offerLeblanc(s2, player, toBattlefield) // LeBlanc - Deceiver: copy a unit here
    s2 = offerTrashConquerReturn(s2, player) // Super Mega Death Rocket!
  }
  return ok(s2)
}

/** After a card EFFECT places a unit at a battlefield (Charm's moveToBf, etc.) the
 *  unit "becomes present" — per the rules that applies Contested status and stages a
 *  showdown. Open one if the battlefield is now contested; otherwise, if the move
 *  flipped control to the moved unit's owner, award the conquer. No-op if a showdown
 *  is already open. `priorController` is the controller BEFORE the effect moved it. */
function showdownOrConquerAfterEffectMove(s: MatchState, bfIndex: number, movedIid: string, priorController: PlayerId | null): MatchState {
  const bf = s.battlefields[bfIndex]
  const movedOwner = bf.units.find((u) => u.iid === movedIid)?.owner
  if (movedOwner == null) return s
  const bfName = getCard(bf.cardId)?.name ?? 'battlefield'
  if (bf.units.some((u) => u.owner !== movedOwner)) {
    if (s.showdown) return s // already mid-showdown; don't nest
    s.phase = 'showdown'
    s.showdown = { battlefield: bfIndex, priority: movedOwner, passes: 0, priorController, movedUnit: movedIid }
    s.showdown.priority = nextShowdownPriority(s, movedOwner)
    return log(s, movedOwner, `Showdown opened at ${bfName} — opponents may respond.`)
  }
  // Uncontested: a conquer if the move flipped control to the moved unit's owner.
  if (bf.controller === movedOwner && priorController !== movedOwner) {
    s = awardPoints(s, movedOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    markConquered(s, movedOwner, bfIndex)
    s = grantHunt(s, movedOwner, bfIndex)
    s = applyConquerPassive(s, movedOwner, bfIndex)
    const here = bf.units.filter((u) => u.owner === movedOwner).map((u) => u.iid)
    s = fireTriggers(s, collectGlobal(s, movedOwner, 'conquer'), bfIndex, 0, priorController == null)
    s = fireTriggers(s, collectSelf(s, movedOwner, 'conquer', here), bfIndex, 0, priorController == null)
    offerLeblanc(s, movedOwner, bfIndex)
    s = offerTrashConquerReturn(s, movedOwner) // Super Mega Death Rocket!
  }
  return s
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
  p.cantPlayCardsThisTurn = false // Brynhir Thundersong lock clears at the start of your turn
  p.playedEquipmentThisTurn = false
  p.discardedThisTurn = false
  p.xpGainedThisTurn = false
  p.zileanDoubledThisTurn = false
  p.apheliosModesThisTurn = 0
  p.azirSwappedThisTurn = false
  p.energySpentOnSpellsThisTurn = 0
  p.spellPlayedThisTurn = false
  p.nextUnitEntersReadyThisTurn = false
  p.conqueredThisTurn = []
  p.oncePerTurnUsed = {}
  p.pool = { energy: 0, power: {} }
  p.unitCostBump = 0 // recomputed below by holding Vaults of Helia
  p.holdPointsThisTurn = 0 // Needlessly Large Yordle's per-hold-point discount
  p.nextSpellCostDiscount = 0 // Raging Firebrand's "next spell costs N less"
  p.grantRepeatNextSpell = false
  s.unitDiedThisTurn = false // reset the "a unit died this turn" gate

  // Awaken: ready everything the active player controls (Maduli "I can't be readied" is skipped).
  if (p.legend && !unitCantBeReadied(p.legend)) p.legend.exhausted = false
  for (const z of Object.keys(p.zones) as ZoneId[])
    p.zones[z] = p.zones[z].map((c) => (unitCantBeReadied(c) ? c : { ...c, exhausted: false }))
  for (const bf of s.battlefields)
    bf.units = bf.units.map((u) => (u.owner === ap && !unitCantBeReadied(u) ? { ...u, exhausted: false } : u))
  s = log(s, ap, `— Turn ${s.turn}: ${p.name} · Awaken —`)

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

  // Track whether a friendly (active-player) unit dies during this Beginning Phase
  // (Shard of Undoing's trigger condition).
  let friendlyDiedInBeginning = false
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
      s.unitDiedThisTurn = true // beginning-phase deaths (Shadow Watcher)
      friendlyDiedInBeginning = true
      s = log(s, ap, `${expired.length} Temporary unit(s) expired.`)
    }
  }
  const baseExpired = p.zones.base.filter(
    (u) => (parseKeywords(def(u)).temporary || u.temporary) && (u.enteredTurn ?? 0) < s.turn,
  )
  if (baseExpired.length) friendlyDiedInBeginning = true
  for (const u of baseExpired) {
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
      if (dead.length) { if (dead.some((d) => d.owner === ap)) friendlyDiedInBeginning = true; s = fireDeaths(s, dead) }
    }
    s = log(s, ap, `${getCard(s.battlefields[i].cardId)?.name ?? 'Battlefield'}: dealt ${dmg} to each unit here.`)
  }

  // Shard of Undoing (gear unl-174-219): "The first time a friendly unit dies during
  // your Beginning Phase each turn, each opponent must kill one of their units." Each
  // opponent CHOOSES which of their units to kill (queued one at a time, pausing the
  // Beginning Phase); declining auto-removes their lowest-Might unit (the kill is
  // mandatory). The Dreaming-Tree etc. are unaffected.
  if (friendlyDiedInBeginning) {
    const hasShard = [...p.zones.base, ...controlledPermanents(s, ap)].some((c) => c.cardId === 'unl-174-219')
    if (!p.oncePerTurnUsed) p.oncePerTurnUsed = {}
    if (hasShard && !p.oncePerTurnUsed['shard-of-undoing']) {
      p.oncePerTurnUsed['shard-of-undoing'] = true
      const opponents = s.players
        .filter((pl) => pl.id !== ap && !pl.out && [...pl.zones.base, ...s.battlefields.flatMap((b) => b.units)].some((u) => u.owner === pl.id && getCard(u.cardId)?.type === 'unit'))
        .map((pl) => pl.id)
      s = offerShardKill(s, opponents)
      if (s.pendingChoice) { s.phase = 'score'; return s } // paused; resumes via RESOLVE_CHOICE
    }
  }

  return resumeBeginning(s)
}

/** Offer the next opponent in `remaining` a forced "kill one of your units" choice
 *  (Shard of Undoing). Skips opponents with no units; sets pendingChoice for the
 *  first eligible opponent (payload carries the rest of the queue), or leaves the
 *  state unchanged if none remain. */
function offerShardKill(s: MatchState, remaining: PlayerId[]): MatchState {
  let queue = remaining
  while (queue.length) {
    const pid = queue[0]
    const rest = queue.slice(1)
    const opts = [...s.players[pid].zones.base, ...s.battlefields.flatMap((b) => b.units)]
      .filter((u) => u.owner === pid && getCard(u.cardId)?.type === 'unit')
      .map((u) => unitOpt(u))
    if (!opts.length) { queue = rest; continue }
    offerChoice(s, { player: pid, kind: 'shardKill', bfIndex: -1, prompt: 'Shard of Undoing — kill one of your units.', options: opts, payload: JSON.stringify({ remaining: rest }) })
    return s
  }
  return s
}

/** The Dusk Rose Lab pre-scoring sacrifice prompt, then the back half of the
 *  Beginning Phase. Split out so Shard of Undoing's opponent-kill prompts (and Dusk
 *  Rose itself) can pause `beginTurn` and resume here via RESOLVE_CHOICE. */
function resumeBeginning(s: MatchState): MatchState {
  const ap = s.activePlayer
  // Dusk Rose Lab: "you may kill a unit you control here to draw 1 — before scoring."
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
      fireOpponentScore(s, ap) // Sumpworks Map
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

  // Ashe - Focused: "When they hold, return it to their hand." When the now-holding
  // active player (ap) is a victim with a card banished this way, return it (the entry
  // persists across turns and fires even if Ashe has since left the board).
  if (holdsAny && s.asheBanishPending?.length) {
    for (const entry of s.asheBanishPending.filter((e) => e.victimId === ap)) {
      const victim = s.players[entry.victimId]
      const idx = victim.banished.findIndex((c) => c.iid === entry.banishedIid)
      if (idx >= 0) {
        const [returned] = victim.banished.splice(idx, 1)
        victim.zones.hand.push({ ...returned, exhausted: false, damage: 0, attached: [] })
        s = log(s, ap, `Ashe - Focused: returned ${getCard(returned.cardId)?.name} to ${victim.name}'s hand.`)
      }
    }
    s.asheBanishPending = (s.asheBanishPending ?? []).filter((e) => e.victimId !== ap)
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
    // Amateur Recital: on hold, you may move one of YOUR units at a battlefield to
    // its base (own units only — "to its base" = the unit owner's base).
    if (bfBaseNameAt(s, s.battlefields.indexOf(bf)) === 'Amateur Recital') {
      const opts = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner === ap).map((u) => unitOpt(u))
      offerChoice(s, { player: ap, kind: 'moveAnyToBase', bfIndex: s.battlefields.indexOf(bf), prompt: 'Amateur Recital — move a unit at a battlefield to its base?', options: opts })
      continue
    }
    // Hallowed Tomb: on hold, return your Chosen Champion from trash to your
    // Champion Zone if it is empty (pure benefit → auto-resolved).
    if (bfBaseNameAt(s, s.battlefields.indexOf(bf)) === 'Hallowed Tomb') {
      if (!p.champion) {
        const champ = p.zones.trash.find((c) => getCard(c.cardId)?.supertype === 'champion' && c.owner === ap)
        if (champ) {
          removeFromZone(p, 'trash', champ.iid)
          p.champion = { ...champ, damage: 0, exhausted: false, attached: [], buffs: 0, tempMight: 0, stunned: false }
          s = log(s, ap, `Hallowed Tomb (hold): returned ${getCard(champ.cardId)?.name} to your Champion Zone.`)
        }
      }
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
      // Pick an UN-buffed friendly unit here (a buff is capped at one per unit, so
      // holding repeatedly must not stack on the same unit).
      const target = bf.units.find((u) => u.owner === ap && (u.buffs ?? 0) < 1)
      if (target) {
        target.buffs = 1
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

  // Iascylla: "When I hold, at the start of your next Main Phase, you may move an
  // enemy unit to this battlefield." Drain pulls queued on a PRIOR turn (the
  // requeue from this turn's hold above stamps the current turn, so it waits). A
  // pull onto a held battlefield may open a showdown — fine, we're now in the
  // Main Phase, so the contest resolves through normal priority.
  const due = s.players[ap].pendingPullsNextTurn
  if (due?.length) {
    s.players[ap].pendingPullsNextTurn = due.filter((q) => q.queuedTurn >= s.turn)
    for (const q of due.filter((q) => q.queuedTurn < s.turn)) s = pullEnemyToBf(s, ap, q.bfIndex, 'Iascylla')
  }
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
  // Ashe - Focused: an eliminated victim will never hold again — drop their pending returns.
  if (s.asheBanishPending?.length) s.asheBanishPending = s.asheBanishPending.filter((e) => e.victimId !== player)
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
 *  turn — otherwise they draw a card instead of scoring it. Hold/Burn-Out
 *  points are unrestricted. */
/** Whether any (live) opponent's score is within `n` points of the Victory Score
 *  (Leona - Zealot, Find Your Center, Poppy - Paragon). */
function opponentScoreWithin(s: MatchState, player: PlayerId, n: number): boolean {
  return s.players.some((pl, i) => i !== player && !pl.out && s.pointsToWin - pl.points <= n)
}

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
  if (kind === 'hold') p.holdPointsThisTurn = (p.holdPointsThisTurn ?? 0) + amount // Needlessly Large Yordle
  emit({ kind: 'score', player, amount })
  fireOpponentScore(s, player) // Sumpworks Map: opponents draw when this player scores
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
  let m = d.might - ci.damage + gearMight(ci, xp) + (ci.buffs ?? 0) + (ci.tempMight ?? 0)
  if (role === 'attacker') m += k.assault + (ci.grantAssault ?? 0) // [Assault] granted this turn
  if (role === 'defender') m += k.shield + (ci.grantShield ?? 0) // [Shield] granted this turn
  // Attached gear grants its [Assault]/[Shield] to the equipped unit's combat role
  // (Serrated Dirk [Assault 2] → +2 while attacking; Cloth Armor [Shield 2] → +2 defending).
  if (role === 'attacker' || role === 'defender') {
    for (const ref of ci.attached) {
      const gk = parseKeywords(getCard(ref.split('|')[0]))
      m += role === 'attacker' ? gk.assault : gk.shield
    }
  }
  m += levelBonus(d, xp).might // [Level N] passive while controller has enough XP
  return Math.max(0, m)
}

/** Combat damage a unit DEALS — 0 if Stunned (it still keeps Might to survive). */
function damageOutput(ci: EngineCard, role: CombatRole, xp = 0): number {
  return ci.stunned ? 0 : mightOf(ci, role, xp)
}

/** Mighty: a unit with effective Might >= 5. (xp-agnostic quick check; the
 *  xp-aware version is the `mighty` state in the registry — `stateActive`.) */
export function isMighty(ci: EngineCard): boolean {
  return mightOf(ci) >= 5
}

/** ── State engine ──────────────────────────────────────────────────────────
 *  A "state" is a LIVE, conditional status a unit has from game conditions —
 *  e.g. [Mighty] = 5+ effective Might. The registry is the single source of truth
 *  for named boolean unit-states. Card text checks them three ways: continuously
 *  ("While I'm [Mighty], I have [Deflect]…" — see the keyword-grant re-gates),
 *  as a transition ("When a unit becomes [Mighty], …" — see refreshStates /
 *  fireBecomesState), and as a filter ("play a [Mighty] unit"). Housed here (not a
 *  separate states.ts) so predicates can use mightOf/gearMight without a circular
 *  import; the data-driven STATES array keeps it generic + extensible. */
export type StateName = 'mighty' | 'alone' | 'buffed' | 'inCombat'

interface StateDef {
  name: StateName
  isActive: (s: MatchState, u: EngineCard) => boolean
}

const STATES: StateDef[] = [
  // 5+ effective Might (base + buffs + temp + gear + level; no combat-role/aura
  // bonuses — matches the Deathknell `mightyAtDeath` snapshot).
  { name: 'mighty', isActive: (s, u) => mightOf(u, null, s.players[u.owner]?.xp ?? 0) >= 5 },
  // The only friendly unit at its battlefield (units in base are never "alone").
  { name: 'alone', isActive: (s, u) => { const bi = bfIndexOfUnit(s, u.iid); return bi >= 0 && s.battlefields[bi].units.filter((x) => x.owner === u.owner).length === 1 } },
  // Carries a +1 Might buff counter.
  { name: 'buffed', isActive: (_s, u) => (u.buffs ?? 0) > 0 },
  // At the battlefield of the currently-open showdown.
  { name: 'inCombat', isActive: (s, u) => !!s.showdown && bfIndexOfUnit(s, u.iid) === s.showdown.battlefield },
]

/** Whether a unit currently has the named state (the canonical live check). */
export function stateActive(s: MatchState, u: EngineCard, name: StateName): boolean {
  return STATES.find((st) => st.name === name)?.isActive(s, u) ?? false
}

/** Every state a unit currently has — used by the transition pass (refreshStates). */
function unitStateNames(s: MatchState, u: EngineCard): StateName[] {
  return STATES.filter((st) => st.isActive(s, u)).map((st) => st.name)
}

/** A unit's current displayed Might (base + buffs + gear + temp + level âˆ’ damage). */
export function displayMight(ci: EngineCard, xp = 0): number {
  const d = getCard(ci.cardId)
  if (!d || d.type !== 'unit') return 0
  return Math.max(0, d.might + (ci.buffs ?? 0) + (ci.tempMight ?? 0) + gearMight(ci, xp) + levelBonus(d, xp).might - ci.damage)
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
  const gear = gearMight(ci, xp)
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

/** State-aware Might for the UI side indicator. `effective` is the unit's current
 *  Might INCLUDING state auras the plain `mightBreakdown` can't see — Draven points,
 *  Dr. Mundo trash (auraMightBonus), Garen/Lee Sin "here" auras (auraMightHere),
 *  and always-on conditional auras (Meditative runes, Sett - Kingpin for-each).
 *  `mods` is the signed stat-modifier total EXCLUDING damage (the ± counter; damage
 *  has its own UI). Combat-role-only bonuses (Shield/Assault/Fiora 1v1) are omitted
 *  — they only exist in a showdown. Pass bfIndex < 0 for base/champion/legend zones. */
/** The always-on, state-aware Might auras on a unit that `displayMight` can't see
 *  (owner-wide self-scalers, "here" auras, and role-independent conditionals). The
 *  UI passes this to BoardCard as `auraBonus`; pass bfIndex < 0 off a battlefield. */
export function auraMightFor(s: MatchState, bfIndex: number, u: EngineCard): number {
  const here = bfIndex >= 0 ? (s.battlefields[bfIndex]?.units ?? []) : []
  return auraMightBonus(s, u) + (bfIndex >= 0 ? auraMightHere(here, u) : 0) + conditionalMight(s, u, null, false)
}

export function mightBreakdownAt(
  s: MatchState,
  bfIndex: number,
  u: EngineCard,
): { base: number; effective: number; mods: number } | null {
  const d = getCard(u.cardId)
  if (!d || d.type !== 'unit') return null
  const xp = s.players[u.owner]?.xp ?? 0
  const level = levelBonus(d, xp).might
  const mods = (u.buffs ?? 0) + (u.tempMight ?? 0) + gearMight(u, xp) + level + auraMightFor(s, bfIndex, u)
  return { base: d.might, effective: Math.max(0, d.might + mods - u.damage), mods }
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
function gearMight(unit: EngineCard, xp = 0): number {
  let bonus = 0
  for (const gid of unit.attached) {
    const g = getCard(gid.split('|')[0]) // attached stored as "cardId|iid"
    // Strip parenthetical reminders FIRST so a keyword's reminder Might
    // ([Assault 2] "(+2 :rb_might: while I'm attacking.)") isn't counted as a flat
    // bonus — that conditional Might comes from the gear's keyword applied to the
    // host (see mightOf), not from here. Only the FLAT "+N :rb_might:" printed
    // outside any reminder is a static bonus (e.g. Cloth Armor's trailing "+2").
    const t = (g?.text ?? '').replace(/\([^)]*\)/g, ' ')
    const m = t.match(/\+(\d+)\s*(?::rb_might:|might\b)(?!\s+while)/i)
    // Excludes granted/temporary pumps (Spirit's Refuge buff, Mask of Foresight).
    if (m && !/this turn|buff|give|gets|gains/i.test(t)) bonus += parseInt(m[1], 10)
    // Level-gated additional gear Might (e.g. "[Level 3][>] I have an additional +1
    // :rb_might:.") applies while the controller has that many XP. `.match` above
    // already took the FLAT base from the first "+N Might", so this adds the extra.
    const lvl = t.match(/\[level (\d+)\][^.]*?additional \+(\d+)\s*(?::rb_might:|might\b)/i)
    if (lvl && xp >= parseInt(lvl[1], 10)) bonus += parseInt(lvl[2], 10)
  }
  // Gearhead: "Each Equipment attached to me gives double its base Might bonus."
  if (/each equipment attached to me gives double its base might/i.test(getCard(unit.cardId)?.text ?? '')) bonus *= 2
  return bonus
}

/** Order units for damage assignment: Tank first (must be killed before
 *  others), then normal, then backline. `isTank` is state-aware (granted Tank
 *  from Lillia counts, not just the printed keyword). */
function damageOrder(units: EngineCard[], isTank: (u: EngineCard) => boolean): EngineCard[] {
  // Tank (0) → normal (1) → backline (2) → "assigned last" (3, e.g. Caitlyn - Patrolling).
  const rank = (u: EngineCard) =>
    isTank(u) ? 0
    : /must be assigned combat damage last/i.test(getCard(u.cardId)?.text ?? '') ? 3
    : parseKeywords(def(u)).backline ? 2 : 1
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
  elderLethal = false, // Elder Dragon: any nonzero damage is lethal to each enemy
): Set<string> {
  const defeated = new Set<string>()
  let remaining = damage
  for (const u of units) {
    if (remaining <= 0 && !elderLethal) break
    const hp = mightOf(u, role, xpOf(u)) + bonusOf(u, role)
    if (hp <= 0) continue
    if (elderLethal && damage > 0) { defeated.add(u.iid); continue }
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
  isTank: (u: EngineCard) => boolean = (u) => parseKeywords(def(u)).tank,
  elderLethal = false,
): DamageAssignStep {
  const role: CombatRole = side === 'defenders' ? 'defender' : 'attacker'
  const ordered = damageOrder(receiving, isTank)
  const hp = hpMap(receiving, role, xpOf, bonusOf)
  const tanks = receiving.filter(isTank).map((u) => u.iid)
  const assignedLast = receiving.filter((u) => /must be assigned combat damage last/i.test(getCard(u.cardId)?.text ?? '')).map((u) => u.iid)
  const totalHp = Object.values(hp).reduce((a, b) => a + b, 0)
  // A choice only exists with 2+ live targets and damage that won't kill them all.
  const liveTargets = receiving.filter((u) => hp[u.iid] > 0)
  const manual = !elderLethal && manualAllowed && amount > 0 && liveTargets.length >= 2 && amount < totalHp
  const defeated = manual ? [] : [...assignDamage(amount, ordered, role, xpOf, bonusOf, elderLethal)]
  return { dealer, side, targets: ordered.map((u) => u.iid), amount, manual, defeated, hp, tanks, assignedLast }
}

/** Conditional / legend-granted combat Might for a unit (not from its printed
 *  stats): rune-count self buffs and global legend buffs. */
function conditionalMight(s: MatchState, u: EngineCard, role: CombatRole, alone: boolean): number {
  const d = def(u)
  const owner = s.players[u.owner]
  if (!d || !owner) return 0
  let b = 0
  const text = (d.text ?? '').toLowerCase()
  // Conditional / dynamic [Assault] (mightOf bakes in a flat +1 from the bracket;
  // adjust it here where we have state). Raging Soul: "If you've discarded a card
  // this turn, I have [Assault]…" — cancel the +1 when the discard hasn't happened.
  if (role === 'attacker' && /if you've discarded a card this turn,?[^.]*\[assault\]/.test(text) && !owner.discardedThisTurn)
    b -= parseKeywords(d).assault
  // Ancient Warmonger: "I have [Assault] equal to the number of enemy units here."
  // Replace the flat +1 with +1 per enemy unit at its battlefield.
  if (role === 'attacker' && /\[assault\] equal to the number of enemy units here/.test(text)) {
    const bi = s.battlefields.findIndex((bf) => bf.units.some((x) => x.iid === u.iid))
    const enemies = bi >= 0 ? s.battlefields[bi].units.filter((x) => x.owner !== u.owner).length : 0
    b += enemies - parseKeywords(d).assault
  }
  // Wily Newtfish: "If you've gained XP this turn, I have +1 Might and [Ganking]."
  if (/if you('ve| have)? gained xp this turn,?[^.]*\+(\d+)/.test(text) && owner.xpGainedThisTurn) {
    const wm = text.match(/if you('ve| have)? gained xp this turn,?[^.]*\+(\d+)/)
    if (wm) b += parseInt(wm[2], 10)
  }
  // Self: "While you have N+ runes, I have +X Might." (Master Yi - Meditative)
  const runeM = text.match(/while you have (\d+)\+? (?:or more )?runes?, i have \+(\d+)\s*(?::rb_might:|might)/)
  if (runeM && owner.zones.runePool.length >= parseInt(runeM[1], 10)) b += parseInt(runeM[2], 10)
  // Self-scaling aura: "I have/get +N Might for each <X>" — Sett - Kingpin (buffed
  // friendly units here), Ornn - Forge God (friendly gear), Petal Pixie ([Temporary]
  // units here), or "enemy unit here". Continuous, so it lives in the Might path.
  const feM = text.match(/i (?:have|get) \+(\d+)\s*(?::rb_might:|might) for each ([a-z '\[\]-]+)/)
  if (feM) {
    const per = parseInt(feM[1], 10)
    const what = feM[2]
    const bi = s.battlefields.findIndex((bf) => bf.units.some((x) => x.iid === u.iid))
    const here = bi >= 0 ? s.battlefields[bi].units : []
    const friendly = [...owner.zones.base, ...s.battlefields.flatMap((bf) => bf.units)].filter((x) => x.owner === u.owner)
    let count = 0
    if (/buffed friendly unit/.test(what)) {
      const pool = /at my battlefield|here/.test(what) ? here : friendly
      count = pool.filter((x) => x.owner === u.owner && x.iid !== u.iid && (x.buffs ?? 0) > 0).length
    } else if (/gear/.test(what)) {
      count = owner.zones.base.filter((x) => def(x)?.type === 'gear').length + friendly.reduce((n, x) => n + (x.attached?.length ?? 0), 0)
    } else if (/temporary/.test(what)) {
      const pool = /here/.test(what) ? here : friendly
      count = pool.filter((x) => x.owner === u.owner && (parseKeywords(def(x)).temporary || x.token)).length
    } else if (/enemy unit/.test(what)) {
      count = (/here/.test(what) ? here : s.battlefields.flatMap((bf) => bf.units)).filter((x) => x.owner !== u.owner).length
    }
    b += per * count
  }
  // Self: "While I'm buffed, I have an additional +N Might." (Wizened Elder)
  if ((u.buffs ?? 0) > 0) {
    const bm = text.match(/while (?:i'm|i am) buffed,? i have (?:an? )?(?:additional )?\+(\d+)\s*(?::rb_might:|might)/)
    if (bm) b += parseInt(bm[1], 10)
  }
  // Lucian - Purifier (legend): "Your Equipment each give [Assault]." Each Equipment
  // attached to an ATTACKING unit grants +1 Might (Assault) while it attacks.
  if (role === 'attacker' && /your equipment each give \[assault\]/.test((getCard(owner.legend?.cardId ?? '')?.text ?? '').toLowerCase()))
    b += (u.attached ?? []).filter((ref) => parseKeywords(getCard(ref.split('|')[0])).equip).length
  // Self: "While I'm attacking or defending alone, I have +N Might." (Wielder of Water)
  if (alone && (role === 'attacker' || role === 'defender')) {
    const am = text.match(/while (?:i'm|i am) attacking (?:or defending )?alone,? i have \+(\d+)\s*(?::rb_might:|might)/)
    if (am) b += parseInt(am[1], 10)
    // Fiora - Peerless: "When I attack or defend one on one, double my Might this
    // combat." 1v1 = her side alone AND exactly one enemy here. Doubling = +her
    // current Might. Applied as a combat-Might aura so showdownSteps sees it.
    if (/double my might this combat/.test(text)) {
      const bi = s.battlefields.findIndex((bf) => bf.units.some((x) => x.iid === u.iid))
      const enemies = bi >= 0 ? s.battlefields[bi].units.filter((x) => x.owner !== u.owner).length : 0
      if (enemies === 1) b += mightOf(u, role, owner.xp ?? 0)
    }
    // Controller's gear: Mask of Foresight — "When a friendly unit attacks or
    // defends alone, give it +N Might this turn." Modeled as a lone-combatant aura.
    // Scans ALL controlled gear (base AND attached), so it works once equipped.
    for (const g of controlledPermanents(s, u.owner)) {
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
  // Self: "If you've spent :rb_energy_N: or more to play a spell this turn, I have +M Might." (Prepared Neophyte)
  const spentM = text.match(/if you've spent :rb_energy_(\d+): or more to play a spell this turn,? i have \+(\d+)\s*(?::rb_might:|might)/)
  if (spentM && (owner.energySpentOnSpellsThisTurn ?? 0) >= parseInt(spentM[1], 10)) b += parseInt(spentM[2], 10)
  // Self: "While you have another unit here, I have +N Might." (Trusty Ramhound) —
  // another friendly unit at the same battlefield.
  const anotherM = text.match(/while you have another unit here,? i have \+(\d+)\s*(?::rb_might:|might)/)
  if (anotherM) {
    const bi = s.battlefields.findIndex((bf) => bf.units.some((x) => x.iid === u.iid))
    const others = bi >= 0 ? s.battlefields[bi].units.filter((x) => x.owner === u.owner && x.iid !== u.iid && getCard(x.cardId)?.type === 'unit').length : 0
    if (others > 0) b += parseInt(anotherM[1], 10)
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
/** Owner-wide "Your <tag>s (each) have [Keyword]" grants — Rumble - Mechanized Menace
 *  ([Shield]), Rumble - Hotheaded ([Assault]), Forecaster ([Vision]), Breakneck Mech
 *  ([Deflect]/[Ganking]). True when a permanent the owner controls grants `keyword`
 *  to a tag that `u` carries. (`keyword` is the lowercase bracket word.) */
function unitGrantedKeyword(s: MatchState, u: EngineCard, keyword: string): boolean {
  const tags = (getCard(u.cardId)?.tags ?? []).map((t) => t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!tags.length) return false
  for (const perm of controlledPermanents(s, u.owner)) {
    const txt = (getCard(perm.cardId)?.text ?? '').toLowerCase()
    if (!txt.includes('have')) continue
    for (const tag of tags)
      if (new RegExp(`your ${tag}s? (?:each )?have [^.]*\\[${keyword}\\]`).test(txt)) return true
  }
  return false
}

/** Positional keyword grants from another friendly unit sharing the battlefield:
 *  "Other friendly units here have [Assault]" (Captain Farron) / "[Shield]"
 *  (Taric - Protector). Like unitGrantedKeyword but bf-local rather than owner-wide. */
function unitGrantedKeywordHere(here: EngineCard[], u: EngineCard, keyword: string): boolean {
  for (const src of here) {
    if (src.iid === u.iid || src.owner !== u.owner) continue
    const t = (def(src)?.text ?? '').toLowerCase()
    if (new RegExp(`(?:other )?friendly units here have [^.]*\\[${keyword}\\]`).test(t)) return true
  }
  return false
}

function unitHasGanking(s: MatchState, u: EngineCard): boolean {
  if (u.grantGanking) return true // [Ganking] granted this turn (Vault Breaker)
  const t = (def(u)?.text ?? '').toLowerCase()
  if (/while (?:i'm|i am) buffed,?[^.]*\[ganking\]/.test(t)) return stateActive(s, u, 'buffed') // single-source state check
  // Fiora - Victorious: "While I'm [Mighty], I have [Deflect], [Ganking], and [Shield]."
  if (/while (?:i'm|i am) \[?mighty\]?,?[^.]*\[ganking\]/.test(t)) return stateActive(s, u, 'mighty')
  // Raging Soul: "If you've discarded a card this turn, I have [Assault] and [Ganking]."
  if (/if you've discarded a card this turn,?[^.]*\[ganking\]/.test(t)) return s.players[u.owner]?.discardedThisTurn ?? false
  // Wily Newtfish: "If you've gained XP this turn, I have +1 Might and [Ganking]."
  if (/if you('ve| have)? gained xp this turn,?[^.]*\[ganking\]/.test(t)) return s.players[u.owner]?.xpGainedThisTurn ?? false
  // Attached gear granting [Ganking] (Boots of Swiftness) → the equipped unit.
  if (u.attached?.some((ref) => parseKeywords(getCard(ref.split('|')[0])).ganking)) return true
  return keywordsAt(def(u), s.players[u.owner]?.xp ?? 0).ganking || unitGrantedKeyword(s, u, 'ganking') // Breakneck Mech
}

/** Unit-granted auras among units sharing a battlefield. Lee Sin - Centered:
 *  "Other buffed friendly units at my battlefield have +2 Might." applies to
 *  each OTHER friendly buffed unit standing with him. */
function auraMightHere(here: EngineCard[], u: EngineCard): number {
  let b = 0
  let leonaApplied = false
  for (const src of here) {
    if (src.iid === u.iid) continue
    const t = (def(src)?.text ?? '').toLowerCase()
    if (src.owner === u.owner) {
      // OTHER friendly units' positive auras.
      const m = t.match(/other buffed friendly units at my battlefield have \+(\d+)\s*(?::rb_might:|might)/)
      if (m && (u.buffs ?? 0) > 0) b += parseInt(m[1], 10)
      // Garen - Commander: "Other friendly units have +N Might here." (no buff gate)
      const gm = t.match(/other friendly units have \+(\d+)\s*(?::rb_might:|might) here/)
      if (gm) b += parseInt(gm[1], 10)
    } else if (!leonaApplied && u.stunned && /stunned enemy units here have -8\s*(?::rb_might:|might)/.test(t)) {
      // Leona - Zealot: "Stunned enemy units here have -8 Might, to a minimum of 1."
      // Floor at 1: bonus = -min(8, currentMight - 1). Applied once (no stacking).
      b -= Math.min(8, Math.max(0, mightOf(u) - 1))
      leonaApplied = true
    }
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
    // Owner-wide granted [Shield]/[Assault] (Rumble - Mechanized Menace / Hotheaded)
    // and positional grants from a unit here (Taric - Protector / Captain Farron):
    // both are just +1 Might in their combat role.
    if (role === 'defender' && (unitGrantedKeyword(s, u, 'shield') || unitGrantedKeywordHere(here, u, 'shield'))) b += 1
    if (role === 'attacker' && (unitGrantedKeyword(s, u, 'assault') || unitGrantedKeywordHere(here, u, 'assault'))) b += 1
    // Fiora - Victorious: conditional [Shield] (+1 while defending) while [Mighty].
    if (role === 'defender' && /while (?:i'm|i am) \[?mighty\]?,?[^.]*\[shield\]/.test((def(u)?.text ?? '').toLowerCase()) && stateActive(s, u, 'mighty')) b += 1
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
  // "Assigned last": a unit that must take combat damage last may only be assigned
  // damage once every OTHER target is lethal (Caitlyn - Patrolling).
  for (const last of step.assignedLast ?? []) {
    if ((alloc[last] ?? 0) > 0 && step.targets.some((iid) => iid !== last && (alloc[iid] ?? 0) < step.hp[iid]))
      return 'Other units must be assigned lethal damage before the "assigned last" unit.'
  }
  return null
}

/** Deflect surcharge (Core Rules Â§735): an opponent's spell/ability that
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
    // Deflect may be granted by a [Level N] clause (Master Yi - Tempered), so
    // resolve keywords against the unit owner's XP.
    if (u && u.owner !== caster) {
      let d = keywordsAt(def(u), state.players[u.owner]?.xp ?? 0).deflect + (unitGrantedKeyword(state, u, 'deflect') ? 1 : 0) // Breakneck Mech
      d += u.attached.reduce((a, ref) => a + parseKeywords(getCard(ref.split('|')[0])).deflect, 0) // attached gear [Deflect] (Hexdrinker)
      d += u.grantDeflect ?? 0 // [Deflect] granted this turn (Kato the Arm)
      // Fiora - Victorious: conditional [Deflect] while [Mighty].
      if (/while (?:i'm|i am) \[?mighty\]?,?[^.]*\[deflect/.test((def(u)?.text ?? '').toLowerCase()) && stateActive(state, u, 'mighty')) d += 1
      // Spirit's Refuge: "Friendly buffed units have [Deflect] if they didn't already."
      if (d === 0 && stateActive(state, u, 'buffed') && controlledPermanents(state, u.owner).some((perm) => /friendly buffed units have \[deflect\]/i.test(getCard(perm.cardId)?.text ?? ''))) d += 1
      total += d
    }
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
    buildAssignStep(moverOwner, 'defenders', defenders, attackMight, true, xpOf, bonusOf, isTank, controlsUnitNamed(s, moverOwner, 'Elder Dragon') && attackMight > 0),
    buildAssignStep(atkDealer, 'attackers', attackers, defendMight, true, xpOf, bonusOf, isTank, controlsUnitNamed(s, atkDealer, 'Elder Dragon') && defendMight > 0),
  ]
  return { moverOwner, steps }
}

/**
 * Resolve a combat showdown at a battlefield. Both sides deal damage equal to
 * their total Might SIMULTANEOUSLY. When a side hits 2+ enemy units and has a
 * choice of distribution, combat PAUSES for that player to assign damage
 * (Tank-first); otherwise it auto-resolves in kill-order.
 */
/** Fire the attack/defend triggers as combat begins — BEFORE the damage math, so
 *  pre-combat board effects (Yasuo - Remorseful's damage, Warwick - Hunter's kill,
 *  Vi - Peacekeeper's stun, Ahri - Inquisitive's −2) shape the showdown. Win-combat
 *  and death triggers still fire afterward (in finalizeShowdown). */
function fireCombatTriggers(s: MatchState, bfIndex: number): MatchState {
  const bf = s.battlefields[bfIndex]
  const mover = s.showdown?.movedUnit
  const moverOwner = bf.units.find((u) => u.iid === mover)?.owner ?? s.activePlayer
  const attackers = bf.units.filter((u) => u.owner === moverOwner)
  const defenders = bf.units.filter((u) => u.owner !== moverOwner)
  // Ahri - Nine-Tailed Fox (legend): "When an enemy unit attacks a battlefield you
  // control, give it −1 Might this turn (min 1)." Applies to each attacker when the
  // pre-combat controller (a defender) has Ahri in play.
  const controller = bf.controller
  if (controller != null && controller !== moverOwner && playerHasLegend(s, controller, 'Ahri - Nine-Tailed Fox')) {
    for (const u of [...attackers]) applyTempMight(s, u.iid, -1, 1)
    if (attackers.length) s = log(s, controller, `Ahri - Nine-Tailed Fox: gave ${attackers.length} attacker(s) −1 Might this turn (min 1).`)
  }
  const combatFired: FiredTrigger[] = []
  // Collect a unit's own combat triggers plus those of any attached gear ("when the
  // equipped unit attacks/defends → …", e.g. Recurve Bow). Gear triggers resolve with
  // the HOST as source so "here"/"me" target the unit, but carry the gear's text.
  const collectCombat = (u: EngineCard, event: TriggerEvent) => {
    for (const ab of triggersFor(def(u), event))
      combatFired.push({ player: u.owner, ability: ab, sourceIid: u.iid, sourceCardId: u.cardId })
    for (const ref of u.attached ?? []) {
      const gCard = getCard(ref.split('|')[0])
      if (!gCard) continue
      for (const ab of triggersFor(gCard, event))
        combatFired.push({ player: u.owner, ability: ab, sourceIid: u.iid, sourceCardId: gCard.id })
    }
  }
  for (const u of attackers) collectCombat(u, 'attack')
  for (const u of defenders) collectCombat(u, 'defend')
  // "When you defend at a battlefield, …" global triggers for the defending player's
  // OTHER permanents (Loyal Pup → move me there). Skip units already collected above.
  const defenderPlayer = defenders[0]?.owner
  if (defenderPlayer != null) {
    const defIids = new Set(defenders.map((u) => u.iid))
    for (const u of controlledPermanents(s, defenderPlayer)) {
      if (defIids.has(u.iid)) continue
      for (const ab of triggersFor(getCard(u.cardId), 'defend'))
        if (ab.scope === 'global')
          combatFired.push({ player: defenderPlayer, ability: ab, sourceIid: u.iid, sourceCardId: u.cardId, bfIndex })
    }
  }
  return fireTriggers(s, combatFired, bfIndex)
}

function resolveShowdown(state: MatchState, bfIndex: number): MatchState {
  let s = clone(state)
  s = fireCombatTriggers(s, bfIndex)
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
  // Use the controller captured when the showdown OPENED — a reaction may have
  // bounced/killed the defender mid-showdown, flipping control to the mover before
  // this resolves; reading it now would wrongly read "mover already held it" and
  // skip the conquer award. Fall back to the live value for legacy showdowns.
  const prevController = s.showdown?.priorController !== undefined ? s.showdown.priorController : s.battlefields[bfIndex].controller

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

  // Attack/Defend triggers already fired in fireCombatTriggers (before the math),
  // so pre-combat board effects could shape this showdown. Only the post-combat
  // scripts and win/death triggers remain below.

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
      offerChoice(s, { player: owner, kind: 'moveHereToBase', bfIndex, prompt: "Reaver's Row — move a friendly unit here to base?", options: opts })
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
    if (dead && tryRecallInsteadOfDeath(s, u, bfIndex)) {
      // Zhonya's / shield / Soraka / Sett: heal, exhaust, recall to base.
      recallToBase(s, u)
      rescued.add(u.iid)
      s = log(s, u.owner, `${getCard(u.cardId)?.name} was saved — healed, exhausted, recalled to base.`)
    } else if (dead && altarOfBlood && getCard(u.cardId)?.supertype !== 'token' && makeBfApi(s).payPowerAny(u.owner, 3)) {
      s.players[u.owner].zones.base.push({ ...u, exhausted: true, damage: 0 })
      emit({ kind: 'buff', iid: u.iid, player: u.owner })
      rescued.add(u.iid)
      s = log(s, u.owner, `Altar of Blood: paid 3 to heal, exhaust, and recall ${getCard(u.cardId)?.name} to base.`)
    } else if (dead && trashOrBanish(s, u)) {
      // Smite: banished instead of dying — death replaced, no death trigger.
      rescued.add(u.iid) // not a death for trigger purposes
      s = log(s, u.owner, `${getCard(u.cardId)?.name} was banished instead of dying.`)
    } else if (dead) {
      u.diedAtBf = bfIndex // for location-scoped death triggers (Kog'Maw)
      emit({ kind: 'defeat', iid: u.iid, cardId: u.cardId })
      defeated.push(u)
    } else survivors.push({ ...u, damage: 0 })
  }
  bf.units = survivors
  const lost = defendersDefeated.size + attackersDefeated.size - rescued.size
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

  // "When I win a combat" / "When you win a combat" — the mover cleared the
  // defenders and still holds units. Self triggers (Draven - Vanquisher, Nidalee)
  // and global ones (Kha'Zix - Voidreaver "gain 1 XP", Draven - Glorious "draw 1").
  const moverHere = s.battlefields[bfIndex].units.filter((u) => u.owner === moverOwner).map((u) => u.iid)
  const enemyHere = s.battlefields[bfIndex].units.some((u) => u.owner !== moverOwner)
  if (moverHere.length > 0 && !enemyHere) {
    s = fireTriggers(s, collectSelf(s, moverOwner, 'winCombat', moverHere))
    s = fireTriggers(s, collectGlobal(s, moverOwner, 'winCombat'))
  }

  // Conquer: mover ends as sole controller of a battlefield they didn't hold.
  const nowController = s.battlefields[bfIndex].controller
  if (nowController === moverOwner && prevController !== moverOwner) {
    // Excess (overkill) the mover assigned to the defenders this combat — the
    // attack damage beyond the defenders' total Might (Trapping Grounds).
    const defStep = steps.find((st) => st.side === 'defenders')
    const totalDefHp = defStep ? Object.values(defStep.hp).reduce((a, b) => a + b, 0) : 0
    const excess = Math.max(0, attackMight - totalDefHp)
    s = awardPoints(s, moverOwner, RULES.pointsPerConquer, `conquered ${bfName}`, 'conquer')
    markConquered(s, moverOwner, bfIndex)
    s = grantHunt(s, moverOwner, bfIndex)
    s = applyConquerPassive(s, moverOwner, bfIndex, excess)
    s = fireTriggers(s, collectGlobal(s, moverOwner, 'conquer'), bfIndex, excess, prevController == null)
    s = fireTriggers(s, collectSelf(s, moverOwner, 'conquer', moverHere), bfIndex, excess, prevController == null)
    offerLeblanc(s, moverOwner, bfIndex) // LeBlanc - Deceiver: copy a unit here
    s = offerTrashConquerReturn(s, moverOwner) // Super Mega Death Rocket!
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

  // Arise!: "Play a 2 Might Sand Soldier unit token for each Equipment you control.
  // Then do this: Ready up to two of them." The parser reads count=1 and drops the
  // "ready up to two" clause, so resolve the per-Equipment count + ready bespoke.
  if (e.namedToken && /for each equipment you control/i.test(card.text ?? '')) {
    const tokName = e.namedToken.name
    const equip = allGearInPlay(s).filter((g) => g.owner === controller && parseKeywords(getCard(g.cardId)).equip).length
    const made = spawnNamedToken(p, tokName, equip, s.turn, true) // enter exhausted
    let readied = 0
    if (made > 0 && /ready up to two/i.test(card.text ?? '')) {
      const fresh = p.zones.base.filter((u) => (getCard(u.cardId)?.name ?? '').toLowerCase().includes(tokName.toLowerCase())).slice(-made)
      for (const tok of fresh.slice(-2)) if (tok.exhausted) { tok.exhausted = false; readied++ }
    }
    return log(s, controller, `${card.name}: played ${made} ${tokName} token(s)${readied ? `, readied ${readied}` : ''} (Equipment: ${equip}).`)
  }

  // Bone Skewer: "Choose a battlefield. An opponent reveals their hand. You may choose a
  // unit from it. They play that unit to that battlefield, ignoring any and all costs.
  // When they do, [Stun] it." Auto-picks the opponent with the most cards, their
  // highest-Might unit in hand, and a safe battlefield (one you control, else empty,
  // else bf0); the unit enters as THEIRS, exhausted + stunned (deals no combat damage).
  if (/play that unit to that battlefield, ignoring any and all costs/i.test(card.text ?? '')) {
    const foe = s.players
      .filter((pl) => pl.id !== controller && !pl.out && pl.zones.hand.some((c) => getCard(c.cardId)?.type === 'unit'))
      .sort((a, b) => b.zones.hand.length - a.zones.hand.length)[0]
    if (!foe) return log(s, controller, `${card.name}: no opponent has a unit in hand.`)
    const pick = foe.zones.hand
      .filter((c) => getCard(c.cardId)?.type === 'unit')
      .sort((a, b) => mightOf(b) - mightOf(a))[0]
    const destBf = (() => {
      const own = s.battlefields.findIndex((b) => b.controller === controller)
      if (own >= 0) return own
      const empty = s.battlefields.findIndex((b) => b.units.length === 0)
      return empty >= 0 ? empty : 0
    })()
    const [played] = foe.zones.hand.splice(foe.zones.hand.findIndex((c) => c.iid === pick.iid), 1)
    s.battlefields[destBf].units.push({ ...played, exhausted: true, stunned: true, enteredTurn: s.turn, attached: [] })
    emit({ kind: 'stun', iid: played.iid, player: controller })
    recomputeControllers(s)
    s = log(s, controller, `${card.name}: forced ${foe.name} to play ${getCard(played.cardId)?.name} to battlefield ${destBf + 1}, Stunned.`)
    return fireStun(s, controller, destBf) // caster's "when you stun an enemy" payoffs
  }

  // Strike Down: a chosen equipped friendly unit deals its Might to an enemy, then
  // detaches an Equipment. Auto-picks the strongest equipped friendly + strongest enemy.
  if (e.strikeDown) {
    const dealer = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
      .filter((u) => u.owner === controller && getCard(u.cardId)?.type === 'unit' && u.attached.length > 0)
      .sort((a, b) => mightOf(b) - mightOf(a))[0]
    const enemy = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== controller).sort((a, b) => mightOf(b) - mightOf(a))[0]
    if (dealer && enemy) {
      const amt = mightOf(dealer)
      s = log(s, controller, `${card.name}: ${getCard(dealer.cardId)?.name} deals ${amt} to ${getCard(enemy.cardId)?.name}.`)
      s = fireDeaths(s, applyTargetDamage(s, enemy.iid, amt, true, controller))
      const d = findUnitAnywhere(s, dealer.iid)
      if (d && d.attached.length) {
        const [ref] = d.attached.splice(0, 1)
        const [cid, iid] = ref.split('|')
        if (getCard(cid)?.supertype !== 'token') s.players[controller].zones.base.push({ iid, cardId: cid, owner: controller, exhausted: false, damage: 0, attached: [] })
        s = log(s, controller, `${card.name}: detached ${getCard(cid)?.name}.`)
      }
    } else {
      s = log(s, controller, `${card.name} fizzled — need an equipped friendly unit and an enemy.`)
    }
    return s
  }

  // Void Assault: "Move a friendly unit, then move an enemy unit. (If they both move
  // to a battlefield you don't control, you're the attacker.)" Auto-resolved: send your
  // strongest unit to an enemy-controlled battlefield (else the strongest enemy's
  // battlefield) and drag the strongest enemy there too, fighting as the attacker.
  // Honours UI-selected targets when provided.
  if (card.name === 'Void Assault') {
    const isUnit = (u: EngineCard) => getCard(u.cardId)?.type === 'unit'
    const allUnits = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
    const chosen = (own: boolean) => (targets ?? []).map((t) => findUnitAnywhere(s, t)).find((u) => !!u && isUnit(u) && (own ? u.owner === controller : u.owner !== controller))
    const friendly = chosen(true) ?? allUnits.filter((u) => u.owner === controller && isUnit(u)).sort((a, b) => mightOf(b) - mightOf(a))[0]
    const enemy = chosen(false) ?? s.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== controller && isUnit(u)).sort((a, b) => mightOf(b) - mightOf(a))[0]
    if (!friendly || !enemy) return log(s, controller, `${card.name} fizzled — need a friendly and an enemy unit.`)
    const enemyBf = battlefieldOf(s, enemy.iid)
    let dest = s.battlefields.findIndex((b) => b.controller != null && b.controller !== controller)
    if (dest < 0) dest = enemyBf >= 0 ? enemyBf : 0
    const priorCtrl = s.battlefields[dest].controller
    const fcard = pluckCardAnywhere(s, friendly.iid)
    if (fcard) s.battlefields[dest].units.push(fcard)
    const ecard = pluckCardAnywhere(s, enemy.iid)
    if (ecard) {
      s.battlefields[dest].units.push(ecard)
      recomputeControllers(s)
      s = blastConeOnEnemyMove(s, controller, ecard.iid)
    }
    recomputeControllers(s)
    s = log(s, controller, `Void Assault: moved ${getCard(friendly.cardId)?.name} and ${getCard(enemy.cardId)?.name} to ${bfBaseNameAt(s, dest) || `Battlefield ${dest + 1}`}.`)
    // "You're the attacker" → designate the friendly unit as the mover (attacker).
    if (fcard) s = showdownOrConquerAfterEffectMove(s, dest, fcard.iid, priorCtrl)
    return s
  }

  // Rocket Barrage: "Choose one — Deal 4 to a unit in a base. Kill a gear." Auto-picks
  // (no manual modal): kill an enemy gear if one exists, else deal 4 to the strongest
  // enemy unit sitting in a base.
  if (card.name === 'Rocket Barrage') {
    const enemyGear = allGearInPlay(s).find((g) => g.owner !== controller)
    if (enemyGear) {
      const nm = getCard(enemyGear.cardId)?.name ?? 'a gear'
      killGearByIid(s, enemyGear.iid)
      s = log(s, controller, `${card.name}: killed ${nm}.`)
    } else {
      const target = s.players
        .flatMap((pl) => (pl.id !== controller ? pl.zones.base : []))
        .filter((u) => getCard(u.cardId)?.type === 'unit')
        .sort((a, b) => mightOf(b) - mightOf(a))[0]
      if (target) {
        s = fireDeaths(s, applyTargetDamage(s, target.iid, 4, true, controller), controller)
        s = log(s, controller, `${card.name}: dealt 4 to ${getCard(target.cardId)?.name} in base.`)
      } else {
        s = log(s, controller, `${card.name}: no enemy gear or base unit — fizzled.`)
      }
    }
    return s
  }

  // Generic "deal damage equal to Might/Assault" spells (Challenge, Clash of Giants,
  // Marching Orders, Gentlemen's Duel, Last Breath, Stormbringer, Alpha Strike).
  // Self-dealer trigger cards (Ezreal/Lucian/Snapvine) resolve via the combat/on-play
  // handlers, not here. Dragon's Rage is excluded: it MOVES an enemy first, then the
  // moved unit clashes with another enemy at the destination (handled in the moveToBf
  // resolver after the move), so it must fall through to the e.moveUnit offer below.
  if (e.dealMight && e.dealMight.dealer !== 'self' && card.name !== "Dragon's Rage") {
    const dm = e.dealMight
    const isUnitCard = (u: EngineCard) => getCard(u.cardId)?.type === 'unit'
    const friendlies = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === controller && isUnitCard(u))
    const enemiesAll = s.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== controller && isUnitCard(u))
    const statOf = (u: EngineCard) => dm.useStat === 'assault'
      ? parseKeywords(getCard(u.cardId)).assault + (u.grantAssault ?? 0)
      : mightOf(u, null, s.players[u.owner]?.xp ?? 0)
    const chosen = (own: boolean) => (targets ?? []).map((t) => findUnitAnywhere(s, t)).find((u) => !!u && (own ? u.owner === controller : u.owner !== controller))
    const dealer = chosen(true) ?? friendlies.sort((a, b) => statOf(b) - statOf(a))[0]
    if (!dealer) return log(s, controller, `${card.name} fizzled — no friendly unit.`)
    const amt = statOf(dealer)
    if (dm.target === 'mutual') {
      const foe = chosen(false) ?? enemiesAll.sort((a, b) => statOf(b) - statOf(a))[0]
      if (!foe) return log(s, controller, `${card.name} fizzled — no enemy unit.`)
      const foeAmt = statOf(foe)
      const dead = [...applyTargetDamage(s, foe.iid, amt, true, controller), ...applyTargetDamage(s, dealer.iid, foeAmt, true, controller)]
      s = log(s, controller, `${card.name}: ${getCard(dealer.cardId)?.name} (${amt}) and ${getCard(foe.cardId)?.name} (${foeAmt}) clash.`)
      return fireDeaths(s, dead)
    }
    if (dm.target === 'allEnemiesAtBf' || dm.target === 'splitAllEnemies') {
      const bf = s.battlefields.map((b, i) => ({ i, foes: b.units.filter((u) => u.owner !== controller && isUnitCard(u)) })).filter((x) => x.foes.length).sort((a, b) => b.foes.length - a.foes.length)[0]
      if (!bf) return log(s, controller, `${card.name} fizzled — no enemies.`)
      const dead: EngineCard[] = []
      if (dm.target === 'allEnemiesAtBf') {
        for (const foe of [...bf.foes]) dead.push(...applyTargetDamage(s, foe.iid, amt, true, controller))
      } else {
        let rem = amt // split to kill as many as possible (lowest effective Might first)
        for (const foe of [...bf.foes].sort((a, b) => mightOf(a) - mightOf(b))) {
          if (rem <= 0) break
          const give = Math.min(rem, Math.max(1, mightOf(foe)))
          dead.push(...applyTargetDamage(s, foe.iid, give, true, controller))
          rem -= give
        }
      }
      const kills = dead.length
      s = fireDeaths(s, dead)
      if (dm.side === 'gainXpPerKill' && kills > 0) { s.players[controller].xp += kills; s.players[controller].xpGainedThisTurn = true; s = log(s, controller, `${card.name}: gained ${kills} XP.`) }
      if (dm.side === 'move' && battlefieldOf(s, dealer.iid) < 0) {
        const moved = pluckCardAnywhere(s, dealer.iid)
        if (moved) { s.battlefields[bf.i].units.push(moved); recomputeControllers(s) }
      }
      return log(s, controller, `${card.name}: ${getCard(dealer.cardId)?.name} dealt ${amt} to ${bf.foes.length} enemy unit(s).`)
    }
    // singleEnemy: "(ready a friendly unit.) It deals damage equal to its Might to an enemy."
    const foe = chosen(false) ?? pickEnemyToDamage(enemiesAll, controller, amt) ?? enemiesAll.sort((a, b) => statOf(b) - statOf(a))[0]
    if (!foe) return log(s, controller, `${card.name} fizzled — no enemy unit.`)
    if (/ready a friendly unit/i.test(card.text ?? '')) { const d = findUnitAnywhere(s, dealer.iid); if (d) d.exhausted = false }
    s = log(s, controller, `${card.name}: ${getCard(dealer.cardId)?.name} dealt ${amt} to ${getCard(foe.cardId)?.name}.`)
    return fireDeaths(s, applyTargetDamage(s, foe.iid, amt, true, controller))
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
    const tgts = (targets ?? []).filter((t) => {
      if (!isValidTarget(s, t)) return false
      const tu = findUnitAnywhere(s, t) // can't choose an enemy unit that's targeting-immune
      return !(tu && tu.owner !== controller && untargetableByEnemy(s, tu))
    })
    if (tgts.length === 0 && !hasUntargetedPart(e))
      s = log(s, controller, `${card.name} fizzled — no valid target.`)
    let stunnedEnemy = false
    let stunnedEnemyBf = -1 // Vex - Mocking: the battlefield where the stun happened (for "move me there")
    for (const t of tgts) {
      s = fireTargetedSelf(s, controller, t) // Jae Medarda / Irelia - Fervent "when you choose me"
      {
        // The Dreaming Tree: the first time per turn you choose YOUR unit at this
        // battlefield with a spell, you draw 1.
        const dtBf = battlefieldOf(s, t)
        const dtu = findUnitAnywhere(s, t)
        if (dtu && dtu.owner === controller && dtBf >= 0 && bfBaseNameAt(s, dtBf) === 'The Dreaming Tree') {
          const cp = s.players[controller]
          const dtKey = `dreaming-tree-bf${dtBf}`
          if (!cp.oncePerTurnUsed) cp.oncePerTurnUsed = {}
          if (!cp.oncePerTurnUsed[dtKey]) {
            cp.oncePerTurnUsed[dtKey] = true
            drawN(cp, 1)
            s = log(s, controller, 'The Dreaming Tree: drew 1 (chose a friendly unit here).')
          }
        }
      }
      let dead: EngineCard[] = []
      // Smite: mark the target so a death from this damage banishes it instead.
      if (e.banishOnDeath) {
        const tu = findUnitAnywhere(s, t)
        if (tu) tu.banishShield = true
      }
      if (e.damage) {
        dead = applyTargetDamage(s, t, e.damage, true, controller)
        s = log(s, controller, `${card.name} dealt ${e.damage}.`)
      } else if (e.kill) {
        // "with N Might or less" restriction (Soul Harvest): skip if too big.
        const tu = findUnitAnywhere(s, t)
        if (e.killMightMax != null && tu && mightOf(tu) > e.killMightMax) {
          s = log(s, controller, `${card.name}: ${getCard(tu.cardId)?.name} has too much Might to kill.`)
        } else {
          dead = killTarget(s, t, true)
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
          // Existential Dread: "[Stun] an attacking enemy unit. If it's already
          // stunned, return it to its owner's hand instead." (Solari Chief uses
          // 'kill'.) The alternate fires only when the target was already stunned.
          if (u.stunned && e.ifTargetStunned === 'bounce') {
            s = bounceUnitToHand(s, t, controller, card.name, e.channelExhausted)
          } else if (u.stunned && e.ifTargetStunned === 'kill') {
            s = fireDeaths(s, killTarget(s, t))
          } else {
            u.stunned = true
            if (u.owner !== controller) { stunnedEnemy = true; stunnedEnemyBf = battlefieldOf(s, t) }
            emit({ kind: 'stun', iid: t, player: controller })
            s = log(s, controller, `${card.name} stunned ${getCard(u.cardId)?.name}.`)
          }
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
      if (e.grantShield || e.grantTank) {
        const u = findUnitAnywhere(s, t)
        if (u) {
          if (e.grantShield) u.grantShield = (u.grantShield ?? 0) + e.grantShield
          if (e.grantTank) u.grantTank = true
          emit({ kind: 'buff', iid: t, player: controller })
          s = log(s, controller, `${card.name}: ${getCard(u.cardId)?.name} gains ${e.grantShield ? `[Shield ${e.grantShield}]` : ''}${e.grantShield && e.grantTank ? ' and ' : ''}${e.grantTank ? '[Tank]' : ''} this turn.`)
        }
      }
      if (e.tempMight) {
        // Friendship: "+1 Might for each of Bird/Cat/Dog/Poro among your units."
        const amt = e.tribeTagCount ? e.tempMight * tribeTagCount(s, controller) : e.tempMight
        const more = applyTempMight(s, t, amt, e.tempMightFloor)
        dead = dead.concat(more)
        s = log(s, controller, `${card.name}: ${amt > 0 ? '+' : ''}${amt} Might this turn.`)
      }
      if (e.bounce) s = bounceUnitToHand(s, t, controller, card.name, e.channelExhausted)
      if (e.moveToBase) {
        const mu = findUnitAnywhere(s, t)
        const nm = getCard(mu?.cardId ?? '')?.name ?? 'a unit'
        const srcBf = battlefieldOf(s, t)
        if (mu && (unitCantMoveToBase(mu) || globalNoMoveToBaseActive(s)))
          s = log(s, controller, `${card.name}: ${nm} can't be moved to base.`)
        else if (mu && sendUnitToBase(s, t)) {
          s = log(s, controller, `${card.name}: moved ${nm} to its base.`)
          // Isolate: "Then, if there's an enemy unit alone at that battlefield, draw 1."
          if (card.name === 'Isolate' && srcBf >= 0) {
            const left = s.battlefields[srcBf].units
            if (left.length === 1 && left[0].owner !== controller) {
              drawN(p, 1)
              s = log(s, controller, 'Isolate: an enemy is alone there — drew 1.')
            }
          }
        }
      }
      if (e.moveUnit) {
        // "Move an enemy unit" (Charm) — the caster picks the destination
        // battlefield via a pendingChoice (offered for the first moved target).
        const mu = findUnitAnywhere(s, t)
        const here = battlefieldOf(s, t)
        let destBfs = s.battlefields.map((b, i) => ({ i, b })).filter(({ i }) => i !== here)
        // Temptation: "Move an enemy unit to a location where there's a unit with the
        // same controller." Restrict to bfs holding another unit owned by the moved unit.
        if (card.name === 'Temptation' && mu)
          destBfs = destBfs.filter(({ b }) => b.units.some((u) => u.owner === mu.owner && u.iid !== mu.iid))
        const dests = destBfs.map(({ i }) => ({ iid: `bf:${i}`, label: bfBaseNameAt(s, i) || `Battlefield ${i + 1}` }))
        if (mu && dests.length) {
          offerChoice(s, { player: controller, kind: 'moveToBf', bfIndex: here, prompt: `Move ${getCard(mu.cardId)?.name ?? 'the unit'} to which battlefield?`, options: dests, payload: t, srcName: card.name })
        }
      }
      if (e.deathShield) {
        const su = findUnitAnywhere(s, t)
        if (su) { su.deathShield = true; s = log(s, controller, `${card.name}: ${getCard(su.cardId)?.name} is protected from its next death this turn.`) }
      }
      if (dead.length && e.drawOnKill) {
        const drew = drawN(p, e.drawOnKill)
        s = log(s, controller, `${card.name}: drew ${drew} (a unit died).`)
      }
      s = fireDeaths(s, dead, controller)
    }
    // "When you stun an enemy unit / one or more enemy units" — fire once per
    // resolution (Eclipse Herald, Leona - Radiant Dawn).
    if (stunnedEnemy) s = fireStun(s, controller, stunnedEnemyBf)
  }

  // Vision / Predict spells: peek the top of your Main Deck; the controller may
  // recycle it. Surfaced as a pending decision (same look as the keyword).
  const kw = parseKeywords(card)
  if ((kw.vision || kw.predict) && p.zones.mainDeck.length > 0) {
    s = { ...s, vision: { player: controller, cardId: p.zones.mainDeck[0].cardId } }
    s = log(s, controller, `${kw.predict ? 'Predict' : 'Vision'} — look at the top of your deck; you may recycle it.`)
  }

  if (e.manual && !hasTargetedPart(e) && !hasUntargetedPart(e))
    s = log(s, controller, `Cast ${card.name} — resolve its effect manually.`)
  return s
}

/** Auto-pick targets for a spell being auto-resolved (Fizz / Kai'Sa replay): the
 *  strongest enemy (damage/kill/stun) or a friendly unit (buff / +Might), up to the
 *  spell's targetCount, preferring units at `bfIndex` then anywhere. */
function autoSpellTargets(s: MatchState, player: PlayerId, card: Card, bfIndex: number): string[] {
  const e = spellEffect(card)
  if (!hasTargetedPart(e)) return []
  const here = bfIndex >= 0 ? s.battlefields[bfIndex].units : []
  const all = s.battlefields.flatMap((b) => b.units)
  const want = e.targetScope === 'friendly' ? 'friendly' : 'enemy'
  const pool = want === 'friendly'
    ? [...s.players[player].zones.base, ...all].filter((u) => u.owner === player && def(u)?.type === 'unit')
    : (here.some((u) => u.owner !== player) ? here : all).filter((u) => u.owner !== player && def(u)?.type === 'unit')
  const ranked = [...pool].sort((a, b) => mightOf(b) - mightOf(a))
  return ranked.slice(0, Math.max(1, e.targetCount || 1)).map((u) => u.iid)
}

/** Play the best qualifying spell from your trash, then recycle it — Fizz -
 *  Trickster (Energy ≤ N) / Kai'Sa - Evolutionary (Energy < your points). The
 *  Energy cost is ignored (Power still paid). State-threaded: call from PLAY_UNIT
 *  / fireTriggers, NOT applyParsed. */
function replaySpellFromTrash(
  s: MatchState,
  player: PlayerId,
  spec: NonNullable<ParsedEffect['playSpellFromTrash']>,
  bfIndex: number,
): MatchState {
  const p = s.players[player]
  const cap = spec.dynamicCap === 'points' ? p.points : spec.maxEnergy
  const energyOf = (c: EngineCard) => (getCard(c.cardId) as { energy?: number } | undefined)?.energy ?? 0
  const qualifies = (c: EngineCard) => {
    if (getCard(c.cardId)?.type !== 'spell') return false
    if (cap == null) return true
    return spec.dynamicCap === 'points' ? energyOf(c) < cap : energyOf(c) <= cap
  }
  const pick = p.zones.trash.filter(qualifies).sort((a, b) => energyOf(b) - energyOf(a))[0]
  if (!pick) return s // optional ("you may") — nothing to replay
  const card = getCard(pick.cardId)!
  // The Energy cost is waived; the Power cost is still due. Abort if it can't be paid.
  const powerDue = spec.energyOnly
    ? Object.values((card as { power?: Record<string, number> }).power ?? {}).reduce((a, b) => a + (b || 0), 0)
    : 0
  if (powerDue > 0 && !makeBfApi(s).payPowerAny(player, powerDue))
    return log(s, player, `Couldn't replay ${card.name} from trash — can't pay its Power cost.`)
  const i = p.zones.trash.findIndex((x) => x.iid === pick.iid)
  const [spell] = p.zones.trash.splice(i, 1)
  s = log(s, player, `Replayed ${card.name} from trash (Energy ignored${powerDue ? `, paid ${powerDue} Power` : ''}).`)
  s = resolveSpellEffects(s, player, card, autoSpellTargets(s, player, card, bfIndex))
  // Recycle it (to the Main Deck) after resolving, per the card text.
  if (spec.recycleAfter) s.players[player].zones.mainDeck.push({ ...spell, damage: 0, exhausted: false, attached: [] })
  else sendToTrash(s.players[player], spell)
  return s
}

/** Outright kill a unit anywhere by iid (no damage roll). Returns it for death
 *  triggers. */
function killTarget(s: MatchState, iid: string, spellKill = false): EngineCard[] {
  for (let bi = 0; bi < s.battlefields.length; bi++) {
    const bf = s.battlefields[bi]
    const idx = bf.units.findIndex((u) => u.iid === iid)
    if (idx >= 0) {
      const [u] = bf.units.splice(idx, 1)
      u.diedAtBf = bi // for location-scoped death triggers (Kog'Maw)
      if (tryRecallInsteadOfDeath(s, u, bi)) { recallToBase(s, u); recomputeControllers(s); return [] }
      if (trashOrBanish(s, u)) { recomputeControllers(s); return [] }
      if (spellKill) u.killedBySpell = true
      emit({ kind: 'defeat', iid, cardId: u.cardId })
      recomputeControllers(s)
      return [u]
    }
  }
  for (const p of s.players) {
    const idx = p.zones.base.findIndex((u) => u.iid === iid)
    if (idx >= 0) {
      const [u] = p.zones.base.splice(idx, 1)
      if (tryRecallInsteadOfDeath(s, u)) { recallToBase(s, u); return [] }
      if (trashOrBanish(s, u)) return []
      if (spellKill) u.killedBySpell = true
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
  // Hard Bargain: "Counter a spell unless its controller pays N." If the target's
  // controller can afford it, PAUSE here (leave both items on the chain) and offer
  // them the choice; the counter is finished in RESOLVE_CHOICE. PASS_PRIORITY guards
  // on pendingChoice so the loop doesn't re-enter while we wait.
  if (item.kind === 'counter') {
    const unlessM = (getCard(item.cardId)?.text ?? '').toLowerCase().match(/counter a spell unless its controller pays :rb_energy_(\d+):/)
    const tgt = unlessM ? s.chain.find((c) => c.id === item.countersId) : undefined
    if (unlessM && tgt && canPayEnergy(s, tgt.controller, parseInt(unlessM[1], 10))) {
      const n = parseInt(unlessM[1], 10)
      s.pendingChoice = {
        player: tgt.controller, kind: 'counterUnlessPay', bfIndex: -1,
        prompt: `${getCard(item.cardId)?.name}: pay ${n} Energy to save ${getCard(tgt.cardId)?.name ?? 'your spell'}, or let it be countered?`,
        options: [{ iid: 'pay', label: `Pay ${n} Energy` }, { iid: 'decline', label: 'Let it be countered' }],
        payload: JSON.stringify({ counterId: item.id, targetId: tgt.id, n }),
      }
      return s // both items stay on the chain; finished in RESOLVE_CHOICE
    }
  }
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
  if (card) {
    s = resolveSpellEffects(s, item.controller, card, item.targets)
    // [Repeat]: resolve the effect an extra time per paid repeat.
    for (let r = 0; r < (item.repeat ?? 0); r++) {
      s = log(s, item.controller, `${card.name}: Repeat — resolving its effect again.`)
      s = resolveSpellEffects(s, item.controller, card, item.targets)
    }
  }
  sendToTrash(p, item.instance)
  return s
}

/** Public reducer: resets the feedback-event buffer, applies the action, and
 *  attaches any emitted events to the result. */
/** Finish interactive setup: apply champion picks, build the chosen battlefields
 *  (4-player: the first player's is dropped), set pointsToWin. Hands are already
 *  drawn (on entry to the 'select' step) and mulligans already applied (per
 *  SUBMIT_PREGAME). The caller starts the game (beginTurn). Mutates and returns
 *  `s` (caller has already cloned). */
function finalizeSetup(s: MatchState): MatchState {
  const su = s.setup!
  const n = s.players.length
  const first = s.firstPlayer
  su.championPick.forEach((id, i) => {
    // Set aside the Chosen Champion (idempotent — SUBMIT_PREGAME already did it).
    if (id) pullChampion(s.players[i], id, i)
  })
  // Safety net: ensure every player has an opening hand (idempotent).
  drawOpeningHands(s)
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
  return log(s, null, 'Setup complete.')
}

/** Set aside a player's Chosen Champion in the Champion Zone. Searches the main
 *  deck first, then the (already-drawn) opening hand; pulling from the hand
 *  draws a replacement so hand size is preserved. Idempotent if already set. */
function pullChampion(p: PlayerState, id: string, seat: PlayerId): void {
  if (p.champion) return
  const baseName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const bn = baseName(getCard(id)?.name ?? '')
  const match = (c: EngineCard) =>
    c.cardId === id || baseName(getCard(c.cardId)?.name ?? '') === bn
  let idx = p.zones.mainDeck.findIndex(match)
  if (idx >= 0) {
    const pulled = p.zones.mainDeck.splice(idx, 1)[0]
    p.champion = { ...pulled, cardId: id }
    return
  }
  idx = p.zones.hand.findIndex(match)
  if (idx >= 0) {
    const pulled = p.zones.hand.splice(idx, 1)[0]
    p.champion = { ...pulled, cardId: id }
    if (p.zones.mainDeck.length > 0) p.zones.hand.push(p.zones.mainDeck.shift()!)
    return
  }
  p.champion = { iid: `${seat}:champ:${id}`, cardId: id, owner: seat, exhausted: false, damage: 0, attached: [] }
}

/** Draw each player's opening hand (idempotent) so the concurrent 'select'
 *  step can show hands for the mulligan. Interactive setup deferred the draw
 *  past the roll (Core Rules §117–118); we draw it on entry to 'select'. */
function drawOpeningHands(s: MatchState): void {
  for (const p of s.players) {
    if (p.zones.hand.length === 0)
      for (let k = 0; k < RULES.openingHand && p.zones.mainDeck.length > 0; k++)
        p.zones.hand.push(p.zones.mainDeck.shift()!)
  }
}

/** Advance the setup state into the single concurrent 'select' step. Champion +
 *  Battlefield + mulligan all happen at once there, gated by per-player Ready
 *  (the legacy sequential 'champion'/'battlefield' steps are no longer used).
 *  Single options are pre-filled as defaults but a Ready submit is still
 *  required so the barrier is uniform. */
function advanceSetup(s: MatchState): EngineResult {
  const su = s.setup!
  if (!su.ready) su.ready = s.players.map(() => false)
  // Out players don't gate the start — count them as ready.
  su.ready = s.players.map((p, i) => (p.out ? true : (su.ready?.[i] ?? false)))
  su.step = 'select'
  drawOpeningHands(s)
  return ok(s)
}

export function reduce(state: MatchState, action: Action): EngineResult {
  pendingEvents = []
  const result = reduceInner(state, action)
  // State transition pass (becomes-[Mighty] etc.) runs after every successful action.
  if (!result.error) result.state = refreshStates(result.state)
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
      // Move into the single concurrent pre-game step (Champion + Battlefield +
      // mulligan all at once, gated by per-player Ready / SUBMIT_PREGAME).
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

    case 'SUBMIT_PREGAME': {
      if (state.phase !== 'setup' || state.setup?.step !== 'select')
        return fail(state, 'Not the pre-game selection step.')
      const su0 = state.setup
      const pl = action.player
      if (pl < 0 || pl >= state.players.length) return fail(state, 'Invalid player.')
      if (state.players[pl].out) return fail(state, 'You are out of the match.')
      if (su0.ready?.[pl]) return fail(state, 'You are already ready.')
      // Validate the champion pick against this player's options. null is allowed
      // only when there's no real choice (≤1 option); else default to the first.
      const champOpts = su0.championOptions[pl] ?? []
      let championId = action.championId
      if (championId == null) championId = champOpts.length > 0 ? champOpts[0] : null
      if (championId != null && !champOpts.includes(championId))
        return fail(state, 'That champion is not an option for you.')
      // Validate the battlefield pick the same way.
      const bfOpts = su0.battlefieldOptions[pl] ?? []
      let battlefieldId = action.battlefieldId
      if (battlefieldId == null) battlefieldId = bfOpts.length > 0 ? bfOpts[0] : null
      if (battlefieldId != null && !bfOpts.includes(battlefieldId))
        return fail(state, 'That battlefield is not an option for you.')
      if (action.toBottom.length > 2)
        return fail(state, 'You may set aside at most 2 cards.')

      let s = clone(state)
      const su = s.setup!
      const p = s.players[pl]
      su.championPick[pl] = championId
      su.battlefieldPick[pl] = battlefieldId
      if (action.playmatId) p.playmatId = action.playmatId
      // Set aside the Chosen Champion now (before the mulligan redraw, so it
      // can't be drawn back), then apply the mulligan to the opening hand.
      if (championId != null) pullChampion(p, championId, pl)
      const setAside: EngineCard[] = []
      for (const iid of action.toBottom) {
        const c = removeFromZone(p, 'hand', iid)
        if (c) setAside.push(c)
      }
      p.zones.mainDeck.push(...setAside)
      for (let i = 0; i < setAside.length && p.zones.mainDeck.length > 0; i++)
        p.zones.hand.push(p.zones.mainDeck.shift()!)
      p.mulliganed = true
      su.ready = s.players.map((_, i) => (i === pl ? true : (su.ready?.[i] ?? false)))
      s = log(
        s,
        pl,
        setAside.length ? `${p.name} is ready (mulliganed ${setAside.length}).` : `${p.name} is ready.`,
      )
      // Start the game once every non-out player has submitted.
      const allReady = s.players.every((pl2, i) => pl2.out || su.ready?.[i])
      if (allReady) return ok(beginTurn(finalizeSetup(s)))
      return ok(s)
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
      // Brynhir Thundersong: "opponents can't play cards this turn."
      if (state.players[action.player]?.cantPlayCardsThisTurn) return fail(state, "You can't play cards this turn.")

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

      // Mageseeker Warden (enemy): "Opponents can only play units to their base."
      if (enemyWardenAtBf(state, action.player)) {
        if (action.type !== 'PLAY_UNIT')
          return fail(state, 'Mageseeker Warden: you can only play units to your base.')
        if ((action as { toBattlefield?: number | null }).toBattlefield != null)
          return fail(state, 'Mageseeker Warden: units must be played to your base.')
      }

      const s = clone(state)
      const p = s.players[action.player]
      const ci = fromChampion ? p.champion! : findInZone(p, 'hand', action.iid)!

      // Accelerate is an OPTIONAL extra cost: when the player opts in, fold it
      // into the cost (so the payment must cover it) and the unit enters ready.
      const accelChosen =
        action.type === 'PLAY_UNIT' && !!action.accelerate && !!accelerateCost(card)
      const baseCost = effectiveCostOf(s, action.player, card, { fromZone: 'hand', targets: (action as { targets?: string[] }).targets })
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
      // Optional "you may pay X as an additional cost to play me" (Clockwork Keeper,
      // Blast Corps Cadet, Frostcoat Cub, Sea Monkey, Akshan). Opt-in via the action;
      // fold the cost in now and gate the "if you paid" bonus on `paidAdditional`.
      const optPlayCost = action.type === 'PLAY_UNIT' ? optionalPlayCost(card) : null
      // Crescent Guardian: the optional Chaos cost is only OFFERED if you've already
      // played a spell this turn — gate the opt-in on spellPlayedThisTurn so a bogus
      // payAdditionalCost can't fold the cost or grant enter-ready when the gate is unmet.
      const crescentGate = action.type === 'PLAY_UNIT' && /if you've played a spell this turn, you may pay/i.test(card.text ?? '')
      const paidAdditional = action.type === 'PLAY_UNIT' && !!action.payAdditionalCost && !!optPlayCost && (!crescentGate || !!p.spellPlayedThisTurn)
      if (paidAdditional) effCost = addCost(effCost, optPlayCost!)
      // Brazen Buccaneer: "you may discard 1 as an additional cost. If you do, reduce my
      // cost by N Energy." The discount must land before payment; the discard itself is
      // deferred to after placement (where s1 exists). Opting in with an empty hand is
      // illegal (can't pay the cost). Auto-discards the cheapest other hand card.
      const brazenM = action.type === 'PLAY_UNIT'
        ? (card.text ?? '').match(/you may discard \d+ as an additional cost\.?\s*if you do,?\s*reduce my cost by :rb_energy_(\d+):/i)
        : null
      let brazenDiscardIid: string | null = null
      if (brazenM && action.type === 'PLAY_UNIT' && action.payAdditionalCost) {
        const energyOf = (cid: string) => (getCard(cid) as { energy?: number } | undefined)?.energy ?? 0
        const cand = p.zones.hand.filter((c) => c.iid !== action.iid)
        if (!cand.length) return fail(state, `Can't play ${card.name}: no card to discard for its additional cost.`)
        const pick = cand.reduce((lo, c) => (energyOf(c.cardId) <= energyOf(lo.cardId) ? c : lo))
        brazenDiscardIid = pick.iid
        effCost = { ...effCost, energy: Math.max(0, effCost.energy - parseInt(brazenM[1], 10)) }
      }
      // Atakhan: "you may kill a friendly unit as an additional cost … If you do, I cost
      // 1 Energy less for each Energy it costs and 1 Order less for each Power it costs."
      // Discount uses the victim's PRINTED base cost; the kill is deferred to after
      // placement. Auto-picks the lowest-Might friendly unit; opting in with none = fail.
      const atakhanM = action.type === 'PLAY_UNIT' && /you may kill a friendly unit as an additional cost to play me\.?\s*if you do, i cost/i.test(card.text ?? '')
      let atakhanVictimIid: string | null = null
      if (atakhanM && action.type === 'PLAY_UNIT' && action.payAdditionalCost) {
        const cands = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === action.player && getCard(u.cardId)?.type === 'unit')
        if (!cands.length) return fail(state, `Can't play ${card.name}: no friendly unit to kill for its additional cost.`)
        const victim = cands.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
        atakhanVictimIid = victim.iid
        const vcard = getCard(victim.cardId)
        const vc = vcard ? costOf(vcard) : { energy: 0, power: {} }
        const pDisc = Object.values(vc.power).reduce((a, b) => a + (b ?? 0), 0)
        effCost = { ...effCost, energy: Math.max(0, effCost.energy - vc.energy), power: { ...effCost.power, order: Math.max(0, (effCost.power.order ?? 0) - pDisc) } }
      }
      const err = applyPayment(p, effCost, action.payment)
      if (err) return fail(state, err)
      // Recap signal: how this play was paid (runes exhausted / recycled). Emitted
      // once per play (unit/gear/spell), alongside the 'play' event(s) below.
      emit({
        kind: 'payment',
        player: action.player,
        cardId: card.id,
        exhaust: action.payment.exhaust.length,
        recycle: action.payment.recycle.length,
      })
      // A card's "cost" for threshold triggers (Lux — "a spell that costs 5+") is
      // total Energy + Power, not just Energy.
      const effTotal = effCost.energy + Object.values(effCost.power).reduce((a, b) => a + (b ?? 0), 0)

      if (fromChampion) p.champion = null
      else removeFromZone(p, 'hand', action.iid)
      const kw = parseKeywords(card)
      // LEGION is "on" if you already played another Main Deck card this turn.
      const legionActive = (p.cardsPlayedThisTurn ?? 0) >= 1
      p.cardsPlayedThisTurn = (p.cardsPlayedThisTurn ?? 0) + 1
      fireSecondCardPlayed(s, action.player) // Darius - Trifarian
      // The Academy grant applies to one spell, consumed when that spell is played.
      if (card.type === 'spell') p.grantRepeatNextSpell = false

      if (action.type === 'PLAY_UNIT') {
        // Units enter exhausted unless the player paid Accelerate, an active
        // [Level N] grants "enters ready", a base "I enter ready" ability (Master
        // Yi - Honed), or the controller's legend grants it (Wuju Master L11).
        const levelReady = levelBonus(card, p.xp).ready
        // Leona - Zealot: "If an opponent's score is within N points of the Victory
        // Score, I enter ready." — a CONDITIONAL enter-ready, not unconditional.
        const scoreReadyM = (card.text ?? '').toLowerCase().match(/if an opponent'?s score is within (\d+) points? of the victory score, i enter(?:s)? ready/)
        // The sentence carrying "I enter ready". If it has an "if …" guard, route it
        // through enterReadyConditionMet instead of treating it as unconditional.
        const readyClause = (card.text ?? '').split(/[.;]/).find((seg) => /\bi enters? ready\b/i.test(seg)) ?? ''
        const readyGuarded = /\bif\b/i.test(readyClause)
        const baseReady = /\bi enters? ready\b/i.test(card.text ?? '') && !scoreReadyM && !readyGuarded
        // Wuju Master: "[Level 11] Your units enter ready." while the controller has 11+ XP.
        const legText = (getCard(p.legend?.cardId ?? '')?.text ?? '').toLowerCase()
        const legReadyM = legText.match(/\[level\s*(\d+)\][^.]*?your units enter(?:s)? ready/)
        const legendReady = !!legReadyM && p.xp >= parseInt(legReadyM[1], 10)
        // Conditional enter-ready: Monch (opponent controls a stunned unit) and
        // Leona - Zealot (an opponent is within N points of winning).
        const monchReady = /if an opponent controls a stunned unit,[^.]*?enter(?:s)? ready/i.test(card.text ?? '')
          && [...s.battlefields.flatMap((b) => b.units), ...s.players.flatMap((pl) => pl.zones.base)]
            .some((u) => u.owner !== action.player && u.stunned)
        const leonaReady = !!scoreReadyM
          && s.players.some((pl, i) => i !== action.player && s.pointsToWin - pl.points <= parseInt(scoreReadyM[1], 10))
        // General conditional enter-ready guard (Direwing, Breakneck Mech, Vayne,
        // Towering Pairofant, Dunebreaker, Xin Zhao, Shadow Watcher, Shadow).
        const guardReady = readyGuarded && enterReadyConditionMet(s, p, readyClause, action.toBattlefield ?? null)
        const condReady = monchReady || leonaReady || guardReady
        // "you may pay X as an additional cost … If you do, I enter ready" (Crescent
        // Guardian) — entering ready is the paid-bonus, granted only when the cost was paid.
        const paidEnterReady = paidAdditional && /if you do,?\s*i enters? ready/i.test(card.text ?? '')
        // Sun Disc: "the next unit you play this turn enters ready" — consume the flag.
        const sunDiscReady = !!p.nextUnitEntersReadyThisTurn
        if (sunDiscReady) p.nextUnitEntersReadyThisTurn = false
        const entersReady = accelChosen || levelReady || baseReady || legendReady || condReady || paidEnterReady || sunDiscReady || friendlyUnitsEnterReadyAura(s, action.player)
        // Required additional cost "As an additional cost to play me, kill a <X>
        // you control" (Stalking Wolf → Bird/Cat/Dog/Poro; Cruel Patron → any
        // friendly unit). Pick the lowest-Might qualifier now (the kill resolves
        // after placement); if none exists the cost can't be paid → reject.
        let killCostBf = -1
        let killCostVictim: string | null = null
        const ctext = (card.text ?? '').toLowerCase()
        if (/as an additional cost to play me, kill /.test(ctext)) {
          const tribes = ['bird', 'cat', 'dog', 'poro']
          const wantsTribe = tribes.some((t) => new RegExp(`kill[^.]*\\b${t}\\b`).test(ctext))
          const candidates = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((x) =>
            x.owner === action.player && getCard(x.cardId)?.type === 'unit' &&
            (wantsTribe ? (getCard(x.cardId)?.tags ?? []).some((tag) => tribes.includes(tag.toLowerCase())) : true),
          )
          if (!candidates.length) return fail(state, `Can't play ${card.name}: no valid unit to kill for its additional cost.`)
          const victim = candidates.reduce((lo, x) => (mightOf(x) < mightOf(lo) ? x : lo))
          killCostVictim = victim.iid
          killCostBf = battlefieldOf(s, victim.iid) // Stalking Wolf may enter at its battlefield
        }
        // Ambush: a Reaction unit enters directly at a contested battlefield. Stalking
        // Wolf may also enter at the battlefield of the unit it killed (even alone).
        const ambushBf = kw.ambush ? (action.toBattlefield ?? (killCostBf >= 0 ? killCostBf : null)) : null
        // A non-Ambush unit whose rules let it be played straight to a battlefield
        // (Blitzcrank - Impassive, Mischievous Marai, Shadow). Honoured only when the
        // player chose a destination. Shadow "enters ready" when played to a battlefield.
        // Miss Fortune - Buccaneer aura: "Friendly units may be played to open battlefields
        // while I'm here." When the player controls her AT a battlefield, any friendly unit
        // may be played to an EMPTY (open) battlefield, even without its own play-to-bf text.
        const mfOpenBfAura = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)].some(
          (u) => u.owner === action.player && battlefieldOf(s, u.iid) >= 0 && /friendly units may be played to open battlefields/i.test(getCard(u.cardId)?.text ?? ''),
        )
        const canPlayToBf = (!kw.ambush && /play (?:me|this) (?:only )?to (?:a|an|any|its)?\s*(?:open |occupied enemy )?battlefield/i.test(card.text ?? ''))
          || (mfOpenBfAura && action.toBattlefield != null && (s.battlefields[action.toBattlefield]?.units.length ?? 0) === 0)
        // Placement predicates — which battlefield is a legal destination.
        const wantsOpenBf = canPlayToBf && /open battlefield/i.test(card.text ?? '')
        const wantsEnemyOccupiedBf = canPlayToBf && /occupied enemy battlefield/i.test(card.text ?? '')
        const wantsConqueredBf = canPlayToBf && /conquered this turn/i.test(card.text ?? '')
        if (wantsOpenBf && action.toBattlefield != null && (s.battlefields[action.toBattlefield]?.units.length ?? 0) > 0)
          return fail(state, `${card.name} can only be played to an open battlefield.`)
        if (wantsEnemyOccupiedBf && action.toBattlefield != null && !s.battlefields[action.toBattlefield]?.units.some((u) => u.owner !== action.player))
          return fail(state, `${card.name} must be played to a battlefield with enemy units.`)
        if (wantsConqueredBf && (action.toBattlefield == null || !(s.players[action.player].conqueredThisTurn ?? []).includes(action.toBattlefield)))
          return fail(state, `${card.name} can only be played to a battlefield you conquered this turn.`)
        const playToBf = canPlayToBf && action.toBattlefield != null ? action.toBattlefield : null
        const enterBf = ambushBf != null ? ambushBf : playToBf
        const priorBfController = enterBf != null ? s.battlefields[enterBf].controller : null
        if (enterBf != null) {
          // Ambush always enters ready; a play-to-battlefield enters ready only if it
          // otherwise would (Accelerate/Level) or its own "enter ready" rule applies.
          const readyHere = ambushBf != null || entersReady || /if you play (?:me|this) to a battlefield, i enters? ready/i.test(card.text ?? '')
          s.battlefields[enterBf].units.push({ ...ci, exhausted: !readyHere, enteredTurn: s.turn })
          recomputeControllers(s)
          bfUnitPlayedHere(s, action.player, enterBf, ci.iid) // Valley of Idols / Star Spring
        } else {
          p.zones.base.push({ ...ci, exhausted: !entersReady, enteredTurn: s.turn })
        }
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        let s1 = log(
          s,
          action.player,
          `Played ${card.name}${ambushBf != null ? ' (Ambush)' : playToBf != null ? ` to ${bfBaseNameAt(s, playToBf) || `Battlefield ${playToBf + 1}`}` : accelChosen ? ' (ready · Accelerate)' : levelReady ? ' (ready · Level)' : ''}.`,
        )
        // Pay the required kill cost now that the unit is in play.
        if (killCostVictim) {
          const vName = getCard(findUnitAnywhere(s1, killCostVictim)?.cardId ?? '')?.name ?? 'a unit'
          s1 = fireDeaths(s1, killTarget(s1, killCostVictim))
          s1 = log(s1, action.player, `${card.name}: killed ${vName} as an additional cost.`)
        }
        // Zaun Punk: "You may kill a friendly gear as an additional cost to play me.
        // When you play me, if you paid the additional cost, kill a gear." The generic
        // parser reads "kill a friendly gear" as an unconditional killGear, so suppress
        // it (below) and resolve both kills bespoke. Opting in with no friendly gear is
        // illegal (mirrors the killCostVictim path). The bonus "kill a gear" auto-picks
        // an enemy gear first (one-sided removal), falling back to any remaining gear.
        // The first-sentence "kill a friendly gear" mis-parses to an unconditional
        // killGear, so suppress the generic apply for this card (isZaunPunk) whether or
        // not the cost was paid; the paid branch (zaunPunk) resolves both kills bespoke.
        const isZaunPunk = /you may kill a friendly gear as an additional cost to play (?:me|this)/i.test(ctext)
        const zaunPunk = !!action.payAdditionalCost && isZaunPunk
        // Safety Inspector: optional 3-XP cost; on play EACH player kills their weakest
        // unit, but the controller is exempt if they paid the XP. Suppress generic apply
        // (the parser shouldn't mis-handle "each player must kill one of their units").
        const isSafetyInspector = /you may spend \d+ xp as an additional cost to play me/i.test(ctext) && /each player must kill one of their units/i.test(ctext)
        if (zaunPunk) {
          const friendlyGear = allGearInPlay(s1).filter((g) => g.owner === action.player)
          if (!friendlyGear.length) return fail(state, `Can't play ${card.name}: no friendly gear to kill for its additional cost.`)
          const costPick = friendlyGear.reduce((lo, g) => (gearEnergyOf(g) <= gearEnergyOf(lo) ? g : lo))
          const costName = getCard(costPick.cardId)?.name ?? 'a gear'
          killGearByIid(s1, costPick.iid)
          s1 = log(s1, action.player, `${card.name}: killed your ${costName} as an additional cost.`)
          let bonus = applyKillGear(s1, action.player, { scope: 'enemy', maxEnergy: null })
          if (!bonus.killed) bonus = applyKillGear(s1, action.player, { scope: 'any', maxEnergy: null })
          for (const ln of bonus.lines) s1 = log(s1, action.player, ln)
        }
        // Brazen Buccaneer: pay the deferred discard cost now (the −Energy discount was
        // already folded into the cost above). Fires the controller's discard triggers.
        if (brazenDiscardIid) {
          const disc = p.zones.hand.find((c) => c.iid === brazenDiscardIid)
          if (disc) {
            removeFromZone(p, 'hand', disc.iid)
            sendToTrash(p, disc)
            s1 = log(s1, action.player, `${card.name}: discarded ${getCard(disc.cardId)?.name ?? 'a card'} as an additional cost.`)
            s1 = fireDiscard(s1, action.player, [disc])
          }
        }
        // Safety Inspector: pay the optional XP cost, then each player culls their
        // weakest unit (the controller skips it if they paid). Opting in without enough
        // XP is illegal. Auto-picks the lowest-Might unit per player (auto-resolve).
        if (isSafetyInspector) {
          const xpM = ctext.match(/you may spend (\d+) xp as an additional cost/)
          const xpCost = xpM ? parseInt(xpM[1], 10) : 3
          let paidXp = false
          if (action.payAdditionalCost) {
            if (p.xp < xpCost) return fail(state, `Can't play ${card.name}: not enough XP (need ${xpCost}).`)
            p.xp -= xpCost
            paidXp = true
            s1 = log(s1, action.player, `${card.name}: spent ${xpCost} XP (you won't kill a unit).`)
          }
          const dead: EngineCard[] = []
          for (const pl of s1.players) {
            if (pl.out) continue
            if (pl.id === action.player && paidXp) continue
            const units = [...pl.zones.base, ...s1.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pl.id && getCard(u.cardId)?.type === 'unit')
            if (!units.length) continue
            const victim = units.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo))
            s1 = log(s1, action.player, `${card.name}: ${pl.name} killed ${getCard(victim.cardId)?.name ?? 'a unit'}.`)
            dead.push(...killTarget(s1, victim.iid))
          }
          if (dead.length) s1 = fireDeaths(s1, dead, action.player)
        }
        // Atakhan: pay the deferred kill cost now (the cost reduction was applied above).
        if (atakhanVictimIid) {
          const vName = getCard(findUnitAnywhere(s1, atakhanVictimIid)?.cardId ?? '')?.name ?? 'a unit'
          s1 = fireDeaths(s1, killTarget(s1, atakhanVictimIid))
          s1 = log(s1, action.player, `${card.name}: killed ${vName} as an additional cost (cost reduced).`)
        }
        const e = onPlayEffect(card)
        const legionGated = kw.legion && !legionActive
        // Insightful Investigator: the parser reads "You may pay 2 XP to choose a card
        // from their hand. If you do, they discard that card and draw 1." as an
        // UNCONDITIONAL strip (+ a draw mis-attributed to the caster). Suppress the
        // generic effect and gate it behind an optional N-XP prompt instead (below).
        const xpStripM = (card.text ?? '').toLowerCase().match(/you may pay (\d+) xp/)
        const insightfulXp = !!xpStripM && (!!e.opponentHandStrip || !!e.opponentDiscards)
        if (!legionGated && !insightfulXp && !isZaunPunk && !isSafetyInspector) {
          for (const line of applyParsed(s1, p, e, undefined, ci.iid)) s1 = log(s1, action.player, line)
          s1 = fireTokenPlay(s1, action.player, tokenUnitsIn(e)) // Lillia: token-unit play synergy
          // Fizz - Trickster: "When you play me, you may play a spell from your trash…"
          if (e.playSpellFromTrash) s1 = replaySpellFromTrash(s1, action.player, e.playSpellFromTrash, ambushBf ?? -1)
          // Raging Firebrand: "the next spell you play this turn costs N less."
          const rfM = (card.text ?? '').toLowerCase().match(/the next spell you play this turn costs :rb_energy_(\d+): less/)
          if (rfM) s1.players[action.player].nextSpellCostDiscount = parseInt(rfM[1], 10)
        } else if (legionGated) {
          s1 = log(s1, action.player, `${card.name}: Legion inactive (no prior card this turn).`)
        }
        // Insightful Investigator: offer the optional 2-XP "they discard + draw 1"
        // (PaymentModal-style yes/no). Auto-targets the opponent holding the most cards.
        if (insightfulXp && !legionGated) {
          const xpCost = parseInt(xpStripM![1], 10)
          const victim = s1.players.filter((pl) => pl.id !== action.player && !pl.out && pl.zones.hand.length > 0).sort((a, b) => b.zones.hand.length - a.zones.hand.length)[0]
          if (victim && p.xp >= xpCost) {
            offerChoice(s1, {
              player: action.player, kind: 'insightfulInvestigator', bfIndex: -1,
              prompt: `${card.name} — pay ${xpCost} XP to make ${victim.name} discard a card and draw 1? (You have ${p.xp} XP)`,
              options: [{ iid: 'pay', label: `Pay ${xpCost} XP` }, { iid: 'decline', label: 'Decline' }],
              payload: JSON.stringify({ victimId: victim.id, xpCost }),
            })
          } else {
            s1 = log(s1, action.player, `${card.name}: ${!victim ? 'no opponent has cards' : 'not enough XP'} — no effect.`)
          }
        }
        // Optional additional-cost bonus — only applied when the player paid it
        // ("When you play me, if you paid the additional cost, …"). Reuses the same
        // applyParsed path the on-play effect uses (so targeting is unchanged).
        if (paidAdditional) {
          s1 = log(s1, action.player, `${card.name}: paid the additional cost.`)
          const pb = paidBonusEffect(card)
          for (const line of applyParsed(s1, p, pb, ambushBf ?? undefined, ci.iid)) s1 = log(s1, action.player, line)
          s1 = fireTokenPlay(s1, action.player, tokenUnitsIn(pb))
        }
        // On-play "deal damage equal to my Might" (dealer='self'): applyParsed has no
        // dealMight branch and resolveCard only handles spell self-dealers, so a played
        // unit's self-dealer clash is resolved here. Carnivorous Snapvine ('mutual':
        // "We deal damage equal to our Mights to each other"); auto-picks the strongest
        // enemy at a battlefield (per the auto-resolve preference) when none is chosen.
        if (e.dealMight?.dealer === 'self' && !legionGated) {
          const self = findUnitAnywhere(s1, ci.iid)
          const statOf = (u: EngineCard) => e.dealMight!.useStat === 'assault'
            ? parseKeywords(getCard(u.cardId)).assault + (u.grantAssault ?? 0)
            : mightOf(u, null, s1.players[u.owner]?.xp ?? 0)
          const foe = s1.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== action.player && getCard(u.cardId)?.type === 'unit').sort((a, b) => statOf(b) - statOf(a))[0]
          if (self && foe) {
            const selfAmt = statOf(self)
            const foeAmt = statOf(foe)
            const dead = [...applyTargetDamage(s1, foe.iid, selfAmt, true, action.player)]
            if (e.dealMight.target === 'mutual') dead.push(...applyTargetDamage(s1, self.iid, foeAmt, true, action.player))
            s1 = log(s1, action.player, e.dealMight.target === 'mutual'
              ? `${card.name}: clashed with ${getCard(foe.cardId)?.name} (${selfAmt} vs ${foeAmt}).`
              : `${card.name}: dealt ${selfAmt} to ${getCard(foe.cardId)?.name}.`)
            s1 = fireDeaths(s1, dead, action.player)
          } else {
            s1 = log(s1, action.player, `${card.name}: no enemy unit to clash with.`)
          }
        }
        // On-play bounce variants the generic `e.bounce` can't express — auto-pick
        // targets (Beast Below / Windsinger / Angler Beast). The just-played source
        // (ci.iid) is never a target.
        if (!legionGated) {
          const txt = (card.text ?? '').toLowerCase()
          const isUnit = (u: EngineCard) => getCard(u.cardId)?.type === 'unit'
          // Beast Below: "return another friendly unit and an enemy unit to their owners' hands."
          if (/return another friendly unit and an enemy unit to their owners'? hands/.test(txt)) {
            const friendly = [...p.zones.base, ...s1.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === action.player && u.iid !== ci.iid && isUnit(u)).sort((a, b) => mightOf(a) - mightOf(b))[0]
            const enemy = s1.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== action.player && isUnit(u)).sort((a, b) => mightOf(b) - mightOf(a))[0]
            if (friendly) s1 = bounceUnitToHand(s1, friendly.iid, action.player, card.name, 0)
            if (enemy) s1 = bounceUnitToHand(s1, enemy.iid, action.player, card.name, 0)
          }
          // Windsinger: "you may return another unit at a battlefield with N Might or less to its owner's hand."
          const winM = txt.match(/return another unit at a battlefield with (\d+)\s*(?::rb_might:|might) or less/)
          if (winM) {
            const cap = parseInt(winM[1], 10)
            const tgt = s1.battlefields.flatMap((b) => b.units).filter((u) => u.iid !== ci.iid && isUnit(u) && mightOf(u) <= cap).sort((a, b) => mightOf(b) - mightOf(a))[0]
            if (tgt) s1 = bounceUnitToHand(s1, tgt.iid, action.player, card.name, 0)
          }
          // Angler Beast: "return all units with N Might or less to their owners' hands." (both sides)
          const allM = txt.match(/return all units with (\d+)\s*(?::rb_might:|might) or less/)
          if (allM) {
            const cap = parseInt(allM[1], 10)
            for (const v of s1.battlefields.flatMap((b) => b.units).filter((u) => u.iid !== ci.iid && isUnit(u) && mightOf(u) <= cap).map((u) => u.iid))
              s1 = bounceUnitToHand(s1, v, action.player, card.name, 0)
          }
          // Dropboarder: "When you play me, if you control two or more gear, ready me."
          const gearReadyM = txt.match(/if you control (two or more|\d+ or more|\d+\+) gear, ready me/)
          if (gearReadyM) {
            const need = /two/.test(gearReadyM[1]) ? 2 : parseInt(gearReadyM[1], 10) || 2
            if (allGearInPlay(s1).filter((g) => g.owner === action.player).length >= need) {
              const self = findUnitAnywhere(s1, ci.iid)
              if (self) { self.exhausted = false; emit({ kind: 'buff', iid: self.iid, player: action.player }) }
            }
          }
          // Brynhir Thundersong: "When you play me, opponents can't play cards this turn."
          if (/opponents can'?t play cards this turn/.test(txt))
            for (const pl of s1.players) if (pl.id !== action.player) pl.cantPlayCardsThisTurn = true
          // Albus Ferros: "When you play me, spend any number of buffs. For each buff
          // spent, channel 1 rune exhausted." Auto-spend all friendly buffs.
          if (/spend any number of buffs/.test(txt) && /channel 1 rune exhausted/.test(txt)) {
            let spent = 0
            for (const u of [...p.zones.base, ...s1.battlefields.flatMap((b) => b.units)])
              if (u.owner === action.player && (u.buffs ?? 0) > 0) { spent += u.buffs ?? 0; u.buffs = 0 }
            if (spent > 0) {
              channelN(p, spent, true)
              for (const l of fireSpendBuffInline(s1, action.player)) s1 = log(s1, action.player, l)
              s1 = log(s1, action.player, `Albus Ferros: spent ${spent} buff(s) → channeled ${spent} exhausted.`)
            }
          }
        }
        // Tideturner: "When you play me, you may choose a unit you control at another
        // location. Move me to its location and it to my original location." Auto-picks
        // the strongest friendly unit elsewhere and swaps (per the auto-resolve policy).
        if (card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Tideturner' && !legionGated) {
          s1 = tideturnerSwap(s1, action.player, ci.iid)
        }
        // Keeper of Masks: when played, play two Reflection copies of itself here.
        if (card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Keeper of Masks' && !legionGated) {
          const dest = ambushBf != null ? s1.battlefields[ambushBf].units : s1.players[action.player].zones.base
          for (let i = 0; i < 2; i++) dest.push(makeReflection(ci, action.player, s1.turn, false))
          if (ambushBf != null) recomputeControllers(s1)
          s1 = log(s1, action.player, `Keeper of Masks: played two Reflection copies.`)
        }
        // Bubble Bot: "When you play me, ready another friendly Mech." Auto-readies an
        // exhausted friendly Mech (not itself).
        if (card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Bubble Bot' && !legionGated) {
          const mech = [...s1.players[action.player].zones.base, ...s1.battlefields.flatMap((b) => b.units)].find(
            (x) => x.owner === action.player && x.iid !== ci.iid && x.exhausted && (getCard(x.cardId)?.tags ?? []).includes('Mech'),
          )
          if (mech) {
            mech.exhausted = false
            emit({ kind: 'buff', iid: mech.iid, player: action.player })
            s1 = log(s1, action.player, `Bubble Bot: readied ${getCard(mech.cardId)?.name}.`)
          }
        }
        // Bard - Mercurial: "You may exhaust your legend as an additional cost … if
        // you paid, move any number of your units to an open battlefield." Opt-in via
        // action.payAdditionalCost: if chosen and the legend is ready and there's an
        // open (uncontrolled + empty) battlefield with a ready base unit to send,
        // exhaust the legend and move that unit there (conquering the open battlefield).
        if (action.payAdditionalCost && card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Bard - Mercurial' && /exhaust your legend as an additional cost/i.test(card.text ?? '') && !legionGated) {
          const legend = p.legend
          const openBf = s1.battlefields.findIndex((b) => b.controller == null && b.units.length === 0)
          const mover = p.zones.base.find((u) => u.iid !== ci.iid && !u.exhausted && getCard(u.cardId)?.type === 'unit')
          if (legend && !legend.exhausted && openBf >= 0 && mover) {
            legend.exhausted = true
            s1 = log(s1, action.player, `Bard - Mercurial: exhausted your legend (additional cost paid).`)
            const mv = moveUnits(s1, action.player, [mover.iid], openBf)
            if (!mv.error) s1 = mv.state
          }
        }
        // Vision / Predict: peek the top of your Main Deck; a decision (keep /
        // recycle) is surfaced to the controller (same look, both keywords). Mechs
        // may have Vision granted owner-wide (Forecaster).
        if ((kw.vision || kw.predict || unitGrantedKeyword(s1, ci, 'vision')) && p.zones.mainDeck.length > 0) {
          s1 = { ...s1, vision: { player: action.player, cardId: p.zones.mainDeck[0].cardId } }
          s1 = log(s1, action.player, `${kw.predict ? 'Predict' : 'Vision'} — look at the top of your deck; you may recycle it.`)
        }
        if (e.manual && !e.draw && !e.channel && !e.recruits && !e.goldTokens && !e.namedToken && !legionGated)
          s1 = log(s1, action.player, `${card.name}: resolve its ability manually.`)
        // Weaponmaster: auto-attach a piece of Equipment on entry. May be granted
        // owner-wide (Azir - Emperor of the Sands → Sand Soldiers). Prefers a gear in
        // hand, then a detached gear in base, then RE-SEATS one already attached to
        // another friendly unit ("even if it's already attached"). (The "[Equip] for
        // one rainbow less" cost is treated as free here — a balance nicety, deferred.)
        if (kw.weaponmaster || unitGrantedKeyword(s1, ci, 'weaponmaster')) {
          const target = p.zones.base.find((u) => u.iid === ci.iid)
          let attachRef: string | undefined
          const handGear = p.zones.hand.find((c) => getCard(c.cardId)?.type === 'gear')
          const baseGear = p.zones.base.find((c) => getCard(c.cardId)?.type === 'gear' && c.iid !== ci.iid)
          if (target && handGear) {
            removeFromZone(p, 'hand', handGear.iid)
            attachRef = `${handGear.cardId}|${handGear.iid}`
          } else if (target && baseGear) {
            removeFromZone(p, 'base', baseGear.iid)
            attachRef = `${baseGear.cardId}|${baseGear.iid}`
          } else if (target) {
            for (const host of [...p.zones.base, ...s1.battlefields.flatMap((b) => b.units)]) {
              if (host.owner !== action.player || host.iid === ci.iid || !host.attached.length) continue
              const [ref] = host.attached.splice(0, 1)
              attachRef = ref
              break
            }
          }
          if (target && attachRef) {
            target.attached = [...target.attached, attachRef]
            const gCid = attachRef.split('|')[0]
            emit({ kind: 'buff', iid: target.iid, player: action.player, cardId: gCid })
            s1 = fireAttachEquip(s1, action.player, target)
            s1 = log(s1, action.player, `Weaponmaster: attached ${getCard(gCid)?.name} to ${card.name}.`)
          } else {
            s1 = log(s1, action.player, `Weaponmaster: no Equipment available to attach.`)
          }
        }
        s1 = firePlayTriggers(s1, action.player, ci.iid, card, effTotal)
        // Elder Dragon: "When you play me, choose up to one enemy unit at each location.
        // Deal 1 to them." Auto-picks the strongest enemy at each battlefield + each
        // opponent's base; the passive above makes that 1 damage lethal.
        if (card.name === 'Blitzcrank - Impassive' && playToBf != null) {
          // "When you play me to a battlefield, you may move an enemy unit to here."
          s1 = pullEnemyToBf(s1, action.player, playToBf, 'Blitzcrank - Impassive')
        }
        if (card.name === 'Baron Nashor') {
          // "As you play me, add the Baron Pit battlefield token to the board if it's
          // not there already. If you do, I enter there." A 4th battlefield slot isn't
          // supported, so (per the Ivern/Brush precedent) replace the least-contested
          // existing slot's identity with Baron Pit and move Baron there.
          const BARON_PIT_ID = 'unl-t01-219'
          if (!s1.battlefields.some((b) => b.cardId === BARON_PIT_ID)) {
            const slotIdx = (() => {
              const open = s1.battlefields.findIndex((b) => b.controller == null)
              if (open >= 0) return open
              return s1.battlefields.reduce((best, b, i) => (b.units.length < s1.battlefields[best].units.length ? i : best), 0)
            })()
            if (s1.battlefields[slotIdx].cardId !== BARON_PIT_ID)
              s1.battlefields[slotIdx].originalCardId = s1.battlefields[slotIdx].cardId
            s1.battlefields[slotIdx].cardId = BARON_PIT_ID
            recomputeControllers(s1)
            s1 = log(s1, action.player, `Baron Nashor: added Baron Pit (battlefield ${slotIdx + 1}).`)
            const baronIdx = s1.players[action.player].zones.base.findIndex((u) => u.iid === ci.iid)
            if (baronIdx >= 0) {
              const priorCtrl = s1.battlefields[slotIdx].controller
              const [baron] = s1.players[action.player].zones.base.splice(baronIdx, 1)
              s1.battlefields[slotIdx].units.push({ ...baron, exhausted: true })
              recomputeControllers(s1)
              s1 = log(s1, action.player, 'Baron Nashor entered Baron Pit.')
              s1 = showdownOrConquerAfterEffectMove(s1, slotIdx, ci.iid, priorCtrl)
            }
          }
        }
        if (card.name === 'Elder Dragon') {
          const strongestEnemy = (units: EngineCard[]) => {
            const en = units.filter((u) => u.owner !== action.player && getCard(u.cardId)?.type === 'unit')
            return en.length ? en.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi)) : null
          }
          const edDead: EngineCard[] = []
          for (const bf of s1.battlefields) { const v = strongestEnemy(bf.units); if (v) edDead.push(...applyTargetDamage(s1, v.iid, 1, true, action.player)) }
          for (const pl of s1.players) { if (pl.id === action.player) continue; const v = strongestEnemy(pl.zones.base); if (v) edDead.push(...applyTargetDamage(s1, v.iid, 1, true, action.player)) }
          if (edDead.length) s1 = fireDeaths(s1, edDead, action.player)
        }
        s1 = fireOpponentUnitPlay(s1, action.player, ci.iid) // Vex - Apathetic
        // A non-Ambush unit played straight to a battlefield "becomes present" there
        // → contested ⇒ a showdown opens (or a control flip awards the conquer).
        if (playToBf != null) s1 = showdownOrConquerAfterEffectMove(s1, playToBf, ci.iid, priorBfController)
        return ok(s1)
      }

      if (action.type === 'PLAY_GEAR') {
        // Track Equipment plays this turn (Azir - Emperor of the Sands gate).
        if (parseKeywords(card).equip) p.playedEquipmentThisTurn = true
        // The gear's own "When you play this, …" effect (Forge of the Future →
        // Recruit token; Shurelya's Requiem → ready your units). Applied after the
        // gear is in play so token/ready effects see correct state.
        const gearOnPlay = onPlayEffect(card)
        const applyGearOnPlay = (st: MatchState): MatchState => {
          for (const line of applyParsed(st, st.players[action.player], gearOnPlay, undefined, ci.iid))
            st = log(st, action.player, line)
          st = fireTokenPlay(st, action.player, tokenUnitsIn(gearOnPlay))
          // Blast Cone: "When you play this, you may move an enemy unit." Auto-sends
          // the strongest enemy to its base; Part 2 (blastConeOnEnemyMove) then exhausts
          // the freshly-played cone to [Stun] that unit.
          if (card.name === 'Blast Cone') {
            const enemy = st.battlefields.flatMap((b) => b.units).filter((u) => u.owner !== action.player && getCard(u.cardId)?.type === 'unit').sort((a, b) => mightOf(b) - mightOf(a))[0]
            if (enemy) {
              const nm = getCard(enemy.cardId)?.name
              if (sendUnitToBase(st, enemy.iid)) {
                st = log(st, action.player, `Blast Cone: moved ${nm} to its base.`)
                st = blastConeOnEnemyMove(st, action.player, enemy.iid)
              }
            }
          }
          return st
        }
        // Attaching from hand on play is ONLY allowed for attach-on-play gear —
        // [Quick-Draw], a Quick-Draw aura (Jax), or [Weaponmaster] — and in sandbox.
        // Normal Equipment plays UNATTACHED to your base; you then pay its [Equip]
        // cost via the ATTACH action (the proper two-step flow). This stops a
        // hand-play from silently attaching for free and bypassing the equip cost.
        const attachOnPlay = state.sandbox || parseKeywords(card).quickDraw || parseKeywords(card).weaponmaster || controlsQuickDrawAura(s, action.player)
        if (action.targetIid && attachOnPlay) {
          for (const u of p.zones.base.concat(s.battlefields.flatMap((b) => b.units)))
            if (u.iid === action.targetIid && u.owner === action.player) {
              u.attached = [...u.attached, `${card.id}|${ci.iid}`]
              emit({ kind: 'buff', iid: u.iid, player: action.player, cardId: card.id })
              emit({ kind: 'equip', iid: u.iid, player: action.player, cardId: card.id })
              let s1 = log(s, action.player, `Equipped ${card.name} to ${getCard(u.cardId)?.name}.`)
              s1 = fireAttachEquip(s1, action.player, u) // Aphelios - Exalted
              s1 = applyGearOnPlay(s1)
              return ok(firePlayTriggers(s1, action.player, ci.iid, card, effTotal))
            }
        }
        // Quick-Draw (gear's own keyword, or Jax - Unmatched's "Your Equipment
        // everywhere have [Quick-Draw]" aura): the gear auto-attaches to a unit you
        // control on play. Auto-pick the strongest friendly unit.
        if (parseKeywords(card).quickDraw || controlsQuickDrawAura(s, action.player)) {
          const host = [...p.zones.base, ...s.battlefields.flatMap((b) => b.units)]
            .filter((u) => u.owner === action.player && getCard(u.cardId)?.type === 'unit')
            .sort((a, b) => mightOf(b) - mightOf(a))[0]
          if (host) {
            host.attached = [...host.attached, `${card.id}|${ci.iid}`]
            emit({ kind: 'buff', iid: host.iid, player: action.player, cardId: card.id })
            emit({ kind: 'equip', iid: host.iid, player: action.player, cardId: card.id })
            let s1 = log(s, action.player, `Quick-Draw: attached ${card.name} to ${getCard(host.cardId)?.name}.`)
            s1 = fireAttachEquip(s1, action.player, host)
            s1 = applyGearOnPlay(s1)
            return ok(firePlayTriggers(s1, action.player, ci.iid, card, effTotal))
          }
        }
        p.zones.base.push({ ...ci })
        emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
        let s1 = applyGearOnPlay(log(s, action.player, `Played gear ${card.name} (unattached).`))
        s1 = firePlayTriggers(s1, action.player, ci.iid, card, effTotal)
        // The List: "As you play this, name a tag." Prompt for a free-form tag name,
        // resolved via RESOLVE_CHOICE kind 'nameTag' (the UI renders a text input).
        if (/as you play (?:this|me), name a tag/i.test(card.text ?? '')) {
          offerChoice(s1, {
            player: action.player, kind: 'nameTag', bfIndex: -1,
            prompt: `${card.name} — name a tag (e.g. "Poro", "Demacia", "Miss Fortune"):`,
            options: [{ iid: '__nameTag__', label: 'Name a tag' }], // placeholder; the UI sends the typed tag as action.iid
            payload: '',
          })
        }
        return ok(s1)
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
          s1 = log(s1, action.player, `${card.name}: Repeat — resolving its effect again.`)
          s1 = resolveSpellEffects(s1, action.player, card, action.targets)
        }
        sendToTrash(s1.players[action.player], ci)
        return ok(s1)
      }
      emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: card.id })
      s.players[action.player].nextSpellCostDiscount = 0 // Raging Firebrand: the discount applied to THIS spell's cost; consumed now
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
      let sStun = log(s, action.player, `Stunned ${getCard(target.cardId)?.name}.`)
      // "When you stun an enemy unit" (Eclipse Herald, Leona - Radiant Dawn).
      if (target.owner !== action.player) sStun = fireStun(sStun, action.player, battlefieldOf(sStun, target.iid))
      return ok(sStun)
    }

    case 'DETACH': {
      if (!state.sandbox) { const guard = requireActiveAction(state, action.player); if (guard) return fail(state, guard) }
      const s = clone(state)
      const unit = state.sandbox ? findUnitAnywhere(s, action.unitIid) : (() => { const u = findUnitAnywhere(s, action.unitIid); return u?.owner === action.player ? u : undefined })()
      if (!unit) return fail(state, 'No such unit.')
      const idx = unit.attached.findIndex((a) => a.split('|')[1] === action.gearIid)
      if (idx < 0) return fail(state, 'That gear is not attached.')
      const [ref] = unit.attached.splice(idx, 1)
      const [cardId, iid] = ref.split('|')
      // Detached gear returns to its owner's Base as an unattached piece of gear.
      const gearOwner = state.sandbox ? unit.owner : action.player
      s.players[gearOwner].zones.base.push({ iid, cardId, owner: gearOwner, exhausted: false, damage: 0, attached: [] })
      emit({ kind: 'buff', iid: unit.iid, player: action.player })
      return ok(log(s, action.player, `Detached ${getCard(cardId)?.name}.`))
    }

    case 'ATTACH': {
      // Attach an unattached piece of Equipment sitting on your Base to one of your
      // units — the [Equip] activated ability. Outside sandbox this pays the gear's
      // [Equip] cost (auto-paid from ready runes/pool); sandbox attaches for free.
      if (!state.sandbox) { const guard = requireActiveAction(state, action.player); if (guard) return fail(state, guard) }
      const s = clone(state)
      // In sandbox, search ALL players' bases for the gear; otherwise only the acting player's.
      let gearPlayer = action.player
      let gIdx: number
      if (state.sandbox) {
        let found = false
        for (let pi = 0; pi < s.players.length; pi++) {
          const i = s.players[pi].zones.base.findIndex((g) => g.iid === action.gearIid && getCard(g.cardId)?.type === 'gear')
          if (i >= 0) { gearPlayer = pi; gIdx = i; found = true; break }
        }
        if (!found) return fail(state, 'That gear is not on any Base.')
      } else {
        gIdx = s.players[action.player].zones.base.findIndex((g) => g.iid === action.gearIid && getCard(g.cardId)?.type === 'gear')
        if (gIdx < 0) return fail(state, 'That gear is not on your Base.')
      }
      const unit = state.sandbox ? findUnitAnywhere(s, action.unitIid) : (() => { const u = findUnitAnywhere(s, action.unitIid); return u?.owner === action.player ? u : undefined })()
      if (!unit || getCard(unit.cardId)?.type !== 'unit')
        return fail(state, 'Choose a unit to equip.')
      // Pay the [Equip] cost (real play only). When the UI supplies a `payment`
      // (the rune picker) and the cost has no rainbow Power, apply it exactly so the
      // player's chosen runes are honored; otherwise auto-pay. Both mutate `s` only on
      // success, so an unaffordable equip returns the untouched original state.
      if (!state.sandbox) {
        const ec = parseKeywords(getCard(s.players[gearPlayer].zones.base[gIdx!].cardId)).equipCost
        if (ec && (ec.energy > 0 || ec.anyPower > 0 || Object.keys(ec.power).length > 0)) {
          if (action.payment && ec.anyPower === 0) {
            const err = applyPayment(s.players[action.player], { energy: ec.energy, power: ec.power }, action.payment)
            if (err) return fail(state, err)
          } else if (!payEquipCost(s, action.player, ec)) {
            return fail(state, 'Not enough resources to pay the Equip cost.')
          }
        }
        // Additional non-resource [Equip] cost: "Recycle N cards from your trash" (Last
        // Rites). Not captured by equipCost — enforce it here. Requires N trash cards;
        // auto-recycles the oldest N to the bottom of the Main Deck. A failure reverts the
        // rune payment above (we return the untouched original state).
        const gearText = getCard(s.players[gearPlayer].zones.base[gIdx!].cardId)?.text ?? ''
        const recM = gearText.match(/recycle (\d+) cards? from your trash/i)
        if (recM) {
          const need = parseInt(recM[1], 10)
          const trash = s.players[action.player].zones.trash
          if (trash.length < need) return fail(state, `Need ${need} card(s) in your trash to pay the Equip cost.`)
          for (const c of trash.splice(trash.length - need, need)) s.players[action.player].zones.mainDeck.push({ ...c, exhausted: false, damage: 0, attached: [] })
        }
      }
      const [gear] = s.players[gearPlayer].zones.base.splice(gIdx!, 1)
      unit.attached = [...unit.attached, `${gear.cardId}|${gear.iid}`]
      emit({ kind: 'equip', iid: unit.iid, player: action.player, cardId: gear.cardId })
      let sA = log(s, action.player, `Attached ${getCard(gear.cardId)?.name} to ${getCard(unit.cardId)?.name}.`)
      sA = fireAttachEquip(sA, action.player, unit) // Aphelios - Exalted, etc.
      return ok(sA)
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
      // Renata Glasc - Chem-Baroness: "While your score is within 3 of the Victory
      // Score, your Gold [ADD] an additional 1 Energy."
      const renata = controlledPermanents(s, action.player).some((perm) => /your gold \[?add\]?[^.]*additional :rb_energy_1:/i.test(getCard(perm.cardId)?.text ?? ''))
      if (renata && s.pointsToWin - p.points <= 3) { p.pool.energy += 1; return ok(log(s, action.player, `Cashed in Gold for 1 ${action.domain} Power + 1 Energy (Renata).`)) }
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
      // Noxus Saboteur: "Your opponents' [Hidden] cards can't be revealed here."
      if (s.battlefields[bfi].units.some((u) => u.owner !== action.player && /your opponents'? \[hidden\] cards can'?t be revealed here/i.test(getCard(u.cardId)?.text ?? '')))
        return fail(state, 'An opponent\'s Noxus Saboteur prevents revealing Hidden cards here.')
      const card = getCard(fd.cardId)
      if (!card) return fail(state, 'Unknown card.')
      s.battlefields[bfi].facedown = null
      const ci: EngineCard = { ...fd, facedown: false, hiddenTurn: undefined }
      emit({ kind: 'play', iid: ci.iid, player: action.player, cardId: ci.cardId })
      // Reveal = play for 0, at the battlefield where it was hidden.
      if (card.type === 'unit') {
        s.battlefields[bfi].units.push({ ...ci, exhausted: !controlsBreacherAura(s, action.player), enteredTurn: s.turn }) // Rek'Sai - Breacher: from-Hidden is non-hand
        recomputeControllers(s)
        s = log(s, action.player, `Revealed ${card.name} — entered play.`)
        for (const line of applyParsed(s, s.players[action.player], onPlayEffect(card), bfi, ci.iid)) s = log(s, action.player, line)
        s = firePlayTriggers(s, action.player, ci.iid, card, 0, true) // played from [Hidden]
        // Evelynn - Entrancing: "When you play me from face down on your turn, you may
        // move an enemy unit at a different location to my battlefield." (Reveal-only.)
        if (card.name === 'Evelynn - Entrancing') s = pullEnemyToBf(s, action.player, bfi, 'Evelynn - Entrancing')
        // Tideturner: the on-play swap also fires when revealed from Hidden (its
        // "original location" is the battlefield it was hidden at).
        if (card.name.replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Tideturner') s = tideturnerSwap(s, action.player, ci.iid)
      } else if (card.type === 'gear') {
        // Edge of Night: "When you play this from face down, attach it to a unit
        // you control (here)." Auto-attach to a friendly unit at this battlefield.
        const fromFD = /when you play this from face ?down,[^.]*attach it to a unit you control/i.test(card.text ?? '')
        const host = fromFD ? s.battlefields[bfi].units.find((u) => u.owner === action.player) : undefined
        if (host) {
          host.attached = [...host.attached, `${card.id}|${ci.iid}`]
          emit({ kind: 'buff', iid: host.iid, player: action.player, cardId: card.id })
          s = log(s, action.player, `Revealed ${card.name} — attached to ${getCard(host.cardId)?.name} (here).`)
          s = fireAttachEquip(s, action.player, host)
        } else {
          s.players[action.player].zones.base.push({ ...ci, exhausted: false })
          s = log(s, action.player, `Revealed ${card.name} — gear entered play.`)
        }
        s = firePlayTriggers(s, action.player, ci.iid, card, 0, true) // played from [Hidden]
      } else {
        s = log(s, action.player, `Revealed ${card.name} — resolving.`)
        s = resolveSpellEffects(s, action.player, card, [])
        s = firePlayTriggers(s, action.player, ci.iid, card, 0, true) // played from [Hidden]
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
          // Minotaur Reckoner (global) / Determined Sentry (self): can't move to base.
          if (globalNoMoveToBaseActive(s))
            return fail(state, "Units can't move to base right now (Minotaur Reckoner).")
          if (unitCantMoveToBase(bf.units[idx]))
            return fail(state, `${def(bf.units[idx])?.name} can't move to base.`)
          if (bfScriptAt(s, i)?.noMoveToBase)
            return fail(state, `Units can't move from ${getCard(bf.cardId)?.name ?? 'here'} to base.`)
          if (bf.units[idx].cantMoveTurn === s.turn)
            return fail(state, `${def(bf.units[idx])?.name} can't move this turn.`)
          const [u] = bf.units.splice(idx, 1)
          bfScriptAt(s, i)?.onMoveFrom?.(u) // Back-Alley Bar: +1 Might this turn
          s.players[action.player].zones.base.push({ ...u, exhausted: true })
          recomputeControllers(s)
          emit({ kind: 'move', iid: u.iid, player: action.player, cardId: u.cardId, retreat: 'base' })
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
        // Karma - Channeler: "When you recycle one or more cards, buff a friendly unit."
        out = fireTriggers(out, collectGlobal(out, action.player, 'recycleCard'))
      } else {
        out = log(s, action.player, `Vision: kept the top card.`)
      }
      return ok({ ...out, vision: undefined })
    }

    case 'READY_UNIT': {
      if (!state.readyChoice || state.readyChoice.player !== action.player)
        return fail(state, 'No unit to ready right now.')
      if (state.readyChoice.excludeIid === action.iid)
        return fail(state, 'That unit can\'t be readied by this effect (ready another unit).')
      const s = clone(state)
      const u = findUnitAnywhere(s, action.iid)
      if (!u || u.owner !== action.player || !u.exhausted || unitCantBeReadied(u) || enemyWardenAtBf(s, action.player))
        return fail(state, 'Choose one of your exhausted units.')
      u.exhausted = false
      emit({ kind: 'buff', iid: u.iid, player: action.player })
      s.readyChoice = s.readyChoice!.count > 1 ? { player: action.player, count: s.readyChoice!.count - 1, excludeIid: s.readyChoice!.excludeIid } : undefined
      return ok(log(s, action.player, `Readied ${getCard(u.cardId)?.name}.`))
    }

    case 'RESOLVE_CHOICE': {
      const pc = state.pendingChoice
      if (!pc || pc.player !== action.player) return fail(state, 'No choice to resolve right now.')
      let s = clone(state)
      s.pendingChoice = undefined
      // The List: free-form tag naming — action.iid carries the typed tag string, so
      // handle it BEFORE the option-membership validation below (it has no preset option).
      if (pc.kind === 'nameTag') {
        const tag = (action.iid ?? '').trim()
        if (tag && tag !== '__nameTag__') { s.players[action.player].namedTag = tag; s = log(s, action.player, `The List: named the tag "${tag}".`) }
        else s = log(s, action.player, 'The List: no tag named.')
        return ok(s)
      }
      if (action.iid !== null && !pc.options.some((o) => o.iid === action.iid))
        return fail(state, 'That is not a valid choice.')

      // Stacked Deck / Called Shot: keep the chosen looked-at card, recycle the rest of
      // the looked-at set to the bottom of the deck. A decline keeps none.
      if (pc.kind === 'peekToHand') {
        const candIids: string[] = JSON.parse(pc.payload ?? '{}').candIids ?? []
        const pl = s.players[action.player]
        const cands = candIids.map((iid) => pl.zones.mainDeck.find((c) => c.iid === iid)).filter((c): c is EngineCard => !!c)
        pl.zones.mainDeck = pl.zones.mainDeck.filter((c) => !candIids.includes(c.iid))
        const chosen = action.iid ? cands.find((c) => c.iid === action.iid) : undefined
        if (chosen) pl.zones.hand.push(chosen)
        for (const c of cands) if (c.iid !== action.iid) pl.zones.mainDeck.push(c) // recycle the rest to the bottom
        // Don't name the kept card — it was a PRIVATE look (only the controller should know).
        return ok(log(s, action.player, chosen ? `Put a card into hand and recycled ${cands.length - 1}.` : `Recycled ${cands.length} looked-at card(s).`))
      }

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

      // Shard of Undoing: each opponent (queued) kills one of their own units. A
      // decline removes their lowest-Might unit (the kill is mandatory). Drains the
      // opponent queue, then resumes the Beginning Phase (Dusk Rose + finishBeginning).
      if (pc.kind === 'shardKill') {
        const pid = pc.player
        let victimIid = action.iid
        if (victimIid === null) {
          const own = [...s.players[pid].zones.base, ...s.battlefields.flatMap((b) => b.units)].filter((u) => u.owner === pid && getCard(u.cardId)?.type === 'unit')
          victimIid = own.length ? own.reduce((lo, u) => (mightOf(u) < mightOf(lo) ? u : lo)).iid : null
        }
        if (victimIid) {
          const nm = getCard(findUnitAnywhere(s, victimIid)?.cardId ?? '')?.name ?? 'a unit'
          s = fireDeaths(s, killTarget(s, victimIid))
          s = log(s, pid, `Shard of Undoing — killed ${nm}.`)
        }
        let rem: PlayerId[] = []
        try { rem = JSON.parse(pc.payload ?? '{"remaining":[]}').remaining ?? [] } catch { rem = [] }
        s = offerShardKill(s, rem)
        if (s.pendingChoice) return ok(s)
        return ok(resumeBeginning(s))
      }

      // Move a chosen unit to a chosen battlefield (Charm). action.iid is "bf:N"
      // (a destination), and the unit being moved is carried in pc.payload.
      if (pc.kind === 'moveToBf') {
        const unitIid = pc.payload
        if (action.iid && unitIid && action.iid.startsWith('bf:')) {
          const dest = parseInt(action.iid.slice(3), 10)
          const card = pluckCardAnywhere(s, unitIid)
          if (card && s.battlefields[dest]) {
            const priorCtrl = s.battlefields[dest].controller
            s.battlefields[dest].units.push(card)
            recomputeControllers(s)
            s = log(s, action.player, `Moved ${getCard(card.cardId)?.name ?? 'a unit'} to ${bfBaseNameAt(s, dest) || `Battlefield ${dest + 1}`}.`)
            // Blast Cone: "When you move an enemy unit, you may exhaust this to [Stun] it."
            s = blastConeOnEnemyMove(s, action.player, card.iid)
            // Dragon's Rage: "Then do this: Choose another enemy unit at its destination.
            // They deal damage equal to their Mights to each other." Auto-picks the
            // strongest other enemy at the destination; both take the other's Might.
            if (pc.srcName === "Dragon's Rage") {
              const others = s.battlefields[dest].units.filter((u) => u.owner === card.owner && u.iid !== card.iid && getCard(u.cardId)?.type === 'unit')
              if (others.length) {
                const other = others.reduce((hi, u) => (mightOf(u) > mightOf(hi) ? u : hi))
                const m1 = mightOf(card)
                const m2 = mightOf(other)
                let dead: EngineCard[] = []
                dead = dead.concat(applyTargetDamage(s, other.iid, m1))
                dead = dead.concat(applyTargetDamage(s, card.iid, m2))
                s = log(s, action.player, `Dragon's Rage: ${getCard(card.cardId)?.name} and ${getCard(other.cardId)?.name} dealt ${m1}/${m2} to each other.`)
                s = fireDeaths(s, dead, action.player)
              }
            }
            // The moved unit "becomes present" → contested ⇒ showdown (Charm initiates combat).
            s = showdownOrConquerAfterEffectMove(s, dest, card.iid, priorCtrl)
          }
        } else {
          s = log(s, action.player, 'Move — declined.')
        }
        return ok(s)
      }

      // "When you discard me, you may pay X to play me" (Flame Chompers). pc.payload
      // carries the alternate cost; the chosen iid is the discarded card in trash.
      if (pc.kind === 'discardReplay') {
        if (action.iid !== null && pc.payload) {
          const cost = JSON.parse(pc.payload) as { energy: number; power: Partial<Record<Domain, number>> }
          s = playFromTrashPayingCost(s, action.player, action.iid, cost)
        } else {
          s = log(s, action.player, 'Discard-play — declined.')
        }
        return ok(s)
      }

      // Insightful Investigator: "You may pay 2 XP … they discard that card and draw 1."
      // On pay: −2 XP, strip the victim's highest-cost card to trash (firing their
      // discard cascade), then the VICTIM draws 1 (per the card, not the caster).
      if (pc.kind === 'insightfulInvestigator') {
        if (action.iid === 'pay') {
          let victimId = 0, xpCost = 2
          try { const pl = JSON.parse(pc.payload ?? '{}'); victimId = pl.victimId ?? 0; xpCost = pl.xpCost ?? 2 } catch { victimId = 0 }
          const caster = s.players[action.player]
          const victim = s.players[victimId]
          if (caster.xp >= xpCost && victim && victim.zones.hand.length > 0) {
            caster.xp -= xpCost
            const pick = [...victim.zones.hand].sort((a, b) => cardCost(b) - cardCost(a))[0]
            const [stripped] = victim.zones.hand.splice(victim.zones.hand.findIndex((c) => c.iid === pick.iid), 1)
            sendToTrash(victim, stripped)
            victim.discardedThisTurn = true
            s = log(s, action.player, `Insightful Investigator — paid 2 XP; ${victim.name} discarded ${getCard(stripped.cardId)?.name} and draws 1.`)
            s = fireDiscard(s, victimId, [stripped]) // the victim's discard cascade
            drawN(s.players[victimId], 1) // the VICTIM draws 1
          } else {
            s = log(s, action.player, 'Insightful Investigator — could not pay (no XP / no cards).')
          }
        } else {
          s = log(s, action.player, 'Insightful Investigator — declined (kept 2 XP).')
        }
        return ok(s)
      }

      // "When you conquer, you may discard 1 to return this from your trash to your
      // hand" (Super Mega Death Rocket!). Discard the lowest-cost hand card as the
      // cost, then move the chosen card from trash to hand.
      if (pc.kind === 'trashConquerReturn') {
        if (action.iid !== null) {
          const p = s.players[action.player]
          const ti = p.zones.trash.findIndex((c) => c.iid === action.iid)
          if (ti >= 0 && p.zones.hand.length > 0) {
            const toss = [...p.zones.hand].sort((a, b) => cardCost(a) - cardCost(b))[0]
            const hi = p.zones.hand.findIndex((x) => x.iid === toss.iid)
            const [discarded] = p.zones.hand.splice(hi, 1)
            sendToTrash(p, discarded)
            const [card] = p.zones.trash.splice(p.zones.trash.findIndex((c) => c.iid === action.iid), 1)
            p.zones.hand.push({ ...card, exhausted: false, damage: 0, attached: [] })
            s = log(s, action.player, `${getCard(card.cardId)?.name} — discarded 1 to return it from trash to hand.`)
            s = fireDiscard(s, action.player, [discarded]) // the discard is itself an event
          }
        } else {
          s = log(s, action.player, 'Trash-return — declined.')
        }
        return ok(s)
      }

      // "When a unit becomes [Mighty], pay <cost> to ready it" (Fiora - Worthy).
      // pc.payload carries the cost; the chosen iid is the unit to ready.
      if (pc.kind === 'becomesStateReady') {
        if (action.iid !== null && pc.payload) {
          const cost = JSON.parse(pc.payload) as { energy: number; power: Partial<Record<Domain, number>> }
          const unit = findUnitAnywhere(s, action.iid)
          if (unit && payFixedCost(s, action.player, cost.energy, cost.power)) {
            unit.exhausted = false
            s = log(s, action.player, `Paid ${costGlyphLabel(cost)} to ready ${getCard(unit.cardId)?.name} (became [Mighty]).`)
          }
        } else {
          s = log(s, action.player, 'Become-[Mighty] ready — declined.')
        }
        return ok(s)
      }

      // Hard Bargain "Counter a spell unless its controller pays N": the target's
      // controller pays to save it (counter fizzles) or lets it be countered.
      if (pc.kind === 'counterUnlessPay') {
        const { counterId, targetId, n } = JSON.parse(pc.payload ?? '{}') as { counterId: string; targetId: string; n: number }
        const counterItem = s.chain.find((c) => c.id === counterId)
        const targetItem = s.chain.find((c) => c.id === targetId)
        if (action.iid === 'pay' && targetItem && makeBfApi(s).payEnergy(targetItem.controller, n)) {
          // Paid → counter fizzles; remove + trash it. The target stays and resolves.
          if (counterItem) { s.chain = s.chain.filter((c) => c.id !== counterId); sendToTrash(s.players[counterItem.controller], counterItem.instance) }
          s = log(s, action.player, `Paid ${n} Energy — ${getCard(targetItem?.cardId ?? '')?.name ?? 'the spell'} is not countered.`)
        } else {
          // Declined / can't pay → counter resolves: remove + trash the target, then the counter.
          if (targetItem) {
            s.chain = s.chain.filter((c) => c.id !== targetId)
            sendToTrash(s.players[targetItem.controller], targetItem.instance)
            emit({ kind: 'counter', iid: targetItem.instance.iid, player: counterItem?.controller ?? action.player, cardId: targetItem.cardId })
            s = log(s, action.player, `Countered ${getCard(targetItem.cardId)?.name ?? 'a spell'}.`)
          }
          if (counterItem) { s.chain = s.chain.filter((c) => c.id !== counterId); sendToTrash(s.players[counterItem.controller], counterItem.instance) }
        }
        // Resume chain resolution for any remaining items.
        s.passes = 0
        s.priority = s.chain.length > 0 ? s.activePlayer : null
        return ok(s)
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
          s = fireDiscard(s, action.player, [discarded]) // Jinx - Rebel: "when you discard …"
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
          return ok(log(s, action.player, `Emperor's Dais — returned ${name} to hand and played a Sand Soldier.`))
        }
        case 'forgePickEquip': {
          // Stored the chosen Equipment; now prompt for the target unit.
          const units = unitsControlledBy(s, action.player).map((u) => unitOpt(u))
          s.pendingChoice = { player: action.player, kind: 'forgePickTarget', bfIndex: -1, prompt: 'Forge of the Fluft — choose a unit to attach it to.', options: units, payload: action.iid }
          return ok(s)
        }
        case 'forgePickTarget': {
          // Attach the carried Equipment to the chosen unit. The Equipment is either
          // detached in base or already attached to another friendly unit (re-seat —
          // Jax - Grandmaster's 2nd ability); detach it from its current host first.
          const equipIid = pc.payload
          const target = findUnitAnywhere(s, action.iid)
          if (!equipIid || !target || target.owner !== action.player) return fail(state, 'Invalid attach target.')
          let gearCardId: string | undefined
          const gi = s.players[action.player].zones.base.findIndex((c) => c.iid === equipIid)
          if (gi >= 0) {
            gearCardId = s.players[action.player].zones.base.splice(gi, 1)[0].cardId
          } else {
            for (const host of [...s.players[action.player].zones.base, ...s.battlefields.flatMap((b) => b.units)]) {
              if (host.owner !== action.player) continue
              const ai = host.attached.findIndex((r) => r.split('|')[1] === equipIid)
              if (ai >= 0) { gearCardId = host.attached.splice(ai, 1)[0].split('|')[0]; break }
            }
          }
          if (!gearCardId) return fail(state, 'That Equipment is no longer available.')
          target.attached = [...target.attached, `${gearCardId}|${equipIid}`]
          return ok(fireAttachEquip(log(s, action.player, `Attached ${getCard(gearCardId)?.name} to ${getCard(target.cardId)?.name}.`), action.player, target))
        }
        case 'orbMinusMight': {
          // Orb of Regret: -N Might this turn, to a minimum of 1 current Might.
          const u = findUnitAnywhere(s, action.iid)
          if (!u) return fail(state, 'That unit is no longer in play.')
          const amt = parseInt(pc.payload ?? '1', 10)
          applyTempMight(s, action.iid, -amt, 1)
          return ok(log(s, action.player, `Orb of Regret: ${name} -${amt} Might this turn (min 1).`))
        }
        case 'heimerBorrow': {
          // Heimerdinger - Inventor: resolve the chosen friendly [Exhaust] ability
          // (action.iid is its source) by re-running the normal ACTIVATE_UNIT
          // resolution against that source — then EXHAUST HEIMERDINGER instead of
          // the source (Heimerdinger pays the exhaust). The source's own
          // exhausted state is restored to what it was before.
          const heimerIid = pc.payload
          const heimer = heimerIid ? controlledInstance(s, action.player, heimerIid) : undefined
          if (!heimer || heimer.exhausted || !isHeimerdinger(getCard(heimer.cardId)))
            return fail(state, 'Heimerdinger is unavailable.')
          const src = controlledInstance(s, action.player, action.iid)
          if (!src) return fail(state, 'That source is no longer in play.')
          const bab = unitActivatedAbility(getCard(src.cardId))
          if (!bab || !bab.exhaust) return fail(state, 'That ability can no longer be borrowed.')
          // Temporarily ready the source so canActivateUnit accepts the re-dispatch
          // (we restore its exhausted state right after).
          const srcWasExhausted = src.exhausted
          src.exhausted = false
          // Untargeted borrowed abilities (draw / channel / tokens / self-pump)
          // resolve fully; targeted ones (deal N / give +Might) currently resolve
          // without a target through this choice flow.
          const inner = reduceInner(s, { type: 'ACTIVATE_UNIT', player: action.player, iid: action.iid })
          if (inner.error) {
            src.exhausted = srcWasExhausted // roll back the temporary ready
            return fail(state, inner.error)
          }
          const s2 = inner.state
          // Restore the source's exhausted state; Heimerdinger pays the exhaust.
          const src2 = controlledInstance(s2, action.player, action.iid)
          if (src2) src2.exhausted = srcWasExhausted
          const heimer2 = controlledInstance(s2, action.player, heimerIid!)
          if (heimer2) heimer2.exhausted = true
          return ok(log(s2, action.player, `Heimerdinger - Inventor: borrowed ${getCard(src.cardId)?.name ?? 'an'} ability — ${bab.effectText}.`))
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
        p.xpGainedThisTurn = true
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
      const equips = controlledEquipOptions(s, action.player)
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
      // Heimerdinger - Inventor: doesn't run a printed effect itself — it offers a
      // CHOICE of any friendly [Exhaust] ability to borrow. Pay nothing yet; the
      // borrowed ability's cost (and Heimerdinger's exhaust) are paid on resolve.
      if (isHeimerdinger(getCard(u.cardId))) {
        const sources = heimerBorrowSources(s, action.player)
        if (!sources.length) return fail(state, 'No friendly [Exhaust] ability to borrow.')
        const options = sources.map(({ src, ab: bab }) => ({
          iid: src.iid,
          label: `${getCard(src.cardId)?.name ?? src.iid}: ${bab.label}`,
        }))
        offerChoice(s, { player: action.player, kind: 'heimerBorrow', bfIndex: -1, prompt: `${name} — borrow a friendly [Exhaust] ability.`, options, payload: u.iid })
        return ok(log(s, action.player, `${name}: choose a friendly [Exhaust] ability to borrow.`))
      }
      const mightNow = mightOf(u) // for "double my Might" before any change
      // Pay the cost: energy/runes, recycle-from-trash, exhaust, kill-this.
      const cost = { energy: ab.energy, power: ab.power }
      if (!costIsFree(cost)) {
        const pay = autoPay(p, cost)
        if (!pay || applyPayment(p, cost, pay)) return fail(state, 'Not enough resources.')
      }
      for (let i = 0; i < ab.recycleTrash && p.zones.trash.length > 0; i++) p.zones.mainDeck.push(p.zones.trash.shift()!)
      // Discard cost (Gutter Palace) — auto-discards from the front of hand.
      const discardedCards: EngineCard[] = []
      for (let i = 0; i < ab.discard && p.zones.hand.length > 0; i++) { const d = p.zones.hand.shift()!; sendToTrash(p, d); discardedCards.push(d) }
      if (ab.exhaust && !ab.killThis) u.exhausted = true
      let s1 = log(s, action.player, `${name}: activated — ${ab.effectText}.`)
      if (discardedCards.length > 0) s1 = fireDiscard(log(s1, action.player, `Discarded ${discardedCards.length} as a cost.`), action.player, discardedCards)
      // Sun Disc: "⟳: [Legion] — The next unit you play this turn enters ready. (Get the
      // effect if you've played another card this turn.)" Set a flag PLAY_UNIT consumes;
      // Legion gates it on having already played another card this turn.
      if (/the next unit you play this turn enters ready/i.test(getCard(u.cardId)?.text ?? '')) {
        if ((p.cardsPlayedThisTurn ?? 0) >= 1) {
          p.nextUnitEntersReadyThisTurn = true
          return ok(log(s1, action.player, `${name}: the next unit you play this turn enters ready.`))
        }
        return ok(log(s1, action.player, `${name}: activated, but Legion is inactive (play another card first).`))
      }
      // "Attach an Equipment you control to a unit you control" (Jax) — a
      // two-step pick-equip → pick-target, reusing the Forge choice flow.
      if (/attach\b[^.]*\bequipment\b[^.]*\bto a unit/i.test(ab.effectText)) {
        const equips = controlledEquipOptions(s1, action.player)
        if (!equips.length) return fail(state, 'No Equipment you control to attach.')
        offerChoice(s1, { player: action.player, kind: 'forgePickEquip', bfIndex: -1, prompt: `${name} — choose an Equipment to attach.`, options: equips })
        return ok(s1)
      }
      // Azir - Ascendant: swap Azir's location with a chosen friendly unit's location
      // (battlefield ↔ battlefield or ↔ base), preserving ready/exhausted state, then
      // optionally steal one Equipment from the target. Once per turn.
      if ((getCard(u.cardId)?.name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() === 'Azir - Ascendant') {
        const targetIid = action.targets?.[0]
        if (!targetIid) return fail(state, 'Azir - Ascendant: choose a friendly unit to swap with.')
        const azir = controlledInstance(s1, action.player, u.iid)
        const tgt = findUnitAnywhere(s1, targetIid)
        if (!azir || !tgt || tgt.owner !== action.player || tgt.iid === azir.iid) return fail(state, 'Azir - Ascendant: invalid swap target.')
        const azirBf = battlefieldOf(s1, azir.iid)
        const tgtBf = battlefieldOf(s1, tgt.iid)
        // Remove both from their current zones.
        const pullFrom = (inst: EngineCard, bi: number) => {
          if (bi >= 0) s1.battlefields[bi].units.splice(s1.battlefields[bi].units.findIndex((x) => x.iid === inst.iid), 1)
          else s1.players[action.player].zones.base.splice(s1.players[action.player].zones.base.findIndex((x) => x.iid === inst.iid), 1)
        }
        pullFrom(azir, azirBf)
        pullFrom(tgt, tgtBf)
        // Place each where the other was (preserving exhausted/damage/etc.).
        ;(tgtBf >= 0 ? s1.battlefields[tgtBf].units : s1.players[action.player].zones.base).push(azir)
        ;(azirBf >= 0 ? s1.battlefields[azirBf].units : s1.players[action.player].zones.base).push(tgt)
        recomputeControllers(s1)
        if (tgt.attached.length > 0) {
          const stolen = tgt.attached.splice(0, 1)[0]
          azir.attached.push(stolen)
          s1 = log(s1, action.player, `${name}: stole ${getCard(stolen.split('|')[0])?.name} from ${getCard(tgt.cardId)?.name}.`)
        }
        s1.players[action.player].azirSwappedThisTurn = true
        return ok(log(s1, action.player, `${name}: swapped locations with ${getCard(tgt.cardId)?.name}.`))
      }
      // Resolve the effect.
      if (ab.doubleMight) {
        u.tempMight = (u.tempMight ?? 0) + mightNow
        emit({ kind: 'buff', iid: u.iid, player: action.player })
      } else if (ab.effect.tempMightSelf) {
        u.tempMight = (u.tempMight ?? 0) + ab.effect.tempMightSelf
        emit({ kind: 'buff', iid: u.iid, player: action.player })
      } else if (ab.effect.dealMight?.dealer === 'self') {
        // Caitlyn - Patrolling: ":rb_exhaust:: Deal damage equal to my Might to a unit
        // at a battlefield." Use the player's chosen target, else auto-pick the
        // strongest enemy at a battlefield (per the auto-resolve preference).
        const bi = battlefieldOf(s1, u.iid)
        const amt = bi >= 0 ? combatMightAt(s1, bi, u, 'attacker') : mightOf(u)
        const explicit = action.targets?.[0]
        let tgt = explicit ? findUnitAnywhere(s1, explicit) : undefined
        if (tgt && tgt.owner !== action.player && untargetableByEnemy(s1, tgt)) tgt = undefined
        if (!tgt) {
          const foes = s1.battlefields.flatMap((b) => b.units).filter((x) => x.owner !== action.player && getCard(x.cardId)?.type === 'unit')
          tgt = foes.sort((a, b) => mightOf(b) - mightOf(a))[0]
        }
        if (tgt && amt > 0) {
          s1 = fireDeaths(s1, applyTargetDamage(s1, tgt.iid, amt, true, action.player))
          s1 = log(s1, action.player, `${name}: dealt ${amt} to ${getCard(tgt.cardId)?.name}.`)
        }
      } else {
        // Targeted parts (deal N / give a unit +N Might this turn / Buff a unit).
        for (const t of action.targets ?? []) {
          // Teemo - Swift Scout may target a Teemo in your Champion Zone (not "in play").
          const championTarget = /champion zone/i.test(ab.effectText) && s1.players.some((pl) => pl.champion?.iid === t)
          if (!isValidTarget(s1, t) && !championTarget) continue
          const immuneTo = findUnitAnywhere(s1, t) // enemy can't choose a targeting-immune unit
          if (immuneTo && immuneTo.owner !== action.player && untargetableByEnemy(s1, immuneTo)) continue
          // The List: "Give a unit with the named tag −N Might." Only a unit carrying
          // the player's named tag is affected.
          if (/with the named tag/i.test(ab.effectText)) {
            const lt = findUnitAnywhere(s1, t)
            const tag = (s1.players[action.player].namedTag ?? '').toLowerCase()
            if (!lt || !(getCard(lt.cardId)?.tags ?? []).some((tg) => tg.toLowerCase() === tag)) {
              s1 = log(s1, action.player, `${name}: target lacks the named tag "${tag || '(none)'}" — no effect.`)
              continue
            }
          }
          if (ab.effect.damage) s1 = fireDeaths(s1, applyTargetDamage(s1, t, ab.effect.damage, true, action.player))
          if (ab.effect.tempMight) s1 = fireDeaths(s1, applyTempMight(s1, t, ab.effect.tempMight, ab.effect.tempMightFloor))
          // "Buff a friendly unit" (Lee Sin) — a permanent +1 Might counter, capped
          // at one per unit (buffing an already-buffed unit does nothing).
          if (ab.effect.buff) {
            const tu = findUnitAnywhere(s1, t)
            if (tu && (tu.buffs ?? 0) < 1) { tu.buffs = 1; emit({ kind: 'buff', iid: tu.iid, player: action.player }) }
          }
          // "Move a friendly unit … to its base" (The Syren, Yasuo pull-back).
          if (/\bmove\b/i.test(ab.effectText) && /\bbase\b/i.test(ab.effectText) && battlefieldOf(s1, t) >= 0)
            sendUnitToBase(s1, t)
          // "Return / Put a unit … to (its owner's) hand" (Teemo, Pyke). Tokens
          // cease to exist; attached gear detaches to base (bounceUnitToHand).
          if (/(return|put|bounce)/i.test(ab.effectText) && /\bhand\b/i.test(ab.effectText))
            s1 = bounceUnitToHand(s1, t, action.player, name, 0)
          // Stun / kill / grant-keyword / ready a chosen unit — activated effects
          // beyond the original curated set (the parser already reads these).
          if (ab.effect.stun) { const tu = findUnitAnywhere(s1, t); if (tu && !tu.stunned) { tu.stunned = true; emit({ kind: 'stun', iid: t, player: action.player }) } }
          if (ab.effect.kill) s1 = fireDeaths(s1, killTarget(s1, t))
          if (ab.effect.grantAssault) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantAssault = (tu.grantAssault ?? 0) + ab.effect.grantAssault }
          if (ab.effect.grantGanking) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantGanking = true }
          if (ab.effect.grantShield) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantShield = (tu.grantShield ?? 0) + ab.effect.grantShield }
          if (ab.effect.grantTank) { const tu = findUnitAnywhere(s1, t); if (tu) tu.grantTank = true }
          if (ab.effect.readyUnits) { const tu = findUnitAnywhere(s1, t); if (tu && !unitCantBeReadied(tu) && !enemyWardenAtBf(s1, action.player)) tu.exhausted = false }
        }
      }
      if (ab.effect.stun) {
        // Vex - Mocking: relocate to the stunned enemy's battlefield. Pick a stunned
        // enemy among the chosen targets and pass its bf into the stun trigger.
        const st = (action.targets ?? []).map((t) => findUnitAnywhere(s1, t)).find((tu) => !!tu && tu.owner !== action.player && tu.stunned)
        s1 = fireStun(s1, action.player, st ? battlefieldOf(s1, st.iid) : undefined) // "when you stun" payoffs
      }
      // Untargeted resource parts (Garbage Grabber: "Draw 1"; channel variants).
      if (ab.effect.draw) drawN(p, ab.effect.draw)
      if (ab.effect.channel) channelN(p, ab.effect.channel)
      if (ab.effect.channelExhausted) channelN(p, ab.effect.channelExhausted, true)
      if (ab.effect.readyAllUnits && !enemyWardenAtBf(s1, action.player)) for (const unit of [...p.zones.base, ...s1.battlefields.flatMap((b) => b.units)]) { if (unit.owner === action.player && !unitCantBeReadied(unit)) unit.exhausted = false }
      if (ab.effect.readySelf && !unitCantBeReadied(u) && !enemyWardenAtBf(s1, action.player)) u.exhausted = false
      if (ab.effect.readyRunes) { let n = ab.effect.readyRunes; for (const r of p.zones.runePool) { if (n <= 0) break; if (r.exhausted) { r.exhausted = false; n-- } } }
      if (ab.effect.grantAssaultHere) { const bi = battlefieldOf(s1, u.iid); if (bi >= 0) for (const unit of s1.battlefields[bi].units) if (unit.owner === action.player && unit.iid !== u.iid) unit.grantAssault = (unit.grantAssault ?? 0) + ab.effect.grantAssaultHere }
      if (ab.effect.grantShieldHere) { const bi = battlefieldOf(s1, u.iid); if (bi >= 0) for (const unit of s1.battlefields[bi].units) if (unit.owner === action.player && unit.iid !== u.iid) unit.grantShield = (unit.grantShield ?? 0) + ab.effect.grantShieldHere }
      // "[Add] <resource>" — rune-ramp gear (Seals, Energy Conduit) add Power/Energy
      // directly to the pool.
      if (ab.effect.addEnergy || Object.keys(ab.effect.addPower).length) {
        if (!p.pool) p.pool = { energy: 0, power: {} }
        p.pool.energy += ab.effect.addEnergy
        for (const [d, n] of Object.entries(ab.effect.addPower)) p.pool.power[d as Domain] = (p.pool.power[d as Domain] ?? 0) + (n ?? 0)
      }
      // Deck/trash play-from-zone + deck-dig families aren't in the curated set
      // above — route them through the generic applier so activated gear like
      // Baited Hook ("Look at the top 5 → banish a unit → play it free") resolves.
      // A minimal effect carrying only these fields avoids re-applying the curated
      // ones. (The Might-ceiling tied to the killed unit is a known simplification:
      // peekBanishPlay auto-plays the highest-cost unit in the revealed cards.)
      if (ab.effect.peekBanishPlay || ab.effect.playUnitFromTrash || ab.effect.playUnitFromHand || ab.effect.revealPlayFromDeck || ab.effect.peekDraw || ab.effect.peekToHand || ab.effect.returnFromTrash) {
        const sub: ParsedEffect = {
          ...EMPTY_EFFECT(),
          peekBanishPlay: ab.effect.peekBanishPlay,
          playUnitFromTrash: ab.effect.playUnitFromTrash,
          playUnitFromHand: ab.effect.playUnitFromHand,
          revealPlayFromDeck: ab.effect.revealPlayFromDeck,
          peekDraw: ab.effect.peekDraw,
          peekToHand: ab.effect.peekToHand,
          returnFromTrash: ab.effect.returnFromTrash,
        }
        const bi = battlefieldOf(s1, u.iid)
        for (const line of applyParsed(s1, p, sub, bi >= 0 ? bi : undefined, u.iid)) s1 = log(s1, action.player, line)
      }
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
      if (xpM) { p.xp += parseInt(xpM[1], 10); p.xpGainedThisTurn = true }
      // Prize of Progress: "When you use an activated ability of a gear, give me
      // +1 Might this turn." Fires when the activated source is a gear.
      if (getCard(u.cardId)?.type === 'gear') s1 = fireGearAbilityUse(s1, action.player)
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
      const u = action.iid ? (findUnitAnywhere(s, action.iid) ?? s.players.flatMap((pl) => pl.zones.runePool).find((c) => c.iid === action.iid)) : undefined
      const nm = u ? getCard(u.cardId)?.name ?? 'a unit' : ''
      switch (action.op) {
        case 'stun': if (u) u.stunned = true; break
        case 'unstun': if (u) u.stunned = false; break
        case 'ready': if (u) u.exhausted = false; break
        case 'exhaust': if (u) u.exhausted = true; break
        case 'buff': if (u) u.buffs = (u.buffs ?? 0) + (action.amount ?? 1); break
        case 'unbuff': if (u) u.buffs = Math.max(0, (u.buffs ?? 0) - (action.amount ?? 1)); break
        case 'mightUp': if (u) u.tempMight = (u.tempMight ?? 0) + (action.amount ?? 1); break
        case 'mightDown': if (u) u.tempMight = (u.tempMight ?? 0) - (action.amount ?? 1); break
        case 'setTempMight': if (u) u.tempMight = action.value ?? 0; break
        case 'kill': if (action.iid) s = fireDeaths(s, killTarget(s, action.iid)); break
        // Force-kill that bypasses death/banish shields (a true sacrifice) by clearing
        // them first, then routing through the normal death path.
        case 'sacrifice': { if (u) { u.deathShield = false; u.banishShield = false } if (action.iid) s = fireDeaths(s, killTarget(s, action.iid)) } break
        case 'toBase': if (action.iid) sendUnitToBase(s, action.iid); break
        case 'banish':
        case 'trash': {
          if (!action.iid) break
          for (const bf of s.battlefields) {
            const i = bf.units.findIndex((x) => x.iid === action.iid)
            if (i >= 0) { const [x] = bf.units.splice(i, 1); detachGearToBase(s.players[x.owner], x); (action.op === 'banish' ? s.players[x.owner].banished : s.players[x.owner].zones.trash).push(x); break }
          }
          for (const pl of s.players)
            for (const z of Object.keys(pl.zones) as ZoneId[]) {
              const i = pl.zones[z].findIndex((x) => x.iid === action.iid)
              if (i >= 0) { const [x] = pl.zones[z].splice(i, 1); detachGearToBase(pl, x); (action.op === 'banish' ? pl.banished : pl.zones.trash).push(x); break }
            }
          break
        }
        // Gear removal fail-safes (sandbox): trash or bounce an attached/unattached
        // gear by its iid (reuses the real killGear/bounceGear effect plumbing).
        case 'killGear': if (action.iid) killGearByIid(s, action.iid); break
        case 'bounceGear': if (action.iid) bounceGearByIid(s, action.iid); break
        case 'draw': drawN(s.players[action.player], action.amount ?? 1); break
        case 'channel': channelN(s.players[action.player], action.amount ?? 1); break
        case 'channelExhausted': channelN(s.players[action.player], action.amount ?? 1, true); break
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
          } else if (action.toZone === 'legend') {
            s.players[card.owner].legend = card
          } else if (action.toZone === 'champion') {
            s.players[card.owner].champion = card
          } else if (action.toZone === 'mainDeck' || action.toZone === 'runeDeck') {
            // Decks draw from the front: "to deck" puts on top, unless `bottom`, or an
            // explicit insert index (`value` = X from top — used to reorder top cards).
            const deck = s.players[card.owner].zones[action.toZone]
            if (action.value != null) deck.splice(Math.max(0, Math.min(action.value, deck.length)), 0, card)
            else if (action.bottom) deck.push(card)
            else deck.unshift(card)
          } else if (action.toZone) {
            s.players[card.owner].zones[action.toZone as ZoneId].push(card)
          } else {
            // No valid destination — put it back in its owner's base.
            s.players[card.owner].zones.base.push(card)
          }
          break
        }
        // --- manual fail-safe ops (player-scoped: action.player is the target) ---
        case 'points': { const p = s.players[action.player]; if (p) p.points = Math.max(0, p.points + (action.amount ?? 1)); break }
        case 'xp': { const p = s.players[action.player]; if (p) p.xp = Math.max(0, (p.xp ?? 0) + (action.amount ?? 1)); break }
        case 'energy': { const p = s.players[action.player]; if (p) { if (!p.pool) p.pool = { energy: 0, power: {} }; p.pool.energy = Math.max(0, p.pool.energy + (action.amount ?? 1)) } break }
        case 'power': { const p = s.players[action.player]; const d = action.domain; if (p && d) { if (!p.pool) p.pool = { energy: 0, power: {} }; p.pool.power[d] = Math.max(0, (p.pool.power[d] ?? 0) + (action.amount ?? 1)) } break }
        case 'shuffle': { const p = s.players[action.player]; if (p) p.zones.mainDeck = shuffle(p.zones.mainDeck); break }
        case 'mill': { const p = s.players[action.player]; const n = action.amount ?? 1; if (p) for (let i = 0; i < n && p.zones.mainDeck.length; i++) p.zones.trash.push(p.zones.mainDeck.shift()!); break }
        case 'damage': { if (u) u.damage = Math.max(0, (u.damage ?? 0) + (action.amount ?? 1)); break }
        case 'setDamage': { if (u) u.damage = Math.max(0, action.value ?? 0); break }
        // Cosmetic status marker (1–4 colored dot). No value = cycle 0→1→2→3→4→0;
        // value < 0 clears. No engine behavior — a manual visual reminder.
        case 'marker': { if (u) { const v = action.value != null ? (action.value < 0 ? 0 : action.value) : ((u.marker ?? 0) + 1) % 5; u.marker = v || undefined } break }
        case 'grant': {
          if (!u) break
          switch (action.flag) {
            case 'assault': u.grantAssault = Math.max(0, (u.grantAssault ?? 0) + (action.amount ?? 1)); break
            case 'shield': u.grantShield = Math.max(0, (u.grantShield ?? 0) + (action.amount ?? 1)); break
            case 'tank': u.grantTank = !u.grantTank; break
            case 'deflect': u.grantDeflect = Math.max(0, (u.grantDeflect ?? 0) + (action.amount ?? 1)); break
            case 'ganking': u.grantGanking = !u.grantGanking; break
            case 'temporary': u.temporary = !u.temporary; break
            case 'deathShield': u.deathShield = !u.deathShield; break
            case 'banishShield': u.banishShield = !u.banishShield; break
            case 'token': u.token = !u.token; break
            case 'facedown': u.facedown = !u.facedown; break
            case 'sickness': u.enteredTurn = 0; break // clear summoning sickness (entered long ago)
            case 'cantmove': u.cantMoveTurn = undefined; break
          }
          break
        }
        case 'readyAll': {
          for (const unit of [...s.players[action.player].zones.base, ...s.battlefields.flatMap((b) => b.units)])
            if (unit.owner === action.player) unit.exhausted = false
          break
        }
        case 'spawn': {
          if (!action.cardId) break
          const card: EngineCard = { iid: `${action.player}:ov:${action.cardId}#${(tokenCounter++).toString(36)}`, cardId: action.cardId, owner: action.player, exhausted: false, damage: 0, attached: [] }
          if (action.toBattlefield != null && s.battlefields[action.toBattlefield]) s.battlefields[action.toBattlefield].units.push(card)
          else if (action.toZone === 'banished') s.players[action.player].banished.push(card)
          else if (action.toZone === 'legend') s.players[action.player].legend = card
          else if (action.toZone === 'champion') s.players[action.player].champion = card
          else if (action.toZone === 'mainDeck' || action.toZone === 'runeDeck') s.players[action.player].zones[action.toZone].unshift(card)
          else if (action.toZone) s.players[action.player].zones[action.toZone as ZoneId].push(card)
          else s.players[action.player].zones.hand.push(card)
          break
        }
        // --- advanced game-state overrides (can break a game) ---
        case 'setActive': if (action.value != null && s.players[action.value]) s.activePlayer = action.value as PlayerId; break
        case 'setTurn': if (action.value != null) s.turn = Math.max(1, action.value); break
        case 'setPointsToWin': if (action.value != null) s.pointsToWin = Math.max(1, action.value); break
        case 'setWinner': s.winner = action.value == null || action.value < 0 ? null : (action.value as PlayerId); break
        case 'setPhase': if (action.phase) s.phase = action.phase; break
        case 'clearChain': s.chain = []; s.priority = null; s.passes = 0; break
        case 'clearShowdown': s.showdown = null; if (s.phase === 'showdown') s.phase = 'action'; break
        // Manually set a battlefield's controller (or clear with value < 0). Early
        // return so the trailing recomputeControllers (which obeys unit majority)
        // doesn't immediately clobber the manual choice.
        case 'setController': {
          if (action.toBattlefield != null && s.battlefields[action.toBattlefield]) {
            const c = action.value
            s.battlefields[action.toBattlefield].controller = c == null || c < 0 ? null : (c as PlayerId)
            const bfName = getCard(s.battlefields[action.toBattlefield].cardId)?.name ?? `Battlefield ${action.toBattlefield + 1}`
            return ok(log(s, action.player, `Override: set control of ${bfName}.`))
          }
          break
        }
        // Re-fire a unit's enter-play effect (its own "When you play me, …" plus
        // other permanents' "when you play a unit" reactions) — a fail-safe for a
        // trigger that didn't auto-resolve.
        case 'triggerEnterPlay': {
          if (!u) break
          const def = getCard(u.cardId)
          if (!def) break
          const bfi = battlefieldOf(s, u.iid)
          const e = onPlayEffect(def)
          for (const line of applyParsed(s, s.players[u.owner], e, bfi >= 0 ? bfi : undefined, u.iid)) s = log(s, u.owner, line)
          s = fireTokenPlay(s, u.owner, tokenUnitsIn(e))
          s = firePlayTriggers(s, u.owner, u.iid, def)
          break
        }
        // Reset a player's stuck per-turn flags (mirrors beginTurn) so a once-per-turn
        // ability that got locked by a partial effect can be used again.
        case 'clearTurnState': {
          const p = s.players[action.player]
          if (p) {
            p.cardsPlayedThisTurn = 0
            p.playedEquipmentThisTurn = false
            p.discardedThisTurn = false
            p.xpGainedThisTurn = false
            p.zileanDoubledThisTurn = false
            p.apheliosModesThisTurn = 0
            p.azirSwappedThisTurn = false
            p.energySpentOnSpellsThisTurn = 0
            p.spellPlayedThisTurn = false
            p.nextUnitEntersReadyThisTurn = false
            p.conqueredThisTurn = []
            p.oncePerTurnUsed = {}
            p.grantRepeatNextSpell = false
          }
          break
        }
        // Tutor: fetch a specific card (e.g. from the deck) to hand/base, then shuffle
        // its owner's deck so the order isn't leaked (CardSearchOverlay deck search).
        case 'tutorShuffle': {
          if (!action.iid) break
          const card = pluckCardAnywhere(s, action.iid)
          if (card) {
            const z: ZoneId = action.toZone === 'base' ? 'base' : 'hand'
            s.players[card.owner].zones[z].push({ ...card, exhausted: false, facedown: false })
            s.players[card.owner].zones.mainDeck = shuffle(s.players[card.owner].zones.mainDeck)
          }
          break
        }
        // Reveal / remove a battlefield's face-down [Hidden] card (the only place such a
        // card lives is bf.facedown). Reveal → owner's hand; remove → trash (or banish).
        case 'revealFacedown':
        case 'removeFacedown': {
          if (!action.iid) break
          for (const bf of s.battlefields) {
            const fd = bf.facedown
            if (fd && fd.iid === action.iid) {
              bf.facedown = null
              if (action.op === 'revealFacedown') s.players[fd.owner].zones.hand.push({ ...fd, facedown: false })
              else if (action.flag === 'banish') banishCard(s.players[fd.owner], fd)
              else sendToTrash(s.players[fd.owner], fd)
              break
            }
          }
          break
        }
        // Move ALL cards of one zone to another (optionally another player's zone).
        case 'bulkMove': {
          const from = action.fromZone
          const to = action.toZone
          if (from && to && to !== 'banished' && to !== 'legend' && to !== 'champion') {
            const destPlayer = action.targetPlayer ?? action.player
            const moved = s.players[action.player].zones[from].splice(0)
            s.players[destPlayer].zones[to as ZoneId].push(...moved.map((c) => ({ ...c, owner: destPlayer })))
          }
          break
        }
        // Swap a whole zone between two players (e.g. swap hands).
        case 'swapZone': {
          const z = action.fromZone
          const other = action.targetPlayer
          if (z && other != null && s.players[other]) {
            const a = s.players[action.player].zones[z]
            const b = s.players[other].zones[z]
            s.players[action.player].zones[z] = b.map((c) => ({ ...c, owner: action.player }))
            s.players[other].zones[z] = a.map((c) => ({ ...c, owner: other }))
          }
          break
        }
        // Force a battlefield-control recompute (the trailing recomputeControllers does it).
        case 'recomputeControllers': break
        // Revert a token battlefield (Brush / Baron Pit) back to its original
        // card. Passives/scripts key on the current cardId, so restoring it
        // automatically brings the original effect back.
        case 'revertBf': {
          const bfi = action.toBattlefield
          if (bfi == null || !s.battlefields[bfi]) break
          const bf = s.battlefields[bfi]
          if (!bf.originalCardId) break
          bf.cardId = bf.originalCardId
          bf.originalCardId = undefined
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
      if (state.pendingChoice) return fail(state, 'Resolve the pending choice first.') // Hard Bargain unless-pay window
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
      fireSecondCardPlayed(s, action.player) // Darius - Trifarian
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
      // End-of-turn cleanup: clear "this turn" Might modifiers, Stun, and the
      // one-shot "would die this turn" death/banish replacements (Highlander, Smite).
      for (const pl of s.players) {
        for (const z of Object.keys(pl.zones) as ZoneId[])
          pl.zones[z] = pl.zones[z].map((c) => ({ ...c, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, grantShield: 0, grantTank: false, grantDeflect: 0, deathShield: false, banishShield: false }))
      }
      for (const bf of s.battlefields)
        bf.units = bf.units.map((u) => ({ ...u, tempMight: 0, stunned: false, grantAssault: 0, grantGanking: false, grantShield: 0, grantTank: false, grantDeflect: 0, deathShield: false, banishShield: false }))
      // "At the end of your turn, …" effects for the ending player's permanents
      // (Dazzling Aurora's free-unit engine; Annie - Dark Child's ready-runes —
      // hence the legend is included). Base gear + units + battlefield units + legend.
      const ender = state.activePlayer
      const perms = [
        ...s.players[ender].zones.base,
        ...s.battlefields.flatMap((b) => b.units.filter((u) => u.owner === ender)),
        ...(s.players[ender].legend ? [s.players[ender].legend!] : []),
      ]
      for (const perm of perms) {
        const def = getCard(perm.cardId)
        if (!def) continue
        const eot = endOfTurnEffect(def)
        // "if I'm at a battlefield, …" (Sona - Harmonious) — skip when the source
        // isn't on a battlefield (in base / legend zone).
        if (/if (?:i'm|i am) at a battlefield/i.test(def.text ?? '') && battlefieldOf(s, perm.iid) < 0) continue
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
          let out = log(s, action.player, `Buffed ${getCard(u.cardId)?.name} (+1 Might).`)
          for (const l of fireBuffTriggers(out, out.players[action.player], u.iid)) out = log(out, action.player, l)
          return ok(out)
        }
      }
      return fail(state, 'No such friendly unit to buff.')
    }

    case 'RECYCLE_RUNE': {
      let s = clone(state)
      const p = s.players[action.player]
      const rune = removeFromZone(p, 'runePool', action.iid)
      if (!rune) return fail(state, 'Rune not in your pool.')
      p.zones.runeDeck.push({ ...rune, exhausted: false, damage: 0 })
      s = log(s, action.player, `Recycled ${getCard(rune.cardId)?.name}.`)
      // Sivir - Battle Mistress: "When you recycle a rune, …" (optional exhaust-me).
      s = fireTriggers(s, collectGlobal(s, action.player, 'recycleRune'))
      return ok(s)
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

/** Whether a unit can't be chosen by an enemy's spells/abilities right now —
 *  e.g. Master Yi - Unstoppable "[Level 16] I can't be chosen by enemy spells
 *  and abilities" while its controller has 16+ XP. */
function untargetableByEnemy(state: MatchState, u: EngineCard): boolean {
  const text = (getCard(u.cardId)?.text ?? '').toLowerCase()
  if (!/can'?t be chosen by enemy spells/.test(text)) return false
  // [Level N]-gated immunity (Master Yi - Unstoppable): only while XP >= N.
  const m = text.match(/\[level\s*(\d+)\][^.]*?can'?t be chosen by enemy spells/)
  if (m) return (state.players[u.owner]?.xp ?? 0) >= parseInt(m[1], 10)
  // Unconditional immunity (Baron Nashor, Ruin Runner): no level gate.
  return true
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
