import { useEffect, useState } from 'react'

// A brief (~1.5s) centered overlay that announces a combat moment: a chain link
// being added, whose react window it is, and the turn order — plus an
// "X played Y targeting Z" line. Driven by a `data.key` that changes per moment.

export interface BannerData {
  key: number
  title: string
  lines: string[]
  tone?: 'chain' | 'showdown' | 'react'
}

export default function CombatBanner({ data }: { data: BannerData | null }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!data) return
    setShow(true)
    const t = setTimeout(() => setShow(false), 1500)
    return () => clearTimeout(t)
  }, [data?.key, data])
  if (!data || !show) return null
  const tone =
    data.tone === 'react'
      ? 'border-amber-400/60 bg-amber-600/25 text-amber-50'
      : data.tone === 'showdown'
        ? 'border-amber-400/60 bg-amber-600/25 text-amber-50'
        : 'border-sky-400/60 bg-sky-600/25 text-sky-50'
  return (
    <div className="pointer-events-none fixed inset-x-0 top-24 z-[55] flex justify-center px-4">
      <div className={`fx-banner max-w-lg rounded-2xl border-2 px-6 py-3 text-center shadow-2xl backdrop-blur-sm ${tone}`}>
        <div className="text-base font-bold">{data.title}</div>
        {data.lines.map((l, i) => (
          <div key={i} className="mt-0.5 text-[11px] opacity-80">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}
