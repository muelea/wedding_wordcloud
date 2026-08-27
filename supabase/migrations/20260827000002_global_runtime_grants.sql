-- Project-global runtime grants. Schema ownership and DDL remain exclusively
-- with the migration role.
grant usage on schema public to wolkenworte_runtime;
grant select, insert, update, delete on all tables in schema public to wolkenworte_runtime;
grant usage, select on all sequences in schema public to wolkenworte_runtime;
grant execute on all functions in schema public to wolkenworte_runtime;

alter default privileges in schema public
  grant select, insert, update, delete on tables to wolkenworte_runtime;
alter default privileges in schema public
  grant usage, select on sequences to wolkenworte_runtime;
alter default privileges in schema public
  grant execute on functions to wolkenworte_runtime;

revoke create on schema public from wolkenworte_runtime;
revoke create on schema public from wolkenworte_app;
