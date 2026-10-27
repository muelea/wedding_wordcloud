-- One private PNG per configuration/surface, shared by previews and production.
create table prepared_print_files (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{24}$'),
  configuration_id text references configurations(id) on delete set null,
  surface_key text not null,
  spec_hash text not null,
  object_key text not null unique,
  sha256 text,
  byte_size integer,
  status text not null check (status in ('uploading','active','deleting')),
  lease uuid,
  lease_until timestamptz,
  expires_at timestamptz not null,
  unique(configuration_id,surface_key)
);
create index prepared_print_files_expiry on prepared_print_files(expires_at);
alter table print_artifacts drop constraint print_artifacts_object_key_key;
alter table print_artifacts add column source_file_id text references prepared_print_files(id) on delete restrict;
create index print_artifacts_source_file_idx on print_artifacts(source_file_id)
  where source_file_id is not null;
alter table orders add column mockup_approval_json jsonb;

alter table prepared_print_files enable row level security;
revoke all on prepared_print_files from public;
do $permissions$
begin
  if current_schema()='public' then
    revoke all on prepared_print_files from anon, authenticated;
    grant select,insert,update,delete on prepared_print_files to wolkenworte_runtime;
    create policy wolkenworte_runtime_all on prepared_print_files for all to wolkenworte_runtime using(true) with check(true);
  end if;
end $permissions$;
insert into app_schema_versions(version) values(9);
