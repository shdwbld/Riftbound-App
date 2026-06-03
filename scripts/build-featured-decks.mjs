// ---------------------------------------------------------------------------
// Build the featured decks shown on /decks.
//
// REAL preconstructed lists (provided card-for-card) are encoded below in the
// flat "<count> <name> (<CODE>)" format and resolved against our card data.
// One champion (Lux) has no published list yet and falls back to a heuristic,
// on-theme build. Run: node scripts/build-featured-decks.mjs
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const cards = JSON.parse(
  await readFile(join(dir, '..', 'src', 'data', 'cards.generated.json'), 'utf8'),
)
// Supplemental cards missing from the ingested dataset (e.g. UNL terrain).
const extra = JSON.parse(await readFile(join(dir, '..', 'src', 'data', 'extraCards.json'), 'utf8'))
cards.push(...extra)
const byId = Object.fromEntries(cards.map((c) => [c.id, c]))

// --- resolver indices ------------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const collKey = (c) => c.id.replace(/-\d+$/, '')
const padKey = (c) => `${c.set}-${String(c.number).padStart(3, '0')}`.toLowerCase()

const collIdx = {}
const shortIdx = {}
const nameIdx = {}
for (const pass of [0, 1]) {
  for (const c of cards) {
    if (pass === 0 && c.alternateArt) continue
    if (!collIdx[collKey(c)]) collIdx[collKey(c)] = c
    if (!shortIdx[padKey(c)]) shortIdx[padKey(c)] = c
    if (!nameIdx[norm(c.name)]) nameIdx[norm(c.name)] = c
  }
}

/** Resolve a deck line by code, then by (cleaned) name. */
function resolveRef(code, name) {
  const c = code.trim().toLowerCase()
  if (byId[c]) return byId[c]
  if (collIdx[c]) return collIdx[c]
  if (shortIdx[c]) return shortIdx[c]
  const m = c.match(/^([a-z]+)-(\d+)/)
  if (m && shortIdx[`${m[1]}-${m[2].padStart(3, '0')}`]) return shortIdx[`${m[1]}-${m[2].padStart(3, '0')}`]
  // Name fallback (strip any "(parenthetical)" qualifier first).
  const clean = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  return nameIdx[norm(name)] ?? nameIdx[norm(clean)]
}

/** Parse a flat "<count> <name> (CODE)" list, classifying cards by type. */
function parseRealList(label, raw) {
  let legendId = null
  const main = {}
  const runes = {}
  const battlefields = []
  const unresolved = []
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)\s+(.+?)\s+[([]([^)\]]+)[)\]]\s*$/)
    if (!m) {
      unresolved.push(line)
      continue
    }
    const count = parseInt(m[1], 10)
    const c = resolveRef(m[3], m[2])
    if (!c) {
      unresolved.push(`${m[2]} (${m[3]})`)
      continue
    }
    if (c.type === 'legend') legendId = c.id
    else if (c.type === 'battlefield') {
      if (!battlefields.includes(c.id)) battlefields.push(c.id)
    } else if (c.type === 'rune') runes[c.id] = (runes[c.id] ?? 0) + count
    else main[c.id] = (main[c.id] ?? 0) + count
  }
  const legend = legendId ? byId[legendId] : undefined
  const champ = legend ? legend.name.split(/\s+-\s+/)[0].trim() : label
  const champUnits = Object.keys(main)
    .map((id) => byId[id])
    .filter((c) => c.supertype === 'champion' && c.name.includes(champ))
    .sort((a, b) => (a.energy ?? 0) - (b.energy ?? 0) || a.number - b.number)
  return {
    legendId,
    championId: champUnits[0]?.id ?? null,
    main,
    runes,
    battlefields,
    unresolved,
    mainCount: Object.values(main).reduce((a, b) => a + b, 0),
    runeCount: Object.values(runes).reduce((a, b) => a + b, 0),
  }
}

function titleFor(legendId, fallback) {
  const l = legendId ? byId[legendId] : undefined
  if (!l) return fallback
  const name = l.name.replace(/\s*\(Starter\)/i, '')
  const [champ, ...rest] = name.split(/\s+-\s+/)
  return rest.length ? `${champ} — ${rest.join(' - ')}` : champ
}

