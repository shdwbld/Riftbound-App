import type { Card } from '../types/cards'

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
  channel: number
  /** The killed unit's CONTROLLER draws N ("kill a unit. Its controller draws 2"
   *  — Hidden Blade). Distinct from drawOnKill, which the caster draws. */
  controllerDrawOnKill: number
  /** A floor a −Might debuff can't push a unit below ("to a minimum of 1 Might"). */
  tempMightFloor: number
  /** "Each player kills one of their units" (Cull the Weak) — symmetric sacrifice. */
  cullEachPlayer: boolean
  /** Number of units to Stun ("[Stun] an enemy unit" — Vi - Peacekeeper). */
  stun: number
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
  /** Number of Gold gear tokens to create. */
  goldTokens: number
  /** A named unit token to create (Sprite / Sand Soldier / Bird / Mech).
   *  `here` = play it at the source unit's battlefield ("… here"), not base. */
  namedToken: { name: string; count: number; exhausted: boolean; temporary: boolean; here: boolean } | null
  /** Number of your units to ready (un-exhaust) — the player chooses which. */
  readyUnits: number
  /** +1 Might buff counters to apply (e.g. "gains +1 Might" / "buff a unit"). A
   *  "buff" is the Riftbound +1 Might token, capped at one per unit. */
  buff: number
  /** The buff(s) target the SOURCE unit ("buff me" / "gains +1 Might"), not a
   *  chosen friendly unit ("buff a friendly unit"). */
  buffSelf: boolean
  /** A targeted buff that must not pick the source ("buff ANOTHER unit"). */
  buffExcludesSelf: boolean
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
  /** Play a UNIT from your trash into play (base), ignoring its cost — Soulgorger,
   *  The Harrowing, Spectral Matron, Glasc Mixologist. Optional cost cap
   *  (≤maxEnergy Energy / ≤maxPower Power). Resolves to the highest-cost qualifier. */
  playUnitFromTrash: { maxEnergy: number | null; maxPower: number | null } | null
  /** Reveal from the top of your Main Deck until a unit, play that unit ignoring
   *  its cost, and recycle the rest to the bottom (Dazzling Aurora). */
  revealPlayFromDeck: boolean
  /** Runes the affected unit's owner channels exhausted (Retreat: "channels 1
   *  rune exhausted"). Distinct from `channel`, which gives the caster ready runes. */
  channelExhausted: number
  /** Signed Might-this-turn applied to the SOURCE (e.g. "give me +1 this turn"). */
  tempMightSelf: number
  /** Signed Might-this-turn applied to ALL the controller's units ("give
   *  friendly units +5 Might this turn" — Grand Strategem). */
  tempMightAll: number
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
  condition: { kind: 'handAtMost' | 'handAtLeast' | 'unitsHereAtLeast' | 'xpAtLeast' | 'excessAtLeast'; value: number } | null
  /** True when there's text we couldn't auto-resolve. */
  manual: boolean
}

const EMPTY_EFFECT = (): ParsedEffect => ({
  draw: 0,
  channel: 0,
  controllerDrawOnKill: 0,
  tempMightFloor: 0,
  cullEachPlayer: false,
  stun: 0,
  killMightMax: null,
  drawPerBattlefield: 0,
  grantAssault: 0,
  grantGanking: false,
  grantAssaultHere: 0,
  damage: 0,
  recruits: 0,
  goldTokens: 0,
  namedToken: null,
  readyUnits: 0,
  buff: 0,
  buffSelf: false,
  buffExcludesSelf: false,
  readySelf: false,
  spendBuff: false,
  kill: 0,
  tempMight: 0,
  bounce: null,
  deathShield: false,
  banishOnDeath: false,
  returnFromTrash: null,
  playUnitFromTrash: null,
  revealPlayFromDeck: false,
  channelExhausted: 0,
  tempMightSelf: 0,
  tempMightAll: 0,
  drawOnKill: 0,
  targetScope: null,
  targetCount: 0,
  battlefieldOnly: false,
  condition: null,
  manual: false,
})

