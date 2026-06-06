// Card-back art. Uses the official-style back images: the generic card back, and
// a dedicated rune-card back (rune decks only). Used for face-down cards, deck
// piles, and rune decks. Sized from the shared --card token (matches BoardCard).

export default function CardBack({
  size = 'md',
  count,
  label,
  rune = false,
}: {
  size?: 'sm' | 'md'
  count?: number
  label?: string
  /** Use the rune-card back (rune decks only). */
  rune?: boolean
}) {
  const cardStyle =
    size === 'sm'
      ? { width: 'var(--card-w-sm)', height: 'var(--card-h-sm)' }
      : { width: 'var(--card-w)', height: 'var(--card-h)' }
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-amber-500/30 shadow-inner"
      style={cardStyle}
    >
      <img
        src={rune ? '/rune-back.jpg' : '/card-back.png'}
        alt={rune ? 'Rune card back' : 'Card back'}
        loading="lazy"
        className="h-full w-full object-cover"
      />
      {count != null && (
        <div className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[10px] font-semibold text-amber-200/90">
          {count}
          {label ? ` ${label}` : ''}
        </div>
      )}
    </div>
  )
}
