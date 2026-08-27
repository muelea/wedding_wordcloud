-- Project-global runtime access for lifecycle and durable abuse-control state.

grant select, insert, update, delete on table public.reserved_event_slugs to wolkenworte_runtime;
grant select, insert, update, delete on table public.admin_pin_failures to wolkenworte_runtime;

alter table public.reserved_event_slugs enable row level security;
alter table public.admin_pin_failures enable row level security;

drop policy if exists wolkenworte_runtime_all on public.reserved_event_slugs;
create policy wolkenworte_runtime_all
  on public.reserved_event_slugs for all to wolkenworte_runtime
  using (true) with check (true);

drop policy if exists wolkenworte_runtime_all on public.admin_pin_failures;
create policy wolkenworte_runtime_all
  on public.admin_pin_failures for all to wolkenworte_runtime
  using (true) with check (true);
