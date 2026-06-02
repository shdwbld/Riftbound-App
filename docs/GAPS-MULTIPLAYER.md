# Multiplayer gaps

Gaps specific to online / multi-seat play (transport, sync, lobby, fairness).
The current model is **host-authoritative**: the host holds the canonical state,
applies all actions through the engine, and broadcasts state; guests send
actions and render received state. Transport is BroadcastChannel (same device)
or Supabase Realtime broadcast (cross-device). ✅ done · ◑ partial · ⏳ open.

## Connection & resilience
1. ⏳ **No reconnect / resync** — if a guest reloads or briefly drops, they lose
   the game; there's no "request current state" handshake to rejoin.
2. ⏳ **No host migration** — the host is a single point of failure. If the host
   leaves, the match ends for everyone.
3. ⏳ **Fire-and-forget delivery** — Realtime broadcast doesn't guarantee
   delivery or ordering; a dropped `state` message can desync a guest with no
   correction (we rebroadcast full state per action, which helps but isn't a
   guaranteed cure).
4. ⏳ **No persistence** — match state lives only in memory; a refresh on any
   client loses that client's view (host refresh ends the match).

## Fairness & integrity
5. ⏳ **Host doesn't verify the sender owns the seat** — the host applies any
   `action` it receives; a tampered client could submit actions for a seat it
   doesn't control. (The engine still checks turn/phase legality, but not seat
   ownership of the sender.) *Security gap.*
6. ⏳ **Hands aren't hidden at the data layer** — the full `MatchState`
   (including every player's hand) is broadcast to all clients; the UI hides
   opponents' hands, but the data is present client-side. A custom client could
   read opponents' cards.
7. ⏳ **No anti-stall / turn timer** — a player can sit on their turn forever.

## Lobby & seating
8. ⏳ **Late joiners are dropped** — once the host starts, a guest who joins
   after gets no seat (only flagged "room full" if they happened to be in the
   start broadcast).
9. ⏳ **Seating is join-order only** — no choosing seats, teams, or first player.
10. ⏳ **Room codes can collide** — 4-char codes are random with no registry, so
    two simultaneous rooms could clash (low odds, unhandled).
11. ⏳ **No room/lobby browser or matchmaking** — you must share a code
    out-of-band.

## Game modes
12. ⏳ **No 2v2 team mode** — only free-for-all; no shared team points or team
    win condition.
13. ◑ **Multiplayer combat is simplified** — mover vs. combined defenders, not
    true multi-party combat among 3+ contesting sides.
14. ⏳ **Multiplayer catch-up economy** — only the 1v1 second-player +1 channel
    exists; 3-4 player turn-1 economy is unconfirmed and unmodeled.

## Social / quality of life
15. ⏳ **No spectators**.
16. ⏳ **No chat / emotes**.
17. ⏳ **No reconnect grace UI** ("player disconnected, waiting…").
18. ⏳ **Same-device (BroadcastChannel) mode** only works across tabs of the same
    browser — not separate machines (that needs the Supabase path, now wired).

## Notes
- The biggest correctness risks are #1 (resync) and #3 (delivery) — they're what
  would cause real desyncs in the wild. The biggest fairness risks are #5 and #6.
- A natural hardening step: a lightweight `games` table in Supabase (persist the
  authoritative state + a seq), so clients can resync on reconnect and the host
  isn't the sole holder of truth.
