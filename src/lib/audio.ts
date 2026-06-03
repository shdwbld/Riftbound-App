// ---------------------------------------------------------------------------
// Audio engine (Web Audio API). SFX are decoded once and auto-spliced at silence
// gaps into variation segments (so a single mp3 holding several sounds plays a
// random one each time). Music/ambience stream via <audio> on a separate gain
// bus so it can be lowered/muted independently. Volumes persist to localStorage.
// The AudioContext is created lazily on the first user gesture (autoplay policy).
// ---------------------------------------------------------------------------

export const SFX_URLS = {
  cardFlip: '/sfx/card-flip.mp3',
  cardThrow: '/sfx/card-throw.mp3',
  playCard: '/sfx/play-card.mp3',
  shuffle: '/sfx/shuffle.mp3',
  arrow: '/sfx/arrow.mp3',
  sword: '/sfx/sword.mp3',
  punch: '/sfx/punch.mp3',
  spell: '/sfx/spell.mp3',
  spellBig: '/sfx/spell-big.mp3',
  unitKilled: '/sfx/unit-killed.mp3',
  undo: '/sfx/undo.mp3',
  confirm: '/sfx/confirm.mp3',
  uiClick: '/sfx/ui-click.mp3',
} as const
export type SfxName = keyof typeof SFX_URLS

export const MUSIC_URLS = {
  battle: '/sfx/music/battle.mp3',
  battle2: '/sfx/music/battle2.mp3',
  ambience: '/sfx/music/ambience.mp3',
} as const
export type MusicName = keyof typeof MUSIC_URLS

interface Segment {
  offset: number
  duration: number
}
interface LoadedSfx {
  buffer: AudioBuffer
  segments: Segment[]
}

export interface AudioSettings {
  sfxVolume: number // 0..1
  musicVolume: number // 0..1 (battle music + ambience; files asked for ~10-20%)
  muted: boolean
}
const SETTINGS_KEY = 'riftbound.audio.v1'
const DEFAULTS: AudioSettings = { sfxVolume: 0.7, musicVolume: 0.18, muted: false }

function loadSettings(): AudioSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<AudioSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Split a decoded buffer into loud regions separated by ≥~180ms of silence.
 *  One-sound files yield a single trimmed segment; multi-sound files yield many. */
function detectSegments(buffer: AudioBuffer): Segment[] {
  const data = buffer.getChannelData(0)
  const sr = buffer.sampleRate
  const win = Math.max(1, Math.floor(sr * 0.01)) // 10ms windows
  const threshold = 0.012 // amplitude considered "loud"
  const minSilenceWin = Math.ceil(180 / 10) // 180ms of silence splits sounds
  const minSegMs = 40

  const loud: boolean[] = []
  for (let i = 0; i < data.length; i += win) {
    let peak = 0
    const end = Math.min(i + win, data.length)
    for (let j = i; j < end; j++) {
      const a = Math.abs(data[j])
      if (a > peak) peak = a
    }
    loud.push(peak >= threshold)
  }

  const segs: Segment[] = []
  let start = -1
  let lastLoud = -1
  const push = (a: number, b: number) => {
    const offset = Math.max(0, (a * win) / sr - 0.005)
    const segEnd = Math.min((b + 1) * win, data.length) / sr
    const duration = segEnd - offset
    if (duration * 1000 >= minSegMs) segs.push({ offset, duration: Math.min(duration + 0.01, buffer.duration - offset) })
  }
  for (let w = 0; w < loud.length; w++) {
    if (loud[w]) {
      if (start < 0) start = w
      lastLoud = w
    } else if (start >= 0 && w - lastLoud >= minSilenceWin) {
      push(start, lastLoud)
      start = -1
    }
  }
  if (start >= 0) push(start, lastLoud)
  if (segs.length === 0) segs.push({ offset: 0, duration: buffer.duration })
  return segs
}

