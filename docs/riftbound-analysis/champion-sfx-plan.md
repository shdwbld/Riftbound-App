# Champion SFX Plan — Handoff

> Handoff for another Claude Code session. Goal: when a **champion card** is played, play that champion's **Select SFX** immediately, then **~1s later** the champion's **Select voiceline**, layered. Audio sourced from the LoL fandom wiki, bundled as MP3 in the repo.

## Decisions (locked by user)
- **Host:** bundle converted MP3s in repo at `public/sfx/champions/<key>/`. ~16MB for all champions, fits Vercel. (Fandom CDN blocks browser fetch — no CORS — so runtime hot-linking is NOT viable; ingest is dev-time only.)
- **Scope:** all champions in the card pool (~82 names).
- **Layering:** KEEP the existing `playCard` thud underneath the champion SFX (user wants it).
- **Format:** MP3, not OGG (Safari `decodeAudioData` can't decode Ogg Vorbis). Convert on ingest via ffmpeg.

## Execution strategy (model split — agreed with user)
- This is a **narrow** task (1 new script + 2 small edits). **Do NOT fan out a workflow** — parallel agents would re-read the same files and waste tokens.
- Exploration + planning already done (Sonnet). Implementation = **Opus main loop** (write script, edit `audio.ts` + `MatchBoard.tsx`).
- The one real unknown (does the wiki API + filename convention hold) is resolved **empirically**: prototype the Ahri fetch first, eyeball it, THEN generalize. Don't research-read wiki docs — running it is cheaper ground truth.

---

## How the audio is fetched (the key mechanism)

The wiki page URL (e.g. `https://leagueoflegends.fandom.com/wiki/Ahri/LoL/Audio`) does NOT contain the `.ogg` files directly. They live on the media CDN at `static.wikia.nocookie.net/leagueoflegends/images/<a>/<ab>/<File>.ogg`, where `<a>/<ab>` is an **unpredictable MD5-hash path**. So you must resolve the real URL via the **MediaWiki API**:

```
https://leagueoflegends.fandom.com/api.php?action=query&titles=File:Ahri_Select.ogg&prop=imageinfo&iiprop=url&format=json
```

Response → `query.pages[<id>].imageinfo[0].url` = the real CDN `.ogg` URL. Then `fetch` it.

Per champion = **2 API calls** (`<Champ>_Select_SFX.ogg` + `<Champ>_Select.ogg`) → **2 downloads** → ffmpeg → 2 MP3s. Public read-only API, no auth. Only external dep: **ffmpeg** installed locally.

**Wiki filename convention:** `<Champion>_Select.ogg` / `<Champion>_Select_SFX.ogg`, spaces→underscores (`Lee Sin`→`Lee_Sin`), apostrophes KEPT (`Kai'Sa`). Oddballs handled by a `WIKI_SLUG_OVERRIDES` map (e.g. `Dr. Mundo`→`Dr._Mundo`). Missing file → API returns "missing" → log + skip, no crash.

---

## Engine changes — `src/lib/audio.ts`

Current state (verified): `AudioManager` (line 102) has `private sfx = Map<SfxName, LoadedSfx>` (107), `loading` (108), `ensureLoaded(name: SfxName)` (157), `play(name: SfxName, opts)` (175) using `fetch → decodeAudioData → detectSegments`, routed through `sfxBus`. Reuse all of it. **Do NOT touch `SFX_URLS`, `SfxName`, or `play()`** — champion audio is additive.

Add (after existing `ensureLoaded`/`play`):

1. **String-keyed caches** (champion URLs aren't in `SfxName`):
   ```ts
   private champSfx = new Map<string, LoadedSfx>()
   private champLoading = new Map<string, Promise<void>>()
   private champLastPlayed = new Map<string, number>()  // debounce
   ```
2. **`private async ensureLoadedUrl(url: string)`** — mirror of `ensureLoaded` but keyed on URL string; same fetch/decode/`detectSegments` + silent `.catch()` (missing file must never break the app).
3. **`private playBufferAt(loaded, whenSec, volume?)`** — factor out buffer-source creation from `play()` (lines 181–191). Schedule via `src.start(this.ctx.currentTime + whenSec, seg.offset, seg.duration)` so the +1s voiceline is locked to the audio clock (no `setTimeout` drift). Route through `sfxBus`.
4. **module-level `function toChampionKey(name)`** — strip `'` and `.`, spaces→`-`, lowercase → `ahri`, `kaisa`, `lee-sin`, `dr-mundo`, `khazix`. The ingest script uses the SAME logic so dir names match.
5. **`async playChampionSelect(championName: string)`** — public:
   - guard `if (!this.ctx || this.settings.muted) return`
   - debounce: skip if `Date.now() - champLastPlayed[key] < 1500`
   - `key = toChampionKey(name)`; URLs `/sfx/champions/${key}/select-sfx.mp3` + `/select-voice.mp3`
   - `await Promise.all([ensureLoadedUrl(sfx), ensureLoadedUrl(voice)])`
   - `playBufferAt(sfxLoaded, 0, SFX_VOL)` then `playBufferAt(voiceLoaded, VOICE_DELAY, VOICE_VOL)` (each only if present)
   - record `champLastPlayed[key]`
   - Tunable consts: `VOICE_DELAY = 1.0`, `SFX_VOL = 0.7`, `VOICE_VOL = 1.0` (tune by ear).

Mute/volume need no extra wiring — `sfxBus` routing means the SFX slider governs it; entry guard handles mute.

---

## Wiring — `src/components/MatchBoard.tsx`

SFX effect is at lines 325–333 (keyed on `match.seq`). Replace the play branch (currently 329–332):
```ts
if (playEvt?.cardId) {
  const c = getCard(playEvt.cardId)
  if (c && c.type === 'spell') audio.play((c.energy ?? 0) >= 5 ? 'spellBig' : 'spell')
  else if (c && c.supertype === 'champion') {
    const champ = c.name.split(' - ')[0].replace(' (Alternate Art)', '').trim()
    void audio.playChampionSelect(champ)
    audio.play('playCard')        // keep the thud underneath (user choice)
  } else if (c) audio.play('playCard')
}
```
Notes: `supertype === 'champion'` is the guard (`src/types/cards.ts`). Champion name from `name.split(' - ')[0]` — reliable across champions (tags[0] is NOT always the champion). Missing audio → silent. Debounce in `playChampionSelect` absorbs duplicate `play` events in one batch.

---

## Ingest script — `scripts/ingest-champion-audio.mjs` (NEW)

Dev-time Node ESM, sibling to `scripts/ingest-cards.mjs`. NOT run in browser.

- Args: optional `--champion <Name>` (default all), `--force` (re-download). Else idempotent skip-if-exists.
- Champion list: read `src/data/cards.generated.json`, filter `supertype === 'champion'`, dedupe `name.split(' - ')[0]`.
- Per champion: resolve real CDN URLs via the MediaWiki API call above (for `_Select_SFX.ogg` + `_Select.ogg`) → `imageinfo[0].url`.
  - `WikiSlug`: spaces→`_`, keep apostrophes. `WIKI_SLUG_OVERRIDES` for oddballs (`Dr. Mundo`→`Dr._Mundo`).
- Download `.ogg` to temp → `ffmpeg -i in.ogg -codec:a libmp3lame -q:a 4 out.mp3` → write `public/sfx/champions/<toChampionKey>/select-sfx.mp3` + `select-voice.mp3` → clean temp.
- Check `ffmpeg -version` at startup; clear error if missing.
- Sequential, ~300ms gap between champions (polite to API). Per-champion failures caught + logged. Final summary: downloaded / skipped / failed (some champs may lack a `Select` voiceline — report them).

Run order: `node scripts/ingest-champion-audio.mjs --champion Ahri` FIRST to validate, then full run (~5–10 min, ~164 fetch+convert).

---

## Other files
- `.gitattributes`: add `public/sfx/champions/**/*.mp3 binary` to avoid diff noise / EOL mangling.

## Critical files
- `src/lib/audio.ts` — engine additions (URL cache, scheduled `playBufferAt`, `playChampionSelect`, `toChampionKey`).
- `src/components/MatchBoard.tsx` — lines 329–332 play branch.
- `scripts/ingest-champion-audio.mjs` — NEW ingest/convert script.
- `src/data/cards.generated.json` — read-only source of champion names.
- `.gitattributes` — binary attr for MP3s.

## Verification
1. `node scripts/ingest-champion-audio.mjs --champion Ahri` → confirm `public/sfx/champions/ahri/select-sfx.mp3` + `select-voice.mp3` exist and play.
2. `npm run dev`, open a match, play an Ahri champion card → SFX immediately, voiceline ~1s later, both audible, thud underneath.
3. Mute in Settings → silence. SFX slider to 0 → silence.
4. Edge cases: two different champions in quick succession (both play, no crash); same champion twice within ~1.5s (debounce → one set); non-champion unit (plain `playCard`, no voiceline); rename a file temporarily (graceful silence, no console error).
5. Full ingest, then `npm run build` → completes; build output well under Vercel's 100MB.

## Legal note
Riot's copyrighted audio. Project is an unofficial non-commercial fan sim already using Riot card art, so consistent in spirit — but bundling/redistributing extracted audio goes a step beyond linking Riot's own CDN. Worst realistic case: DMCA takedown to Vercel/GitHub. Mitigate: stay non-commercial, add footer attribution ("Audio: Riot Games / League of Legends"), and since the pipeline is scripted you can pull the audio fast without touching game code if asked.

## Suggested first step for the implementing session
Prototype the Ahri fetch (resolve via API → download both `.ogg` → ffmpeg → MP3) and eyeball the result BEFORE building the full script. If Ahri comes down clean, generalize. Stay in main loop (Opus); no workflow/fan-out — surface is too small to amortize agent context cost.
