import { useState } from 'react'

// Free-form tag-naming overlay for "As you play this, name a tag" (The List).
// Centered, PaymentModal-style; the engine stores whatever string is confirmed.
export default function TagNameModal({
  prompt,
  onConfirm,
  onCancel,
}: {
  prompt: string
  onConfirm: (tag: string) => void
  onCancel: () => void
}) {
  const [tag, setTag] = useState('')
  const submit = () => {
    const t = tag.trim()
    if (t) onConfirm(t)
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-xl font-bold">✦ Name a tag</h3>
        <p className="mb-3 text-sm text-white/55">{prompt}</p>
        <input
          autoFocus
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="e.g. Poro, Demacia, Miss Fortune"
          className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:border-indigo-400/60"
        />
        <div className="mt-3 flex gap-2">
          <button
            disabled={!tag.trim()}
            onClick={submit}
            className="flex-1 rounded-lg bg-indigo-500/30 px-4 py-2 text-sm font-semibold hover:bg-indigo-500/50 disabled:opacity-40"
          >
            Name it
          </button>
          <button onClick={onCancel} className="rounded-lg bg-white/5 px-4 py-2 text-sm text-white/60 hover:bg-white/10">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
