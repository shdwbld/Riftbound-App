-- Deck share-codes: publish a deck and get a short code; load it on any device.
-- No accounts/login — decks aren't secret, so anon may insert + select. Apply
-- this in your Supabase project (SQL editor) or via the Supabase CLI/MCP.

create table if not exists public.shared_decks (
  code        text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.shared_decks enable row level security;

-- Anyone may publish a deck (insert) and load one by code (select).
drop policy if exists "anon insert shared decks" on public.shared_decks;
create policy "anon insert shared decks"
  on public.shared_decks for insert to anon, authenticated
  with check (char_length(code) between 4 and 12);

drop policy if exists "anon select shared decks" on public.shared_decks;
create policy "anon select shared decks"
  on public.shared_decks for select to anon, authenticated
  using (true);
