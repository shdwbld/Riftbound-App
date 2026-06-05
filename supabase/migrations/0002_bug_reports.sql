-- Bug-capture: snapshot a buggy moment (pre-state → action → post-state → events)
-- so it can be reproduced and exported as a vitest fixture. No accounts — this is a
-- private friends-only fan project, so anon may insert/select/delete. Apply in the
-- Supabase SQL editor or via the CLI/MCP.

create table if not exists public.bug_reports (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  note         text,
  severity     text,
  mode         text,
  seq          int,
  pre_state    jsonb,
  action       jsonb,
  post_state   jsonb,
  events       jsonb,
  invariants   jsonb,
  app_version  text
);

alter table public.bug_reports enable row level security;

-- Anyone may file a bug (insert), review bugs (select), and clear them (delete).
drop policy if exists "anon insert bug_reports" on public.bug_reports;
create policy "anon insert bug_reports"
  on public.bug_reports for insert to anon, authenticated
  with check (true);

drop policy if exists "anon select bug_reports" on public.bug_reports;
create policy "anon select bug_reports"
  on public.bug_reports for select to anon, authenticated
  using (true);

drop policy if exists "anon delete bug_reports" on public.bug_reports;
create policy "anon delete bug_reports"
  on public.bug_reports for delete to anon, authenticated
  using (true);
