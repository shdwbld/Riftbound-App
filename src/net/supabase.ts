import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Supabase client (optional). Configure via .env to enable true cross-device
// online play (Supabase Realtime broadcast — no database table required):
//
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=eyJ...
//
// When unset, the app falls back to same-device BroadcastChannel multiplayer.
// ---------------------------------------------------------------------------

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseEnabled = Boolean(url && anonKey)

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!supabaseEnabled)
    throw new Error('Supabase is not configured (set VITE_SUPABASE_* env vars).')
  if (!client) client = createClient(url!, anonKey!)
  return client
}
