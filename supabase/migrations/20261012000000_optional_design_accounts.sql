-- Optional design accounts are independent of guest events and commerce.
create table design_accounts (
  id uuid primary key,
  locale text not null default 'de' check (locale in ('de','en','fr','it','es','tr')),
  verified boolean not null default false,
  status text not null default 'active' check (status in ('active','deleting')),
  created_at timestamptz not null default transaction_timestamp(),
  last_activity_at timestamptz not null default transaction_timestamp()
);
create table account_sessions (
  id_hash text primary key check (length(id_hash) = 64),
  account_id uuid not null references design_accounts(id) on delete cascade,
  tokens_ciphertext text not null,
  access_expires_at timestamptz not null,
  expires_at timestamptz not null,
  purpose text not null default 'signin' check (purpose in ('signin','recovery')),
  reauthenticated_at timestamptz,
  refresh_lease_until timestamptz,
  refresh_lease uuid
);
create index account_sessions_owner_idx on account_sessions(account_id);
create index account_sessions_expiry_idx on account_sessions(expires_at);
create index design_accounts_retention_idx on design_accounts(status,last_activity_at,created_at);
create table account_oauth_flows (
  id_hash text primary key check (length(id_hash) = 64),
  verifier_ciphertext text not null,
  return_to text not null,
  purpose text not null check (purpose in ('signin','reauth')),
  account_id uuid,
  expires_at timestamptz not null default transaction_timestamp() + interval '10 minutes'
);
create table saved_designs (
  id uuid primary key,
  account_id uuid not null references design_accounts(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  product_key text not null,
  orientation text not null,
  snapshot_key text not null,
  preview_key text not null,
  snapshot_sha256 text not null check (length(snapshot_sha256) = 64),
  byte_size integer not null check (byte_size > 0 and byte_size <= 20971520),
  version integer not null default 1 check (version > 0),
  workspace_event_id bigint references events(id) on delete set null,
  created_at timestamptz not null default transaction_timestamp(),
  saved_at timestamptz not null default transaction_timestamp(),
  last_activity_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null default transaction_timestamp() + interval '3 months'
);
create index saved_designs_owner_idx on saved_designs(account_id, saved_at desc);
create index saved_designs_expiry_idx on saved_designs(expires_at);
-- Object ledger survives account/design deletion and network failures. No
-- editable snapshots are ever placed in the paid print-artifact bucket.
create table saved_design_objects (
  object_key text primary key,
  account_id uuid not null,
  state text not null check (state in ('uploading','active','delete_pending')),
  upload_deadline timestamptz not null,
  delete_after timestamptz not null default transaction_timestamp(),
  attempts integer not null default 0,
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default transaction_timestamp()
);
create index saved_design_objects_cleanup_idx on saved_design_objects(state, next_attempt_at);
create table saved_design_writes (
  id uuid primary key,
  account_id uuid not null,
  design_id uuid not null,
  expected_version integer not null,
  snapshot_key text not null,
  preview_key text not null,
  snapshot_sha256 text not null,
  byte_size integer not null,
  additional_bytes integer not null,
  is_new boolean not null,
  name text not null,
  product_key text not null,
  orientation text not null,
  status text not null default 'pending' check (status in ('pending','complete','failed')),
  result_version integer,
  expires_at timestamptz not null default transaction_timestamp() + interval '1 minute',
  created_at timestamptz not null default transaction_timestamp()
);
create unique index saved_design_writes_pending_idx on saved_design_writes(design_id) where status = 'pending';
create index saved_design_writes_owner_idx on saved_design_writes(account_id, status);
create table account_deletions (
  account_id uuid primary key,
  created_at timestamptz not null default transaction_timestamp(),
  completed_at timestamptz,
  attempts integer not null default 0,
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default transaction_timestamp()
);
create index account_deletions_cleanup_idx on account_deletions(next_attempt_at) where completed_at is null;
create table account_maintenance_cursor (id boolean primary key default true check (id), page integer not null default 1);
insert into account_maintenance_cursor (id) values (true);
create table account_rate_limits (
  key_hash text primary key check (length(key_hash) = 64),
  hits integer not null,
  expires_at timestamptz not null
);
create table auth_email_receipts (
  id_hash text primary key check (length(id_hash) = 64),
  payload_hash text not null,
  delivered boolean not null default false,
  created_at timestamptz not null default transaction_timestamp()
);
alter table configurations add column saved_design_id uuid, add column saved_design_owner_id uuid;
-- No FK: deleting a library entry must never delete a basket or paid copy.

do $permissions$
declare table_name text;
begin
  foreach table_name in array array['design_accounts','account_sessions','account_oauth_flows',
    'saved_designs','saved_design_objects','saved_design_writes','account_deletions',
    'account_maintenance_cursor','account_rate_limits','auth_email_receipts'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('revoke all on table %I from public', table_name);
    if current_schema() = 'public' then
      execute format('revoke all on table %I from anon, authenticated', table_name);
      execute format('grant select, insert, update, delete on table %I to wolkenworte_runtime', table_name);
      execute format('create policy wolkenworte_runtime_all on %I for all to wolkenworte_runtime using (true) with check (true)', table_name);
    end if;
  end loop;
  if current_schema() = 'public' and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
    values ('wolkenworte-designs','wolkenworte-designs',false,20971520,array['application/json','image/png'])
    on conflict (id) do update set public = false,
      file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $permissions$;
insert into app_schema_versions(version) values (6);
