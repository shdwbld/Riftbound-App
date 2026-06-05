import type { Card, Domain } from '../types/cards'

// ---------------------------------------------------------------------------
// Lightweight effect parsing. We can't script all ~1000 bespoke cards, but we
// can auto-resolve the most common, unambiguous patterns from the card text:
//   - "draw N" / "draw a card"
//   - "channel N runes"
//   - "deal N" / "deal N damage to a unit"  (needs a target)
// Everything else is surfaced for manual resolution. Conservative on purpose:
// for non-spell cards we only fire when the text reads as an on-play trigger,
// to avoid misfiring on conditional ("when you play a spell…") text.
// ---------------------------------------------------------------------------

export type TargetScope = 'enemy' | 'friendly' | 'any' | null

export interface ParsedEffect {
  draw: number
  /** Cards the controller discards from hand ("discard N", "discard N then draw N"
   *  — Chemtech Enforcer, Scrapyard Champion, Undercover Agent, Jinx - Demolitionist,
   *  Ezreal - Prodigy, …). Auto-discards the N lowest-cost cards. Excludes opponent
   *  discards ("they discard"), optional additional-cost discards, and "discard me". */
  discard: number
  channel: number
  /** "[Add] <resource>" — rune-ramp gear/abilities that add Power/Energy directly to
   *  the pool (Seal of Rage/Focus/…, Energy Conduit). addPower is per-domain pips. */
  addEnergy: number
  addPower: Partial<Record<Domain, number>>
  /** The killed unit's CONTROLLER draws N ("kill a unit. Its controller draws 2"
   *  — Hidden Blade). Distinct from drawOnKill, which the caster draws. */
  controllerDrawOnKill: number
  /** A floor a −Might debuff can't push a unit below ("to a minimum of 1 Might"). */
  tempMightFloor: number
  /** "Each player kills one of their units" (Cull the Weak) — symmetric sacrifice. */
  cullEachPlayer: boolean
  /** Number of units to Stun ("[Stun] an enemy unit" — Vi - Peacekeeper). */
  stun: number
  /** Points scored directly ("you score N point" — Ahri, Draven - Audacious). */
  score: number
  /** XP gained directly ("gain N XP" — Scuttle Crab, Right of Conquest). */
  gainXp: number
  /** An alternate action taken on the stun target if it was ALREADY stunned,
   *  instead of stunning it: 'bounce' = return it to hand (Existential Dread),
   *  'kill' = kill it (Solari Chief). Null = always just stun. */
  ifTargetStunned: 'bounce' | 'kill' | null
  /** Max Might a kill may target ("kill a unit with 3 Might or less" — Soul
   *  Harvest). Null = no Might restriction. */
  killMightMax: number | null
  /** Extra cards drawn, one per battlefield the controller (or allies) control
   *  ("draw 1 for each battlefield you control" — Right of Conquest). */
  drawPerBattlefield: number
  /** [Assault N] granted to the chosen unit this turn ("give a unit [Assault 4]
   *  this turn" — Square Up, Vault Breaker). 0 = none. */
  grantAssault: number
  /** [Ganking] granted to the chosen unit this turn (Vault Breaker). */
  grantGanking: boolean
  /** [Assault N] granted to your OTHER units at the source's battlefield this
   *  turn ("give your other units here [Assault]" — Lord Broadmane). */
  grantAssaultHere: number
  /** Damage to each chosen target unit, if the text calls for it. */
  damage: number
  /** Number of Recruit unit tokens to create. */
  recruits: number
  /** Recruit tokens enter at the source unit's battlefield ("… token(s) here" —
   *  Noxian Drummer, Corina Veraza), not the controller's Base. */
  recruitsHere: boolean
  /** Number of Gold gear tokens to create. */
  goldTokens: number
  /** A named unit token to create (Sprite / Sand Soldier / Bird / Mech).
   *  `here` = play it at the source unit's battlefield ("… here"), not base. */
  namedToken: { name: string; count: number; exhausted: boolean; temporary: boolean; here: boolean; opponent: boolean } | null
  /** Number of your units to ready (un-exhaust) — the player chooses which. */
  readyUnits: number
  /** Ready ALL your units, no choice ("ready your units" — Shurelya's Requiem). */
  readyAllUnits: boolean
  /** "ready or exhaust a legend" (Royal Entourage) — auto-resolved (exhaust an
   *  opponent's ready legend if any, else ready your own exhausted legend). */
  readyOrExhaustLegend: boolean
  /** Strike Down: a chosen equipped friendly unit deals damage equal to its Might
   *  to an enemy, then detaches an Equipment. Hand-resolved with auto-targets. */
  strikeDown: boolean
  /** Number of your runes to ready (un-exhaust) — "ready up to N (friendly) runes"
   *  (Sona - Harmonious, Annie - Dark Child). */
  readyRunes: number
  /** +1 Might buff counters to apply (e.g. "gains +1 Might" / "buff a unit"). A
   *  "buff" is the Riftbound +1 Might token, capped at one per unit. */
  buff: number
  /** The buff(s) target the SOURCE unit ("buff me" / "gains +1 Might"), not a
   *  chosen friendly unit ("buff a friendly unit"). */
  buffSelf: boolean
  /** A targeted buff that must not pick the source ("buff ANOTHER unit"). */
  buffExcludesSelf: boolean
  /** A "ready ANOTHER unit" effect (First Mate) — the ready picker must exclude the
   *  source unit. */
  readyExcludesSelf: boolean
  /** An area buff: 'all' = every friendly unit you control ("buff all friendly
   *  units" — Overt Operation); 'here' = friendly units at the source's
   *  battlefield ("buff all units here" — Enthusiastic Promoter, Peak Guardian).
   *  Each target is still capped at one buff. */
  buffAll: 'all' | 'here' | null
  /** Ready the SOURCE unit itself ("ready me"). Distinct from `readyUnits`,
   *  which lets the controller choose which exhausted units to ready. */
  readySelf: boolean
  /** A cost: spend (remove) a buff from one of your buffed units before the
   *  self-buff/ready resolves ("spend a buff to …" — Wildclaw Shaman). If no
   *  buff is available to spend, the optional effect doesn't happen. */
  spendBuff: boolean
  /** Units to outright kill (no damage roll). */
  kill: number
  /** Signed Might-this-turn applied to each chosen target (e.g. Stupefy −1). */
  tempMight: number
  /** Return a chosen unit to its owner's hand ("Retreat"). Scope: whose unit. */
  bounce: 'friendly' | 'enemy' | 'any' | null
  /** Move a chosen unit from a battlefield to its owner's base ("move a unit from
   *  a battlefield to its base" — Fight or Flight, Isolate, Emperor's Divide). The
   *  target must be on a battlefield; `targetScope` says whose, `targetCount` how
   *  many. Not a recall (keeps damage); resolved via sendUnitToBase. */
  moveToBase: boolean
  /** Move a chosen unit to a player-chosen battlefield ("Move an enemy unit" —
   *  Charm, Skyward Strike). Distinct from moveToBase (which has a fixed base
   *  destination); the destination is picked via a pendingChoice. */
  moveUnit: boolean
  /** Grant a chosen friendly unit a one-shot death shield ("the next time it
   *  would die this turn, heal it, exhaust it, and recall it instead" —
   *  Highlander, Tactical Retreat). */
  deathShield: boolean
  /** Replace the damaged target's next death with a banish ("if it would die this
   *  turn, banish it instead" — Smite). Set on the target before damage resolves. */
  banishOnDeath: boolean
  /** Return a card from YOUR TRASH to your hand ("return a unit from your trash
   *  to your hand" — Morbid Return, Cemetery Attendant). `type` filters the trash
   *  by card type ('card' = any). Resolves by returning the highest-cost match. */
  returnFromTrash: { type: 'unit' | 'spell' | 'gear' | 'card'; count: number } | null
  /** Opponent hand disruption — "choose an opponent. They reveal their hand. Choose
   *  a [non-unit] card from it, and they discard / recycle / banish it." Mindsplitter
   *  (trash), Sabotage (deck/recycle, non-unit), Ashe - Focused (banish). Auto-picks
   *  the highest-cost matching card from the opponent holding the most cards. */
  opponentHandStrip: { to: 'trash' | 'deck' | 'banish'; nonUnit: boolean } | null
  /** "Choose a player/opponent. They discard N." — the opponent loses N cards of
   *  THEIR choice (auto: their lowest-cost). Bewitching Spirit. */
  opponentDiscards: number
  /** Play a UNIT from your trash into play (base), ignoring its cost — Soulgorger,
   *  The Harrowing, Spectral Matron, Glasc Mixologist. Optional cost cap
   *  (≤maxEnergy Energy / ≤maxPower Power). Resolves to the highest-cost qualifier.
   *  `energyOnly` = "ignoring its ENERGY cost" (still pay Power) vs "ignoring its
   *  cost" (free). */
  playUnitFromTrash: { maxEnergy: number | null; maxPower: number | null; energyOnly: boolean; fullCost?: boolean } | null
  /** Play a UNIT from your HAND, ignoring its (Energy) cost — Rift Herald's
   *  Deathknell ("Play a unit from your hand to your base, ignoring its Energy
   *  cost"). `energyOnly` keeps the Power cost due (Rift Herald); otherwise free.
   *  Auto-plays the highest-cost unit in hand into base. */
  playUnitFromHand: { energyOnly: boolean } | null
  /** Play a SPELL from your trash, then recycle it — Fizz - Trickster (Energy cost
   *  ≤ maxEnergy), Kai'Sa - Evolutionary (`dynamicCap:'points'` = Energy cost <
   *  your points). `energyOnly` ignores only the Energy cost (still pay Power). */
  playSpellFromTrash: { maxEnergy: number | null; dynamicCap: 'points' | null; energyOnly: boolean; recycleAfter: boolean } | null
  /** Reveal from the top of your Main Deck until a unit, play that unit ignoring
   *  its cost, and recycle the rest to the bottom (Dazzling Aurora). */
  revealPlayFromDeck: boolean
  /** Deck-dig: "Look at the top N cards of your Main Deck. You may reveal a <type>
   *  from among them and draw it. Recycle the rest." (Ornn - Blacksmith, Ivern -
   *  Nurturer, Rift Herald, Fate Weaver; the N=1 "reveal the top card … if it's a
   *  <type>, draw it" — Apprentice Smith.) Auto-draws the highest-cost matching card,
   *  recycling the rest to the bottom. `energyMin` is Fate Weaver's "cost 4+" filter;
   *  `thenBuffIfTribe` is Ivern's tribe-gated [Buff]. */
  peekDraw: { n: number; type: 'gear' | 'unit' | 'spell' | 'card'; energyMin?: number; thenBuffIfTribe?: string[] } | null
  /** Deck-dig: "Look at the top N cards of your Main Deck. Put 1 into your hand (/
   *  draw one) and recycle the rest." (Stacked Deck, Called Shot.) No type filter —
   *  auto-draws the highest-cost of the N. */
  peekToHand: { n: number } | null
  /** Deck-dig: "Look at/reveal the top N, you may banish one (a unit), then play it
   *  (ignoring its cost / reducing its cost by D). Recycle the rest." (Rek'Sai -
   *  Swarm Queen, Rek'sai - Void Burrower, Reinforce, Void Rush, Blind Fury.)
   *  Auto-plays the highest-cost playable UNIT for free (or whose discounted cost is
   *  0); recycles the rest (or `drawRest` = Void Rush draws them). `from:'opponent'`
   *  reveals the top of each opponent's deck (Blind Fury); `here` plays it at the
   *  source's battlefield (Swarm Queen). */
  peekBanishPlay: { n: number; from: 'self' | 'opponent'; discount?: number; here?: boolean; drawRest?: boolean } | null
  /** Runes the affected unit's owner channels exhausted (Retreat: "channels 1
   *  rune exhausted"). Distinct from `channel`, which gives the caster ready runes. */
  channelExhausted: number
  /** Signed Might-this-turn applied to the SOURCE (e.g. "give me +1 this turn"). */
  tempMightSelf: number
  /** Signed Might-this-turn applied to ALL the controller's units ("give
   *  friendly units +5 Might this turn" — Grand Strategem). */
  tempMightAll: number
  /** Signed Might-this-turn applied to ALL enemy units ("give enemy units -3 Might
   *  this turn, to a minimum of 1" — Thousand-Tailed Watcher). Floored by
   *  `tempMightFloor`. */
  tempMightAllEnemy: number
  /** Tag-scoped Might-this-turn: "give your Mechs +N Might this turn" (Danger Zone).
   *  Applies `amount` to every friendly unit carrying `tag`. */
  tempMightTag: { tag: string; amount: number } | null
  /** Multiply a per-unit effect (currently the chosen target's +Might) by the count
   *  of distinct tribe tags (Bird/Cat/Dog/Poro) among your units — "for each of the
   *  following tags … Bird, Cat, Dog, and Poro" (Friendship). */
  tribeTagCount: boolean
  /** Extra cards drawn if a chosen target dies during this resolution. */
  drawOnKill: number
  /** Who the targeted part may hit. */
  targetScope: TargetScope
  /** How many units the targeted part affects (0 = no target). */
  targetCount: number
  /** A target must be on a battlefield (not at base). */
  battlefieldOnly: boolean
  /** A gating condition the effect's controller must meet for it to apply
   *  (e.g. Jinx — "draw 1 if you have one or fewer cards in your hand"; Garen —
   *  "if you have 4+ units at that battlefield"). The caller (applyParsed)
   *  evaluates it against game state. Null = unconditional. `unitsHereAtLeast`
   *  needs the relevant battlefield's index, supplied at the trigger site.
   *  `xpAtLeast` gates a `[Level N][>]` effect on the controller's XP (Wuju
   *  Apprentice — "[Level 6][>] … draw 1"). */
  condition: { kind: 'handAtMost' | 'handAtLeast' | 'unitsHereAtLeast' | 'xpAtLeast' | 'excessAtLeast' | 'controlsTribe' | 'allTribeTags' | 'wasMighty' | 'diedAlone' | 'diedNotAlone'; value: number; tag?: string } | null
  /** True when there's text we couldn't auto-resolve. */
  manual: boolean
}

