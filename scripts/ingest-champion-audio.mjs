#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dev-time ingest: download each champion's League "Select" SFX + voiceline from
// the LoL Fandom wiki (resolved via the MediaWiki API), convert OGG → MP3 with
// ffmpeg, and bundle them under public/sfx/champions/<key>/{select-sfx,
// select-voice}.mp3. Played in-app by audio.playChampionSelect() when a champion
// card is played. NOT run in the browser. Requires network + ffmpeg-static.
//
//   node scripts/ingest-champion-audio.mjs                 # all, skip existing
//   node scripts/ingest-champion-audio.mjs --champion Ahri # one champion
//   node scripts/ingest-champion-audio.mjs --force         # re-download
//
// Note: Riot's copyrighted audio — for the unofficial non-commercial fan sim.
// ---------------------------------------------------------------------------

import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const execFileP = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = join(ROOT, 'public', 'sfx', 'champions')
const TMP = join(ROOT, '.tmp-champ-audio')
const API = 'https://leagueoflegends.fandom.com/api.php'
const UA = 'RiftboundFanSim/1.0 (champion-select audio ingest; non-commercial)'

// Must match toChampionKey() in src/lib/audio.ts.
const toKey = (name) => name.replace(/['.]/g, '').trim().replace(/\s+/g, '-').toLowerCase()

// Wiki "File:" slug — spaces→_, apostrophes/periods kept. The default handles the
// oddballs (Dr. Mundo→Dr._Mundo, Lee Sin→Lee_Sin, Kai'Sa→Kai'Sa). Add overrides
// here only if a champion's wiki page uses a different name than the card pool.
const WIKI_SLUG_OVERRIDES = {}
const wikiSlug = (name) => WIKI_SLUG_OVERRIDES[name] ?? name.replace(/ /g, '_')

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyIdx = args.indexOf('--champion')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

function championNames() {
  const data = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'cards.generated.json'), 'utf8'))
  const arr = Array.isArray(data) ? data : (data.cards ?? Object.values(data))
  const names = new Set()
  for (const c of arr) {
    if (c?.supertype !== 'champion') continue
    names.add(c.name.split(' - ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim())
  }
  return [...names].sort()
}

async function resolveUrl(fileName) {
  const u = `${API}?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&format=json`
  const res = await fetch(u, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const json = await res.json()
  const page = Object.values(json?.query?.pages ?? {})[0]
  if (!page || 'missing' in page) return null
  return page.imageinfo?.[0]?.url ?? null
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`download ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

const toMp3 = (ogg, mp3) =>
  execFileP(ffmpegPath, ['-y', '-i', ogg, '-codec:a', 'libmp3lame', '-q:a', '4', mp3])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ingestOne(name) {
  const key = toKey(name)
  const dir = join(OUT_ROOT, key)
  const sfxOut = join(dir, 'select-sfx.mp3')
  const voiceOut = join(dir, 'select-voice.mp3')
  if (!force && existsSync(sfxOut) && existsSync(voiceOut)) return { name, status: 'skip' }
  mkdirSync(dir, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  const slug = wikiSlug(name)
  const targets = [
    { file: `${slug}_Select_SFX.ogg`, out: sfxOut, tmp: join(TMP, `${key}-sfx.ogg`), kind: 'sfx' },
    { file: `${slug}_Select.ogg`, out: voiceOut, tmp: join(TMP, `${key}-voice.ogg`), kind: 'voice' },
  ]
  const got = []
  const missing = []
  for (const t of targets) {
    if (!force && existsSync(t.out)) { got.push(t.kind); continue }
    const url = await resolveUrl(t.file)
    if (!url) { missing.push(t.kind); continue }
    await download(url, t.tmp)
    await toMp3(t.tmp, t.out)
    rmSync(t.tmp, { force: true })
    got.push(t.kind)
  }
  return { name, status: got.length ? 'ok' : 'fail', got, missing }
}

async function main() {
  if (!ffmpegPath) {
    console.error('ffmpeg-static not found. Run: npm i -D ffmpeg-static')
    process.exit(1)
  }
  const names = only ? [only] : championNames()
  console.log(`ffmpeg: ${ffmpegPath}`)
  console.log(`Ingesting ${names.length} champion(s) → ${OUT_ROOT}\n`)
  const summary = { ok: [], skip: [], fail: [], partial: [] }
  for (const name of names) {
    try {
      const r = await ingestOne(name)
      if (r.status === 'skip') { summary.skip.push(name); process.stdout.write(`  · ${name}: skip (exists)\n`) }
      else if (r.status === 'fail') { summary.fail.push(name); process.stdout.write(`  ✗ ${name}: no audio found\n`) }
      else if (r.missing?.length) { summary.partial.push(`${name} (no ${r.missing.join('/')})`); process.stdout.write(`  ~ ${name}: got ${r.got.join('+')}, missing ${r.missing.join('/')}\n`) }
      else { summary.ok.push(name); process.stdout.write(`  ✓ ${name}\n`) }
    } catch (e) {
      summary.fail.push(name)
      process.stdout.write(`  ✗ ${name}: ${e.message}\n`)
    }
    if (!only) await sleep(300)
  }
  rmSync(TMP, { force: true, recursive: true })
  console.log(`\nDone. ok=${summary.ok.length} partial=${summary.partial.length} skip=${summary.skip.length} fail=${summary.fail.length}`)
  if (summary.partial.length) console.log('Partial:', summary.partial.join(', '))
  if (summary.fail.length) console.log('Failed:', summary.fail.join(', '))
}

main().catch((e) => { console.error(e); process.exit(1) })
