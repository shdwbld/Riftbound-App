import { getCard } from '../data/cards'
import CardText from './CardText'

// Vision / Predict (Core Rules §743): look at the top card of your Main Deck and
// choose to recycle it (to the bottom) or keep it on top. Both keywords surface
// the same decision; Predict is reached from different triggers.
export default function VisionPrompt({
  cardId,
  onKeep,
  onRecycle,
}: {
  cardId: string
  onKeep: () => void
  onRecycle: () => void
}) {
  const card = getCard(cardId)
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-sky-400/40 bg-[#0d1320] p-5 text-center shadow-2xl">
        <h3 className="text-xl font-bold text-sky-100">👁 Vision / Predict</h3>
        <p className="mb-3 text-sm text-white/55">Top of your Main Deck — recycle it to the bottom, or keep it.</p>
        <div className="mx-auto mb-3 w-40">
          {card?.imageUrl ? (
            <img src={card.imageUrl} alt={card.name} className="w-full rounded-xl" style={{ aspectRatio: '744/1039', objectFit: 'cover' }} />
          ) : (
            <div className="flex w-full items-center justify-center rounded-xl bg-[#0a1e33] p-4 text-sm" style={{ aspectRatio: '744/1039' }}>
              {card?.name ?? cardId}
            </div>
          )}
        </div>
        {card && (
          <div className="mb-3">
            <div className="font-semibold">{card.name}</div>
            {card.text && (
              <div className="mt-1 text-[11px] leading-snug text-white/70">
                <CardText text={card.text} />
              </div>
            )}
          </div>
        )}
        <div className="flex justify-center gap-2">
          <button onClick={onRecycle} className="rounded-lg bg-amber-500/80 px-4 py-2 text-sm font-semibold hover:bg-amber-500">
            ♺ Recycle (bottom)
          </button>
          <button onClick={onKeep} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold hover:bg-sky-400">
            Keep on top
          </button>
        </div>
      </div>
    </div>
  )
}
