import { type CardInstance, card } from '../game/state'
import { getCard } from '../data/cards'
import { isUnit } from '../types/cards'

/** Effective Might for display, defensive across solo/match card shapes. */
function effectiveMight(ci: CardInstance, base: number): { might: number; boosted: boolean } {
  const x = ci as CardInstance & { buffs?: number; tempMight?: number; attached?: string[] }
  let gear = 0
  for (const gid of x.attached ?? []) {
    const g = getCard(gid.split('|')[0])
    const m = (g?.text ?? '').match(/\+(\d+)\s*Might/i)
    if (m) gear += parseInt(m[1], 10)
  }
  const mods = (x.buffs ?? 0) + (x.tempMight ?? 0) + gear
  return { might: Math.max(0, base + mods - ci.damage), boosted: mods > 0 }
}

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
      {def && isUnit(def) && !faceDown && (() => {
        const { might, boosted } = effectiveMight(ci, def.might)
        const x = ci as CardInstance & { buffs?: number; attached?: string[]; stunned?: boolean }
        return (
          <>
            <span
              className={`absolute bottom-0 right-0 rounded-tl px-1 text-[9px] font-bold ${
                boosted ? 'bg-emerald-600/90 text-white' : 'bg-black/75 text-rose-300'
              }`}
            >
              {might}⚔{ci.damage ? <span className="text-rose-200">!</span> : null}
            </span>
            {/* status badges: attached gear / buffs / stun */}
            <span className="absolute left-0 top-0 flex flex-col gap-px text-[8px]">
              {(x.attached?.length ?? 0) > 0 && (
                <span className="rounded-br bg-amber-500/80 px-0.5 text-black" title="Equipped">🔧</span>
              )}
              {(x.buffs ?? 0) > 0 && (
                <span className="rounded-br bg-emerald-500/80 px-0.5 text-black" title="Buffed">✦</span>
              )}
              {x.stunned && (
                <span className="rounded-br bg-sky-400/80 px-0.5 text-black" title="Stunned">✸</span>
              )}
            </span>
          </>
        )
      })()}
    </button>
  )
}
