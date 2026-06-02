import { DOMAIN_META, type Domain } from '../types/cards'

// Renders Riftbound card text, replacing :rb_*: shorthand tokens with inline
// icons. Tokens in the data: rb_might, rb_energy_N (0-7), rb_exhaust,
// rb_rune_<domain> (fury/calm/mind/body/chaos/order), rb_rune_rainbow.

const RUNE_DOMAIN: Record<string, Domain> = {
  fury: 'fury',
  calm: 'calm',
  mind: 'mind',
  body: 'body',
  chaos: 'chaos',
  order: 'order',
}

const pill =
  'mx-px inline-flex h-4 min-w-4 items-center justify-center rounded px-1 align-middle text-[10px] font-bold leading-none'
const circle =
  'mx-px inline-flex h-4 w-4 items-center justify-center rounded-full align-middle text-[9px] font-bold leading-none'

function TokenIcon({ token }: { token: string }) {
  if (token === 'rb_might')
    return (
      <span className={`${pill} bg-rose-500/30 text-rose-200`} title="Might">
        ⚔
      </span>
    )
  if (token === 'rb_exhaust')
    return (
      <span className={`${circle} bg-white/15 text-white/80`} title="Exhaust">
        ⟳
      </span>
    )
  const energy = token.match(/^rb_energy_(\d+)$/)
  if (energy)
    return (
      <span className={`${circle} bg-amber-400/30 text-amber-200`} title={`${energy[1]} Energy`}>
        {energy[1]}
      </span>
    )
  if (token === 'rb_rune_rainbow')
    return (
      <span
        className={`${circle} text-black`}
        title="Power of any domain"
        style={{
          background:
            'conic-gradient(#e2433b,#e08a36,#d8c23f,#3fae6e,#3f87d6,#9a55d4,#e2433b)',
        }}
      >
        ◆
      </span>
    )
  const rune = token.match(/^rb_rune_(\w+)$/)
  if (rune && RUNE_DOMAIN[rune[1]]) {
    const d = RUNE_DOMAIN[rune[1]]
    const meta = DOMAIN_META[d]
    return (
      <span
        className={circle}
        title={`${meta.label} Power`}
        style={{ background: `${meta.color}33`, color: meta.color, border: `1px solid ${meta.color}` }}
      >
        {meta.glyph}
      </span>
    )
  }
  return <span className="text-white/40">:{token}:</span>
}

export default function CardText({
  text,
  className,
}: {
  text?: string | null
  className?: string
}) {
  if (!text) return null
  const parts = text.split(/(:rb_[a-z0-9_]+:)/g)
  return (
    <span className={className}>
      {parts.map((part, i) => {
        const m = part.match(/^:(rb_[a-z0-9_]+):$/)
        return m ? <TokenIcon key={i} token={m[1]} /> : <span key={i}>{part}</span>
      })}
    </span>
  )
}
