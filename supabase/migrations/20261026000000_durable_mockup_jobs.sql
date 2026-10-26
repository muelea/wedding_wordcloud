-- Mockup work is separate from orders and immutable paid print artifacts.
create table mockup_provider_budgets (
  scope text primary key check (length(scope) = 64),
  next_create_at timestamptz not null default '-infinity',
  next_read_at timestamptz not null default '-infinity',
  lease uuid,
  lease_until timestamptz
);
create table mockup_jobs (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{24}$'),
  scope text not null references mockup_provider_budgets(scope),
  event_id bigint not null references events(id) on delete cascade,
  configuration_id text not null references configurations(id) on delete cascade,
  mode text not null check (mode in ('operator','customer')),
  cache_key text not null check (length(cache_key) = 64),
  status text not null check (status in ('queued','preparing','submitting','pending','retrying','completed','failed')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  next_at timestamptz not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  lease uuid,
  lease_until timestamptz
);
create index mockup_jobs_due_idx on mockup_jobs(scope,next_at);
create index mockup_jobs_cache_idx on mockup_jobs(scope,mode,cache_key,created_at desc);
create unique index mockup_jobs_request_idx on mockup_jobs(scope,mode,configuration_id,(data->>'requestId'));
create unique index mockup_jobs_active_idx on mockup_jobs(scope,mode,cache_key)
  where status not in ('completed','failed');

do $permissions$
declare table_name text;
begin
  foreach table_name in array array['mockup_provider_budgets','mockup_jobs'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('revoke all on table %I from public', table_name);
    if current_schema() = 'public' then
      execute format('revoke all on table %I from anon, authenticated', table_name);
      execute format('grant select, insert, update, delete on table %I to wolkenworte_runtime', table_name);
      execute format('create policy wolkenworte_runtime_all on %I for all to wolkenworte_runtime using (true) with check (true)', table_name);
    end if;
  end loop;
end $permissions$;
insert into app_schema_versions(version) values (7);
