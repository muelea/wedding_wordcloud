-- Project-global setup. Tests intentionally do not apply this file to their
-- isolated schemas; they exercise the application migration below instead.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wolkenworte_runtime') then
    create role wolkenworte_runtime
      nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'wolkenworte_app') then
    create role wolkenworte_app
      nologin nosuperuser nocreatedb nocreaterole inherit;
  end if;
end
$$;

grant wolkenworte_runtime to wolkenworte_app;
alter role wolkenworte_app set search_path = public;
alter role wolkenworte_app set statement_timeout = '10s';
alter role wolkenworte_app set lock_timeout = '5s';

-- The application roles can use objects granted explicitly after the schema
-- migration, but cannot create arbitrary objects in the public schema.
revoke create on schema public from public;
revoke create on schema public from wolkenworte_runtime;
revoke create on schema public from wolkenworte_app;
