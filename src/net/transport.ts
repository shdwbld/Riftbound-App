import type { Deck } from '../types/deck'
import type { MatchState, Action, GameEvent } from '../engine/types'

// ---------------------------------------------------------------------------
// Netcode transport. Host-authoritative: the host holds the canonical
// MatchState, applies all actions through the engine, and broadcasts state.
// Two transports share one interface:
//   - BroadcastChannel: two tabs on the same machine (zero setup)
//   - Supabase Realtime: true cross-device (when env keys are configured)
// ---------------------------------------------------------------------------

export type NetMessage =
  | { kind: 'join'; name: string; deck: Deck; clientId: string }
  | { kind: 'lobby'; joined: number; needed: number }
  | { kind: 'start'; state: MatchState; seats: Record<string, number> }
  | { kind: 'state'; state: MatchState; events?: GameEvent[] }
  | { kind: 'action'; action: Action }
  /** A reconnecting guest asks the host to re-send start + current state. */
  | { kind: 'resync'; clientId: string }
  /** A guest asks the host to undo the last action (manual fail-safe). */
  | { kind: 'undo' }
  | { kind: 'leave' }

export interface Transport {
  send(msg: NetMessage): void
  onMessage(cb: (msg: NetMessage) => void): () => void
  /** Subscribe to the set of present peer clientIds (Realtime presence). The
   *  same-device BroadcastChannel transport has no presence and never fires. */
  onPresence(cb: (clientIds: string[]) => void): () => void
  close(): void
}

// --- BroadcastChannel (same-device, no backend) ----------------------------

class BroadcastTransport implements Transport {
  private ch: BroadcastChannel
  private listeners = new Set<(m: NetMessage) => void>()

  constructor(roomCode: string) {
    this.ch = new BroadcastChannel(`riftbound:room:${roomCode}`)
    this.ch.onmessage = (e) => {
      for (const l of this.listeners) l(e.data as NetMessage)
    }
  }
  send(msg: NetMessage) {
    this.ch.postMessage(msg)
  }
  onMessage(cb: (m: NetMessage) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  onPresence(_cb: (ids: string[]) => void) {
    return () => {} // same-device: no presence
  }
  close() {
    this.send({ kind: 'leave' })
    this.ch.close()
    this.listeners.clear()
  }
}

// --- Supabase Realtime (cross-device) --------------------------------------

import { supabaseEnabled, getSupabase } from './supabase'

class SupabaseTransport implements Transport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private channel: any
  private listeners = new Set<(m: NetMessage) => void>()
  private presenceListeners = new Set<(ids: string[]) => void>()
  // Broadcasts sent before the channel reaches SUBSCRIBED are dropped by
  // Realtime, so we queue them and flush once the subscription is live. This is
  // what makes the join handshake reliable cross-device.
  private ready = false
  private queue: NetMessage[] = []

  constructor(roomCode: string, clientId: string) {
    const supabase = getSupabase()
    this.channel = supabase.channel(`riftbound:room:${roomCode}`, {
      // presence key = clientId so presenceState() is keyed by peer.
      config: { broadcast: { self: false }, presence: { key: clientId } },
    })
    this.channel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on('broadcast', { event: 'msg' }, ({ payload }: any) => {
        for (const l of this.listeners) l(payload as NetMessage)
      })
      .on('presence', { event: 'sync' }, () => this.emitPresence())
      .on('presence', { event: 'join' }, () => this.emitPresence())
      .on('presence', { event: 'leave' }, () => this.emitPresence())
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          this.ready = true
          const pending = this.queue
          this.queue = []
          for (const m of pending) this.raw(m)
          // Announce our presence so peers can detect us join/leave.
          this.channel.track({ clientId })
        }
      })
  }
  private emitPresence() {
    const state = (this.channel.presenceState?.() ?? {}) as Record<string, unknown>
    const ids = Object.keys(state)
    for (const cb of this.presenceListeners) cb(ids)
  }
  private raw(msg: NetMessage) {
    this.channel.send({ type: 'broadcast', event: 'msg', payload: msg })
  }
  send(msg: NetMessage) {
    if (this.ready) this.raw(msg)
    else this.queue.push(msg) // flushed in order on SUBSCRIBED
  }
  onMessage(cb: (m: NetMessage) => void) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  onPresence(cb: (ids: string[]) => void) {
    this.presenceListeners.add(cb)
    return () => this.presenceListeners.delete(cb)
  }
  close() {
    this.send({ kind: 'leave' })
    getSupabase().removeChannel(this.channel)
    this.listeners.clear()
    this.presenceListeners.clear()
  }
}

// --- factory ---------------------------------------------------------------

export const onlineAvailable = supabaseEnabled

export function createTransport(roomCode: string, clientId: string): Transport {
  return supabaseEnabled
    ? new SupabaseTransport(roomCode, clientId)
    : new BroadcastTransport(roomCode)
}

/** Human-friendly 4-char room code. Caller supplies randomness (no Date/Math
 *  restrictions in the browser app). */
export function makeRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 4; i++)
    code += chars[Math.floor(Math.random() * chars.length)]
  return code
}
