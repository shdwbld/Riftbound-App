// ---------------------------------------------------------------------------
// Card ingestion: Riftcodex API -> normalized Card[] -> src/data/cards.generated.json
//
// Run: node scripts/ingest-cards.mjs
//
// We fetch the full Riftcodex dataset, normalize each record into our stable
// `Card` shape (src/types/cards.ts), and write a local JSON file the app reads
// at build time. Artwork URLs are hot-linked (official Riot CDN), never copied.
// ---------------------------------------------------------------------------
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = 'https://api.riftcodex.com'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'cards.generated.json')

const DOMAIN_MAP = {
  Fury: 'fury',
  Calm: 'calm',
  Mind: 'mind',
  Body: 'body',
  Chaos: 'chaos',
  Order: 'order',
  // Colorless -> no domain (empty array)
}
const ALL_DOMAINS = ['fury', 'calm', 'mind', 'body', 'chaos', 'order']

function mapDomains(arr) {
  return (arr ?? []).map((d) => DOMAIN_MAP[d]).filter(Boolean)
}

function mapRarity(r) {
  const v = (r ?? '').toLowerCase()
  const known = ['common', 'uncommon', 'rare', 'epic', 'showcase', 'promo']
  return known.includes(v) ? v : 'common'
}

// The source gives a single `power` pip count. Distribute it across the card's
// domain(s): mono-domain -> exact; multi-domain -> all on the first domain with
// an ambiguity flag (refined later by parsing rune symbols / art in Phase 4).
function buildPowerCost(powerNum, domains) {
  const power = {}
  let ambiguous = false
  if (powerNum && powerNum > 0) {
    if (domains.length === 1) {
      power[domains[0]] = powerNum
    } else if (domains.length === 0) {
      // colorless power requirement is unusual; record as generic on fury slot
      power.__generic = powerNum
      ambiguous = true
    } else {
      power[domains[0]] = powerNum
      ambiguous = true
    }
  }
  return { power, ambiguous }
}

function normalize(raw) {
  const type = (raw.classification?.type ?? '').toLowerCase()
  const domains = mapDomains(raw.classification?.domain)
  const base = {
    id: raw.riftbound_id ?? raw.id,
    sourceId: raw.riftbound_id,
    name: raw.name,
    type,
    domains,
    rarity: mapRarity(raw.classification?.rarity),
    set: raw.set?.set_id ?? 'UNK',
    number: raw.collector_number ?? 0,
    text: raw.text?.plain || undefined,
    flavor: raw.text?.flavour || undefined,
    tags: raw.tags?.length ? raw.tags : undefined,
    imageUrl: raw.media?.image_url || undefined,
    artist: raw.media?.artist || undefined,
    alternateArt: raw.metadata?.alternate_art === true || undefined,
  }

  const energy = raw.attributes?.energy ?? 0
  const power = raw.attributes?.power ?? 0
  const might = raw.attributes?.might ?? 0

  switch (type) {
    case 'unit': {
      const { power: pc } = buildPowerCost(power, domains)
      return { ...base, type: 'unit', energy, power: pc, might }
    }
    case 'spell': {
      const { power: pc } = buildPowerCost(power, domains)
      // speed not provided by source; default sorcery, detect Reaction/Action in text
      const t = (base.text ?? '').toLowerCase()
      const speed = t.includes('[reaction]') || t.includes('[action]') ? 'action' : 'sorcery'
      return { ...base, type: 'spell', energy, power: pc, speed }
    }
    case 'gear': {
      const { power: pc } = buildPowerCost(power, domains)
      return { ...base, type: 'gear', energy, power: pc }
    }
    case 'battlefield':
      return { ...base, type: 'battlefield' }
    case 'legend':
      return { ...base, type: 'legend', identity: domains }
    case 'rune': {
      const produces = domains.length ? domains : ALL_DOMAINS // colorless/wild -> any
      return { ...base, type: 'rune', produces }
    }
    default:
      return null
  }
}

async function getPage(page) {
  const res = await fetch(`${BASE}/cards?size=100&page=${page}`)
  if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  console.log('Fetching from', BASE, '…')
  const first = await getPage(1)
  const raw = [...first.items]
  for (let p = 2; p <= first.pages; p++) {
    process.stdout.write(`\r  page ${p}/${first.pages}`)
    raw.push(...(await getPage(p)).items)
  }
  console.log(`\n  fetched ${raw.length} raw records`)

  const cards = raw.map(normalize).filter(Boolean)
  const dropped = raw.length - cards.length
  if (dropped) console.log(`  dropped ${dropped} unrecognized records`)

  // Stable sort: set, then collector number.
  cards.sort((a, b) => a.set.localeCompare(b.set) || a.number - b.number)

  const byType = {}
  for (const c of cards) byType[c.type] = (byType[c.type] ?? 0) + 1
  const alt = cards.filter((c) => c.alternateArt).length

  await writeFile(OUT, JSON.stringify(cards, null, 0) + '\n')
  console.log(`\n  wrote ${cards.length} cards -> ${OUT}`)
  console.log('  by type:', byType)
  console.log(`  alternate-art reprints: ${alt}`)
}

main().catch((e) => {
  console.error('\nIngestion failed:', e.message)
  process.exit(1)
})
