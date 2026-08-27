-- Project-global runtime grants and RLS policies for the schema-relative
-- design asset tables. Keep this separate so per-test schemas never mutate
-- global roles or policies.

grant select, insert, update, delete on table public.design_assets to wolkenworte_runtime;
grant select, insert, update, delete on table public.configuration_assets to wolkenworte_runtime;

alter table public.design_assets enable row level security;
alter table public.configuration_assets enable row level security;

drop policy if exists wolkenworte_runtime_all on public.design_assets;
create policy wolkenworte_runtime_all
  on public.design_assets for all to wolkenworte_runtime
  using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.configuration_assets;
create policy wolkenworte_runtime_all
  on public.configuration_assets for all to wolkenworte_runtime
  using (true) with check (true);