/** The part of an effect that requires choosing target unit(s). */
export function hasTargetedPart(e: ParsedEffect): boolean {
  return e.damage > 0 || e.kill > 0 || e.tempMight !== 0 || e.bounce !== null || e.stun > 0 || e.grantAssault > 0 || e.grantGanking || e.deathShield
}
/** The part of an effect that resolves with no target (draw/channel/etc.). */
export function hasUntargetedPart(e: ParsedEffect): boolean {
  return e.draw > 0 || e.drawPerBattlefield > 0 || e.channel > 0 || e.channelExhausted > 0 || e.recruits > 0 || e.goldTokens > 0 || !!e.namedToken || e.readyUnits > 0 || e.buff > 0 || e.tempMightSelf !== 0 || e.tempMightAll !== 0 || e.cullEachPlayer || e.grantAssaultHere > 0 || !!e.returnFromTrash || !!e.playUnitFromTrash || e.revealPlayFromDeck
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

  const drawM = tNoCond.match(new RegExp(`draw ${NUM}`))
  if (drawM) { eff.draw += num(drawM[1]); hit = true }

  // Channel ready runes — but NOT the "channel N rune exhausted" variant (Soaring
  // Scout), which the channelExhausted parse below handles as exhausted instead.
  const chM = t.match(new RegExp(`channel ${NUM}`))
  if (chM && !/channel[^.]*?exhausted/.test(t)) {
    eff.channel += num(chM[1]); hit = true
  }

  // "Its controller draws N" (Hidden Blade) — the KILLED unit's owner draws.
  const ctrlDrawM = t.match(new RegExp(`controller draws? ${NUM}`))
  if (ctrlDrawM) { eff.controllerDrawOnKill += num(ctrlDrawM[1]); hit = true }

  // "to a minimum of N Might" — a floor a −Might debuff can't push below.
  const floorM = t.match(new RegExp(`to a minimum of (\\d+)\\s*${MIGHT}`))
  if (floorM) eff.tempMightFloor = parseInt(floorM[1], 10)

  // "Each player kills one of their units" (Cull the Weak) — symmetric sacrifice.
  if (/each player kills? (?:one|1|a)\b[^.]*?units?/.test(t)) { eff.cullEachPlayer = true; hit = true }

  const recM = t.match(new RegExp(`play ${NUM}[^.]*?recruit unit tokens?`))
  if (recM) { eff.recruits += num(recM[1]); hit = true }

  // Gold gear tokens: "play a Gold gear token", "play 2 gold gear tokens".
  const goldM = t.match(new RegExp(`play ${NUM}[^.]*?gold gear tokens?`))
  if (goldM) { eff.goldTokens += num(goldM[1]); hit = true }

  // Named unit tokens: "play a 2 :rb_might: Sand Soldier unit token",
  // "play a ready 3 Sprite unit token", "play a 1 Might Bird unit token".
  const namedM = t.match(/play (?:a |an |(\d+|two|three) )?(?:ready |exhausted )?[^.]*?\b(sprite|sand soldier|bird|mech)\b[^.]*?tokens?(?:\s+with\s+\[temporary\])?/)
  if (namedM) {
    eff.namedToken = {
      name: namedM[2],
      count: namedM[1] ? num(namedM[1]) : 1,
      exhausted: !/\bready\b/.test(namedM[0]),
      temporary: /\[temporary\]/.test(namedM[0]),
      // "play a … token here" → at the source's battlefield. \bhere\b excludes
      // "there" (whose origin-placement stays at base, correct for base→bf moves).
      here: /\bhere\b/.test(t),
    }
    hit = true
  }

  // Ready your unit(s): "ready a friendly unit", "ready up to 2 units" — the
  // player chooses which to un-exhaust. ("enters ready" is a different effect.)
  // Guard against "ready" as a TOKEN adjective ("play a ready 3 :rb_might: Sprite
  // unit token" — Trevor Snoozebottom): that's part of the token, not a
  // ready-units action, and always reads "a/an ready …".
  const readyM = t.match(/\bready (?:up to )?(a|an|another|target|one|two|three|\d+)\b[^.]*?\bunits?\b/i)
  if (readyM && !/\b(?:a|an) ready\b/.test(t)) {
    const w = readyM[1].toLowerCase()
    eff.readyUnits += /^(a|an|another|target|one)$/.test(w) ? 1 : num(w)
    hit = true
  }

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
  }

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
  // Play a unit from your trash, ignoring its cost (Soulgorger, The Harrowing,
  // Spectral Matron, Glasc Mixologist). Optional "no more than :rb_energy_N:
  // and no more than :rb_rune_*:" cost cap.
  const putM = t.match(/play a unit[^.]*?from your trash[^.]*?ignoring its (?:energy )?cost/)
  if (putM) {
    const me = putM[0].match(/no more than :rb_energy_(\d+):/)
    const mp = (putM[0].match(/:rb_rune_[a-z]+:/g) || []).length
    eff.playUnitFromTrash = { maxEnergy: me ? parseInt(me[1], 10) : null, maxPower: mp || null }
    hit = true
  }
  // "reveal cards from the top of your Main Deck until you reveal a unit … play
  // it, ignoring its cost, and recycle the rest" (Dazzling Aurora).
  if (/reveal cards from (?:the )?top of your main deck until you reveal a unit/.test(t)) {
    eff.revealPlayFromDeck = true
    hit = true
  }
  // "its owner channels N rune(s) exhausted" — tied to the bounced unit's owner.
  const chExM = t.match(new RegExp(`channels? ${NUM} runes? exhausted`))
  if (chExM) { eff.channelExhausted += num(chExM[1]); hit = true }

  // Signed Might-this-turn to a target unit: "give a unit -1 Might this turn".
  const tmTargetM = t.match(new RegExp(`give (?:a|an|target|another) (?:friendly |enemy )?unit (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmTargetM) {
    const sign = tmTargetM[1] === '-' ? -1 : 1
    eff.tempMight += sign * parseInt(tmTargetM[2], 10)
    hit = true
  }

  // Signed Might-this-turn to self: "give me +1 Might this turn".
  const tmSelfM = t.match(new RegExp(`give me (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmSelfM) {
    const sign = tmSelfM[1] === '-' ? -1 : 1
    eff.tempMightSelf += sign * parseInt(tmSelfM[2], 10)
    hit = true
  }

  // Signed Might-this-turn to ALL your units: "give friendly units +5 Might this
  // turn" (Grand Strategem). Plural "units" — a board-wide buff, no target.
  const tmAllM = t.match(new RegExp(`give (?:all |your )?friendly units (-|\\+)?(\\d+)\\s*${MIGHT} this turn`))
  if (tmAllM) {
    eff.tempMightAll += (tmAllM[1] === '-' ? -1 : 1) * parseInt(tmAllM[2], 10)
    hit = true
  }

  // Permanent +Might buff counter ("this unit gains +1 Might"), not "this turn".
  // This phrasing always refers to the source unit, so it's a self-buff.
  if (!/this turn/.test(t)) {
    const buffM = t.match(new RegExp(`(?:gains?|grant|put) \\+?${NUM} ${MIGHT}`))
    if (buffM) { eff.buff += num(buffM[1]); eff.buffSelf = true; hit = true }
  }

  // The Riftbound "buff" action (give a +1 Might buff token; max one per unit).
  // "buff me/this" buffs the source; "buff a/another friendly unit" buffs a
  // chosen friendly unit. The alternation requires a determiner/pronoun right
  // after "buff ", so "spend a buff" (a cost) and "Buffs give"/"buffed"
  // (adjectives) don't match. Skip when already captured as a "gains +N" self-buff.
  if (!eff.buff) {
    if (/\bbuff (?:me|myself|this)\b/.test(t)) {
      eff.buff += 1; eff.buffSelf = true; hit = true
    } else {
      const bm = t.match(
        new RegExp(`\\bbuff (?:up to ${NUM} )?(?:a|an|another|the chosen|target|one|two|\\d+)?\\s*(?:other )?(?:friendly )?units?`),
      )
      if (bm) {
        eff.buff += bm[1] ? num(bm[1]) : 1
        if (/\banother\b/.test(t)) eff.buffExcludesSelf = true
        hit = true
      }
    }
  }

  // "ready me/myself/this" — un-exhaust the source unit (vs. `readyUnits`, a
  // choose-which-to-ready effect that needs a unit noun).
  if (/\bready (?:me|myself|this)\b/.test(t)) { eff.readySelf = true; hit = true }

  // "spend a buff to …" — a cost paid by removing a buff from one of your units
  // (Wildclaw Shaman). The actual effect after "to" supplies the `hit`.
  if (/\bspend a buff to\b/.test(t)) eff.spendBuff = true

  // Multi-target count: "each of up to two units" / "up to 2 units".
  const multiM = t.match(new RegExp(`(?:each of )?up to ${NUM} units?`)) || t.match(new RegExp(`each of ${NUM} units?`))

  // Resolve targeting metadata for any targeted part.
  if (hasTargetedPart(eff)) {
    eff.targetCount = multiM ? num(multiM[1]) : Math.max(1, eff.stun)
    eff.battlefieldOnly = /at a battlefield/.test(t)
    eff.targetScope =
      eff.bounce && eff.bounce !== 'any'
        ? eff.bounce // an explicit "return a friendly/enemy unit"
        : /friendly|your unit/.test(t)
          ? 'friendly'
          : /enemy|opposing/.test(t)
            ? 'enemy'
            : eff.tempMight > 0 || eff.buff > 0 || eff.grantAssault > 0 || eff.grantGanking
              ? 'friendly' // buffs / keyword grants help your own units
              : eff.bounce
                ? 'any' // a generic "return a unit" can hit either side
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
  const t = (card.text ?? '').toLowerCase()
  if (!ON_PLAY.test(t)) return EMPTY_EFFECT()
  return parse(card.text ?? '')
}

/** A permanent's "At the end of your turn, …" effect (Dazzling Aurora), or empty. */
export function endOfTurnEffect(card: Card): ParsedEffect {
  const t = (card.text ?? '').toLowerCase()
  if (!/at the end of (?:your|each) turn/.test(t)) return EMPTY_EFFECT()
  return parse(card.text ?? '')
}
