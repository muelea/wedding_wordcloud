-- Project-global least-privilege access for Phase 8 operator audit records.

grant select, insert, update, delete on table public.operator_actions to wolkenworte_runtime;
grant usage, select on all sequences in schema public to wolkenworte_runtime;

alter table public.operator_actions enable row level security;

drop policy if exists wolkenworte_runtime_all on public.operator_actions;
create policy wolkenworte_runtime_all on public.operator_actions
  for all to wolkenworte_runtime using (true) with check (true);
