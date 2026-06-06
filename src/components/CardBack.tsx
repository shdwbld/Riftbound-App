// A CSS card back evoking the official Riftbound back (dark with a gold rift
// emblem). Used for face-down cards, deck piles, and rune decks — no external
// asset needed.

export default function CardBack({
  size = 'md',
  count,
  label,
}: {
  size?: 'sm' | 'md'
  count?: number
  label?: string
}) {
  // Size from the single --card-h token (matches BoardCard).
  const cardStyle =
    size === 'sm'
      ? { width: 'var(--card-w-sm)', height: 'var(--card-h-sm)' }
      : { width: 'var(--card-w)', height: 'var(--card-h)' }
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-amber-500/30 shadow-inner"
      style={cardStyle}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-[#1a1206] via-[#0c0a14] to-[#05060c]" />
      {/* radial rift glow */}
      <div
        className="absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(circle at 50% 45%, rgba(212,175,55,0.28), transparent 60%)',
        }}
      />
      {/* emblem */}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg text-amber-400/80 drop-shadow-[0_0_6px_rgba(212,175,55,0.6)]">
          ❖
        </span>
      </div>
      {/* corner frame */}
      <div className="absolute inset-1 rounded border border-amber-500/15" />
      {count != null && (
        <div className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[10px] font-semibold text-amber-200/90">
          {count}
          {label ? ` ${label}` : ''}
        </div>
      )}
    </div>
  )
}
