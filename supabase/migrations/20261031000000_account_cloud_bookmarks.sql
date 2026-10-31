-- Private bookmarks reference shared clouds without owning or retaining them.
create table saved_clouds (
  id uuid primary key,
  account_id uuid not null references design_accounts(id) on delete cascade,
  event_id bigint references events(id) on delete set null,
  slug text not null check (slug ~ '^[A-Za-z0-9_-]{22}$'),
  title text not null check (char_length(title) between 1 and 120),
  saved_at timestamptz not null default transaction_timestamp(),
  unique (account_id, slug)
);
create index saved_clouds_owner_idx on saved_clouds(account_id, saved_at desc);
create index saved_clouds_event_idx on saved_clouds(event_id);
alter table saved_clouds enable row level security;
revoke all on saved_clouds from public;
do $permissions$
begin
  if current_schema() = 'public' then
    revoke all on saved_clouds from anon, authenticated;
    grant select, insert, update, delete on saved_clouds to wolkenworte_runtime;
    create policy wolkenworte_runtime_all on saved_clouds for all
      to wolkenworte_runtime using (true) with check (true);
  end if;
end $permissions$;
insert into app_schema_versions(version) values (11);
