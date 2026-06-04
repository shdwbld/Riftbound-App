import type { Card } from '../types/cards'

/** A small centered yes/no (or short-choice) prompt in the rune PaymentModal
 *  style — dark rounded panel, amber border, optional card thumbnail, footer
 *  buttons. Used for per-play decisions (e.g. optional additional cost Pay/Skip)
 *  instead of a browser window.confirm. */
export default function PromptModal({
  title,
  message,
  card,
  options,
  onCancel,
}: {
  title: string
  message?: string
  card?: Card | null
  options: { label: string; onClick: () => void; variant?: 'primary' | 'secondary' }[]
  onCancel?: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {card?.imageUrl && (
            <img
              src={card.imageUrl}
              alt={card.name}
              className="h-24 w-[68px] shrink-0 rounded-md object-cover"
              style={{ aspectRatio: '744/1039' }}
            />
          )}
          <div className="min-w-0">
            <h3 className="text-lg font-bold leading-tight">{title}</h3>
            {message && <p className="mt-1 text-sm text-white/55">{message}</p>}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {options.map((o, i) => (
            <button
              key={i}
              onClick={o.onClick}
              className={`rounded-lg px-5 py-2 text-sm font-semibold transition ${
                o.variant === 'primary' ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-white/10 hover:bg-white/20'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
