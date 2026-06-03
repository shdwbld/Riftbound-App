import type { MatchState } from '../engine/types'

// Persist enough of an online session to sessionStorage that a player who
// refreshes (or briefly drops) can rejoin the SAME match instead of losing it.
// sessionStorage (not localStorage) so it's scoped to the tab and clears when
// the tab is closed for good.

const SESSION_KEY = 'riftbound.online.session.v1'
const HOST_STATE_KEY = 'riftbound.online.hoststate.v1'

export interface OnlineSession {
  roomCode: string
  role: 'host' | 'guest'
  seat: number
  clientId: string
  count: number
}

export function saveSession(s: OnlineSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function loadSession(): OnlineSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as OnlineSession) : null
  } catch {
    return null
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(HOST_STATE_KEY)
  } catch {
    /* non-fatal */
  }
}

/** The host persists its canonical state + seat map so a host refresh can
 *  resume authority and re-broadcast to connected guests. */
export interface HostSnapshot {
  state: MatchState
  seats: Record<string, number>
}

export function saveHostState(snap: HostSnapshot): void {
  try {
    sessionStorage.setItem(HOST_STATE_KEY, JSON.stringify(snap))
  } catch {
    /* non-fatal */
  }
}

export function loadHostState(): HostSnapshot | null {
  try {
    const raw = sessionStorage.getItem(HOST_STATE_KEY)
    return raw ? (JSON.parse(raw) as HostSnapshot) : null
  } catch {
    return null
  }
}
