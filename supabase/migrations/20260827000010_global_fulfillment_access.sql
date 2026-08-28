-- Project-global access for the schema-relative Phase 5 tables and SVG
-- support in the existing private Storage bucket.

grant select, insert, update, delete on table public.print_artifacts to wolkenworte_runtime;
grant select, insert, update, delete on table public.maintenance_runs to wolkenworte_runtime;
grant select, insert, update, delete on table public.printful_webhook_events to wolkenworte_runtime;
grant select, insert, update, delete on table public.provider_smoke_runs to wolkenworte_runtime;
grant usage, select on all sequences in schema public to wolkenworte_runtime;

alter table public.print_artifacts enable row level security;
alter table public.maintenance_runs enable row level security;
alter table public.printful_webhook_events enable row level security;
alter table public.provider_smoke_runs enable row level security;

drop policy if exists wolkenworte_runtime_all on public.print_artifacts;
create policy wolkenworte_runtime_all on public.print_artifacts
  for all to wolkenworte_runtime using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.maintenance_runs;
create policy wolkenworte_runtime_all on public.maintenance_runs
  for all to wolkenworte_runtime using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.printful_webhook_events;
create policy wolkenworte_runtime_all on public.printful_webhook_events
  for all to wolkenworte_runtime using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.provider_smoke_runs;
create policy wolkenworte_runtime_all on public.provider_smoke_runs
  for all to wolkenworte_runtime using (true) with check (true);

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']::text[],
    file_size_limit = 25165824
where id = 'wolkenworte-private';