export const EMPTY_EFFECT = (): ParsedEffect => ({
  draw: 0,
  discard: 0,
  channel: 0,
  addEnergy: 0,
  addPower: {},
  controllerDrawOnKill: 0,
  tempMightFloor: 0,
  cullEachPlayer: false,
  stun: 0,
  score: 0,
  gainXp: 0,
  ifTargetStunned: null,
  killMightMax: null,
  drawPerBattlefield: 0,
  grantAssault: 0,
  grantGanking: false,
  grantAssaultHere: 0,
  damage: 0,
  recruits: 0,
  recruitsHere: false,
  readyAllUnits: false,
  readyOrExhaustLegend: false,
  strikeDown: false,
  goldTokens: 0,
  namedToken: null,
  readyUnits: 0,
  readyRunes: 0,
  buff: 0,
  buffSelf: false,
  buffExcludesSelf: false,
  readyExcludesSelf: false,
  buffAll: null,
  readySelf: false,
  spendBuff: false,
  kill: 0,
  tempMight: 0,
  bounce: null,
  moveToBase: false,
  moveUnit: false,
  deathShield: false,
  banishOnDeath: false,
  returnFromTrash: null,
  opponentHandStrip: null,
  opponentDiscards: 0,
  playUnitFromTrash: null,
  playUnitFromHand: null,
  playSpellFromTrash: null,
  revealPlayFromDeck: false,
  peekDraw: null,
  peekToHand: null,
  peekBanishPlay: null,
  channelExhausted: 0,
  tempMightSelf: 0,
  tempMightAll: 0,
  tempMightAllEnemy: 0,
  tempMightTag: null,
  tribeTagCount: false,
  drawOnKill: 0,
  targetScope: null,
  targetCount: 0,
  battlefieldOnly: false,
  condition: null,
  manual: false,
})

