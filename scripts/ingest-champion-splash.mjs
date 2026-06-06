#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dev-time ingest: pull champion SPLASH art (base + skins) from the LoL Fandom
// wiki for the playmat overlay + picker. Enumerates each champion's *Centered.jpg
// splashes via the MediaWiki API, downloads up to MAX_VARIANTS, and writes a
// manifest. No ffmpeg needed (images).
//   public/img/champions/<key>/<id>.jpg
//   public/img/champions/<key>/skins.json   = [{ id, label, file }]  (original first)
//   node scripts/ingest-champion-splash.mjs [--champion Ahri] [--force]
// Riot copyrighted art — for the unofficial non-commercial fan sim.
// ---------------------------------------------------------------------------

import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'img', 'champions')
const API = 'https://leagueoflegends.fandom.com/api.php'
const UA = 'RiftboundFanSim/1.0 (champion splash ingest; non-commercial)'
const MAX_VARIANTS = 6

const toKey = (name) => name.replace(/['.]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
const wikiSlug = (name) => name.replace(/ /g, '_')
const humanize = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim() || 'Original'

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyIdx = args.indexOf('--champion')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function championNames() {
  const data = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'cards.generated.json'), 'utf8'))
  const arr = Array.isArray(data) ? data : (data.cards ?? Object.values(data))
  const names = new Set()
  for (const c of arr) if (c?.supertype === 'champion') names.add(c.name.split(' - ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim())
  return [...names].sort()
}

async function listSplashes(slug) {
  // Enumerate <Slug>_*Centered.jpg across skins (paginate).
  const out = []
  let cont = ''
  for (let p = 0; p < 4; p++) {
    const u = `${API}?action=query&list=allimages&aiprefix=${encodeURIComponent(slug + '_')}&ailimit=500&format=json${cont}`
    const res = await fetch(u, { headers: { 'User-Agent': UA } })
    if (!res.ok) break
    const json = await res.json()
    for (const img of json?.query?.allimages ?? []) {
      const m = img.name.match(new RegExp(`^${slug}_(.+)Centered\\.jpg$`))
      if (m && !/_old|_Ch$|_WR|_HD/i.test(img.name)) out.push({ skin: m[1].replace(/_$/, ''), url: img.url })
    }
    if (json?.continue?.aicontinue) cont = `&aicontinue=${encodeURIComponent(json.continue.aicontinue)}`
    else break
  }
  // Original first, then others; cap.
  out.sort((a, b) => (a.skin === 'Original' ? -1 : b.skin === 'Original' ? 1 : a.skin.localeCompare(b.skin)))
  return out.slice(0, MAX_VARIANTS)
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`download ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function ingestOne(name) {
  const key = toKey(name)
  const dir = join(OUT, key)
  const manifestPath = join(dir, 'skins.json')
  if (!force && existsSync(manifestPath)) return 'skip'
  const splashes = await listSplashes(wikiSlug(name))
  if (!splashes.length) return 'miss'
  mkdirSync(dir, { recursive: true })
  const manifest = []
  for (const s of splashes) {
    const id = toKey(s.skin) || 'original'
    const file = `${id}.jpg`
    try {
      if (force || !existsSync(join(dir, file))) await download(s.url, join(dir, file))
      manifest.push({ id, label: humanize(s.skin), file })
    } catch { /* skip a bad one */ }
    await sleep(120)
  }
  if (!manifest.length) return 'miss'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return `ok(${manifest.length})`
}

async function main() {
  const names = only ? [only] : championNames()
  console.log(`Splash ingest: ${names.length} champion(s) → ${OUT}\n`)
  let ok = 0, skip = 0, miss = 0
  for (const name of names) {
    try {
      const r = await ingestOne(name)
      if (r === 'skip') { skip++; process.stdout.write(`  · ${name}\n`) }
      else if (r === 'miss') { miss++; process.stdout.write(`  ✗ ${name}: no splash\n`) }
      else { ok++; process.stdout.write(`  ✓ ${name}: ${r}\n`) }
    } catch (e) { miss++; process.stdout.write(`  ✗ ${name}: ${e.message}\n`) }
    if (!only) await sleep(150)
  }
  console.log(`\nDone. ok=${ok} skip=${skip} miss=${miss}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
