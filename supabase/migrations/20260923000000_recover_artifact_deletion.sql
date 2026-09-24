alter table print_artifacts
  add column deletion_claimed_at timestamptz;

create index print_artifacts_deleting_claim_idx
  on print_artifacts (deletion_claimed_at, id)
  where storage_status = 'deleting';

insert into app_schema_versions (version) values (4);
