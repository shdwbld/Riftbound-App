import { getCard } from '../data/cards'
import type { MatchState, PlayerId } from '../engine/types'
import CardText from './CardText'
import CardPreview from './CardPreview'

/** Right-rail "last played" spotlight. While a chain is live it shows the chain as
 *  a LIFO stack (the newest reaction big on top, the cards it responds to listed
 *  beneath); otherwise it persists the most recently played card. Big art + full
 *  rules so players can read what just happened. */
export default function PlayedCardSpotlight({
  match,
  lastPlayed,
}: {
  match: MatchState
  perspective: PlayerId
  lastPlayed: { cardId: string; player: PlayerId } | null
}) {
  const stack: { cardId: string; player: PlayerId; kind: 'spell' | 'counter' }[] = match.chain.length
    ? [...match.chain].reverse().map((it) => ({ cardId: it.cardId, player: it.controller, kind: it.kind }))
    : lastPlayed
      ? [{ cardId: lastPlayed.cardId, player: lastPlayed.player, kind: 'spell' }]
      : []
  const top = stack[0]
  const card = top ? getCard(top.cardId) : null
  const bare = (n?: string) => (n ? n.replace(/\s*\([^)]*\)\s*$/, '') : '')

  return (
    <div className="rounded-xl border border-white/10 bg-[#15151f] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-white/40">
        {match.chain.length ? `⛓ Chain (${match.chain.length})` : 'Last played'}
      </div>
      {!card || !top ? (
        <div className="flex h-40 items-center justify-center text-center text-sm text-white/25">Nothing played yet</div>
      ) : (
        <div className="space-y-2">
          {/* The big top card — art + full rules. Hover the art to zoom (no click). */}
          <div className="flex gap-3">
            <CardPreview cardId={top.cardId} delay={80}>
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt={card.name}
                  className="w-24 shrink-0 cursor-zoom-in rounded-lg object-cover shadow-lg"
                  style={{ aspectRatio: '744/1039' }}
                />
              ) : (
                <div
                  className="flex w-24 shrink-0 items-center justify-center rounded-lg bg-[#1c1c28] p-1 text-center text-[10px]"
                  style={{ aspectRatio: '744/1039' }}
                >
                  {card.name}
                </div>
              )}
            </CardPreview>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold leading-tight">{bare(card.name)}</div>
              <div className="text-[11px] text-white/40">
                {top.kind === 'counter' ? '✗ Counter · ' : ''}
                {match.players[top.player]?.name}
              </div>
              {card.text && (
                <div className="mt-1 text-[11px] leading-snug text-white/70">
                  <CardText text={card.text} />
                </div>
              )}
            </div>
          </div>

          {/* The cards beneath (what the top card is responding to) */}
          {stack.length > 1 && (
            <div className="space-y-1 border-t border-white/10 pt-2">
              {stack.slice(1).map((s, i) => {
                const c = getCard(s.cardId)
                return (
                  <CardPreview key={i} cardId={s.cardId} delay={80}>
                    <div className="flex cursor-zoom-in items-center gap-2 text-[11px] text-white/55">
                      {c?.imageUrl && (
                        <img src={c.imageUrl} alt="" className="h-8 w-[23px] shrink-0 rounded object-cover" style={{ aspectRatio: '744/1039' }} />
                      )}
                      <span className="truncate">
                        {s.kind === 'counter' ? '✗ ' : ''}
                        {bare(c?.name) || s.cardId}
                      </span>
                      <span className="shrink-0 text-white/30">· {match.players[s.player]?.name}</span>
                    </div>
                  </CardPreview>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
