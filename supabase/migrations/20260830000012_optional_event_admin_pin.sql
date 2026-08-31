-- A cloud may deliberately remain open for anyone with its link to edit.
-- Only clouds whose creator chose a PIN store the verifier material.
alter table events
  alter column admin_pin_hash drop not null,
  alter column admin_pin_salt drop not null;

-- Direct-start drafts used a random temporary PIN before this was optional.
-- It was never shown to the creator, so retain draft ownership but remove the
-- unusable credential and let the creator choose whether to add one.
update events
set admin_pin_hash = null, admin_pin_salt = null
where is_draft = true;
