import { type CardInstance, card } from '../game/state'
import { getCard } from '../data/cards'
import { isUnit, type Card } from '../types/cards'
import { parseKeywords, levelBonus } from '../engine/keywords'

/** Manual sandbox status-marker dot colors, indexed 1–4 (0/undefined = none). */
const MARKER_COLORS = ['', 'bg-rose-500', 'bg-amber-400', 'bg-emerald-400', 'bg-sky-400']

/** Compact combat/status keyword badges for an in-play unit. */
function keywordBadges(def: Card): { label: string; title: string; cls: string }[] {
  const k = parseKeywords(def)
  const out: { label: string; title: string; cls: string }[] = []
  if (k.tank) out.push({ label: 'T', title: 'Tank — must be hit first', cls: 'bg-sky-600/90 text-white' })
  if (k.shield) out.push({ label: `S${k.shield}`, title: `Shield ${k.shield} — +${k.shield} Might while defending`, cls: 'bg-emerald-600/90 text-white' })
  if (k.assault) out.push({ label: `A${k.assault}`, title: `Assault ${k.assault} — +${k.assault} Might while attacking`, cls: 'bg-rose-600/90 text-white' })
  if (k.deflect) out.push({ label: `D${k.deflect}`, title: `Deflect ${k.deflect} — costs enemies +${k.deflect} to target`, cls: 'bg-indigo-600/90 text-white' })
  if (k.backline) out.push({ label: 'BL', title: 'Backline — does not fight on the frontline', cls: 'bg-slate-600/90 text-white' })
  if (k.ganking) out.push({ label: 'G', title: 'Ganking — may move battlefield-to-battlefield', cls: 'bg-fuchsia-600/90 text-white' })
  if (k.deathknell) out.push({ label: '☠', title: 'Deathknell — triggers an effect when defeated', cls: 'bg-violet-700/90 text-white' })
  if (k.temporary) out.push({ label: '⏳', title: 'Temporary — defeated at the start of your next turn', cls: 'bg-amber-600/90 text-black' })
  return out
}