// --- the real lists --------------------------------------------------------
const REAL = {
  jinx: { group: 'Starter Deck', archetype: 'Aggro · direct damage', list: `
1 Jinx - Loose Cannon (OGN-251)
1 Morbid Return (OGN-170)
1 Zaun Warrens (OGN-298)
1 The Candlelit Sanctum (OGN-291)
1 Targon's Peak (OGN-289)
1 Super Mega Death Rocket! (OGN-252)
3 Seal of Discord (OGN-204)
1 Rhasa the Sunderer (OGN-195)
3 Traveling Merchant (OGN-185)
3 Stacked Deck (OGN-183)
2 Fading Memories (OGN-180)
1 Undercover Agent (OGN-178)
1 Rebuke (OGN-172)
2 Blazing Scorcher (OGN-001)
3 Gust (OGN-169)
6 Chaos Rune (OGN-166)
2 Cemetery Attendant (OGN-165)
1 Vi - Destructive (OGN-036)
1 Jinx - Demolitionist (OGN-030)
2 Void Seeker (OGN-024)
3 Raging Soul (OGN-019)
2 Get Excited! (OGN-008)
6 Fury Rune (OGN-007)
3 Flame Chompers (OGN-006)
3 Chemtech Enforcer (OGN-003)
2 Brazen Buccaneer (OGN-002)
` },
  'lee-sin': { group: 'Starter Deck', archetype: 'Tempo · combat tricks', list: `
1 Lee Sin - Blind Monk (OGN-257)
2 Pakaa Cub (OGN-135)
1 Targon's Peak (OGN-289)
1 Monastery of Hirana (OGN-282)
1 Grove of the God-Willow (OGN-280)
1 Udyr - Wildman (OGN-157)
1 Mistfall (OGN-152)
1 Lee Sin - Centered (OGN-151)
3 Wildclaw Shaman (OGN-147)
2 Mountain Drake (OGN-142)
2 Stormclaw Ursine (OGN-137)
3 Pit Rookie (OGN-136)
6 Calm Rune (OGN-042)
3 First Mate (OGN-132)
3 Challenge (OGN-128)
6 Body Rune (OGN-126)
2 Bilgewater Bully (OGN-125)
3 Wizened Elder (OGN-065)
1 Mask of Foresight (OGN-060)
3 Discipline (OGN-058)
3 Wielder of Water (OGN-055)
2 Stand United (OGN-053)
3 Stalwart Poro (OGN-052)
2 Charm (OGN-043)
` },
  'master-yi': { group: 'Starter Deck', archetype: 'Tempo · precision', list: `
1 Master Yi - Wuju Master (UNL-191)
2 Herald of Spring (UNL-034)
1 Gardens of Becoming (UNL-213)
1 Master Yi - Tempered (UNL-113)
3 Voracious Gromp (UNL-100)
2 Hunter's Machete (UNL-096)
3 Gemhand Hunter (UNL-094)
3 Concentrate (UNL-091)
3 Master Yi - Unstoppable (UNL-059)
2 Scuttle Crab (UNL-053)
2 Back Off (UNL-042)
3 Wuju Apprentice (UNL-040)
2 Skyward Strike (UNL-038)
3 Defy (OGN-045)
7 Body Rune (SFD-R04)
5 Calm Rune (SFD-R02)
3 Punch First (SFD-097)
2 Emperor's Divide (SFD-043)
1 Targon's Peak (OGN-289)
1 Reckoner's Arena (OGN-286)
3 Zhonya's Hourglass (OGN-077)
3 Discipline (Origins Nexus Night Promo) (OGN-058-P)
` },
  annie: { group: 'Starter Deck', archetype: 'Aggro · burn', list: `
1 Annie - Dark Child - Starter (OGS-017)
3 Blast Corps Cadet (SFD-013)
6 Chaos Rune (UNL-R05)
1 Abandoned Hall (UNL-205)
2 Diana - No Longer Human (UNL-149)
3 Syndra - Transcendent (UNL-146)
3 Undying Legion (UNL-025)
3 Smite (UNL-007)
3 Mischievous Marai (UNL-003)
1 Ravenbloom Conservatory (SFD-215)
3 Fizz - Trickster (SFD-140)
3 Hard Bargain (SFD-136)
3 Disintegrate (OGN-005)
2 Battering Ram (SFD-012)
3 Tibbers (OGS-018)
2 Annie - Stubborn (OGS-010)
3 Firestorm (OGS-002)
1 Annie - Fiery (OGS-001)
1 Void Gate (OGN-296)
3 Iron Ballista (OGN-017)
6 Fury Rune (OGN-007)
` },
  lillia: { group: 'Starter Deck', archetype: 'Midrange · sprites', list: `
1 Lillia - Bashful Bloom (UNL-189)
3 Gustwalker (UNL-075)
1 Brush (UNL-T03)
1 Baron Pit (UNL-T01)
1 Black Flame Altar (UNL-208)
1 Lilting Lullaby (UNL-190)
1 Blue Sentinel (UNL-087A)
1 Blue Sentinel (UNL-087)
3 Sprite Queen (UNL-084)
3 Smoke and Mirrors (UNL-083)
2 Lillia - Fae Fawn (UNL-082)
3 Sprite Fountain (UNL-078)
2 Soul Shepherd (UNL-077)
6 Calm Rune (OGN-042)
2 Frigid Jewel (UNL-074)
3 Sprite Burst (UNL-069)
1 Lillia - Protector of Dreams (UNL-058A)
1 Lillia - Protector of Dreams (UNL-058)
1 Scuttle Crab (UNL-053)
2 Ivern - Nurturer (UNL-051)
3 Trevor Snoozebottom (UNL-048)
2 Forgotten Signpost (UNL-045)
3 Plundering Poro (SFD-069)
1 Ravenbloom Student (OGN-103)
2 Sprite Call (OGN-094)
6 Mind Rune (OGN-089)
` },
  vex: { group: 'Starter Deck', archetype: 'Control · gloom', list: `
1 Vex - Gloomist (UNL-193)
2 Vex - Mocking (UNL-055)
6 Chaos Rune (UNL-R05)
6 Calm Rune (UNL-R02)
1 Ripper's Bay (UNL-214)
1 Gardens of Becoming (UNL-213)
1 Amateur Recital (UNL-207)
1 Shadow (UNL-194)
1 Vex - Apathetic (UNL-150)
1 Evelynn - Entrancing (UNL-141)
1 Scryer's Bloom (UNL-136)
2 Existential Dread (UNL-134)
2 Blast Cone (UNL-133)
2 Mister Root (UNL-127)
1 Megatusk (UNL-126)
1 Vex - Cheerless (SFD-146)
1 Nami - Headstrong (UNL-052)
1 Iascylla (UNL-050)
2 Trevor Snoozebottom (UNL-048)
2 Mosstomper (UNL-047)
1 Enthusiastic Promoter (UNL-043)
3 Back Off (UNL-042)
2 Allay - Eager Admirer (UNL-041)
3 Wuju Apprentice (UNL-040)
2 Soul Sword (UNL-039)
2 Skyward Strike (UNL-038)
2 Mutated Mouser (UNL-036)
1 Monch (UNL-035)
2 Herald of Spring (UNL-034)
2 Combat Experience (UNL-031)
` },
  viktor: { group: 'Featured Deck', archetype: 'Control · value engine', list: `
1 Viktor - Herald of the Arcane (OGN-265)
7 Order Rune (OGN-214)
1 Vilemaw's Lair (OGN-295)
1 Trifarian War Camp (OGN-294)
1 The Arena's Greatest (OGN-290)
1 Viktor - Leader (OGN-246)
2 Machine Evangel (OGN-239)
2 Grand Strategem (OGN-233)
2 Imperial Decree (OGN-221)
1 Facebreaker (OGN-220)
3 Vanguard Captain (OGN-218)
3 Soaring Scout (OGN-216)
2 Consult the Past (OGN-083)
3 Hidden Blade (OGN-213)
3 Faithful Manufactor (OGN-211)
2 Daring Poro (OGN-210)
3 Cull the Weak (OGN-209)
3 Sprite Mother (OGN-106)
2 Singularity (OGN-105)
1 Blastcone Fae (OGN-097)
3 Stupefy (OGN-095)
2 Smoke Screen (OGN-093)
5 Mind Rune (OGN-089)
2 Mega-Mech (OGN-088)
` },
  fiora: { group: 'Featured Deck', archetype: 'Aggro · duelist', list: `
1 Fiora - Grand Duelist (SFD-205)
3 Challenge (OGN-128)
6 Order Rune (SFD-R06)
6 Body Rune (SFD-R04)
1 Sunken Temple (SFD-218)
3 Riposte (SFD-206)
1 Fiora - Worthy (SFD-180)
3 Unsung Hero (SFD-167)
3 B.F. Sword (SFD-161)
1 Yone - Blademaster (SFD-116)
3 Lucian - Merciless (SFD-113)
1 Fiora - Peerless (SFD-110)
2 Akshan - Mischievous (SFD-109)
1 Warmog's Armor (SFD-108)
1 Sea Monkey (SFD-098)
3 Punch First (SFD-097)
3 Doran's Blade (SFD-095)
1 Trifarian War Camp (OGN-294)
1 Monastery of Hirana (OGN-282)
2 Spectral Matron (OGN-226)
2 Hidden Blade (OGN-213)
2 Call to Glory (OGN-207)
3 Pit Rookie (OGN-136)
3 First Mate (OGN-132)
` },
}

