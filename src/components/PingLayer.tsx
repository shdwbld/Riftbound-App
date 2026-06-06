import { useEffect } from 'react'
import { audio } from '../lib/audio'

// Ephemeral "ping" markers (Alt+click). Each ping shows the icon at a viewport-
// relative point (x/y are fractions [0,1]) with a pop + 2s fade to 0% opacity,
// and plays the ping SFX once when it appears — for whoever renders it (the
// pinger and every other player who received the broadcast). pointer-events-none
// so it never blocks the board.

export type PingData = { id: number; x: number; y: number; name?: string }

function Ping({ x, y, name }: { x: number; y: number; name?: string }) {
  useEffect(() => {
    audio.play('ping')
  }, [])
  return (
    <div
      className="ping-pop pointer-events-none fixed z-[70] flex flex-col items-center"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, transform: 'translate(-50%, -50%)' }}
    >
      <img
        src="/ping.png"
        alt="ping"
        className="w-auto drop-shadow-[0_0_10px_rgba(255,210,120,0.85)]"
        style={{ height: 84 }}
      />
      {name && (
        <div className="mt-0.5 rounded bg-black/60 px-1.5 text-xs font-bold text-amber-200 drop-shadow">{name}</div>
      )}
    </div>
  )
}

export default function PingLayer({ pings }: { pings: PingData[] }) {
  return (
    <>
      {pings.map((p) => (
        <Ping key={p.id} x={p.x} y={p.y} name={p.name} />
      ))}
    </>
  )
}
