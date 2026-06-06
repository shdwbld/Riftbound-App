import { getCard } from '../data/cards'
import { toChampionKey } from './audio'
import type { PlayerState } from '../engine/types'

/** Champion base name from a full card name: strips the " - subtitle" and a
 *  trailing "(set)" → "Yasuo - The Unforgiven (OGN)" becomes "Yasuo". Shared by
 *  the audio cues, the playmat splash, and the end-of-match screen. */
export function champBase(name: string): string {
  return name.split(' - ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** Resolve a player's champion splash image from their Legend + chosen skin
 *  (playmatId). Returns null if they have no legend or the name can't resolve. */
export function matSplashUrl(p: PlayerState): string | null {
  if (!p.legend) return null
  const raw = getCard(p.legend.cardId)?.name
  if (!raw) return null
  const name = champBase(raw)
  if (!name) return null
  return `/img/champions/${toChampionKey(name)}/${p.playmatId || 'original'}.jpg`
}

/** A player's champion display name (base name of their Legend), or null. */
export function championName(p: PlayerState): string | null {
  if (!p.legend) return null
  const raw = getCard(p.legend.cardId)?.name
  return raw ? champBase(raw) : null
}
