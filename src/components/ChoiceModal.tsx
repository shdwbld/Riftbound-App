// A tiny generic chooser overlay: a title and a list of option buttons.
// Used for Ambush battlefield selection (and reusable for other prompts).
export default function ChoiceModal<T extends string | number>({
  title,
  subtitle,
  options,
  onPick,
  onCancel,
}: {
  title: string
  subtitle?: string
  options: { label: string; value: T }[]
  onPick: (value: T) => void
  onCancel?: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-xl font-bold">{title}</h3>
        {subtitle && <p className="mb-3 text-sm text-white/55">{subtitle}</p>}
        <div className="mt-2 flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={String(o.value)}
              onClick={() => onPick(o.value)}
              className="rounded-lg bg-white/10 px-4 py-2 text-left text-sm font-semibold hover:bg-sky-500/30"
            >
              {o.label}
            </button>
          ))}
        </div>
        {onCancel && (
          <button onClick={onCancel} className="mt-3 w-full rounded-lg bg-white/5 px-4 py-2 text-sm text-white/60 hover:bg-white/10">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
