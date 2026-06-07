import { getCard } from '../data/cards'
import CardPreview from './CardPreview'

// "An opponent reveals their hand" picker: shows the revealed hand face-up as card
// images and lets the caster click one (Bone Skewer, Mindsplit, Sabotage, Ashe…).
// Optional picks (Bone Skewer's "you may") expose a Decline button.

export default function RevealHandModal({
  title,
  options,
  cardIdOf,
  optional,
  onPick,
}: {
  title: string
  /** The revealed hand: each option's value is the card instance iid. */
  options: { label: string; value: string }[]
  /** Resolve a card-instance iid → its cardId (for the art). */
  cardIdOf: (iid: string) => string | undefined
  optional?: boolean
  onPick: (value: string | null) => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={() => optional && onPick(null)}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-amber-500/30 bg-[#10131c] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-xl font-bold">🃏 {title}</h3>
        <p className="mb-3 text-sm text-white/55">Click a card to choose it{optional ? ', or decline.' : '.'}</p>
        <div className="flex max-h-[60vh] flex-wrap justify-center gap-2 overflow-y-auto">
          {options.map((o) => {
            const cardId = cardIdOf(o.value)
            const card = cardId ? getCard(cardId) : undefined
            return (
              <CardPreview key={o.value} cardId={cardId ?? ''} center>
                <button
                  onClick={() => onPick(o.value)}
                  className="group relative overflow-hidden rounded-lg border-2 border-transparent transition hover:border-amber-400 hover:shadow-[0_0_18px_-4px_rgba(200,155,60,0.8)]"
                >
                  {card?.imageUrl ? (
                    <img src={card.imageUrl} alt={card.name} className="h-44 w-auto object-contain" draggable={false} />
                  ) : (
                    <div className="flex h-44 w-32 items-center justify-center bg-[#16223a] p-2 text-center text-xs font-semibold text-white">
                      {o.label}
                    </div>
                  )}
                </button>
              </CardPreview>
            )
          })}
        </div>
        {optional && (
          <button onClick={() => onPick(null)} className="mt-4 w-full rounded-lg bg-white/5 px-4 py-2 text-sm text-white/60 hover:bg-white/10">
            Decline (take nothing)
          </button>
        )}
      </div>
    </div>
  )
}
