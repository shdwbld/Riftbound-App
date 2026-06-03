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
  | { kind: 'leave' }

export interface Transport {
  send(msg: NetMessage): void
  onMessage(cb: (msg: NetMessage) => void): () => void
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
  // Broadcasts sent before the channel reaches SUBSCRIBED are dropped by
  // Realtime, so we queue them and flush once the subscription is live. This is
  // what makes the join handshake reliable cross-device.
  private ready = false
  private queue: NetMessage[] = []

  constructor(roomCode: string) {
    const supabase = getSupabase()
    this.channel = supabase.channel(`riftbound:room:${roomCode}`, {
      config: { broadcast: { self: false } },
    })
    this.channel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on('broadcast', { event: 'msg' }, ({ payload }: any) => {
        for (const l of this.listeners) l(payload as NetMessage)
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          this.ready = true
          const pending = this.queue
          this.queue = []
          for (const m of pending) this.raw(m)
        }
      })
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
  close() {
    this.send({ kind: 'leave' })
    getSupabase().removeChannel(this.channel)
    this.listeners.clear()
  }
}

// --- factory ---------------------------------------------------------------

export const onlineAvailable = supabaseEnabled

export function createTransport(roomCode: string): Transport {
  return supabaseEnabled
    ? new SupabaseTransport(roomCode)
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
