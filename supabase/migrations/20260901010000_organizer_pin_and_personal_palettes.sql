drop index if exists events_draft_owner_idx;

alter table events rename column admin_pin_hash to organizer_pin_hash;
alter table events rename column admin_pin_salt to organizer_pin_salt;
alter table admin_pin_failures rename to organizer_pin_failures;
alter table organizer_pin_failures
  rename constraint admin_pin_failures_hash_valid to organizer_pin_failures_hash_valid;
alter table organizer_pin_failures
  rename constraint admin_pin_failures_attempts_valid to organizer_pin_failures_attempts_valid;
alter index admin_pin_failures_expiry_idx rename to organizer_pin_failures_expiry_idx;

alter table events
  drop column subtitle,
  drop column theme,
  drop column is_draft,
  drop column draft_owner_hash;

alter table events
  add constraint events_organizer_pin_pair_check
  check ((organizer_pin_hash is null) = (organizer_pin_salt is null));

insert into app_schema_versions (version) values (3);
