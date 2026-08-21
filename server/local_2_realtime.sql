-- LOCAL DEVELOPMENT ONLY, part 2 of 2. Runs AFTER the core migration,
-- because the trigger below needs the lots table to exist.
-- Never runs against Supabase.

-- ---------------------------------------------------------------- realtime shim
-- Stands in for the supabase_realtime publication. The payload carries the
-- same column set the publication is restricted to in 0002 — reserve_cents and
-- high_bidder are not in it, so the local stream cannot leak what the cloud
-- stream cannot leak either.
create or replace function notify_lot_change() returns trigger
language plpgsql as $$
begin
  perform pg_notify('lot_change', json_build_object(
    'lot_no',              new.lot_no,
    'status',              new.status,
    'current_price_cents', new.current_price_cents,
    'bid_count',           new.bid_count,
    'ends_at',             new.ends_at,
    'extension_count',     new.extension_count,
    'buy_now_cents',       new.buy_now_cents
  )::text);
  return new;
end $$;

drop trigger if exists lots_notify on lots;
create trigger lots_notify
  after update on lots
  for each row
  when (old.* is distinct from new.*)
  execute function notify_lot_change();
