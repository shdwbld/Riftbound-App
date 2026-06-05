import { useState } from 'react'

// A centered PaymentModal-style "report a bug" dialog: a note + severity, then
// the page captures the last {pre → action → post → events} step to Supabase.

type Severity = 'low' | 'med' | 'high'

export default function BugReportModal({
  enabled,
  onSubmit,
  onClose,
}: {
  /** False when Supabase isn't configured — the form is shown but submit is disabled. */
  enabled: boolean
  onSubmit: (note: string, severity: Severity) => Promise<void>
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const [sev, setSev] = useState<Severity>('med')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onSubmit(note.trim(), sev)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-bold text-amber-100">🐞 Report a bug</div>
        <p className="mt-1 text-xs text-white/50">
          Captures the last action + the full game state so it can be reproduced and turned into a test.
        </p>

        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What went wrong? What did you expect to happen?"
          rows={4}
          className="mt-3 w-full resize-y rounded-lg bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-white/30"
        />

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-white/40">Severity</span>
          {(['low', 'med', 'high'] as Severity[]).map((s) => (
            <button
              key={s}
              onClick={() => setSev(s)}
              className={`rounded px-2.5 py-1 text-xs font-semibold ${sev === s ? 'bg-amber-500/40 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
            >
              {s === 'med' ? 'medium' : s}
            </button>
          ))}
        </div>

        {!enabled && (
          <div className="mt-3 rounded bg-rose-500/15 px-3 py-2 text-xs text-rose-200">
            Supabase isn't configured — bug capture can't save. (Set VITE_SUPABASE_* env vars.)
          </div>
        )}
        {err && <div className="mt-3 rounded bg-rose-500/15 px-3 py-2 text-xs text-rose-200">{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !enabled || note.trim().length === 0}
            className="rounded-lg bg-amber-500/80 px-4 py-2 text-sm font-bold text-black hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Capturing…' : 'Capture bug'}
          </button>
        </div>
      </div>
    </div>
  )
}
