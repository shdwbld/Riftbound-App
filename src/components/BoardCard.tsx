import { type CardInstance, card } from '../game/state'
import { isUnit } from '../types/cards'

export default function BoardCard({
  ci,
  selected,
  onClick,
  size = 'md',
  faceDown = false,
}: {
  ci: CardInstance
  selected?: boolean
  onClick?: (e: React.MouseEvent) => void
  size?: 'sm' | 'md'
  faceDown?: boolean
}) {
  const def = card(ci)
  const w = size === 'sm' ? 'w-12' : 'w-[68px]'
  return (
    <button
      onClick={onClick}
      title={def?.name}
      className={`relative ${w} shrink-0 overflow-hidden rounded-md border transition ${
        selected
          ? 'border-indigo-400 ring-2 ring-indigo-400/60'
          : 'border-white/15 hover:border-white/40'
      } ${ci.exhausted ? 'rotate-90' : ''}`}
      style={{ aspectRatio: '744/1039' }}
    >
      {faceDown ? (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-indigo-900 to-fuchsia-900 text-white/40">
          ⚔
        </div>
      ) : def?.imageUrl ? (
        <img
          src={def.imageUrl}
          alt={def.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#1c1c28] p-1 text-center text-[8px] text-white/70">
          {def?.name ?? ci.cardId}
        </div>
      )}
      {def && isUnit(def) && !faceDown && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-[9px] font-bold text-rose-300">
          {def.might + (ci.damage ? `-${ci.damage}` : '')}
        </span>
      )}
    </button>
  )
}
