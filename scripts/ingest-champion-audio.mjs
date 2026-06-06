#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Dev-time ingest: pull League audio from the LoL Fandom wiki (resolved via the
// MediaWiki API), convert OGG → MP3 with ffmpeg-static, and bundle it for the app.
//   public/sfx/champions/<key>/{select-sfx,select-voice,death,win,ability-<slot>}.mp3
//   public/sfx/generic/<name>.mp3   (announcer + summoner SFX)
// NOT run in the browser. Requires network + ffmpeg-static (devDependency).
//   node scripts/ingest-champion-audio.mjs            # all, skip existing
//   node scripts/ingest-champion-audio.mjs --champion Ahri
//   node scripts/ingest-champion-audio.mjs --force
// Riot copyrighted audio — for the unofficial non-commercial fan sim.
// ---------------------------------------------------------------------------

import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

const execFileP = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CH_ROOT = join(ROOT, 'public', 'sfx', 'champions')
const GEN_ROOT = join(ROOT, 'public', 'sfx', 'generic')
const TMP = join(ROOT, '.tmp-champ-audio')
const API = 'https://leagueoflegends.fandom.com/api.php'
const UA = 'RiftboundFanSim/1.0 (champion audio ingest; non-commercial)'

const toKey = (name) => name.replace(/['.]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
const WIKI_SLUG_OVERRIDES = {}
const wikiSlug = (name) => WIKI_SLUG_OVERRIDES[name] ?? name.replace(/ /g, '_')

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyIdx = args.indexOf('--champion')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

function loadCards() {
  const data = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'cards.generated.json'), 'utf8'))
  return Array.isArray(data) ? data : (data.cards ?? Object.values(data))
}
function championNames(cards) {
  const names = new Set()
  for (const c of cards) {
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

/** Try each candidate wiki filename; first that resolves is downloaded+converted to `out`. */
async function fetchFirst(candidates, out, tmpName) {
  if (!force && existsSync(out)) return 'have'
  mkdirSync(TMP, { recursive: true })
  const tmp = join(TMP, tmpName)
  for (const file of candidates) {
    const url = await resolveUrl(file)
    if (!url) continue
    await download(url, tmp)
    await toMp3(tmp, out)
    rmSync(tmp, { force: true })
    return 'ok'
  }
  return 'miss'
}

async function ingestChampion(name) {
  const key = toKey(name)
  const dir = join(CH_ROOT, key)
  mkdirSync(dir, { recursive: true })
  const slug = wikiSlug(name)
  const o = `${slug}_Original`
  const targets = [
    { cands: [`${slug}_Select_SFX.ogg`], out: 'select-sfx.mp3' },
    { cands: [`${slug}_Select.ogg`], out: 'select-voice.mp3' },
    { cands: [`${o}_Death_0.ogg`, `${o}_Death.ogg`], out: 'death.mp3' },
    { cands: [`${o}_Kill_0.ogg`, `${o}_Taunt_0.ogg`, `${o}_Taunt.ogg`], out: 'win.mp3' },
  ]
  const got = []
  for (const t of targets) {
    const r = await fetchFirst(t.cands, join(dir, t.out), `${key}-${t.out}.ogg`)
    if (r !== 'miss') got.push(t.out.replace('.mp3', ''))
  }
  return got
}

async function ingestSignatures(cards) {
  const map = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'signatureAudio.json'), 'utf8'))
  const done = new Set()
  let ok = 0, miss = 0
  for (const c of cards) {
    if (c?.supertype !== 'signature') continue
    const base = c.name.replace(/\s*\([^)]*\)\s*$/, '').trim()
    const slot = map[base]
    const champ = (c.tags ?? [])[0]
    if (!slot || !champ) continue
    const key = toKey(champ)
    const tag = `${key}:${slot}`
    if (done.has(tag)) continue
    done.add(tag)
    if (only && champ !== only) continue
    const dir = join(CH_ROOT, key)
    mkdirSync(dir, { recursive: true })
    const slug = wikiSlug(champ)
    const r = await fetchFirst(
      [`${slug}_Original_${slot}_0.ogg`, `${slug}_Original_${slot}.ogg`],
      join(dir, `ability-${slot.toLowerCase()}.mp3`),
      `${key}-ability-${slot}.ogg`,
    )
    if (r === 'miss') { miss++; process.stdout.write(`  ~ ${champ} ${slot} (no VO)\n`) }
    else { ok++; process.stdout.write(`  ⚡ ${champ} ${slot}\n`) }
    await sleep(200)
  }
  return { ok, miss }
}

const GENERIC = {
  victory: ['Announcer_OnVictory_0_old2.ogg'],
  defeat: ['Announcer_OnDefeat_0_old2.ogg'],
  'first-blood': ['Announcer_OnFirstBlood_0_old2.ogg'],
  'double-kill': ['Announcer_OnChampionDoubleKill_0_old2.ogg'],
  'triple-kill': ['Announcer_OnChampionTripleKill_0_old2.ogg'],
  'quadra-kill': ['Announcer_OnChampionQuadraKill_0_old2.ogg'],
  'penta-kill': ['Announcer_OnChampionPentaKill_0_old2.ogg'],
  turret: ['Announcer_OnTurretDieEnemyTeam_0_old2.ogg'],
  inhibitor: ['Announcer_OnDampenerDieEnemyTeam_0_old2.ogg'],
  recall: ['Recall_SFX.ogg'],
}
async function ingestGeneric() {
  mkdirSync(GEN_ROOT, { recursive: true })
  let ok = 0, miss = 0
  for (const [outName, cands] of Object.entries(GENERIC)) {
    const r = await fetchFirst(cands, join(GEN_ROOT, `${outName}.mp3`), `gen-${outName}.ogg`)
    if (r === 'miss') { miss++; process.stdout.write(`  ~ generic ${outName} (missing)\n`) }
    else { ok++; process.stdout.write(`  ♪ generic ${outName}\n`) }
    await sleep(200)
  }
  return { ok, miss }
}

async function main() {
  if (!ffmpegPath) { console.error('ffmpeg-static missing. npm i -D ffmpeg-static'); process.exit(1) }
  const cards = loadCards()
  const names = only ? [only] : championNames(cards)
  console.log(`ffmpeg: ${ffmpegPath}\nChampions: ${names.length}\n`)
  const sum = { champOk: 0, champFail: 0 }
  for (const name of names) {
    try {
      const got = await ingestChampion(name)
      if (got.length) { sum.champOk++; process.stdout.write(`  ✓ ${name} [${got.join(',')}]\n`) }
      else { sum.champFail++; process.stdout.write(`  ✗ ${name}: nothing\n`) }
    } catch (e) { sum.champFail++; process.stdout.write(`  ✗ ${name}: ${e.message}\n`) }
    if (!only) await sleep(250)
  }
  console.log('\n-- signature abilities --')
  const sig = await ingestSignatures(cards)
  console.log('\n-- generic SFX --')
  const gen = await ingestGeneric()
  rmSync(TMP, { force: true, recursive: true })
  console.log(`\nDone. champions ok=${sum.champOk} fail=${sum.champFail} | abilities ok=${sig.ok} miss=${sig.miss} | generic ok=${gen.ok} miss=${gen.miss}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
