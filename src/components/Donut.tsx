// A small CSS-only donut chart (conic-gradient ring) with a legend. Pure
// presentation — pass pre-computed segments.

export interface DonutSegment {
  label: string
  value: number
  color: string
}

export default function Donut({
  segments,
  size = 88,
  thickness = 14,
}: {
  segments: DonutSegment[]
  size?: number
  thickness?: number
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  // Build conic-gradient stops.
  let acc = 0
  const stops: string[] = []
  for (const s of segments) {
    if (s.value <= 0) continue
    const start = (acc / total) * 360
    acc += s.value
    const end = (acc / total) * 360
    stops.push(`${s.color} ${start}deg ${end}deg`)
  }
  const gradient = total > 0 ? `conic-gradient(${stops.join(', ')})` : 'conic-gradient(#2a2a38 0deg 360deg)'

  return (
    <div className="flex items-center gap-3">
      <div
        className="relative shrink-0 rounded-full"
        style={{ width: size, height: size, background: gradient }}
      >
        <div
          className="absolute rounded-full bg-[#15151f]"
          style={{ inset: thickness }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white/70">
          {total}
        </div>
      </div>
      <ul className="space-y-0.5 text-[11px]">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="capitalize text-white/70">{s.label}</span>
              <span className="text-white/40">
                {s.value} · {total ? Math.round((s.value / total) * 100) : 0}%
              </span>
            </li>
          ))}
      </ul>
    </div>
  )
}
