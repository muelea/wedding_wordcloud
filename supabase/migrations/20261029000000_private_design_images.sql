-- Immutable source images. Design/configuration/order JSON contains asset IDs;
-- legacy inline snapshots remain readable and are never rewritten here.
create table design_image_assets (
  id uuid primary key,
  scope_key text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text not null unique,
  mime_type text not null check (mime_type in ('image/png','image/jpeg')),
  byte_size integer not null check (byte_size between 1 and 1250000),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  status text not null check (status in ('uploading','active','deleting')),
  protected_until timestamptz not null,
  upload_deadline timestamptz not null,
  lease uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default transaction_timestamp(),
  last_error text,
  created_at timestamptz not null default transaction_timestamp(),
  unique(scope_key,sha256)
);
create index design_image_assets_cleanup on design_image_assets(protected_until,next_attempt_at);
alter table saved_designs add column image_asset_ids uuid[] not null default '{}';
alter table saved_design_writes add column image_asset_ids uuid[] not null default '{}';

create table configuration_image_assets (
  configuration_id text not null references configurations(id) on delete cascade,
  asset_id uuid not null references design_image_assets(id) on delete restrict,
  primary key(configuration_id,asset_id)
);
create table order_item_image_assets (
  order_item_id bigint not null references order_items(id) on delete cascade,
  asset_id uuid not null references design_image_assets(id) on delete restrict,
  primary key(order_item_id,asset_id)
);
create table saved_design_image_assets (
  design_id uuid not null references saved_designs(id) on delete cascade,
  asset_id uuid not null references design_image_assets(id) on delete restrict,
  primary key(design_id,asset_id)
);
create table saved_design_write_image_assets (
  write_id uuid not null references saved_design_writes(id) on delete cascade,
  asset_id uuid not null references design_image_assets(id) on delete restrict,
  primary key(write_id,asset_id)
);
create index configuration_image_assets_asset on configuration_image_assets(asset_id);
create index order_item_image_assets_asset on order_item_image_assets(asset_id);
create index saved_design_image_assets_asset on saved_design_image_assets(asset_id);
create index saved_design_write_image_assets_asset on saved_design_write_image_assets(asset_id);

-- References are published atomically with their immutable parent, including
-- reorder copies and artwork redaction. Row locks fence deletion claims.
create function sync_design_image_references() returns trigger language plpgsql as $$
declare
  ids uuid[];
  document jsonb;
  reference_table text;
  parent_column text;
  ready_count integer;
begin
  case tg_table_name
    when 'configurations' then
      document := new.design_json;
      reference_table := 'configuration_image_assets'; parent_column := 'configuration_id';
    when 'order_items' then
      document := new.configuration_snapshot_json->'design';
      reference_table := 'order_item_image_assets'; parent_column := 'order_item_id';
    when 'saved_designs' then
      ids := new.image_asset_ids;
      reference_table := 'saved_design_image_assets'; parent_column := 'design_id';
    when 'saved_design_writes' then
      ids := case when new.status='pending' then new.image_asset_ids else '{}'::uuid[] end;
      reference_table := 'saved_design_write_image_assets'; parent_column := 'write_id';
  end case;
  if ids is null then
    select coalesce(array_agg(distinct (value #>> '{}')::uuid),'{}'::uuid[]) into ids
      from jsonb_path_query(coalesce(document,'{}'::jsonb),'$.**.assetId') as images(value);
  end if;
  if cardinality(ids)>20 then raise exception 'design_image_limit'; end if;
  perform id from design_image_assets where id=any(ids) order by id for update;
  select count(*) into ready_count from design_image_assets where id=any(ids)
    and (status='active' or (tg_table_name='saved_design_writes' and status='uploading'));
  if ready_count<>cardinality(ids) then raise exception 'design_image_unavailable'; end if;
  execute format('delete from %I where %I=$1',reference_table,parent_column) using new.id;
  execute format('insert into %I(%I,asset_id) select $1,unnest($2::uuid[])',reference_table,parent_column)
    using new.id,ids;
  return new;
end $$;
create trigger configurations_image_references after insert or update of design_json on configurations
  for each row execute function sync_design_image_references();
create trigger order_items_image_references after insert or update of configuration_snapshot_json on order_items
  for each row execute function sync_design_image_references();
create trigger saved_designs_image_references after insert or update of image_asset_ids on saved_designs
  for each row execute function sync_design_image_references();
create trigger saved_design_writes_image_references after insert or update of image_asset_ids,status on saved_design_writes
  for each row execute function sync_design_image_references();

-- Keep database validation in step with the PNG renderer and private bucket.
alter table print_artifacts drop constraint print_artifacts_size_valid;
alter table print_artifacts add constraint print_artifacts_size_valid
  check (byte_size between 1 and 41943040);

do $permissions$
declare relation text;
begin
  foreach relation in array array['design_image_assets','configuration_image_assets','order_item_image_assets',
    'saved_design_image_assets','saved_design_write_image_assets'] loop
    execute format('alter table %I enable row level security',relation);
    execute format('revoke all on %I from public',relation);
    if current_schema()='public' then
      execute format('revoke all on %I from anon,authenticated',relation);
      execute format('grant select,insert,update,delete on %I to wolkenworte_runtime',relation);
      execute format('create policy wolkenworte_runtime_all on %I for all to wolkenworte_runtime using(true) with check(true)',relation);
    end if;
  end loop;
  if current_schema()='public' and to_regclass('storage.buckets') is not null then
    update storage.buckets set file_size_limit=41943040,
      allowed_mime_types=array['image/svg+xml','image/png','image/jpeg'] where id='wolkenworte-private';
  end if;
end $permissions$;
insert into app_schema_versions(version) values(10);
