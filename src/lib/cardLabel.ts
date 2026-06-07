import { getCard } from '../data/cards'
import type { EngineCard } from '../engine/types'

const bare = (s?: string) => (s ?? '').replace(/\s*\([^)]*\)\s*$/, '')

/** "#N" suffix for a token instance (its stable per-owner ordinal), else ''.
 *  Lets identical-named tokens (Sand Soldiers) be told apart in pickers, targeting,
 *  damage assignment and equip prompts. */
export function tokenNoTag(ci: { tokenNo?: number } | null | undefined): string {
  return ci?.tokenNo ? ` #${ci.tokenNo}` : ''
}

/** Display label for a card instance: its bare name (no "(set)") + the token
 *  ordinal when it's a token. */
export function unitLabel(ci: EngineCard | null | undefined): string {
  if (!ci) return ''
  return bare(getCard(ci.cardId)?.name ?? ci.cardId) + tokenNoTag(ci)
}
