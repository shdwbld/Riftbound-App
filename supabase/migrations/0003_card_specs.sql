-- Card-spec / coverage sheet: per-card "what it actually does" (structured JSON) +
-- a verification status, editable by anyone (private friends-only project). Apply in
-- the Supabase SQL editor or via the CLI/MCP.

create table if not exists public.card_specs (
  card_id     text primary key,
  name        text,
  spec        jsonb,
  status      text not null default 'untested',
  updated_at  timestamptz not null default now()
);

alter table public.card_specs enable row level security;

-- Anyone may read, add, and edit specs (upsert needs both insert + update).
drop policy if exists "anon select card_specs" on public.card_specs;
create policy "anon select card_specs"
  on public.card_specs for select to anon, authenticated using (true);

drop policy if exists "anon insert card_specs" on public.card_specs;
create policy "anon insert card_specs"
  on public.card_specs for insert to anon, authenticated with check (true);

drop policy if exists "anon update card_specs" on public.card_specs;
create policy "anon update card_specs"
  on public.card_specs for update to anon, authenticated using (true) with check (true);
