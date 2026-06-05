import type { Card } from '../types/cards'
import generated from './cards.generated.json'
import extra from './extraCards.json'

// ---------------------------------------------------------------------------
// Card data — REAL dataset.
//
// `cards.generated.json` is produced by `scripts/ingest-cards.mjs`, which pulls
// the full card list from the Riftcodex API and normalizes it into our `Card`
// shape. Artwork URLs are hot-linked from the official Riot CDN (never copied).
//
// Re-generate after a new set releases:  node scripts/ingest-cards.mjs
// ---------------------------------------------------------------------------

/** Rules-text patches for cards whose ingested text is incomplete — the Riftcodex
 *  API occasionally stores only an [Equip] cost line and drops the equipped-unit
 *  bonus. Keyed by card id; the value REPLACES the card's `text`. Re-applied after
 *  every ingest (so `node scripts/ingest-cards.mjs` won't lose the fix). */
const TEXT_PATCHES: Record<string, string> = {
  // Last Rites — ingest captured only the [Equip] cost; restore the conquer/hold
  // bonus so its full-cost play-from-trash resolves (see playfrom-research.md).
  'sfd-150-221':
    '[Equip] — :rb_rune_chaos:, Recycle 2 cards from your trash (Pay the cost: Attach this to a unit you control.) When I conquer or hold, you may play a unit from your trash. (You still pay its costs.)',
  // [Equip] attached-effect text restored from web sources (riftbound.gg / riftmana /
  // TCG listings) via the equip-text-restore research workflow — the ingest had dropped
  // every equipped-unit bonus. High confidence unless noted.
  "opp-009-221": "[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) [Assault 2] (+2 :rb_might: while I'm attacking.)",
  "opp-033-221": "[Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.) [Tank] (I must be assigned combat damage first.) +1 :rb_might:",
  "opp-064-221": "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.)[Equip] :rb_rune_mind: (:rb_rune_mind:: Attach this to a unit you control.) [Shield 2] (+2 :rb_might: while I'm a defender.) +2 :rb_might:",
  "opp-086-221": "[Equip] :rb_rune_mind: (:rb_rune_mind:: Attach this to a unit you control.) When I hold, play two Gold gear tokens exhausted. +2 :rb_might:",
  "opp-095-221": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.) +2 :rb_might:",
  "opp-118a-221": "[Equip] :rb_energy_1::rb_rune_body: (:rb_energy_1::rb_rune_body:: Attach this to a unit you control.) When I conquer, channel 1 rune exhausted. +2 :rb_might:",
  "opp-124-221": "[Equip] :rb_rune_chaos: (:rb_rune_chaos:: Attach this to a unit you control.) When I conquer, discard 1, then draw 1. +1 :rb_might:",
  "opp-153-221": "[Equip] :rb_rune_order: (:rb_rune_order:: Attach this to a unit you control.) When I move, play a 1 :rb_might: Recruit unit token here.",
  "sfd-009-221": "[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) [Assault 2] (+2 :rb_might: while I'm attacking.)",
  "sfd-016-221": "[Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) When I attack or defend, deal 2 to an enemy unit here.",
  "sfd-022-221": "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.) [Equip] :rb_rune_fury: (:rb_rune_fury:: Attach this to a unit you control.) +2 :rb_might:",
  "sfd-030-221": "[Equip] :rb_energy_1::rb_rune_fury: (:rb_energy_1::rb_rune_fury:: Attach this to a unit you control.) My hold effects are also conquer effects, and vice versa. +2 :rb_might:",
  "sfd-033-221": "[Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.) [Tank] (I must be assigned combat damage first.) +1 :rb_might:",
  "sfd-042-221": "[Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.) If this was attached to me this turn, I have an additional +2 :rb_might:. +1 :rb_might:",
  "sfd-051-221": "[Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.) If I would die, kill Guardian Angel instead. Heal me, exhaust me, and recall me. +1 :rb_might:",
  "sfd-056-221": "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.) [Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.) +3 :rb_might:",
  "sfd-059-221": "[Equip] :rb_energy_1::rb_rune_calm: (:rb_energy_1::rb_rune_calm:: Attach this to a unit you control.) As this is attached to a unit, copy that unit's text to this Equipment's effect text for as long as this is attached to it.",
  "sfd-064-221": "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.) [Equip] :rb_rune_mind: (:rb_rune_mind:: Attach this to a unit you control.) [Shield 2] (+2 :rb_might: while I'm a defender.) +2 :rb_might:",
  "sfd-073-221": "[Equip] :rb_rune_mind: (:rb_rune_mind:: Attach this to a unit you control.) I am a mech. +1 :rb_might:",
  "sfd-086-221": "[Equip] :rb_rune_mind: (:rb_rune_mind:: Attach this to a unit you control.) When I hold, play two Gold gear tokens exhausted. +2 :rb_might:",
  "sfd-090-221": "[Equip] :rb_energy_1::rb_rune_mind: (:rb_energy_1::rb_rune_mind:: Attach this to a unit you control.) :rb_energy_3::rb_rune_mind:, Banish this: Play all units banished with this, ignoring their costs. (Use only if unattached.) [Deathknell] — Banish me. (When I die, get the effect.) +2 :rb_might:",
  "sfd-095-221": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.) +2 :rb_might:",
  "sfd-102-221": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.) [Deflect] (Opponents must pay :rb_rune_rainbow: to choose me with a spell or ability.) +1 :rb_might:",
  "sfd-108-221": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.) When I conquer, buff me. (If I don't have a buff, I get a +1 :rb_might: buff.) +1 :rb_might:",
  "sfd-115-221": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.) When I hold, score 1 point. +2 :rb_might:",
  "sfd-118-221": "[Equip] :rb_energy_1::rb_rune_body: (:rb_energy_1::rb_rune_body:: Attach this to a unit you control.) When I conquer, channel 1 rune exhausted. +2 :rb_might:",
  "sfd-124-221": "[Equip] :rb_rune_chaos: (:rb_rune_chaos:: Attach this to a unit you control.) When I conquer, discard 1, then draw 1. +1 :rb_might:",
  "sfd-133-221": "[Equip] :rb_rune_chaos: (:rb_rune_chaos:: Attach this to a unit you control.) +2 :rb_might: [Ganking] (I can move from battlefield to battlefield.)",
  "sfd-134-221": "[Equip] :rb_rune_chaos: (:rb_rune_chaos:: Attach this to a unit you control.) +1 :rb_might: When I conquer, play a Gold gear token exhausted.",
  "sfd-139-221": "[Hidden] (Hide now for :rb_rune_rainbow: to react with later for :rb_energy_0:.) When you play this from face down, attach it to a unit you control (here). [Equip] :rb_rune_chaos: (:rb_rune_chaos:: Attach this to a unit you control.) +2 :rb_might:",
  "sfd-153-221": "[Equip] :rb_rune_order: (:rb_rune_order:: Attach this to a unit you control.) When I move, play a 1 :rb_might: Recruit unit token here.",
  "sfd-161-221": "[Equip] :rb_rune_order: (:rb_rune_order:: Attach this to a unit you control.) +3 :rb_might:",
  "sfd-172-221": "[Equip] :rb_rune_order: (:rb_rune_order:: Attach this to a unit you control.) +1 :rb_might: [Deathknell] — Draw 1. (When I die, get the effect.)",
  "sfd-178-221": "[Equip] — :rb_rune_order:, Kill a friendly unit (Pay the cost: Attach this to a unit you control.) +4 :rb_might:",
  "sfd-186-221": "[Quick-Draw] (This has [Reaction]. When you play it, attach it to a unit you control.) [Equip] :rb_rune_rainbow: (:rb_rune_rainbow:: Attach this to a unit you control.) [Temporary] (If this is unattached, kill it at the start of its controller's Beginning Phase, before scoring.) +3 :rb_might:",
  "sfd-190-221": "[Unique] (Your deck can have only 1 card with this name.)[Equip] :rb_rune_rainbow: (:rb_rune_rainbow:: Attach this to a unit you control.)When I attack or defend, deal 2 to all enemy units here. +3 :rb_might:",
  "sfd-191-221": "[Unique] (Your deck can have only 1 card with this name.)[Equip] :rb_rune_rainbow: (:rb_rune_rainbow:: Attach this to a unit you control.)Your spells and abilities deal 3 Bonus Damage. +3 :rb_might:",
  "sfd-192-221": "[Unique] (Your deck can have only 1 card with this name.)[Equip] :rb_rune_rainbow: (:rb_rune_rainbow:: Attach this to a unit you control.)When you play this, ready your units.Your units here have [Ganking] (We can move from battlefield to battlefield.). +2 :rb_might:",
  "unl-019-219": "[Equip] :rb_energy_1::rb_rune_fury: (:rb_energy_1::rb_rune_fury:: Attach this to a unit you control.)At the end of your turn, if I didn't conquer this turn, unattach this and deal 4 to me. +4 :rb_might:",
  "unl-039-219": "[Equip] :rb_rune_calm: (:rb_rune_calm:: Attach this to a unit you control.)+1 :rb_might:. [Level 3][>] I have an additional +1 :rb_might:. (While you have 3+ XP, get the effect.)",
  "unl-096-219": "[Equip] :rb_rune_body: (:rb_rune_body:: Attach this to a unit you control.)[Hunt] (When I conquer or hold, gain 1 XP.) +2 :rb_might:",
  "unl-188-219": "[Equip] :rb_energy_3::rb_rune_rainbow:. This ability's Energy cost is reduced by the Might of the unit you choose. (Pay the cost: Attach this to a unit you control.)When I conquer, if you assigned 3 or more excess damage, draw 1. +3 :rb_might:",
}

