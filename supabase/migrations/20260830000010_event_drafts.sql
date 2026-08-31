alter table events
  add column is_draft boolean not null default false,
  add column draft_owner_hash text;

create index events_draft_owner_idx on events (id, draft_owner_hash)
  where is_draft = true;