/** The part of an effect that requires choosing target unit(s). */
export function hasTargetedPart(e: ParsedEffect): boolean {
  return e.damage > 0 || e.kill > 0 || e.tempMight !== 0 || e.bounce !== null || e.moveToBase || e.moveUnit || e.stun > 0 || e.grantAssault > 0 || e.grantGanking || e.deathShield
}
/** The part of an effect that resolves with no target (draw/channel/etc.). */
export function hasUntargetedPart(e: ParsedEffect): boolean {
  return e.draw > 0 || e.discard > 0 || e.drawPerBattlefield > 0 || e.channel > 0 || e.channelExhausted > 0 || e.recruits > 0 || e.goldTokens > 0 || !!e.namedToken || e.readyUnits > 0 || e.readyRunes > 0 || e.buff > 0 || !!e.buffAll || e.tempMightSelf !== 0 || e.tempMightAll !== 0 || e.tempMightAllEnemy !== 0 || !!e.tempMightTag || e.cullEachPlayer || e.grantAssaultHere > 0 || !!e.returnFromTrash || !!e.playUnitFromTrash || !!e.playUnitFromHand || e.revealPlayFromDeck || !!e.peekDraw || !!e.peekToHand || !!e.peekBanishPlay || e.score > 0 || !!e.opponentHandStrip || e.opponentDiscards > 0
}

const WORD_NUM: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
}

function num(token: string): number {
  return WORD_NUM[token.toLowerCase()] ?? (parseInt(token, 10) || 0)
}

const NUM = '(\\d+|a|an|one|two|three|four|five)'

/** The Might symbol token or the literal word. */
const MIGHT = '(?::rb_might:|might)'

