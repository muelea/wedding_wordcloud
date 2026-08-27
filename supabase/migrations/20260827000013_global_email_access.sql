-- Project-global runtime grants and RLS policies for Phase 6 tables.

grant select, insert, update, delete on table public.email_jobs to wolkenworte_runtime;
grant select, insert, update, delete on table public.resend_webhook_events to wolkenworte_runtime;
grant select, insert, update, delete on table public.email_smoke_runs to wolkenworte_runtime;
grant usage, select on all sequences in schema public to wolkenworte_runtime;

alter table public.email_jobs enable row level security;
alter table public.resend_webhook_events enable row level security;
alter table public.email_smoke_runs enable row level security;

drop policy if exists wolkenworte_runtime_all on public.email_jobs;
create policy wolkenworte_runtime_all on public.email_jobs
  for all to wolkenworte_runtime using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.resend_webhook_events;
create policy wolkenworte_runtime_all on public.resend_webhook_events
  for all to wolkenworte_runtime using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.email_smoke_runs;
create policy wolkenworte_runtime_all on public.email_smoke_runs
  for all to wolkenworte_runtime using (true) with check (true);
