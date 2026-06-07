import type { TeamLobbyEntry } from '../net/transport'

// 2v2 team-selection lobby. Players pick Left or Right; the roster updates in
// real time (host re-broadcasts on every change). Everyone clicks Confirm; the
// host starts the match once both teams have exactly 2 confirmed players.

const TEAM_META = [
  { id: 0 as const, label: 'Left Team', accent: 'sky', ring: 'border-sky-400/50', bg: 'bg-sky-500/10', chip: 'bg-sky-500/25 text-sky-100' },
  { id: 1 as const, label: 'Right Team', accent: 'rose', ring: 'border-rose-400/50', bg: 'bg-rose-500/10', chip: 'bg-rose-500/25 text-rose-100' },
]

export default function TeamSelectLobby({ roster, myClientId, roomCode, onPick, onConfirm, onLeave }: {
  roster: TeamLobbyEntry[]
  myClientId: string
  roomCode: string
  onPick: (team: 0 | 1) => void
  onConfirm: (confirmed: boolean) => void
  onLeave: () => void
}) {
  const me = roster.find((r) => r.clientId === myClientId)
  const confirmedCount = roster.filter((r) => r.confirmed).length
  const balanced = [0, 1].every((t) => roster.filter((r) => r.team === t).length === 2)
  const allReady = roster.length === 4 && confirmedCount === 4 && balanced

  const Column = ({ team }: { team: 0 | 1 }) => {
    const meta = TEAM_META[team]
    const members = roster.filter((r) => r.team === team)
    const full = members.length >= 2 && !members.some((m) => m.clientId === myClientId)
    const onThisTeam = me?.team === team
    return (
      <div className={`flex flex-1 flex-col rounded-2xl border ${meta.ring} ${meta.bg} p-4`}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold">{meta.label}</h3>
          <span className="text-xs text-white/40">{members.length}/2</span>
        </div>
        <div className="flex flex-col gap-2">
          {members.map((m) => (
            <div key={m.clientId} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${meta.chip}`}>
              <span className="truncate font-semibold">
                {m.name}
                {m.clientId === myClientId && <span className="ml-1 text-[10px] opacity-70">(you)</span>}
              </span>
              <span className="shrink-0 text-xs">{m.confirmed ? '✓ ready' : '…'}</span>
            </div>
          ))}
          {Array.from({ length: Math.max(0, 2 - members.length) }).map((_, i) => (
            <div key={`empty-${i}`} className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-center text-xs text-white/30">empty seat</div>
          ))}
        </div>
        <button
          onClick={() => onPick(team)}
          disabled={onThisTeam || full}
          className={`mt-3 rounded-lg px-3 py-2 text-sm font-semibold transition ${
            onThisTeam ? 'bg-white/10 text-white/40' : full ? 'cursor-not-allowed bg-white/5 text-white/25' : 'bg-white/15 hover:bg-white/25'
          }`}
        >
          {onThisTeam ? 'You are here' : full ? 'Team full' : `Join ${meta.label}`}
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Choose your team</h2>
          <p className="mt-1 text-sm text-white/50">Pick a side, then Confirm. The match starts when all four players are ready (2 v 2).</p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-white/40">Room</div>
          <div className="font-mono text-xl tracking-widest">{roomCode}</div>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <Column team={0} />
        <Column team={1} />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0a1428] p-4">
        <span className="text-sm text-white/55">
          {allReady ? 'All ready — starting…' : `${confirmedCount}/4 confirmed${!balanced ? ' · teams must be 2 v 2' : ''}`}
        </span>
        <div className="flex gap-2">
          <button onClick={onLeave} className="rounded-lg px-3 py-2 text-sm text-white/50 hover:bg-white/5">Leave</button>
          <button
            onClick={() => onConfirm(!me?.confirmed)}
            disabled={!me?.team}
            className={`rounded-lg px-5 py-2 text-sm font-bold transition ${
              !me?.team ? 'cursor-not-allowed bg-white/5 text-white/25' : me?.confirmed ? 'bg-amber-500/30 text-amber-100 hover:bg-amber-500/50' : 'bg-emerald-500/30 text-emerald-100 hover:bg-emerald-500/50'
            }`}
          >
            {me?.confirmed ? 'Unconfirm' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
