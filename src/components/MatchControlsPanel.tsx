import { useState } from 'react'
import AudioSettings from './AudioSettings'

// Right-rail "Controls & Settings" panel: a collapsible cheat-sheet of the mouse +
// keyboard controls (including drag-to-play and the radial menu) with the sound /
// animation settings folded in.

const MOUSE: { k: string; label: string }[] = [
  { k: 'Drag a hand card', label: 'Play it — drop on a glowing green zone' },
  { k: 'Drag to screen edge', label: 'Pan / scroll the board while holding a card' },
  { k: 'Right-click', label: 'Open the radial action menu (card / zone)' },
  { k: 'Radial → Move', label: 'Move a card — click a glowing destination' },
  { k: 'Click unit → battlefield', label: 'Move your unit(s) to attack' },
]

const KEYS: { k: string; label: string }[] = [
  { k: 'Space', label: 'Pass / end turn' },
  { k: 'A / S', label: 'Pass priority (resolve top of chain)' },
  { k: 'D', label: 'Draw a card' },
  { k: 'R / Backspace', label: 'Undo last action' },
  { k: 'Esc', label: 'Cancel targeting / move / drag' },
  { k: 'H / ?', label: 'Full hotkey help' },
]

const SANDBOX: { k: string; label: string }[] = [
  { k: 'Z + click', label: 'Stun / toggle a card (Override)' },
  { k: 'C + click', label: 'Add a marker · Ctrl+C removes' },
  { k: 'Shift + click', label: 'Recycle a rune' },
  { k: 'Alt + click', label: 'Ping a card (everyone sees)' },
]

function Group({ title, rows }: { title: string; rows: { k: string; label: string }[] }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] font-bold uppercase tracking-wide text-white/35">{title}</div>
      {rows.map((r) => (
        <div key={r.k} className="flex items-start justify-between gap-2">
          <kbd className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/75">{r.k}</kbd>
          <span className="flex-1 text-right text-[11px] leading-tight text-white/60">{r.label}</span>
        </div>
      ))}
    </div>
  )
}

export default function MatchControlsPanel({ sandbox, onOpenFullHelp }: { sandbox?: boolean; onOpenFullHelp?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a1428]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-white/45 hover:text-white/70"
      >
        <span>⌨ Controls & Settings</span>
        <span className="text-white/30">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/10 p-2.5">
          <Group title="Mouse" rows={MOUSE} />
          <Group title="Keys" rows={KEYS} />
          {sandbox && <Group title="Override (sandbox)" rows={SANDBOX} />}
          <div className="flex items-center justify-between border-t border-white/10 pt-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-white/60">⚙ Settings</span>
            <div className="flex items-center gap-1">
              {onOpenFullHelp && (
                <button onClick={onOpenFullHelp} title="Full hotkey list" className="rounded-md px-2 py-1.5 text-sm text-white/60 hover:bg-white/10 hover:text-white">
                  ⌨
                </button>
              )}
              <AudioSettings />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