class AudioManager {
  private ctx?: AudioContext
  private masterBus?: GainNode
  private sfxBus?: GainNode
  private musicBus?: GainNode
  private sfx = new Map<SfxName, LoadedSfx>()
  private loading = new Map<SfxName, Promise<void>>()
  private music = new Map<MusicName, { el: HTMLAudioElement }>()
  settings = loadSettings()
  private listeners = new Set<() => void>()

  /** Subscribe to settings changes (for the settings UI). */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Create the AudioContext + buses. Safe to call repeatedly; must follow a
   *  user gesture the first time. */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    if (!Ctx) return
    this.ctx = new Ctx()
    this.masterBus = this.ctx.createGain()
    this.masterBus.connect(this.ctx.destination)
    this.sfxBus = this.ctx.createGain()
    this.sfxBus.connect(this.masterBus)
    this.musicBus = this.ctx.createGain()
    this.musicBus.connect(this.masterBus)
    this.applyVolumes()
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.masterBus || !this.sfxBus || !this.musicBus) return
    this.masterBus.gain.value = this.settings.muted ? 0 : 1
    this.sfxBus.gain.value = this.settings.sfxVolume
    this.musicBus.gain.value = this.settings.musicVolume
  }

  setSettings(partial: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...partial }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch {
      /* non-fatal */
    }
    this.applyVolumes()
    for (const cb of this.listeners) cb()
  }

  private async ensureLoaded(name: SfxName): Promise<void> {
    if (this.sfx.has(name) || !this.ctx) return
    let p = this.loading.get(name)
    if (!p) {
      p = (async () => {
        const res = await fetch(SFX_URLS[name])
        const buf = await res.arrayBuffer()
        const buffer = await this.ctx!.decodeAudioData(buf)
        this.sfx.set(name, { buffer, segments: detectSegments(buffer) })
      })().catch(() => {
        /* missing/undecodable file — ignore so the app still works */
      })
      this.loading.set(name, p)
    }
    await p
  }

  /** Play a SFX (a random spliced variation). volume/rate are per-play tweaks. */
  async play(name: SfxName, opts: { volume?: number; rate?: number } = {}): Promise<void> {
    if (!this.ctx || this.settings.muted) return
    await this.ensureLoaded(name)
    const loaded = this.sfx.get(name)
    if (!loaded || !this.sfxBus) return
    const seg = loaded.segments[Math.floor(Math.random() * loaded.segments.length)]
    const src = this.ctx.createBufferSource()
    src.buffer = loaded.buffer
    src.playbackRate.value = opts.rate ?? 1
    const g = this.ctx.createGain()
    g.gain.value = opts.volume ?? 1
    src.connect(g).connect(this.sfxBus)
    try {
      src.start(0, seg.offset, seg.duration)
    } catch {
      /* start may throw if offset/duration invalid — ignore */
    }
  }

  /** Loop a music/ambience track on the music bus (low volume). */
  playMusic(name: MusicName, opts: { volume?: number } = {}): void {
    if (!this.ctx || !this.musicBus) return
    if (this.music.has(name)) return
    const el = new Audio(MUSIC_URLS[name])
    el.loop = true
    el.crossOrigin = 'anonymous'
    try {
      const node = this.ctx.createMediaElementSource(el)
      const g = this.ctx.createGain()
      g.gain.value = opts.volume ?? 1
      node.connect(g).connect(this.musicBus)
    } catch {
      el.volume = (opts.volume ?? 1) * this.settings.musicVolume // fallback path
    }
    this.music.set(name, { el })
    void el.play().catch(() => {})
  }

  stopMusic(name?: MusicName): void {
    const stop = (m: { el: HTMLAudioElement }) => {
      m.el.pause()
      m.el.src = ''
    }
    if (name) {
      const m = this.music.get(name)
      if (m) {
        stop(m)
        this.music.delete(name)
      }
    } else {
      for (const m of this.music.values()) stop(m)
      this.music.clear()
    }
  }

  get ready(): boolean {
    return !!this.ctx
  }
}

export const audio = new AudioManager()
