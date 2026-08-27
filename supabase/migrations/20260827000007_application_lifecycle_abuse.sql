-- Lifecycle and durable abuse-control state. This migration is deliberately
-- schema-relative so the test suite can apply it inside isolated schemas.

insert into app_schema_versions (version) values (3);

-- Event slugs are permanent public capabilities. Deleting an expired event
-- must never make its old URL available to another couple.
create table reserved_event_slugs (
  slug                 text primary key,
  original_created_at  timestamptz not null,
  constraint reserved_event_slugs_nonempty check (length(slug) between 1 and 120)
);

insert into reserved_event_slugs (slug, original_created_at)
select slug, created_at from events
on conflict (slug) do nothing;

-- Each immutable personal-memory revision gets its own 30-day unpaid window.
-- Shared event-wordcloud configurations remain available for the event's
-- lifetime. Paid/order-linked configurations may later be detached and kept.
alter table configurations add column expires_at timestamptz;

update configurations configuration
set expires_at = case
  when configuration.configuration_type = 'personal_memory'
    then configuration.created_at + interval '30 days'
  else coalesce(event.expires_at, configuration.created_at + interval '365 days')
end
from events event
where event.id = configuration.event_id;

update configurations
set expires_at = created_at + case
  when configuration_type = 'personal_memory' then interval '30 days'
  else interval '365 days'
end
where expires_at is null;

alter table configurations alter column expires_at set not null;

create index configurations_expiry_idx
  on configurations (expires_at, event_id, id);

-- Reset brute-force protection must survive process restarts. Only an HMAC of
-- the normalized source address is persisted; raw client addresses never are.
create table admin_pin_failures (
  event_id          bigint not null references events(id) on delete cascade,
  source_ip_hash    text not null,
  window_started_at timestamptz not null default transaction_timestamp(),
  failed_attempts   integer not null default 0,
  blocked_until     timestamptz,
  updated_at        timestamptz not null default transaction_timestamp(),
  primary key (event_id, source_ip_hash),
  constraint admin_pin_failures_hash_valid check (source_ip_hash ~ '^[a-f0-9]{64}$'),
  constraint admin_pin_failures_attempts_valid check (failed_attempts between 0 and 5)
);

create index admin_pin_failures_expiry_idx
  on admin_pin_failures (updated_at, event_id);
