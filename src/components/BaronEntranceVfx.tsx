import { useEffect } from 'react'

// Pixel-art entrance VFX for Baron Nashor / the Baron Pit. A chunky void-purple
// portal opens with glowing teal eyes and an acid-green pixel-font title rising,
// over a full-screen void flash. Stepped keyframes (index.css fx-baron-*) give the
// retro 8-bit feel. Purely cosmetic + pointer-events-none; auto-dismisses.
// Palette (Baron Nashor void serpent): deep void purple, violet, teal eyes, acid spit.
const VOID = '#1a0a2e' // void body shadow / pit floor
const VIOLET = '#7b35cc' // carapace highlight (exo-purple)
const TEAL = '#00e5ff' // glowing void eyes / energy
const ACID = '#a8ff00' // acid spit

export default function BaronEntranceVfx({
  token,
  label,
  onDone,
}: {
  /** Changes per trigger so the overlay remounts and replays. */
  token: number
  label: string
  onDone: () => void
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 1650)
    return () => clearTimeout(t)
  }, [token, onDone])

  return (
    <div key={token} className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" aria-hidden>
      {/* full-screen void flash */}
      <div
        className="fx-baron-flash absolute inset-0"
        style={{ background: `radial-gradient(circle at 50% 52%, ${VIOLET}, ${VOID} 55%, #000 100%)` }}
      />
      {/* chunky pixel portal (concentric bordered squares), centered */}
      <div className="fx-baron-portal absolute" style={{ left: '50%', top: '50%', width: 240, height: 240 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="absolute"
            style={{
              inset: i * 28,
              border: `12px solid ${i % 2 ? TEAL : VIOLET}`,
              boxShadow: `0 0 0 4px #000, 0 0 26px ${i % 2 ? TEAL : VIOLET}`,
            }}
          />
        ))}
        {/* glowing teal eyes */}
        <div className="fx-baron-eye absolute" style={{ left: 78, top: 104, width: 20, height: 20, background: TEAL, boxShadow: `0 0 14px ${TEAL}, 0 0 0 4px #000` }} />
        <div className="fx-baron-eye absolute" style={{ right: 78, top: 104, width: 20, height: 20, background: TEAL, boxShadow: `0 0 14px ${TEAL}, 0 0 0 4px #000` }} />
      </div>
      {/* pixel-font title rising */}
      <div
        className="fx-baron-rise absolute"
        style={{
          left: '50%',
          bottom: '20%',
          fontFamily: 'monospace',
          fontWeight: 900,
          letterSpacing: '0.28em',
          fontSize: 'clamp(20px, 5vw, 46px)',
          color: ACID,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          textShadow: `3px 3px 0 ${VOID}, 6px 6px 0 #000, 0 0 18px ${TEAL}`,
        }}
      >
        {label}
      </div>
    </div>
  )
}
