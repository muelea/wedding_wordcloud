-- Existing customer data is preserved. Previously active workspaces receive
-- a full transition period; already expired workspaces remain expired.
drop trigger events_set_expiry on events;
alter table events drop constraint events_expiry_exact;
alter table events add column updated_at timestamptz;
update events set updated_at = case when expires_at > transaction_timestamp()
  then transaction_timestamp() else created_at end;
update events set expires_at = updated_at + interval '3 months';
alter table events alter column updated_at set not null;
alter table events alter column updated_at set default transaction_timestamp();
alter table events add constraint events_expiry_exact
  check (expires_at = updated_at + interval '3 months');

create or replace function set_event_expiry() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, transaction_timestamp());
    new.updated_at := coalesce(new.updated_at, new.created_at);
  elsif new.title is distinct from old.title
    or new.organizer_pin_hash is distinct from old.organizer_pin_hash then
    new.updated_at := greatest(old.updated_at, transaction_timestamp());
  end if;
  new.expires_at := new.updated_at + interval '3 months';
  return new;
end $$;
create trigger events_set_expiry before insert or update on events
  for each row execute function set_event_expiry();

-- Statement transition tables touch each affected cloud once, in ID order.
-- The update commits/rolls back with the edit and cannot revive expired URLs.
create function touch_word_events() returns trigger language plpgsql as $$
begin
  perform id from events where id in (select event_id from changed_words)
    and expires_at > transaction_timestamp() order by id for update;
  update events set updated_at = greatest(updated_at, transaction_timestamp())
    where id in (select event_id from changed_words)
      and expires_at > transaction_timestamp();
  return null;
end $$;
create trigger words_touch_insert after insert on words
  referencing new table as changed_words for each statement execute function touch_word_events();
create trigger words_touch_update after update on words
  referencing new table as changed_words for each statement execute function touch_word_events();
create trigger words_touch_delete after delete on words
  referencing old table as changed_words for each statement execute function touch_word_events();

create function touch_configuration_event() returns trigger language plpgsql as $$
begin
  update events set updated_at = greatest(updated_at, transaction_timestamp())
    where id = new.event_id and expires_at > transaction_timestamp();
  return new;
end $$;
create trigger configurations_touch_event after insert on configurations
  for each row execute function touch_configuration_event();

create index mockup_jobs_expiry_idx on mockup_jobs(expires_at,id);

create table retention_runs (
  day date primary key,
  cutoff timestamptz not null default transaction_timestamp(),
  status text not null default 'running' check (status in ('running','completed','completed_with_deferrals')),
  progress jsonb not null default '{}',
  lease uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error text,
  last_error_at timestamptz
);
create unique index retention_one_active_run on retention_runs ((true)) where status = 'running';
create table retention_deferrals (
  category text not null,
  target_id text not null,
  reason text not null,
  attempts integer not null default 1,
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default transaction_timestamp() + interval '5 minutes',
  primary key (category,target_id)
);
create index retention_deferrals_due on retention_deferrals(next_attempt_at);
do $permissions$
declare table_name text;
begin
  foreach table_name in array array['retention_runs','retention_deferrals'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('revoke all on table %I from public', table_name);
    if current_schema() = 'public' then
      execute format('revoke all on table %I from anon, authenticated', table_name);
      execute format('grant select, insert, update, delete on table %I to wolkenworte_runtime', table_name);
      execute format('create policy wolkenworte_runtime_all on %I for all to wolkenworte_runtime using (true) with check (true)', table_name);
    end if;
  end loop;
end $permissions$;
insert into app_schema_versions(version) values (8);