// --- heuristic fallback (Lux only) -----------------------------------------
const MAIN = 40
const RUNES = 12
const MAX_COPIES = 3
const isPlayable = (c) => c.type === 'unit' || c.type === 'spell' || c.type === 'gear'
const totalPower = (c) => Object.values(c.power || {}).reduce((a, b) => a + (b || 0), 0)
const cost = (c) => (isPlayable(c) ? (c.energy || 0) + totalPower(c) : 0)
const onIdentity = (c, id) => (c.domains || []).every((d) => id.includes(d))
function basicRune(domain) {
  return cards.find((c) => c.type === 'rune' && !c.alternateArt && (c.produces || []).includes(domain))
}
function buildHeuristic(champ) {
  const legend =
    cards.find((c) => c.type === 'legend' && !c.alternateArt && c.name.includes(champ) && /starter/i.test(c.name)) ??
    cards.find((c) => c.type === 'legend' && !c.alternateArt && c.name.includes(champ))
  const identity = legend?.identity || []
  const pool = cards.filter(
    (c) => !c.alternateArt && c.supertype !== 'token' && isPlayable(c) && onIdentity(c, identity),
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
  for (const c of tagged) add(c, MAX_COPIES)
  for (const c of support) {
    if (count >= MAIN) break
    add(c, MAX_COPIES)
  }
  const runes = {}
  const per = Math.floor(RUNES / Math.max(identity.length, 1))
  let runeCount = 0
  for (const d of identity) {
    const r = basicRune(d)
    if (r) {
      runes[r.id] = per
      runeCount += per
    }
  }
  if (runeCount < RUNES && identity[0]) {
    const r = basicRune(identity[0])
    if (r) runes[r.id] = (runes[r.id] || 0) + (RUNES - runeCount)
  }
  const bfs = cards
    .filter((c) => c.type === 'battlefield' && !c.alternateArt)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => c.id)
  const champUnit = Object.keys(main)
    .map((id) => byId[id])
    .filter((c) => c.supertype === 'champion' && c.name.includes(champ))
    .sort((a, b) => (a.energy ?? 0) - (b.energy ?? 0))[0]
  return {
    legendId: legend?.id ?? null,
    championId: champUnit?.id ?? null,
    main,
    runes,
    battlefields: bfs,
    unresolved: [],
    mainCount: count,
    runeCount: Object.values(runes).reduce((a, b) => a + b, 0),
  }
}

