-- Supabase enables RLS for tables created in public. The backend-only runtime
-- role receives unrestricted row access only on Wolkenworte's own tables;
-- table privileges and the lack of schema CREATE remain the outer boundary.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'app_schema_versions',
    'events',
    'words',
    'word_contributions',
    'archives',
    'configurations',
    'checkout_quotes',
    'orders',
    'checkout_order_shipments',
    'order_items',
    'stripe_webhook_events'
  ]
  loop
    execute format('drop policy if exists wolkenworte_runtime_all on public.%I', table_name);
    execute format(
      'create policy wolkenworte_runtime_all on public.%I for all to wolkenworte_runtime using (true) with check (true)',
      table_name
    );
  end loop;
end
$$;

-- Migration history is deliberately not part of the application data plane.
revoke all on table public.wolkenworte_migrations from wolkenworte_runtime;
