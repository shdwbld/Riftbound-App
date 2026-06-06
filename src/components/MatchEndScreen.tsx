import type { MatchState, PlayerId } from '../engine/types'
import { matSplashUrl, championName } from '../lib/championArt'

const bare = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '')

/** Full-screen end-of-match takeover: the winner's champion splash, the result,
 *  final scores for every seat, and the caller's action buttons. Shared by the
 *  hotseat (MatchPage) and online (OnlinePage) game-over states. When a
 *  `perspective` seat is given (online), the headline reads Victory / Defeat from
 *  that seat's point of view; without it (hotseat) it announces the winner. */
export default function MatchEndScreen({
  match,
  perspective,
  actions,
}: {
  match: MatchState
  perspective?: PlayerId
  actions: { label: string; onClick: () => void; variant?: 'primary' }[]
}) {
  const w = match.winner!
  const winner = match.players[w]
  const splash = matSplashUrl(winner)
  const champ = championName(winner)
  const won = perspective != null ? perspective === w : true
  const headline = perspective != null ? (won ? 'Victory' : 'Defeat') : `${bare(winner.name)} wins`
  const ranked = [...match.players].sort((a, b) => b.points - a.points)

  return (
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center overflow-hidden">
      {/* Champion splash backdrop (falls back to the navy scrim alone). */}
      {splash && (
        <img
          src={splash}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition: 'center 22%' }}
          onError={(e) => ((e.currentTarget.style.display = 'none'))}
        />
      )}
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(circle at 50% 35%, rgba(8,16,32,0.55), rgba(6,12,24,0.92) 70%)' }}
      />

      <div className="relative flex flex-col items-center gap-6 px-6 text-center">
        <div className={`text-sm font-semibold uppercase tracking-[0.4em] ${won ? 'text-amber-300/90' : 'text-rose-300/80'}`}>
          {perspective != null ? (won ? '🏆 Match won' : 'Match over') : '🏆 Match over'}
        </div>
        <h1
          className={`text-6xl font-black tracking-wide drop-shadow-[0_2px_18px_rgba(0,0,0,0.8)] sm:text-7xl ${
            won ? 'bg-gradient-to-b from-amber-200 to-amber-400 bg-clip-text text-transparent' : 'text-rose-200'
          }`}
        >
          {headline}
        </h1>
        {champ && (
          <div className="text-lg text-white/70">
            {bare(winner.name)} · <span className="text-amber-200/90">{champ}</span>
          </div>
        )}

        {/* Final standings */}
        <div className="mt-2 w-full max-w-sm space-y-1.5">
          {ranked.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center justify-between rounded-lg px-4 py-2 text-sm ${
                p.id === w ? 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/40' : 'bg-white/5 text-white/70'
              }`}
            >
              <span className="flex items-center gap-2 font-semibold">
                <span className="w-5 text-white/40">{i + 1}.</span>
                {bare(p.name)}
                {p.id === w && <span>👑</span>}
                {p.out && <span className="text-[10px] uppercase tracking-wide text-rose-300/70">out</span>}
              </span>
              <span className="font-mono text-base">
                {p.points}
                <span className="text-white/40"> / {match.pointsToWin}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
          {actions.map((a) => (
            <button
              key={a.label}
              onClick={a.onClick}
              className={`rounded-xl px-6 py-3 text-base font-bold shadow-lg transition ${
                a.variant === 'primary'
                  ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-black hover:from-amber-300 hover:to-amber-400'
                  : 'border border-white/20 bg-white/5 text-white/80 hover:bg-white/10'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