/** Effective Might for display, defensive across solo/match card shapes. */
function effectiveMight(ci: CardInstance, base: number): { might: number; boosted: boolean } {
  const x = ci as CardInstance & { buffs?: number; tempMight?: number; attached?: string[] }
  let gear = 0
  for (const gid of x.attached ?? []) {
    const t = getCard(gid.split('|')[0])?.text ?? ''
    const m = t.match(/\+(\d+)\s*(?::rb_might:|might)\b/i)
    if (m && !/this turn/i.test(t)) gear += parseInt(m[1], 10)
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
  flash,
  dim = false,
  glow,
  xp = 0,
  auraBonus = 0,
}: {
  ci: CardInstance
  selected?: boolean
  onClick?: (e: React.MouseEvent) => void
  size?: 'sm' | 'md'
  faceDown?: boolean
  /** One-shot feedback animation, replayed by remounting (key includes a seq). */
  flash?: 'damage' | 'defeat' | 'play' | 'buff' | 'stun' | 'move' | 'equip'
  /** Greyed + desaturated when the card is currently unplayable. */
  dim?: boolean
  /** Persistent affordance highlight. */
  glow?: 'ready' | 'playable' | 'target'
  /** Controlling player's XP — drives [Level N] activation + bonus Might. */
  xp?: number
  /** State-aware Might auras the card can't compute itself (Draven points, Mundo
   *  trash, Garen "here", Meditative runes, …) — from `auraMightFor` at the call
   *  site that has MatchState + battlefield index. Folded into the displayed Might. */
  auraBonus?: number
}) {
  const def = card(ci)
  const w = size === 'sm' ? 'w-12' : 'w-[68px]'
  const borderClass =
    glow === 'target'
      ? 'border-amber-300 ring-2 ring-amber-300/70 shadow-[0_0_12px_2px_rgba(252,211,77,0.55)]'
      : selected
        ? 'border-indigo-400 ring-2 ring-indigo-400/60'
        : glow === 'playable'
          ? 'border-emerald-400/60 ring-1 ring-emerald-400/40'
          : 'border-white/15 hover:border-white/40'
  return (
    <button
      onClick={onClick}
      title={def?.name}
      data-iid={(ci as { iid?: string }).iid}
      className={`relative ${w} shrink-0 overflow-hidden rounded-md border transition ${borderClass} ${
        ci.exhausted ? 'rotate-90' : ''
      } ${dim ? 'opacity-40 saturate-0' : ''} ${glow === 'ready' ? 'fx-ready' : ''} ${
        flash ? `fx-${flash}` : ''
      }`}
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
      {(ci as { stunned?: boolean }).stunned && !faceDown && (
        <span className="stun-stars" aria-hidden>💫</span>
      )}
      {/* Manual status marker (sandbox): a colored dot in the top-right corner. */}
      {(ci as { marker?: number }).marker ? (
        <span
          className={`absolute right-0 top-0 m-0.5 h-2.5 w-2.5 rounded-full shadow ring-1 ring-black/60 ${MARKER_COLORS[(ci as { marker?: number }).marker!] ?? 'bg-white'}`}
          title={`Status marker ${(ci as { marker?: number }).marker}`}
          aria-hidden
        />
      ) : null}
      {def && isUnit(def) && !faceDown && (() => {
        const base = effectiveMight(ci, def.might)
        const lvl = levelBonus(def, xp)
        const aura = auraBonus ?? 0
        const might = Math.max(0, base.might + lvl.might + aura)
        const boosted = base.boosted || lvl.might > 0 || aura > 0
        const x = ci as CardInstance & { buffs?: number; attached?: string[]; stunned?: boolean; tempMight?: number }
        // Might breakdown for the tooltip: "2 + 1 = 3 (this turn)".
        let gear = 0
        for (const gid of x.attached ?? []) {
          const m = (getCard(gid.split('|')[0])?.text ?? '').match(/\+(\d+)\s*Might/i)
          if (m) gear += parseInt(m[1], 10)
        }
        // The ± Might counter: all stat modifiers vs printed base, EXCLUDING damage
        // (damage has its own marker). "this turn" cue when a temp modifier is live.
        const mods = (x.buffs ?? 0) + (x.tempMight ?? 0) + gear + lvl.might + aura
        const thisTurn = (x.tempMight ?? 0) !== 0
        const parts: string[] = [`${def.might} base`]
        if ((x.buffs ?? 0) > 0) parts.push(`+${x.buffs} buff`)
        if (gear > 0) parts.push(`+${gear} gear`)
        if (lvl.might > 0) parts.push(`+${lvl.might} Level`)
        if (aura !== 0) parts.push(`${aura > 0 ? '+' : ''}${aura} aura`)
        if ((x.tempMight ?? 0) !== 0) parts.push(`${(x.tempMight ?? 0) > 0 ? '+' : ''}${x.tempMight} this turn`)
        if (ci.damage > 0) parts.push(`−${ci.damage} damage`)
        const mightTitle = `Might: ${parts.join(' ')} = ${might}`
        const badges = keywordBadges(def)
        const lvlThreshold = parseKeywords(def).level
        return (
          <>
            <span
              title={mightTitle}
              className={`absolute bottom-0 right-0 rounded-tl px-1 text-[9px] font-bold ${
                boosted ? 'bg-emerald-600/90 text-white' : 'bg-black/75 text-rose-300'
              }`}
            >
              {might}⚔{ci.damage ? <span className="text-rose-200" title={`${ci.damage} damage marked`}>−{ci.damage}</span> : null}
            </span>
            {/* Side ±Might counter — clean pill on the LEFT edge, vertically centered
                (the right edge belongs to the attached-gear peek). */}
            {mods !== 0 && (
              <span
                title={mightTitle}
                className={`absolute left-0 top-1/2 -translate-y-1/2 rounded-r px-1 text-[9px] font-bold leading-tight shadow ${
                  mods > 0 ? 'bg-emerald-500/95 text-black' : 'bg-rose-600/95 text-white'
                } ${thisTurn ? 'ring-1 ring-white/70' : ''}`}
              >
                {mods > 0 ? '+' : '−'}{Math.abs(mods)}
              </span>
            )}
            {/* status badges: Mighty / gear / Gold / buff / stun */}
            <span className="absolute left-0 top-0 flex flex-col gap-px text-[8px]">
              {might >= 5 && (
                <span className="rounded-br bg-rose-600/90 px-0.5 font-bold text-white" title="Mighty (≥5 Might)">M</span>
              )}
              {(x.buffs ?? 0) > 0 && (
                <span className="rounded-br bg-emerald-500/80 px-0.5 text-black" title="Buffed (permanent +Might)">✦</span>
              )}
              {(x.tempMight ?? 0) > 0 && (
                <span className="rounded-br bg-teal-400/90 px-0.5 font-bold text-black" title={`+${x.tempMight} Might this turn`}>↑</span>
              )}
              {(x.tempMight ?? 0) < 0 && (
                <span className="rounded-br bg-orange-500/90 px-0.5 font-bold text-black" title={`${x.tempMight} Might this turn`}>↓</span>
              )}
              {x.stunned && (
                <span className="rounded-br bg-sky-400/80 px-0.5 text-black" title="Stunned — deals no combat damage this turn">✸</span>
              )}
              {(ci as { grantShield?: number }).grantShield ? (
                <span className="rounded-br bg-cyan-400/90 px-0.5 font-bold text-black" title="Granted [Shield] this turn">S</span>
              ) : null}
              {(ci as { grantTank?: boolean }).grantTank && (
                <span className="rounded-br bg-amber-500/90 px-0.5 font-bold text-black" title="Granted [Tank] this turn">T</span>
              )}
              {((ci as { deathShield?: boolean }).deathShield || (ci as { banishShield?: boolean }).banishShield) && (
                <span className="rounded-br bg-lime-400/90 px-0.5 font-bold text-black" title="Protected from its next death this turn">P</span>
              )}
              {(ci as { targetingImmune?: boolean }).targetingImmune && (
                <span className="rounded-br bg-indigo-400/90 px-0.5 font-bold text-white" title="Can't be chosen by enemy spells/abilities">⦸</span>
              )}
              {/\bi can'?t be readied\b/i.test(def.text ?? '') && (
                <span className="rounded-br bg-slate-400/90 px-0.5 font-bold text-black" title="Can't be readied">∅</span>
              )}
              {lvlThreshold > 0 && (
                <span
                  className={`rounded-br px-0.5 font-bold ${lvl.active ? 'bg-fuchsia-500/90 text-white' : 'bg-white/15 text-white/50'}`}
                  title={`Level ${lvlThreshold} — ${lvl.active ? 'ACTIVE' : `needs ${lvlThreshold} XP (have ${xp})`}`}
                >
                  Lv{lvlThreshold}
                </span>
              )}
              {/* Token instance number — distinguishes identical tokens (Sand Soldiers,
                  Recruits, …). Derived from the unique iid suffix so it is stable. */}
              {(def as { supertype?: string }).supertype === 'token' && (() => {
                const m = String((ci as { iid?: string }).iid ?? '').match(/#([0-9a-z]+)$/i)
                if (!m) return null
                return (
                  <span className="rounded-br bg-black/75 px-0.5 font-bold text-amber-200" title={`Token #${parseInt(m[1], 36)}`}>
                    #{parseInt(m[1], 36)}
                  </span>
                )
              })()}
            </span>
            {/* combat keyword badges along the bottom-left */}
            {badges.length > 0 && (
              <span className="absolute bottom-0 left-0 flex max-w-full flex-wrap gap-px p-px text-[7px] font-bold leading-none">
                {badges.map((b) => (
                  <span key={b.label} title={b.title} className={`rounded-sm px-0.5 ${b.cls}`}>
                    {b.label}
                  </span>
                ))}
              </span>
            )}
          </>
        )
      })()}
    </button>
  )
}
