-- Realtime push + the closing sweeper. Supabase-specific; run after 0001.

-- Broadcast only the columns a spectator is allowed to see.
-- Postgres 15+ supports column lists in publications, which is the right
-- place to enforce this: Realtime cannot leak a column it never receives.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table lots (
      id, lot_no, status, current_price_cents, bid_count, ends_at,
      extension_count, buy_now_cents
    );
  else
    create publication supabase_realtime for table lots (
      id, lot_no, status, current_price_cents, bid_count, ends_at,
      extension_count, buy_now_cents
    );
  end if;
end $$;

-- Leave the replica identity as the primary key. Supabase's docs often suggest
-- REPLICA IDENTITY FULL to get old values in the payload, but Postgres rejects
-- that alongside a column list ("column list does not cover the replica
-- identity"), and the front end only needs the new price and clock anyway.

-- Close lots the moment their clock runs out.
-- Every minute is enough: place_bid already refuses a lot past ends_at,
-- so the sweeper only settles status, it is not part of the bidding path.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('close-due-lots', '* * * * *', 'select close_due_lots();');
  else
    raise notice 'pg_cron not available here; schedule close_due_lots() yourself';
  end if;
end $$;
