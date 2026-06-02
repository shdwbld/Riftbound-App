// ---------------------------------------------------------------------------
// Build "Featured" starter decks for the 7 official Riftbound champions.
//
// The exact card-for-card Riot preconstructed lists aren't publicly available
// in a parseable form, so these are LEGAL, ON-THEME community builds: each uses
// the official champion's Legend, its champion-tagged cards, on-identity support
// cards with a sensible curve, matching runes, and battlefields. Deterministic
// (no RNG) so the output is stable and reviewable.
//
// Run: node scripts/build-featured-decks.mjs  ->  src/data/featuredDecks.json
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const cards = JSON.parse(
  await readFile(join(dir, '..', 'src', 'data', 'cards.generated.json'), 'utf8'),
)
const byId = Object.fromEntries(cards.map((c) => [c.id, c]))

const MAIN = 40
const RUNES = 12
const MAX_COPIES = 3

// The official lineup. `group` distinguishes the two product lines.
const CHAMPIONS = [
  { champ: 'Jinx', group: 'Champion Deck', archetype: 'Aggro · direct damage', starter: false },
  { champ: 'Lee Sin', group: 'Champion Deck', archetype: 'Tempo · combat tricks', starter: false },
  { champ: 'Viktor', group: 'Champion Deck', archetype: 'Control · value engine', starter: false },
  { champ: 'Annie', group: 'Proving Grounds', archetype: 'Aggro · burn', starter: true },
  { champ: 'Master Yi', group: 'Proving Grounds', archetype: 'Tempo · precision', starter: true },
  { champ: 'Lux', group: 'Proving Grounds', archetype: 'Spells · light control', starter: true },
  { champ: 'Garen', group: 'Proving Grounds', archetype: 'Midrange · board control', starter: true },
]

const isPlayable = (c) => c.type === 'unit' || c.type === 'spell' || c.type === 'gear'
const totalPower = (c) => Object.values(c.power || {}).reduce((a, b) => a + (b || 0), 0)
const cost = (c) => (isPlayable(c) ? (c.energy || 0) + totalPower(c) : 0)
const onIdentity = (c, id) => (c.domains || []).every((d) => id.includes(d))

function findLegend(champ, starter) {
  // Prefer the matching product's legend (Starter legends are named "(Starter)").
  const matches = cards.filter(
    (c) => c.type === 'legend' && !c.alternateArt && c.name.includes(champ),
  )
  const starterL = matches.find((c) => /starter/i.test(c.name))
  return (starter ? starterL : matches.find((c) => !/starter/i.test(c.name))) ?? matches[0]
}

function basicRune(domain) {
  return cards.find(
    (c) => c.type === 'rune' && !c.alternateArt && (c.produces || []).includes(domain),
  )
}

function buildDeck({ champ, group, archetype, starter }) {
  const legend = findLegend(champ, starter)
  if (!legend) throw new Error(`No legend for ${champ}`)
  const identity = legend.identity || []

  // Candidate pool: on-identity playable cards. Champion-tagged first, then a
  // cost-balanced spread of support cards.
  const pool = cards.filter(
    (c) =>
      !c.alternateArt &&
      c.supertype !== 'token' && // tokens are generated, never decked
      isPlayable(c) &&
      onIdentity(c, identity),
  )
  const tagged = pool.filter((c) => (c.tags || []).some((t) => t.includes(champ)))
  const support = pool
    .filter((c) => !tagged.includes(c))
    .sort((a, b) => cost(a) - cost(b) || a.name.localeCompare(b.name))

  const main = {}
  let count = 0
  const add = (c, n) => {
    if (!c) return
    const room = Math.min(MAX_COPIES - (main[c.id] || 0), n, MAIN - count)
    if (room > 0) {
      main[c.id] = (main[c.id] || 0) + room
      count += room
    }
  }

  // 3 copies of each champion-tagged card.
  for (const c of tagged) add(c, MAX_COPIES)
  // Fill the curve with support cards (cheap → expensive), 3 copies each.
  for (const c of support) {
    if (count >= MAIN) break
    add(c, MAX_COPIES)
  }
  // Top up if still short (rare): loop support again at any remaining capacity.
  for (const c of support) {
    if (count >= MAIN) break
    add(c, MAX_COPIES)
  }

  // Runes: split 6/6 across the two identity domains.
  const runes = {}
  const perDomain = Math.floor(RUNES / Math.max(identity.length, 1))
  let runeCount = 0
  for (const d of identity) {
    const r = basicRune(d)
    if (r) {
      runes[r.id] = perDomain
      runeCount += perDomain
    }
  }
  // Remainder to the first domain.
  if (runeCount < RUNES && identity[0]) {
    const r = basicRune(identity[0])
    if (r) runes[r.id] = (runes[r.id] || 0) + (RUNES - runeCount)
  }

  // Battlefields: 3 distinct for deckbuilding (one is placed in 1v1).
  const bfs = cards
    .filter((c) => c.type === 'battlefield' && !c.alternateArt)
    .sort(
      (a, b) =>
        (a.domains.length === 0 ? 0 : 1) - (b.domains.length === 0 ? 0 : 1) ||
        a.name.localeCompare(b.name),
    )
  const battlefields = bfs.slice(0, 3).map((c) => c.id)

  return {
    id: `featured-${champ.toLowerCase().replace(/\s+/g, '-')}`,
    name: `${champ} — ${legend.name.replace(/\s*\(Starter\)/, '')}`,
    champion: champ,
    group,
    archetype,
    legendId: legend.id,
    main,
    runes,
    battlefields,
    mainCount: count,
    runeCount: Object.values(runes).reduce((a, b) => a + b, 0),
  }
}

const decks = CHAMPIONS.map(buildDeck)
await writeFile(
  join(dir, '..', 'src', 'data', 'featuredDecks.json'),
  JSON.stringify(decks, null, 0) + '\n',
)
for (const d of decks)
  console.log(
    `${d.name}: main ${d.mainCount}/40, runes ${d.runeCount}/12, bf ${d.battlefields.length}/3 ` +
      `(legend ${byId[d.legendId] ? 'ok' : 'MISSING'})`,
  )
console.log(`\nWrote ${decks.length} featured decks.`)