const applyPatches = (cards: Card[]): Card[] =>
  cards.map((c) => (TEXT_PATCHES[c.id] ? { ...c, text: TEXT_PATCHES[c.id] } : c))

/** Every card, including alternate-art reprints, plus supplemental cards missing
 *  from the ingested dataset (see extraCards.json). */
export const ALL_CARDS = [
  ...applyPatches(generated as unknown as Card[]),
  ...(extra as unknown as Card[]),
]

/** Playable set with alternate-art reprints removed (one entry per card). */
export const CARDS: Card[] = ALL_CARDS.filter((c) => !c.alternateArt)

/** Back-compat alias used by early UI. */
export const SEED_CARDS = CARDS

/** Fast lookup by id, across all printings. */
export const CARD_INDEX: Record<string, Card> = Object.fromEntries(
  ALL_CARDS.map((c) => [c.id, c]),
)

export function getCard(id: string): Card | undefined {
  // Ids are stored lowercase; accept the official UPPERCASE code too (so a code
  // copied from the card detail / pasted into the importer resolves).
  return CARD_INDEX[id] ?? CARD_INDEX[id.toLowerCase()]
}

/** Short "SET-number" code (zero-padded, lowercase) → preferred (non-alt) id.
 *  Lets a short collector code like "OGN-215" or "OGS-023" resolve, the way
 *  other sites print them (without the set-total suffix). */
