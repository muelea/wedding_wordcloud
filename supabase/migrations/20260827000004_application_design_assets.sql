-- Schema-relative private-photo metadata. Object bytes live exclusively in
-- the private Supabase Storage bucket declared by the following global
-- migration; application tests apply this file inside an isolated schema.

insert into app_schema_versions (version) values (2);

create table design_assets (
  id                    text primary key,
  event_id              bigint references events(id) on delete restrict,
  uploader_owner_id     text not null,
  object_key            text not null unique,
  mime_type             text not null,
  byte_size             integer not null,
  sha256                text not null,
  storage_status        text not null default 'uploading',
  deletion_attempts     integer not null default 0,
  last_delete_error     text,
  created_at            timestamptz not null default transaction_timestamp(),
  expires_at            timestamptz not null,
  deleted_at            timestamptz,
  constraint design_assets_owner_valid
    check (uploader_owner_id ~ '^[a-f0-9]{32}$'),
  constraint design_assets_mime_valid
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint design_assets_size_valid
    check (byte_size between 1 and 6291456),
  constraint design_assets_sha_valid
    check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint design_assets_status_valid
    check (storage_status in ('uploading', 'active', 'deleting', 'delete_failed')),
  constraint design_assets_attempts_valid check (deletion_attempts >= 0),
  constraint design_assets_error_length
    check (last_delete_error is null or length(last_delete_error) <= 240),
  constraint design_assets_deleted_state
    check (deleted_at is null or storage_status = 'deleting')
);

create index design_assets_event_status_expiry_idx
  on design_assets (event_id, storage_status, expires_at, id);
create index design_assets_owner_unattached_idx
  on design_assets (event_id, uploader_owner_id, storage_status, created_at, id);
create index design_assets_dedup_idx
  on design_assets (event_id, uploader_owner_id, sha256, storage_status, created_at);

create table configuration_assets (
  configuration_id  text not null references configurations(id) on delete cascade,
  asset_id           text not null references design_assets(id) on delete restrict,
  primary key (configuration_id, asset_id)
);

create index configuration_assets_asset_idx
  on configuration_assets (asset_id, configuration_id);
