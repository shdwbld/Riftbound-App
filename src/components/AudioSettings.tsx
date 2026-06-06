import { useEffect, useReducer, useState } from 'react'
import { audio } from '../lib/audio'

// Gear/speaker control in the header: master mute + SFX and Music/Ambience
// volume sliders. Persists via the audio engine; usable any time (incl.
// mid-game). Marked data-no-sfx so its own controls don't trigger click SFX.
export default function AudioSettings() {
  const [, force] = useReducer((x) => x + 1, 0)
  const [open, setOpen] = useState(false)
  useEffect(() => audio.subscribe(force), [])
  const s = audio.settings

  return (
    <div className="relative shrink-0" data-no-sfx>
      <button
        onClick={() => {
          audio.init()
          setOpen((o) => !o)
        }}
        title="Sound settings"
        className="rounded-md px-2 py-1.5 text-lg text-white/70 hover:bg-white/10 hover:text-white"
      >
        {s.muted ? '🔇' : '🔊'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-60 space-y-3 rounded-xl border border-white/15 bg-[#0a1428] p-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Sound</span>
              <button
                onClick={() => audio.setSettings({ muted: !s.muted })}
                className={`rounded px-2 py-1 text-xs font-semibold ${s.muted ? 'bg-rose-500/30 text-rose-200' : 'bg-emerald-500/25 text-emerald-200'}`}
              >
                {s.muted ? 'Muted' : 'On'}
              </button>
            </div>
            <label className="block">
              <span className="flex justify-between text-xs text-white/55">
                <span>Effects</span>
                <span>{Math.round(s.sfxVolume * 100)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(s.sfxVolume * 100)}
                onChange={(e) => audio.setSettings({ sfxVolume: Number(e.target.value) / 100 })}
                className="mt-1 w-full accent-sky-400"
              />
            </label>
            <label className="block">
              <span className="flex justify-between text-xs text-white/55">
                <span>Music &amp; ambience</span>
                <span>{Math.round(s.musicVolume * 100)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(s.musicVolume * 100)}
                onChange={(e) => audio.setSettings({ musicVolume: Number(e.target.value) / 100 })}
                className="mt-1 w-full accent-amber-400"
              />
            </label>
            <p className="text-[10px] text-white/35">Saved on this device. Battle music stays low by default.</p>
          </div>
        </>
      )}
    </div>
  )
}