function parse(text: string): ParsedEffect {
  const t = text.toLowerCase()
  const eff = EMPTY_EFFECT()
  let hit = false

  // Hand-size gate ("draw 1 if you have one or fewer cards in your hand" — Jinx).
  // Recorded on the effect; applyParsed checks it against state before applying.
  // Not counted as a `hit` on its own (a bare condition with no action is inert).
  const condAtMost = t.match(new RegExp(`if you have ${NUM} or fewer cards? in your hand`))
  if (condAtMost) eff.condition = { kind: 'handAtMost', value: num(condAtMost[1]) }
  const condAtLeast = t.match(new RegExp(`if you have ${NUM} or more cards? in your hand`))
  if (condAtLeast) eff.condition = { kind: 'handAtLeast', value: num(condAtLeast[1]) }
  // "if you have 4+ units at that battlefield" / "N or more units at …" (Garen).
  const condUnits = t.match(new RegExp(`if you have (\\d+)\\+? (?:or more )?units? at (?:that|this|the) battlefield`))
  if (condUnits) eff.condition = { kind: 'unitsHereAtLeast', value: parseInt(condUnits[1], 10) }
  // "if you assigned 3 or more excess damage" (Vi - Piltover Enforcer, Yeti Brawler).
  const condExcess = t.match(/if you assigned (\d+)\+? (?:or more )?excess damage/)
  if (condExcess) eff.condition = { kind: 'excessAtLeast', value: parseInt(condExcess[1], 10) }
  // Tribe/tag conditions. "if you control a Poro" (Poro Herder) — controlsTribe.
  const condTribe = t.match(/if you control an? (bird|cat|dog|poro|dragon|mech)\b/)
  if (condTribe) eff.condition = { kind: 'controlsTribe', value: 1, tag: condTribe[1] }
  // "your units have all (4 / of the following) tags … Bird … Poro" — allTribeTags
  // (Ivern - Friend to All score; Daisy! attack-stun).
  if (/all (?:4|four) tags/.test(t) || /all of the following tags[^.]*?\bporo\b/.test(t)) eff.condition = { kind: 'allTribeTags', value: 4 }
  // Deathknell state gates (evaluated at death in fireDeaths; conditionMet passes).
  // "[Mighty]" is stripped to "" in Deathknell clauses, leaving "if i was , draw 2",
  // so match both the full phrase and that residue.
  if (/if i was[^.]*mighty/.test(t) || /if i was\s*,/.test(t)) eff.condition = { kind: 'wasMighty', value: 5 }
  if (/if i did(?:n'?t| not) die alone/.test(t)) eff.condition = { kind: 'diedNotAlone', value: 0 }
  else if (/if i died alone/.test(t)) eff.condition = { kind: 'diedAlone', value: 0 }
  // "+N Might … for each of the following tags … Bird … Poro" (Friendship) — the
  // chosen target's temp-Might is multiplied by the live distinct-tribe count.
  if (/for each of the following tags[^.]*?\bporo\b/.test(t)) eff.tribeTagCount = true

  // Conditional draw on a kill ("if this kills it … draw 1"); detected first so
  // its "draw N" isn't also counted as an unconditional draw.
  const dokM = t.match(new RegExp(`if (?:this kills it|it (?:dies|would die))[^.]*?draw ${NUM}`))
  if (dokM) { eff.drawOnKill += num(dokM[1]); hit = true }

  // "draw N for each battlefield you (or allies) control" (Right of Conquest) —
  // parsed (and stripped) first so its "draw N" isn't also a flat draw.
  const dpbM = t.match(new RegExp(`draw ${NUM} for each battlefield (?:you|an ally)`))
  if (dpbM) { eff.drawPerBattlefield += num(dpbM[1]); hit = true }

  let tNoCond = dokM ? t.replace(dokM[0], ' ') : t
  if (dpbM) tNoCond = tNoCond.replace(dpbM[0], ' ')

  // The trailing \b stops "draw an" matching inside "draw any (you didn't banish)"
  // (Void Rush) and similar — a number word must end at a boundary.
  const drawM = tNoCond.match(new RegExp(`draw ${NUM}\\b`))
  if (drawM) { eff.draw += num(drawM[1]); hit = true }

  // "discard N" self-discard (Chemtech Enforcer, Scrapyard, Undercover Agent, Jinx -
  // Demolitionist, "discard N then draw N"). Skip opponent discards ("they discard")
  // and optional additional-cost discards ("you may discard … as an additional cost").
  const dm = t.match(new RegExp(`discard ${NUM}\\b`))
  if (dm) {
    const idx = dm.index ?? 0
    const pre = t.slice(Math.max(0, idx - 14), idx)
    const post = t.slice(idx, idx + 50)
    if (!/\bthey\s+$/.test(pre) && !/\bmay\b/.test(pre) && !/as an additional cost/.test(post)) {
      eff.discard += num(dm[1]); hit = true
    }
  }

  // Channel ready runes — but NOT the "channel N rune exhausted" variant (Soaring
  // Scout), which the channelExhausted parse below handles as exhausted instead.
  const chM = t.match(new RegExp(`channel ${NUM}`))
  if (chM && !/channel[^.]*?exhausted/.test(t)) {
    eff.channel += num(chM[1]); hit = true
  }

  // "[Add] <resource>" — rune-ramp (Seal of Rage/Focus/…, Energy Conduit, Malzahar):
  // add Power pips and/or Energy directly to the pool.
  for (const m of t.matchAll(/\[add\]\s*:rb_rune_([a-z]+):/g)) {
    eff.addPower[m[1] as Domain] = (eff.addPower[m[1] as Domain] ?? 0) + 1; hit = true
  }
  const addEM = t.match(/\[add\]\s*:rb_energy_(\d+):/)
  if (addEM) { eff.addEnergy += parseInt(addEM[1], 10); hit = true }

  // "Its controller draws N" (Hidden Blade) — the KILLED unit's owner draws.
  const ctrlDrawM = t.match(new RegExp(`controller draws? ${NUM}`))
  if (ctrlDrawM) { eff.controllerDrawOnKill += num(ctrlDrawM[1]); hit = true }

  // "to a minimum of N Might" — a floor a −Might debuff can't push below.
  const floorM = t.match(new RegExp(`to a minimum of (\\d+)\\s*${MIGHT}`))
  if (floorM) eff.tempMightFloor = parseInt(floorM[1], 10)

  // "Each player kills one of their units" (Cull the Weak) — symmetric sacrifice.
  if (/each player kills? (?:one|1|a)\b[^.]*?units?/.test(t)) { eff.cullEachPlayer = true; hit = true }

  const recM = t.match(new RegExp(`play ${NUM}[^.]*?recruit unit tokens?( here)?`))
  if (recM) { eff.recruits += num(recM[1]); if (recM[2]) eff.recruitsHere = true; hit = true }

  // Gold gear tokens: "play a Gold gear token", "play 2 gold gear tokens".
  const goldM = t.match(new RegExp(`play ${NUM}[^.]*?gold gear tokens?`))
  if (goldM) { eff.goldTokens += num(goldM[1]); hit = true }

  // Named unit tokens: "play a 2 :rb_might: Sand Soldier unit token",
  // "play a ready 3 Sprite unit token", "play a 1 Might Bird unit token".
  // The (?!me\b|this\b) skips "when you play me" so the count anchors on the real
  // "play <N> <token>" clause (e.g. "play me, play four Bird tokens").
  const namedM = t.match(/play (?!me\b|this\b)(?:a |an |(\d+|two|three|four|five|six) )?(?:ready |exhausted )?[^.]*?\b(sprite|sand soldier|bird|mech)\b[^.]*?tokens?(?:\s+with\s+\[temporary\])?/)
  if (namedM) {
    eff.namedToken = {
      name: namedM[2],
      count: namedM[1] ? num(namedM[1]) : 1,
      exhausted: !/\bready\b/.test(namedM[0]),
      temporary: /\[temporary\]/.test(namedM[0]),
      // "play a … token here" → at the source's battlefield. \bhere\b excludes
      // "there" (whose origin-placement stays at base, correct for base→bf moves).
      here: /\bhere\b/.test(t),
      // "choose an opponent. They play a … token" (Walking Roost) → the OPPONENT
      // gets the token in THEIR base.
      opponent: /\bthey play\b/.test(t),
    }
    hit = true
  }

  // Ready your unit(s): "ready a friendly unit", "ready up to 2 units" — the
  // player chooses which to un-exhaust. ("enters ready" is a different effect.)
  // Guard against "ready" as a TOKEN adjective ("play a ready 3 :rb_might: Sprite
  // unit token" — Trevor Snoozebottom): that's part of the token, not a
  // ready-units action, and always reads "a/an ready …".
  // "ready your units" / "ready all (your/friendly) units" with no count — readies
  // every friendly unit (Shurelya's Requiem). Distinct from the counted form below.
  if (/\bready (?:all (?:your |friendly )?|your )units\b/.test(t)) { eff.readyAllUnits = true; hit = true }
  // "ready or exhaust a legend" (Royal Entourage).
  if (/\bready or exhaust an? legend\b/.test(t)) { eff.readyOrExhaustLegend = true; hit = true }
  // Strike Down: "choose an equipped friendly unit. It deals damage equal to its
  // Might to an enemy unit. Then detach an Equipment from it."
  if (/choose an equipped friendly unit\.[\s\S]*deals damage equal to its might[\s\S]*then detach/.test(t)) { eff.strikeDown = true; hit = true }
  const readyM = t.match(/\bready (?:up to )?(a|an|another|target|one|two|three|\d+)\b[^.]*?\bunits?\b/i)
  if (readyM && !/\b(?:a|an) ready\b/.test(t)) {
    const w = readyM[1].toLowerCase()
    eff.readyUnits += /^(a|an|another|target|one)$/.test(w) ? 1 : num(w)
    if (w === 'another') eff.readyExcludesSelf = true // "ready ANOTHER unit" (First Mate)
    hit = true
  }

  // Ready your RUNES: "ready up to N (friendly) runes" (Sona - Harmonious, Annie -
  // Dark Child). Distinct from readyUnits (needs the "runes" noun).
  const readyRunesM = t.match(new RegExp(`ready (?:up to )?${NUM} (?:friendly )?runes?`))
  if (readyRunesM) { eff.readyRunes += num(readyRunesM[1]); hit = true }

  // Damage to unit(s): "deal 3 to a unit", "deal 6 to each of up to two units".
  const dmgM = t.match(/deal (\d+)(?: damage)?\s+to\b[^.]*?units?/)
  if (dmgM) { eff.damage += parseInt(dmgM[1], 10); hit = true }

  // Outright kill: "kill a unit". May be restricted to "with N Might or less".
  const killM = t.match(/\bkill (?:a |an |target |another )?unit/)
  if (killM) {
    eff.kill += 1; hit = true
    const kmM = t.match(new RegExp(`kill[^.]*?with (\\d+)\\s*${MIGHT} or less`))
    if (kmM) eff.killMightMax = parseInt(kmM[1], 10) // Soul Harvest
  }

  // Stun: "[Stun] an enemy unit" / "Stun a friendly unit and an enemy unit".
  // Count the unit nouns in the stun clause (Facebreaker stuns two).
  const stunIdx = t.search(/\bstun\b/)
  if (stunIdx >= 0) {
    const seg = t.slice(stunIdx).split('.')[0]
    const cnt = (seg.match(/\bunits?\b/g) || []).length
    if (cnt > 0) { eff.stun += cnt; hit = true }
    // "If it's already stunned, return it to its owner's hand instead"
    // (Existential Dread) / "if it is stunned, kill it" (Solari Chief): an
    // alternate action when the target was already stunned.
    if (/(?:already stunned|it is stunned|it's stunned)[^.]*?(?:return it|to (?:its owner'?s?|their) hand)/.test(t)) eff.ifTargetStunned = 'bounce'
    else if (/if it(?:'s| is) (?:already )?stunned, kill it/.test(t)) eff.ifTargetStunned = 'kill'
  }

  // Direct scoring: "you score 1 point" / "score 2 points" (Ahri, Draven -
  // Audacious, Renata, Power Nexus). Not the noun "score" ("opponent's score",
  // "Victory Score") — requires a number + "point(s)".
  const scoreM = t.match(new RegExp(`score ${NUM} points?`))
  if (scoreM) { eff.score += num(scoreM[1]); hit = true }

  // Direct XP gain: "gain 1 XP" / "gain :rb_xp: 2" (Scuttle Crab, Right of Conquest).
  const xpGainM = t.match(/gain (\d+)\s*(?::rb_xp:|xp)/)
  if (xpGainM) { eff.gainXp += parseInt(xpGainM[1], 10); hit = true }

  // Temporary keyword grants "this turn". Targeted: "give a unit [Assault N] (and
  // [Ganking]) this turn" (Square Up, Vault Breaker). Area: "give your other
  // units here [Assault] this turn" (Lord Broadmane).
  if (/this turn/.test(t)) {
    const areaM = t.match(/give your (?:other )?units here \[assault(?:\s*(\d+))?\]/)
    if (areaM) { eff.grantAssaultHere = areaM[1] ? parseInt(areaM[1], 10) : 1; hit = true }
    else {
      const gaM = t.match(/give (?:a|an|target|another) (?:friendly |enemy )?unit[^.]*?\[assault(?:\s*(\d+))?\]/)
      if (gaM) { eff.grantAssault = gaM[1] ? parseInt(gaM[1], 10) : 1; hit = true }
      const ggM = t.match(/give (?:a|an|target|another) (?:friendly |enemy )?unit[^.]*?\[ganking\]/)
      if (ggM) { eff.grantGanking = true; hit = true }
    }
  }

  // Bounce: "return a friendly unit to its owner's hand" (Retreat). Scope from
  // the determiner — friendly / enemy / any.
  const bounceM = t.match(/return (?:a|an|target|another) (friendly |enemy )?unit to (?:its owner'?s?|your|their) hand/)
  if (bounceM) {
    eff.bounce = bounceM[1]?.trim() === 'friendly' ? 'friendly' : bounceM[1]?.trim() === 'enemy' ? 'enemy' : 'any'
    hit = true
  }
  // Move a unit (on a battlefield) to its base — "move a unit from a battlefield
  // to its base" (Fight or Flight, Maddened Marauder), "move an enemy unit … to
  // its base" (Isolate), "move … units … to their base" (Emperor's Divide). Not a
  // recall (keeps damage). Excludes the token-spawn "play a … token to your base"
  // (those have no "move") and the self-move "move me to your base" (no "unit").
  if (/\bmove\b[^.]*?\bunits?\b[^.]*?\bto (?:its|their|your) base\b/.test(t)) {
    eff.moveToBase = true
    eff.battlefieldOnly = true // a unit at base can't be moved to base
    hit = true
  }
  // Move a chosen unit to a chosen battlefield ("Move an enemy unit" — Charm,
  // Skyward Strike). Only when it's NOT a move-to-base; the destination is picked
  // via a pendingChoice. Excludes the "move me/self" forms (no unit noun).
  else if (/\bmove (?:a|an|target|up to \w+) (?:friendly |enemy )?units?\b/.test(t)) {
    eff.moveUnit = true
    hit = true
  }
  // One-shot death shield: "the next time it would die this turn, heal it,
  // exhaust it, and recall it instead" (Highlander, Tactical Retreat).
  if (/the next time it would die this turn[^.]*?(?:heal it|recall)/.test(t)) {
    eff.deathShield = true
    eff.targetScope = eff.targetScope ?? 'friendly'
    if (!eff.targetCount) eff.targetCount = 1
    hit = true
  }
  // Banish-instead-of-death: "if it would die this turn, banish it instead"
  // (Smite — paired with a "deal N to a unit" part that supplies the target).
  if (/if it would die[^.]*?banish it instead/.test(t)) { eff.banishOnDeath = true; hit = true }
  // Return a card from your TRASH to your hand ("return a unit/spell/gear from
  // your trash to your hand" — Morbid Return, Annie, Aspiring Engineer, …). The
  // type word filters the trash; "or"/named-subtypes fall back to any card.
  const rftM = t.match(/return (?:a|an|up to (\d+|two|three))\s+([a-z][a-z, ]*?)\s*(?:with \[[^\]]+\] )?from your trash to your hand/)
  if (rftM) {
    const count = rftM[1] ? num(rftM[1]) : 1
    const ph = rftM[2]
    const type: 'unit' | 'spell' | 'gear' | 'card' =
      /\bor\b|,/.test(ph) ? 'card'
        : /\bspell\b/.test(ph) ? 'spell'
          : /\bgear\b/.test(ph) ? 'gear'
            : /\bunit\b/.test(ph) ? 'unit' : 'card'
    eff.returnFromTrash = { type, count }
    hit = true
  }
  // Opponent hand disruption — "They reveal their hand. Choose a [non-unit] card
  // from it, and they discard / recycle / banish it" (Mindsplitter → trash, Sabotage
  // → deck, Ashe - Focused → banish). Auto-picks the highest-cost match.
  const ohsM = t.match(/they reveal their hand\.?[\s\S]*?choose (?:a|an) (non-unit )?card[\s\S]*?(?:they discard|recycle|banish)/)
  if (ohsM) {
    const to: 'trash' | 'deck' | 'banish' = /recycle (?:that card|it)/.test(t) ? 'deck' : /banish (?:that card|it)\b/.test(t) ? 'banish' : 'trash'
    eff.opponentHandStrip = { to, nonUnit: !!ohsM[1] }
    hit = true
  }
  // "Choose a player/opponent. They discard N." — opponent's own choice (Bewitching
  // Spirit). Distinct from self-discard (e.discard) and the strip above.
  const odM = !ohsM ? t.match(/(?:choose (?:a player|an opponent)[\s\S]*?)?they discard (\d+|a|an|one)\b/) : null
  if (odM) { eff.opponentDiscards += num(odM[1]); hit = true }
  // Play a unit from your trash, ignoring its cost (Soulgorger, The Harrowing,
  // Spectral Matron, Glasc Mixologist). Optional "no more than :rb_energy_N:
  // and no more than :rb_rune_*:" cost cap.
  const putM = t.match(/play a unit[^.]*?from your trash[^.]*?ignoring its (energy )?cost/)
  if (putM) {
    const me = putM[0].match(/no more than :rb_energy_(\d+):/)
    const mp = (putM[0].match(/:rb_rune_[a-z]+:/g) || []).length
    // "ignoring its ENERGY cost" (The Harrowing, Soulgorger) still charges the
    // Power cost; "ignoring its cost" (Spectral Matron, Glasc) waives everything.
    eff.playUnitFromTrash = { maxEnergy: me ? parseInt(me[1], 10) : null, maxPower: mp || null, energyOnly: !!putM[1] }
    hit = true
  }
  // Full-cost variant — "play a unit from your trash. (You still pay its costs.)"
  // (Last Rites). No cost is ignored; only the from-hand restriction is bypassed,
  // so the unit's full Energy + Power is paid from the pool.
  if (!eff.playUnitFromTrash && /play a unit from your trash\b/.test(t) && /(?:you )?still pay its costs?\b/.test(t)) {
    eff.playUnitFromTrash = { maxEnergy: null, maxPower: null, energyOnly: false, fullCost: true }
    hit = true
  }
  // Play a unit from your HAND, ignoring its (Energy) cost — Rift Herald's
  // [Deathknell] ("Play a unit from your hand to your base, ignoring its Energy
  // cost"). "ignoring its ENERGY cost" still owes Power.
  const pufhM = t.match(/play a unit from your hand(?: to your base)?[^.]*?ignoring its (energy )?cost/)
  if (pufhM) {
    eff.playUnitFromHand = { energyOnly: !!pufhM[1] }
    hit = true
  }
  // Play a SPELL from your trash, then recycle it — Fizz - Trickster ("Energy cost
  // no more than :rb_energy_3:"), Kai'Sa - Evolutionary ("Energy cost less than
  // your points"). Both ignore the Energy cost (still pay Power).
  const pstM = t.match(/play a spell from your trash[^.]*?(?:ignoring its energy cost|without paying its energy cost)/)
  if (pstM) {
    const me = pstM[0].match(/no more than :rb_energy_(\d+):/)
    eff.playSpellFromTrash = {
      maxEnergy: me ? parseInt(me[1], 10) : null,
      dynamicCap: /less than your points/.test(pstM[0]) ? 'points' : null,
      energyOnly: true,
      // Both cards recycle the spell afterward; the "Then recycle it" sentence can
      // be truncated off a trigger clause, so default true (leaving it in trash
      // would let it be replayed every turn).
      recycleAfter: true,
    }
    hit = true
  }
  // "reveal cards from the top of your Main Deck until you reveal a unit … play
  // it, ignoring its cost, and recycle the rest" (Dazzling Aurora).
  if (/reveal cards from (?:the )?top of your main deck until you reveal a unit/.test(t)) {
    eff.revealPlayFromDeck = true
    hit = true
  }
  // Deck-dig: "look at the top N cards of your Main Deck … (you may) reveal a <type>
  // … and draw it. Recycle the rest." (Ornn, Ivern, Rift Herald, Fate Weaver) and
  // the N=1 "reveal the top card … if it's a <type>, draw it" (Apprentice Smith).
  const pdM = t.match(/(?:look at|reveal) the top (\d+|a|an|one|two|three|four|five) cards? of your main deck[\s\S]*?reveal (?:a|an) (gear|unit|spell|card)\b[\s\S]*?draw it/)
  const asM = !pdM ? t.match(/reveal the top card of your main deck[\s\S]*?if it'?s (?:a|an) (gear|unit|spell|card)\b[\s\S]*?draw it/) : null
  if (pdM || asM) {
    const m = (pdM || asM) as RegExpMatchArray
    const type = m[pdM ? 2 : 1] as 'gear' | 'unit' | 'spell' | 'card'
    const emM = m[0].match(/energy cost :rb_energy_(\d+): or more/)
    eff.peekDraw = { n: pdM ? num(pdM[1]) : 1, type, ...(emM ? { energyMin: parseInt(emM[1], 10) } : {}) }
    if (/if you revealed a bird/.test(t)) eff.peekDraw.thenBuffIfTribe = ['Bird', 'Cat', 'Dog', 'Poro']
    hit = true
  }
  // Deck-dig: "look at the top N cards … put 1 into your hand (/ draw one) and
  // recycle the rest" (Stacked Deck, Called Shot). No type filter.
  if (!eff.peekDraw) {
    const pthM = t.match(/look at the top (\d+|a|an|one|two|three|four|five) cards? of your main deck[\s\S]*?(?:put (?:1|one|a card) into your hand|draw one)[\s\S]*?recycle the (?:rest|other)/)
    if (pthM) { eff.peekToHand = { n: num(pthM[1]) }; hit = true }
  }
  // Deck-dig: "look at/reveal the top N … (you may) banish one/a unit, then play it
  // (ignoring its cost / reducing its cost by D)" (Rek'Sai - Swarm Queen, Rek'sai -
  // Void Burrower, Reinforce, Void Rush). Blind Fury reveals each opponent's top
  // card instead. Auto-plays the best playable unit; recycles (or draws) the rest.
  const pbpM = t.match(/(?:look at|reveal) the top (\d+|a|an|one|two|three|four|five) cards? of your main deck[\s\S]*?banish (?:one|an?(?: unit)?)\b[\s\S]*?play it/)
  const bfM = !pbpM ? t.match(/each opponent reveals the top card[\s\S]*?banish it,? then play it/) : null
  if (pbpM || bfM) {
    // "reducing its cost by N" can sit after "play it", so scan the whole text.
    const discM = t.match(/reducing its cost by :rb_energy_(\d+):/)
    eff.peekBanishPlay = {
      n: pbpM ? num(pbpM[1]) : 1,
      from: bfM ? 'opponent' : 'self',
      ...(discM ? { discount: parseInt(discM[1], 10) } : {}),
      ...(/play it here|play it (?:to|at) (?:that|the) battlefield/.test(t) ? { here: true } : {}),
      ...(/draw any you didn'?t banish/.test(t) ? { drawRest: true } : {}),
    }
    hit = true
  }
  // "its owner channels N rune(s) exhausted" — tied to the bounced unit's owner.
  const chExM = t.match(new RegExp(`channels? ${NUM} runes? exhausted`))
  if (chExM) { eff.channelExhausted += num(chExM[1]); hit = true }

  // Signed Might-this-turn to a CHOSEN target: "give a/an/target/another unit … +N
  // Might this turn", "give it +N …" (the previously-chosen unit), "give one of
  // your other units … +N". Allow location/qualifier words between the noun and
  // the value ("…at a battlefield +2", "…they control here +1").
  const tmTargetM = t.match(new RegExp(`give (?:it|a|an|target|another|one of (?:your )?other) (?:friendly |enemy )?(?:units?)?[^.+]*?(-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmTargetM) {
    const sign = tmTargetM[1] === '-' ? -1 : 1
    eff.tempMight += sign * parseInt(tmTargetM[2], 10)
    hit = true
  }

  // "give N (friendly) units each +M Might this turn" — M to each of N chosen
  // units (Back to Back, Bonds of Strength). targetCount is set by `multiM` below.
  const tmEachM = t.match(new RegExp(`give ${NUM} (?:friendly )?units? each (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmEachM) { eff.tempMight += (tmEachM[2] === '-' ? -1 : 1) * parseInt(tmEachM[3], 10); hit = true }

  // Signed Might-this-turn to self: "give me +1 Might this turn". Guard against a
  // cost-gated activated clause ("Spend my buff: Give me +4 Might this turn" —
  // Sett - Brawler): that effect only happens when the ability is ACTIVATED (the
  // activated path parses the post-cost clause), not on play. `costGated` is only
  // true when parsing the whole card text, which still has the "spend … buff:" cost.
  const costGated = /spend (?:my|a|an|its|the) buffs?\s*:/.test(t)
  const tmSelfM = costGated ? null : t.match(new RegExp(`give me (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmSelfM) {
    const sign = tmSelfM[1] === '-' ? -1 : 1
    eff.tempMightSelf += sign * parseInt(tmSelfM[2], 10)
    hit = true
  }

  // Signed Might-this-turn to ALL your units: "give (all/your/other) friendly
  // units (here/there) +N Might this turn" (Grand Strategem, Undertitan, Siphon
  // Power). Plural "units" — board-wide, no target. (Tag-scoped "your Mechs +N"
  // is intentionally NOT matched — it would over-buff non-Mechs; left manual.)
  const tmAllM = t.match(new RegExp(`give (?:all |your )?(?:other )?(?:friendly )?units(?:\\s+(?:here|there))? (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmAllM) {
    eff.tempMightAll += (tmAllM[1] === '-' ? -1 : 1) * parseInt(tmAllM[2], 10)
    hit = true
  }

  // Signed Might-this-turn to ALL ENEMY units: "give (all) enemy units -N Might this
  // turn (to a minimum of 1)" (Thousand-Tailed Watcher). Floored by tempMightFloor.
  const tmEnemyM = t.match(new RegExp(`give (?:all )?enemy units?(?:\\s+(?:here|there))? (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmEnemyM) {
    eff.tempMightAllEnemy += (tmEnemyM[1] === '-' ? -1 : 1) * parseInt(tmEnemyM[2], 10)
    hit = true
  }

  // Tag-scoped Might-this-turn: "give your Mechs +N Might this turn" (Danger Zone).
  // The tag is the capitalized noun (plural 's' stripped). Skip the generic "units"
  // form (handled by tempMightAll above).
  const tmTagM = t.match(new RegExp(`give your ([a-z]+?)s? (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmTagM && !['unit', 'friendly', 'other', 'token', 'enemy'].includes(tmTagM[1])) {
    const tag = tmTagM[1][0].toUpperCase() + tmTagM[1].slice(1)
    eff.tempMightTag = { tag, amount: (tmTagM[2] === '-' ? -1 : 1) * parseInt(tmTagM[3], 10) }
    hit = true
  }

  // Permanent +Might buff counter ("this unit gains +1 Might"), not "this turn".
  // This phrasing always refers to the source unit, so it's a self-buff.
  if (!/this turn/.test(t)) {
    const buffM = t.match(new RegExp(`(?:gains?|grant|put) \\+?${NUM} ${MIGHT}`))
    if (buffM) { eff.buff += num(buffM[1]); eff.buffSelf = true; hit = true }
  }

  // The Riftbound "buff" action (give a +1 Might buff token; max one per unit).
  // Normalize the "[Buff]" word-backer bracket form ("[Buff] a unit") to plain
  // "buff" so the regexes below fire. "buff me/this" buffs the source; "buff
  // all (friendly) units (here)" is an area buff; "buff a/another friendly unit"
  // buffs a chosen friendly unit. Skip when already a "gains +N" self-buff.
  const bt = t.replace(/\[buff\]/g, 'buff')
  if (!eff.buff) {
    if (/\bbuff (?:me|myself|this)\b/.test(bt)) {
      eff.buff += 1; eff.buffSelf = true; hit = true
    }
    // Area buff: "buff all (other) (friendly) units (here/there/at …)" /
    // "buff all units here". "here"/"there"/"at" scopes it to the source's bf.
    const allM = bt.match(/\bbuff all (?:other )?(?:friendly )?units?(?:\s+(here|there|at))?/)
    if (allM) { eff.buffAll = allM[1] ? 'here' : 'all'; hit = true }
    // "buff it/them" — a contextual target (Nami "ready it and [Buff] it"). The
    // engine can't track "it", so applyBuff picks a friendly unit (highest Might).
    else if (!eff.buffSelf && /\bbuff (?:it|them)\b/.test(bt)) { eff.buff += 1; hit = true }
    // Targeted single/multi buff (only if it wasn't a self- or area-buff). Allow
    // one adjective ("an EXHAUSTED friendly unit") between determiner and noun.
    if (!eff.buffSelf && !eff.buffAll) {
      const bm = bt.match(
        new RegExp(`\\bbuff (?:up to ${NUM} )?(?:a|an|another|the chosen|target|one|two|\\d+)?\\s*(?:[a-z]+ )?(?:other )?(?:friendly )?units?`),
      )
      if (bm) {
        eff.buff += bm[1] ? num(bm[1]) : 1
        // "buff ANOTHER / OTHER friendly unit" excludes the source from candidates.
        if (/\b(?:another|other)\b/.test(bm[0])) eff.buffExcludesSelf = true
        hit = true
      }
    }
  }

  // "ready me/myself/this" — un-exhaust the source unit (vs. `readyUnits`, a
  // choose-which-to-ready effect that needs a unit noun).
  if (/\bready (?:me|myself|this)\b/.test(t)) { eff.readySelf = true; hit = true }

  // "spend a/its/my/N buff(s)" — a cost paid by removing buff counters (Wildclaw
  // Shaman, Monastery of Hirana, Call to Glory, Kraken Hunter, …). The actual
  // effect supplies the `hit`.
  if (/\bspend (?:a|an|its|my|the|any number of|\d+) buffs?\b/.test(t)) eff.spendBuff = true

  // Multi-target count: "each of up to two units" / "up to 2 units" / "N units each".
  const multiM = t.match(new RegExp(`(?:each of )?up to ${NUM} units?`)) || t.match(new RegExp(`each of ${NUM} units?`)) || t.match(new RegExp(`give ${NUM} (?:friendly )?units? each`))

  // Resolve targeting metadata for any targeted part.
  if (hasTargetedPart(eff)) {
    eff.targetCount = multiM ? num(multiM[1]) : Math.max(1, eff.stun)
    // A move-to-base target must be on a battlefield even when the text reads
    // "from a battlefield" rather than "at a battlefield".
    eff.battlefieldOnly = eff.battlefieldOnly || /at a battlefield/.test(t)
    eff.targetScope =
      eff.bounce && eff.bounce !== 'any'
        ? eff.bounce // an explicit "return a friendly/enemy unit"
        : /friendly|your unit/.test(t)
          ? 'friendly'
          : /enemy|opposing/.test(t)
            ? 'enemy'
            : eff.tempMight > 0 || eff.buff > 0 || eff.grantAssault > 0 || eff.grantGanking
              ? 'friendly' // buffs / keyword grants help your own units
              : eff.bounce || eff.moveToBase || eff.moveUnit
                ? 'any' // a generic "return / move a unit" can hit either side
                : 'enemy' // damage / kill / debuff default to enemies
  }

  // [Level N][>] activated gate (Wuju Apprentice — "[Level 6][>] … draw 1"): a
  // resource effect (draw/channel/recruit/token) that lives ONLY inside the gated
  // clause must be conditioned on the controller having N+ XP. We compare against
  // the pre-gate text so a base effect the Level clause merely upgrades (Combat
  // Experience's +1 → +3 Might) stays ungated. Continuous "+Might / enters ready"
  // Levels are handled separately by levelBonus(); only resource effects need this.
  const lvlGate = t.match(/\[level\s*(\d+)\]\s*\[(?:&gt;|>)\]/)
  if (lvlGate && lvlGate.index != null && !eff.condition) {
    const pre = parse(t.slice(0, lvlGate.index))
    const resources: (keyof ParsedEffect)[] = ['draw', 'channel', 'recruits', 'goldTokens', 'namedToken']
    const hasRes = (e: ParsedEffect) => resources.some((k) => e[k])
    // Gate only when every present resource effect comes from the gated portion.
    if (hasRes(eff) && !hasRes(pre)) eff.condition = { kind: 'xpAtLeast', value: num(lvlGate[1]) }
  }

  // Ivern - Nurturer's "[Buff] a friendly unit" is gated on revealing a tribe card,
  // so it's folded into peekDraw — drop the buff the generic parser also captured so
  // it doesn't apply unconditionally.
  if (eff.peekDraw?.thenBuffIfTribe) { eff.buff = 0; eff.buffSelf = false; eff.buffExcludesSelf = false; eff.buffAll = null }

  if (!hit && t.trim().length > 0) eff.manual = true
  return eff
}

const ON_PLAY = /when (?:i(?:'m| am)? )?(?:played|enter|cast)|when you play (?:me|this)|^play/

/** Effect to apply when a SPELL resolves (its whole text is the effect). */
export function spellEffect(card: Card): ParsedEffect {
  return parse(card.text ?? '')
}

/** Parse an arbitrary effect clause (used by battlefield passives). */
export function parseEffectText(text: string): ParsedEffect {
  return parse(text)
}

/** A spell that copies a chosen unit ("becomes a copy of that unit" — Mirror
 *  Image). The generic parser can't express "copy", so it's detected by text. */
export function isCopySpell(card: Card): boolean {
  return card.type === 'spell' && /becomes a copy of that unit/i.test(card.text ?? '')
}

/** True if a spell has a part that targets unit(s) (damage / kill / ±Might, or a
 *  copy-a-unit spell that must choose its source). */
export function needsTarget(card: Card): boolean {
  if (card.type !== 'spell') return false
  if (isCopySpell(card)) return true
  const e = spellEffect(card)
  return hasTargetedPart(e) && e.targetCount > 0
}

/** On-play effect for a unit/gear — only the unambiguous on-play triggers. */
export function onPlayEffect(card: Card): ParsedEffect {
  const full = card.text ?? ''
  const t = full.toLowerCase()
  if (!ON_PLAY.test(t)) return EMPTY_EFFECT()
  // Exclude a trailing [Deathknell] ability from the on-play clause (Scuttle Crab's
  // "Gain 1 XP" is a death effect, not on-play) — only when the on-play wording
  // precedes the marker.
  const dkIdx = t.search(/\[deathknell\]/)
  const onPlayIdx = t.search(/when you play (?:me|this)|when i(?:'m| am)? (?:played|enter)/)
  const base = dkIdx > onPlayIdx && onPlayIdx >= 0 ? full.slice(0, dkIdx) : full
  // Strip the "if you paid the additional cost, …" bonus — it's gated and applied
  // separately (paidBonusEffect) only when the optional additional cost was paid,
  // so it must NOT resolve unconditionally here.
  return parse(base.replace(/(?:when you play (?:me|this),?\s*)?if you paid the additional cost,[^.]*\.?/i, ''))
}

/** The on-play bonus a card grants ONLY when its optional additional cost was paid
 *  ("When you play me, if you paid the additional cost, <X>") — Clockwork Keeper
 *  (draw 1), Blast Corps Cadet (deal 2), Frostcoat Cub (−2 Might), Sea Monkey
 *  (buff me), Akshan (move an enemy gear). Empty if the card has no such clause. */
export function paidBonusEffect(card: Card): ParsedEffect {
  const m = (card.text ?? '').match(/if you paid the additional cost,\s*([^.]+)\.?/i)
  if (!m) return EMPTY_EFFECT()
  return parse(m[1])
}

/** A permanent's "At the end of your turn, …" effect (Dazzling Aurora), or empty. */
export function endOfTurnEffect(card: Card): ParsedEffect {
  const t = (card.text ?? '').toLowerCase()
  if (!/at the end of (?:your|each) turn/.test(t)) return EMPTY_EFFECT()
  return parse(card.text ?? '')
}