// --- assemble --------------------------------------------------------------
const ORDER = [
  ['jinx'], ['lee-sin'], ['master-yi'], ['annie'], ['lillia'], ['vex'], ['garen'], ['lux'], ['viktor'], ['fiora'],
]
// Garen keeps its previously-encoded real list:
REAL.garen = { group: 'Starter Deck', archetype: 'Midrange · board control', list: `
1 Garen - Might of Demacia - Starter (OGS-023)
2 Petty Officer (OGN-215)
2 Decisive Strike (OGS-024)
3 Vanguard Attendant (OGS-016)
3 Recruit the Vanguard (OGS-015)
2 Garen - Commander (OGS-013)
2 Garen - Rugged (OGS-007)
1 Trifarian War Camp (OGN-294)
3 Noxian Drummer (OGN-222)
3 Vanguard Sergeant (OGN-219)
6 Body Rune (OGN-126)
6 Order Rune (OGN-214)
3 Faithful Manufactor (OGN-211)
3 Daring Poro (OGN-210)
3 Back to Back (OGN-206)
3 First Mate (OGN-132)
2 Dune Drake (OGN-131)
3 Crackshot Corsair (OGN-130)
3 Confront (OGN-129)
` }

const LABELS = {
  jinx: 'Jinx', 'lee-sin': 'Lee Sin', 'master-yi': 'Master Yi', annie: 'Annie',
  lillia: 'Lillia', vex: 'Vex', garen: 'Garen', viktor: 'Viktor', fiora: 'Fiora',
}

const decks = []
for (const [key] of ORDER) {
  if (key === 'lux') {
    const r = buildHeuristic('Lux')
    decks.push({ id: 'featured-lux', name: titleFor(r.legendId, 'Lux'), champion: 'Lux', group: 'Starter Deck', archetype: 'Spells · light control', ...r })
    continue
  }
  const meta = REAL[key]
  const r = parseRealList(LABELS[key], meta.list)
  decks.push({
    id: `featured-${key}`,
    name: titleFor(r.legendId, LABELS[key]),
    champion: LABELS[key],
    group: meta.group,
    archetype: meta.archetype,
    ...r,
  })
}

await writeFile(
  join(dir, '..', 'src', 'data', 'featuredDecks.json'),
  JSON.stringify(decks.map(({ unresolved, ...d }) => d), null, 0) + '\n',
)
for (const d of decks)
  console.log(
    `${d.name.padEnd(34)} [${d.group}] main ${d.mainCount}/40 runes ${d.runeCount}/12 bf ${d.battlefields.length} ` +
      `legend ${byId[d.legendId] ? 'ok' : 'MISSING'} champ ${d.championId ? 'ok' : '-'}` +
      (d.unresolved?.length ? `  UNRESOLVED: ${d.unresolved.join('; ')}` : ''),
  )
console.log(`\nWrote ${decks.length} featured decks.`)
