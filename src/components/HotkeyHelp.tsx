// In-match hotkey reference overlay. Toggled with H or ?.

const KEYS: { keys: string; label: string; ready: boolean }[] = [
  { keys: 'Space', label: 'Pass / end turn', ready: true },
  { keys: 'D', label: 'Draw a card', ready: true },
  { keys: 'R / Backspace', label: 'Rewind (undo) last action', ready: true },
  { keys: 'H / ?', label: 'Toggle this help', ready: true },
  { keys: 'Right-click', label: 'Card actions: buff · recycle · trash · reveal', ready: true },
  { keys: 'A', label: 'Approve top chain effect', ready: false },
  { keys: 'S', label: 'Resolve top chain effect', ready: false },
  { keys: 'C', label: 'Add counters', ready: false },
  { keys: 'B', label: 'Buff units (via right-click for now)', ready: false },
  { keys: 'T', label: 'Target from top chain effect', ready: false },
  { keys: 'E', label: 'Emote wheel', ready: false },
  { keys: 'P', label: 'Ping your cards', ready: false },
  { keys: 'Shift', label: 'Put hovered card on top of deck', ready: false },
]

export default function HotkeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#12121a] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-bold">Hotkeys</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            ✕
          </button>
        </div>
        <ul className="space-y-1.5 text-sm">
          {KEYS.map((k) => (
            <li key={k.keys} className="flex items-center justify-between gap-3">
              <kbd className="rounded bg-white/10 px-2 py-0.5 font-mono text-xs">{k.keys}</kbd>
              <span className={`flex-1 text-right ${k.ready ? 'text-white/80' : 'text-white/35'}`}>
                {k.label}
                {!k.ready && <span className="ml-1 text-[10px] text-amber-400/60">soon</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-white/30">
          Greyed actions need the Chain/targeting/social systems (in progress).
        </p>
      </div>
    </div>
  )
}
