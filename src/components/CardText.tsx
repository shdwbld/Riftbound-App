import { DOMAIN_META, type Domain } from '../types/cards'
import { keywordDef } from '../engine/keywords'

// Renders Riftbound card text, replacing :rb_*: shorthand tokens with inline
// icons. Tokens in the data: rb_might, rb_energy_N (0-7), rb_exhaust,
// rb_rune_<domain> (fury/calm/mind/body/chaos/order), rb_rune_rainbow.
//
// If a real icon file exists in src/assets/icons/ (see that folder's README), we
// render it; otherwise we fall back to a built-in CSS glyph. So the app works
// with zero, some, or all real icons present.

// Icon registry: every image in src/assets/icons/ AND the project-root icons/
// folder, keyed by base filename.
const ICON_MODULES = import.meta.glob(
  ['../assets/icons/*.{svg,png,webp}', '../../icons/*.{svg,png,webp}'],
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>
const ICONS: Record<string, string> = {}
for (const [path, url] of Object.entries(ICON_MODULES)) {
  const name = path.split('/').pop()!.replace(/\.(svg|png|webp)$/i, '').toLowerCase()
  ICONS[name] = url
}

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

/** The icon-registry key + tooltip for a token, or null if it has no image
 *  form (energy is a dynamic number, kept as CSS). */
function iconFor(token: string): { key: string; title: string } | null {
  if (token === 'rb_might') return { key: 'might', title: 'Might' }
  if (token === 'rb_exhaust') return { key: 'exhaust', title: 'Exhaust' }
  if (token === 'rb_recycle') return { key: 'recycle', title: 'Recycle' }
  if (token === 'rb_rune_rainbow') return { key: 'rune-wild', title: 'Power of any domain' }
  const r = token.match(/^rb_rune_(\w+)$/)
  if (r && RUNE_DOMAIN[r[1]]) return { key: `rune-${r[1]}`, title: `${DOMAIN_META[RUNE_DOMAIN[r[1]]].label} Power` }
  return null
}

/** Public: the rune-Power icon URL for a domain (e.g. 'calm' → calm.webp),
 *  or undefined if that icon isn't in the registry. */
export function domainIconUrl(domain: string): string | undefined {
  return resolveIconUrl(`rune-${domain}`)
}

/** Inline domain icon: the real webp rune art, with the emoji glyph as a
 *  fallback if no image is registered. Used project-wide for domain chips. */
export function DomainIcon({
  domain,
  size = 14,
  className,
}: {
  domain: string
  size?: number
  className?: string
}) {
  const url = domainIconUrl(domain)
  if (url)
    return (
      <img
        src={url}
        alt=""
        className={`inline-block align-middle ${className ?? ''}`}
        style={{ width: size, height: size }}
      />
    )
  const meta = DOMAIN_META[domain as Domain]
  return <span className={className}>{meta?.glyph ?? '◆'}</span>
}

function resolveIconUrl(key: string): string | undefined {
  if (ICONS[key]) return ICONS[key]
  // Accept bare names too: "fury.webp" for rune-fury, "rainbow"/"wild" for wild.
  if (key.startsWith('rune-')) {
    const bare = key.slice(5)
    if (ICONS[bare]) return ICONS[bare]
  }
  if (key === 'rune-wild') return ICONS['rune-rainbow'] ?? ICONS['rainbow'] ?? ICONS['wild']
  return undefined
}

function TokenIcon({ token }: { token: string }) {
  // Prefer a real icon image when one is present in src/assets/icons/.
  const icon = iconFor(token)
  if (icon) {
    const url = resolveIconUrl(icon.key)
    if (url)
      return (
        <img
          src={url}
          alt={icon.title}
          title={icon.title}
          className="mx-px inline-block h-4 w-4 align-middle"
        />
      )
  }

  // --- CSS glyph fallbacks --------------------------------------------------
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
  if (token === 'rb_recycle')
    return (
      <span className={`${circle} bg-white/15 text-white/80`} title="Recycle">
        ♺
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

/** A recognized [Keyword] / [Keyword N] printed the way the card shows it:
 *  white text on a blue chip, with the rules definition as a tooltip. */
function KeywordChip({ label, def }: { label: string; def: string }) {
  return (
    <span
      title={def}
      className="mx-px inline-flex items-center rounded bg-sky-600/90 px-1 align-baseline text-[0.95em] font-semibold leading-tight text-white shadow-sm"
    >
      {label}
    </span>
  )
}

// Split on both :rb_*: symbol tokens and [Keyword]/[Keyword N] tokens.
const TOKEN_RE = /(:rb_[a-z0-9_]+:|\[[A-Za-z][A-Za-z'-]*(?:\s*(?:\d+|X))?\])/g

export default function CardText({
  text,
  className,
}: {
  text?: string | null
  className?: string
}) {
  if (!text) return null
  const parts = text.split(TOKEN_RE)
  return (
    <span className={className}>
      {parts.map((part, i) => {
        const sym = part.match(/^:(rb_[a-z0-9_]+):$/)
        if (sym) return <TokenIcon key={i} token={sym[1]} />
        const kw = part.match(/^\[([A-Za-z][A-Za-z'-]*(?:\s*(?:\d+|X))?)\]$/)
        if (kw) {
          const label = kw[1].trim()
          const def = keywordDef(label)
          if (def) return <KeywordChip key={i} label={label} def={def} />
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}