const SHORT_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  const key = (c: Card) => `${c.set}-${String(c.number).padStart(3, '0')}`.toLowerCase()
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[key(c)]) idx[key(c)] = c.id
  for (const c of ALL_CARDS) if (!idx[key(c)]) idx[key(c)] = c.id // fill gaps with alt printings
  return idx
})()

/** Collector index keyed by the id minus its trailing "-<setTotal>" — captures
 *  exact printings other short codes can't: alt-art (`unl-087a`), promo
 *  (`ogn-058-p`), special numbering (`sfd-t03`). */
const COLL_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  const key = (c: Card) => c.id.replace(/-\d+$/, '')
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[key(c)]) idx[key(c)] = c.id
  for (const c of ALL_CARDS) if (!idx[key(c)]) idx[key(c)] = c.id
  return idx
})()

/**
 * Resolve any collector code to a canonical card id. Accepts:
 *  - a full id / official code: "ogn-210-298" or "OGN-210-298"
 *  - a short "SET-number" code: "OGN-215", "ogs-023" (no set-total)
 *  - a code with a wrong/missing total (matched by SET-number prefix)
 * Returns undefined if nothing matches.
 */
export function resolveCardCode(raw: string): string | undefined {
  const code = raw.trim().toLowerCase()
  if (CARD_INDEX[code]) return code
  if (COLL_INDEX[code]) return COLL_INDEX[code]
  if (SHORT_INDEX[code]) return SHORT_INDEX[code]
  const m = code.match(/^([a-z]+)-(\d+)/)
  if (m) {
    const short = `${m[1]}-${m[2].padStart(3, '0')}`
    if (SHORT_INDEX[short]) return SHORT_INDEX[short]
  }
  return undefined
}

/** Card name → preferred (non-alt) id, matched loosely (case/punctuation/spacing
 *  insensitive) so "Garen - Might of Demacia - Starter" finds "Garen - Might of
 *  Demacia (Starter)". Lets a decklist that prints names resolve. */
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const NAME_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {}
  for (const c of ALL_CARDS) if (!c.alternateArt && !idx[normName(c.name)]) idx[normName(c.name)] = c.id
  for (const c of ALL_CARDS) if (!idx[normName(c.name)]) idx[normName(c.name)] = c.id
  return idx
})()

export function resolveCardName(name: string): string | undefined {
  return NAME_INDEX[normName(name)]
}

/** Resolve a deck-line reference to a card id: try its code first, then its
 *  name. Accepts full/short codes and loose names. */
export function resolveCardRef(code: string | undefined, name: string | undefined): string | undefined {
  return (code ? resolveCardCode(code) : undefined) ?? (name ? resolveCardName(name) : undefined)
}
