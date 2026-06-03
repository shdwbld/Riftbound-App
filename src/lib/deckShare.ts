import { getSupabase, supabaseEnabled } from '../net/supabase'
import { cloneIntoLibrary } from './deckStorage'
import type { Deck } from '../types/deck'

// Deck share-codes (no login): publish a deck to Supabase and get a short code;
// load it by code on any device. Requires Supabase configured + the
// `shared_decks` table (supabase/migrations/0001_shared_decks.sql). Falls back
// to "not available" when Supabase isn't set up.

export const deckShareEnabled = supabaseEnabled

// Unambiguous alphabet (no 0/O/1/I), matching the room-code generator.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function genCode(len = 6): string {
  let c = ''
  for (let i = 0; i < len; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return c
}

/** The portable deck shape stored under a share-code (matches cloneIntoLibrary). */
export interface SharePayload {
  name: string
  legendId: string | null
  championId: string | null
  main: Record<string, number>
  runes: Record<string, number>
  battlefields: string[]
  sideboard: Record<string, number>
}

export function toSharePayload(d: Deck): SharePayload {
  return {
    name: d.name,
    legendId: d.legendId,
    championId: d.championId ?? null,
    main: { ...d.main },
    runes: { ...d.runes },
    battlefields: [...d.battlefields],
    sideboard: { ...(d.sideboard ?? {}) },
  }
}

/** Publish a deck; returns a short share-code (retries on collision). */
export async function shareDeck(deck: Deck): Promise<string> {
  if (!supabaseEnabled) throw new Error('Online is not configured — sharing needs Supabase.')
  const sb = getSupabase()
  const data = toSharePayload(deck)
  for (let i = 0; i < 6; i++) {
    const code = genCode()
    const { error } = await sb.from('shared_decks').insert({ code, data })
    if (!error) return code
    // Retry only on a primary-key collision; surface anything else.
    if (!/duplicate|unique|conflict/i.test(error.message)) throw new Error(error.message)
  }
  throw new Error('Could not generate a unique code — please try again.')
}

/** Load a shared deck by code into the local library as a fresh, editable copy. */
export async function loadSharedDeck(code: string): Promise<Deck> {
  if (!supabaseEnabled) throw new Error('Online is not configured — loading needs Supabase.')
  const sb = getSupabase()
  const { data, error } = await sb
    .from('shared_decks')
    .select('data')
    .eq('code', code.trim().toUpperCase())
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('No deck found for that code.')
  const p = (data as { data: SharePayload }).data
  return cloneIntoLibrary({
    name: p.name,
    legendId: p.legendId,
    championId: p.championId,
    main: p.main,
    runes: p.runes,
    battlefields: p.battlefields,
    sideboard: p.sideboard,
  })
}
