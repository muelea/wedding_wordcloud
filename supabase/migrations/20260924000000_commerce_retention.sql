-- Only metadata is added here. Deletion runs through authenticated maintenance.
alter table orders
  add column checkout_expired_confirmed_at timestamptz,
  add column retention_checked_at timestamptz,
  add column retention_hold_reason text,
  add column retention_review_at timestamptz,
  add column retention_years integer not null default 8,
  add column technical_data_erased_at timestamptz,
  add column operational_data_erased_at timestamptz,
  add constraint orders_retention_years check (retention_years between 8 and 100),
  add constraint orders_retention_hold check (
    (retention_hold_reason is null and retention_review_at is null) or
    (retention_hold_reason is not null
      and retention_hold_reason in ('support', 'refund', 'dispute', 'audit', 'legal')
      and retention_review_at is not null)
  );

create index orders_retention_scan_idx on orders (retention_checked_at nulls first, id);

alter table email_jobs add column content_erased_at timestamptz;
alter table operator_actions drop constraint operator_actions_type_valid;
alter table operator_actions add constraint operator_actions_type_valid check (
  action_type in ('manual_fulfillment_retry', 'prelive_cleanup', 'retention_policy')
);

insert into app_schema_versions (version) values (5);
