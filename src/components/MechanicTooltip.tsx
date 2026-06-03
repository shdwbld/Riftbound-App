import { useState, type ReactNode } from 'react'
import { KEYWORD_DEFS } from '../engine/keywords'

// A small hover/tap overlay that explains a game mechanic in plain rules text.
// Reuses the keyword definitions and adds non-keyword mechanics (Gold, tokens,
// resources, XP, statuses) so any indicator on the board can carry a "what does
// this do?" explanation.

export const MECHANIC_DEFS: Record<string, { title: string; text: string }> = {
  gold: {
    title: 'Gold (gear token)',
    text: 'A Gold gear token. Sacrifice it — kill it and exhaust it — at Reaction speed to add 1 Power of any domain to your pool. Right-click it to cash in.',
  },
  token: {
    title: 'Token',
    text: 'A unit created by an effect (e.g. Recruit). Tokens cease to exist when they leave play — they never go to the Trash.',
  },
  recruit: {
    title: 'Recruit token',
    text: 'A 1-Might token unit generated onto your Base by Recruit effects. A token — it vanishes when it leaves play.',
  },
  energy: {
    title: 'Energy',
    text: 'Generic resource. Exhaust a ready rune to add 1 Energy. Pool Energy is spent before runes and empties at end of turn.',
  },
  power: {
    title: 'Power',
    text: 'Colored resource. Recycle a rune (put it on the bottom of your rune deck) to add 1 Power of its domain. One rune can be exhausted for Energy and also recycled for Power.',
  },
  rune: {
    title: 'Rune',
    text: 'Your resource cards. Channel one each turn. Exhaust for 1 Energy or recycle for 1 Power of its domain.',
  },
  xp: {
    title: 'Experience (XP)',
    text: 'Earned via Hunt when you conquer or hold. Fuels Level abilities, which switch on once you have enough XP.',
  },
  might: {
    title: 'Might',
    text: 'A unit’s combat strength. The side with more total Might in a showdown wins. Shown as base + bonuses − damage.',
  },
  mighty: {
    title: 'Mighty',
    text: 'A unit with 5 or more Might. Some effects care whether a unit is Mighty.',
  },
  stun: {
    title: 'Stunned',
    text: 'Deals no combat damage this turn. It keeps its Might to survive, but contributes 0 while stunned.',
  },
  damage: {
    title: 'Damage',
    text: 'Marked on a unit; it reduces effective Might. A unit is defeated when marked damage meets or exceeds its Might.',
  },
  summoning: {
    title: 'Can’t act yet',
    text: 'A unit entered play this turn and is exhausted, so it can’t move/attack until it readies next Awaken — unless it has Accelerate.',
  },
}

/** Resolve a mechanic definition by key (keyword or mechanic), case-insensitive,
 *  tolerating a trailing number like "Shield 2". */
export function mechanicDef(key: string): { title: string; text: string } | undefined {
  const base = key.toLowerCase().replace(/\s*\d+$/, '')
  if (MECHANIC_DEFS[base]) return MECHANIC_DEFS[base]
  const kw = KEYWORD_DEFS[base] ?? KEYWORD_DEFS[base.replace(/\s+/g, '-')]
  if (kw) return { title: key, text: kw }
  return undefined
}

/** Wrap any node in a hover/focus tooltip explaining a mechanic. */
export default function MechanicTooltip({
  mechanic,
  title,
  text,
  children,
}: {
  /** Key into MECHANIC_DEFS / KEYWORD_DEFS (e.g. 'gold', 'Shield 2'). */
  mechanic?: string
  /** Or supply an explicit title/text. */
  title?: string
  text?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const def = mechanic ? mechanicDef(mechanic) : undefined
  const t = title ?? def?.title ?? mechanic ?? ''
  const body = text ?? def?.text ?? ''
  if (!body) return <>{children}</>
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      {children}
      {open && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-48 -translate-x-1/2 rounded-lg border border-white/15 bg-[#0c0c14] p-2 text-left text-[11px] leading-snug text-white/85 shadow-xl">
          <span className="mb-0.5 block font-bold text-white">{t}</span>
          {body}
        </span>
      )}
    </span>
  )
}
