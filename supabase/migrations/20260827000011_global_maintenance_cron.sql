-- The actual URL and bearer secret live in Supabase Vault. This migration
-- installs the audited Cron request, but deliberately does not embed either
-- hosted value. scripts/configure-maintenance-cron.js writes/rotates the two
-- Vault entries and then invokes the function below.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.configure_wolkenworte_maintenance_cron()
returns bigint
language plpgsql
security definer
set search_path = public, vault, cron, net
as $$
declare
  maintenance_url text;
  maintenance_secret text;
  scheduled_job_id bigint;
begin
  select decrypted_secret into maintenance_url
  from vault.decrypted_secrets where name = 'wolkenworte_maintenance_url';
  select decrypted_secret into maintenance_secret
  from vault.decrypted_secrets where name = 'wolkenworte_maintenance_secret';
  if maintenance_url is null or maintenance_secret is null then
    raise exception 'Wolkenworte maintenance Vault secrets are missing';
  end if;

  perform cron.unschedule(jobid)
  from cron.job where jobname = 'wolkenworte-maintenance';

  select cron.schedule(
    'wolkenworte-maintenance',
    '*/5 * * * *',
    $request$
      select net.http_post(
        url := (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'wolkenworte_maintenance_url'
        ),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret from vault.decrypted_secrets
            where name = 'wolkenworte_maintenance_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $request$
  ) into scheduled_job_id;
  return scheduled_job_id;
end
$$;

revoke all on function public.configure_wolkenworte_maintenance_cron() from public;
revoke all on function public.configure_wolkenworte_maintenance_cron() from wolkenworte_runtime;
