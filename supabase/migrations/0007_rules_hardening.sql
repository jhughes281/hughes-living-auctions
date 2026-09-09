-- Hughes Living Auctions — the rules the page publishes, enforced
--
-- A review of 0001–0006 against what index.html promises turned up five places
-- where the engine was looser than the copy:
--
--   1. opens_at was recorded and never checked. A pallet imported with
--      `--open Friday` took bids the moment it was committed.
--   2. reserve_cents was recorded and never enforced. close_due_lots() left the
--      high bidder as the winner whether or not the reserve was met, the office
--      view counted it as hammer revenue, and the bidder was told they won.
--      Now: a maximum that covers the reserve lifts the price to it, and a lot
--      that closes under its reserve closes with no buyer (lots.sold = false).
--   3. buy_now() skipped the suspended-bidder check that place_bid() has, and
--      had no idempotency replay: a retried request raised on the unique index.
--   4. Protection was accepted on grade D lots. The rubric says it is not offered.
--   5. Error text carried raw cents ("minimum bid is 6000") straight to the
--      person's screen through PostgREST.
--
-- Plus one default that 0004 fixed for tables but not functions: CREATE
-- FUNCTION grants EXECUTE to PUBLIC, so every migration since has had to
-- remember to revoke by hand. Done once here, for everything that comes later.

-- ---------------------------------------------------------------- dollars
create or replace function dollars(cents integer)
returns text language sql immutable parallel safe as $$
  select '$' || to_char(cents / 100.0, 'FM999,999,990');
$$;
revoke execute on function dollars(integer) from public;

-- ---------------------------------------------------------------- sold
-- Whether a closed lot actually has a buyer. bid_count > 0 used to imply it;
-- with reserves enforced it no longer does, and the page needs a public
-- column it can read to tell "hammered" from "closed, reserve not met".
-- Written only by close_due_lots() and buy_now(), alongside high_bidder, so it
-- cannot disagree with the office view; and it leaks nothing high_bidder's
-- absence did not already say. (A generated column would be tidier, but
-- Postgres refuses generated columns in a publication column list, and the
-- realtime payload needs it.)
do $$
begin
  -- an earlier draft of this migration made it a generated column
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'lots'
                and column_name = 'sold' and is_generated = 'ALWAYS') then
    alter table lots drop column sold;
  end if;
end $$;
alter table lots add column if not exists sold boolean not null default false;
update lots set sold = (high_bidder is not null) where status <> 'open' and sold is distinct from (high_bidder is not null);

comment on column lots.sold is
  'True when the lot has a buyer. Set at close with high_bidder, which is withheld from the browser; this column is not.';

grant select (sold) on lots to anon, authenticated;

-- Realtime: broadcast it with the other public columns so a lot that closes
-- flips to the results table without a reload.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime set table lots (
      id, lot_no, status, current_price_cents, bid_count, ends_at,
      extension_count, buy_now_cents, sold
    );
  end if;
end $$;

-- ---------------------------------------------------------------- place a bid
create or replace function place_bid(
  p_lot_no          integer,
  p_max_cents       integer,
  p_protection      boolean default false,
  p_idempotency_key text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bidder     uuid := auth.uid();
  v_lot        lots%rowtype;
  v_now        timestamptz;
  v_min_next   integer;
  v_my_max     integer;
  v_price      integer;
  v_leader     uuid;
  v_count      integer;
  v_extended   boolean := false;
  v_existing   bids%rowtype;
  v_bid_id     bigint;
  v_leader_max integer;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not exists (select 1 from bidders b where b.id = v_bidder and not b.suspended) then
    raise exception 'bidder not registered or suspended' using errcode = '42501';
  end if;

  -- Replay of a bid we already accepted: return the current state, do not bid twice.
  if p_idempotency_key is not null then
    select * into v_existing
      from bids
     where bidder_id = v_bidder and idempotency_key = p_idempotency_key;
    if found then
      select * into v_lot from lots where id = v_existing.lot_id;
      select price_cents, leader into v_price, v_leader from resolve_price(v_lot.id);
      return jsonb_build_object(
        'status',     case when v_leader = v_bidder then 'leading' else 'outbid' end,
        'replayed',   true,
        'lot_no',     v_lot.lot_no,
        'price_cents', v_price,
        'ends_at',    v_lot.ends_at,
        'min_next_cents', min_next_cents(v_lot.id));
    end if;
  end if;

  -- Serialize everything for this lot behind one row lock, and read the clock
  -- AFTER we hold it: now() is frozen at transaction start, which under
  -- contention is before the lock was granted.
  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  v_now := clock_timestamp();

  if v_lot.status <> 'open' then
    raise exception 'lot % is not open for bidding', p_lot_no using errcode = 'P0001';
  end if;

  if v_lot.opens_at is not null and v_now < v_lot.opens_at then
    raise exception 'lot % opens %', p_lot_no,
      to_char(v_lot.opens_at at time zone 'America/Chicago', 'FMDay FMMonth FMDD "at" FMHH12:MI am')
      using errcode = 'P0001';
  end if;

  if v_now >= v_lot.ends_at then
    raise exception 'lot % has closed', p_lot_no using errcode = 'P0001';
  end if;

  if p_max_cents % 100 <> 0 then
    raise exception 'bids are in whole dollars' using errcode = '22003';
  end if;

  if p_protection and v_lot.grade = 'd' then
    raise exception 'bench protection is not offered on grade D lots' using errcode = '22023';
  end if;

  select max(max_cents) into v_my_max
    from bids where lot_id = v_lot.id and bidder_id = v_bidder;

  v_min_next := min_next_cents(v_lot.id);

  -- Raising your own ceiling must actually be a raise...
  if v_my_max is not null and p_max_cents <= v_my_max then
    raise exception 'your maximum is already %, raise it to bid again', dollars(v_my_max)
      using errcode = '22003';
  end if;

  -- ...and anyone who does not already hold the lot must clear the published
  -- minimum. The current leader is exempt: they hold it at the current price
  -- already, so lifting their own ceiling needs no increment.
  if v_lot.high_bidder is distinct from v_bidder
     and p_max_cents < v_min_next then
    raise exception 'the minimum bid is %', dollars(v_min_next) using errcode = '22003';
  end if;

  -- Two-minute rule, transactional with the bid so simultaneous bids
  -- cannot each extend the clock separately.
  if v_lot.ends_at - v_now < interval '2 minutes'
     and (v_lot.max_extensions is null or v_lot.extension_count < v_lot.max_extensions)
  then
    v_lot.ends_at         := v_now + interval '2 minutes';
    v_lot.extension_count := v_lot.extension_count + 1;
    v_extended            := true;
  end if;

  insert into bids (lot_id, bidder_id, kind, max_cents, price_at_bid,
                    protection, idempotency_key)
  values (v_lot.id, v_bidder, 'proxy', p_max_cents, 0, p_protection, p_idempotency_key)
  returning id into v_bid_id;

  select price_cents, leader, bidder_count
    into v_price, v_leader, v_count
    from resolve_price(v_lot.id);

  -- A reserve behaves the way bidders expect from everywhere else: the moment
  -- somebody's maximum covers it, the price rises to it. Otherwise a sole
  -- bidder with a $200 max would sit at $1 under a $50 reserve and the lot
  -- would pass at close for no reason.
  if v_lot.reserve_cents is not null and v_price < v_lot.reserve_cents then
    select max(max_cents) into v_leader_max
      from bids where lot_id = v_lot.id and bidder_id = v_leader;
    if v_leader_max >= v_lot.reserve_cents then
      v_price := v_lot.reserve_cents;
    end if;
  end if;

  update bids set price_at_bid = v_price where id = v_bid_id;

  update lots
     set current_price_cents = v_price,
         high_bidder         = v_leader,
         bid_count           = (select count(*) from bids where lot_id = v_lot.id),
         ends_at             = v_lot.ends_at,
         extension_count     = v_lot.extension_count,
         buy_now_cents       = null          -- buy-it-now comes off at the first bid
   where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'bid', v_bidder,
          jsonb_build_object('price_cents', v_price, 'extended', v_extended));

  if v_extended then
    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'extended', v_bidder,
            jsonb_build_object('ends_at', v_lot.ends_at,
                               'extension_count', v_lot.extension_count));
  end if;

  return jsonb_build_object(
    'status',         case when v_leader = v_bidder then 'leading' else 'outbid' end,
    'replayed',       false,
    'lot_no',         v_lot.lot_no,
    'price_cents',    v_price,
    'ends_at',        v_lot.ends_at,
    'extended',       v_extended,
    'bidder_count',   v_count,
    'protection_cents', case when p_protection
                             then protection_cents(v_price) else 0 end,
    'min_next_cents', v_price + bid_increment_cents(v_price));
end;
$$;

-- ---------------------------------------------------------------- buy it now
create or replace function buy_now(
  p_lot_no          integer,
  p_protection      boolean default false,
  p_idempotency_key text    default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_bidder   uuid := auth.uid();
  v_lot      lots%rowtype;
  v_price    integer;
  v_now      timestamptz;
  v_existing bids%rowtype;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Same gate as place_bid. A suspended bidder could not bid but could buy.
  if not exists (select 1 from bidders b where b.id = v_bidder and not b.suspended) then
    raise exception 'bidder not registered or suspended' using errcode = '42501';
  end if;

  -- Replay: the purchase already went through, say so instead of raising on
  -- the unique index.
  if p_idempotency_key is not null then
    select * into v_existing
      from bids
     where bidder_id = v_bidder and idempotency_key = p_idempotency_key;
    if found then
      select * into v_lot from lots where id = v_existing.lot_id;
      return jsonb_build_object('status', 'won', 'replayed', true,
                                'lot_no', v_lot.lot_no,
                                'price_cents', v_existing.max_cents,
                                'protection_cents',
                                  case when v_existing.protection
                                       then protection_cents(v_existing.max_cents) else 0 end);
    end if;
  end if;

  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  v_now := clock_timestamp();

  if v_lot.status <> 'open' or v_now >= v_lot.ends_at then
    raise exception 'lot % is not open', p_lot_no using errcode = 'P0001';
  end if;
  if v_lot.opens_at is not null and v_now < v_lot.opens_at then
    raise exception 'lot % opens %', p_lot_no,
      to_char(v_lot.opens_at at time zone 'America/Chicago', 'FMDay FMMonth FMDD "at" FMHH12:MI am')
      using errcode = 'P0001';
  end if;
  if v_lot.buy_now_cents is null then
    raise exception 'buy it now is no longer available on lot %', p_lot_no
      using errcode = 'P0001';
  end if;
  if p_protection and v_lot.grade = 'd' then
    raise exception 'bench protection is not offered on grade D lots' using errcode = '22023';
  end if;

  v_price := v_lot.buy_now_cents;

  insert into bids (lot_id, bidder_id, kind, max_cents, price_at_bid,
                    protection, idempotency_key)
  values (v_lot.id, v_bidder, 'buy_now', v_price, v_price, p_protection,
          p_idempotency_key);

  update lots
     set status = 'closed', current_price_cents = v_price, high_bidder = v_bidder,
         sold = true, bid_count = bid_count + 1, buy_now_cents = null, ends_at = v_now
   where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'buy_now', v_bidder, jsonb_build_object('price_cents', v_price));

  return jsonb_build_object('status', 'won', 'replayed', false, 'lot_no', p_lot_no,
                            'price_cents', v_price,
                            'protection_cents',
                              case when p_protection
                                   then protection_cents(v_price) else 0 end);
end;
$$;

-- ---------------------------------------------------------------- closing
-- A reserve that was not met means there is no buyer. Clear high_bidder so
-- the office view files it under "relist", staff_summary stops counting it as
-- hammer, my_positions stops telling the bidder they lead, and `sold` goes
-- false for the page. The bids and the final price stay on record.
create or replace function close_due_lots()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot   lots%rowtype;
  v_met   boolean;
  v_count integer := 0;
begin
  for v_lot in
    select * from lots
     where status = 'open' and ends_at <= now()
     order by ends_at
     for update skip locked
  loop
    v_met := v_lot.reserve_cents is null
             or v_lot.current_price_cents >= v_lot.reserve_cents;

    update lots
       set status      = 'closed',
           high_bidder = case when v_met then high_bidder else null end,
           sold        = v_met and v_lot.high_bidder is not null
     where id = v_lot.id;

    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'closed', v_lot.high_bidder,
            jsonb_build_object(
              'price_cents', v_lot.current_price_cents,
              'met_reserve', v_met,
              'reserve_cents', v_lot.reserve_cents,
              'would_have_won', case when v_met then null else v_lot.high_bidder end,
              'bid_count',   v_lot.bid_count));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- positions
-- is_leading was `high_bidder = auth.uid()`, which is NULL, not false, on a lot
-- with no winner. Nothing could hit that before; a passed reserve can now.
create or replace function my_positions()
returns table (lot_no integer, my_max_cents integer, price_cents integer,
               is_leading boolean, ends_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.lot_no,
         max(b.max_cents)::integer,
         l.current_price_cents,
         coalesce(l.high_bidder = auth.uid(), false),
         l.ends_at
    from bids b join lots l on l.id = b.lot_id
   where b.bidder_id = auth.uid()
   group by l.lot_no, l.current_price_cents, l.high_bidder, l.ends_at;
$$;

-- ---------------------------------------------------------------- defaults
-- Functions created from here on are executable by nobody until granted.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke usage, select, update on sequences from anon, authenticated;

-- The replaced functions keep their grants (CREATE OR REPLACE preserves ACLs),
-- but assert it rather than trust it.
do $$
begin
  if has_function_privilege('anon', 'place_bid(integer, integer, boolean, text)', 'execute')
     or has_function_privilege('anon', 'buy_now(integer, boolean, text)', 'execute')
     or has_function_privilege('anon', 'close_due_lots()', 'execute')
     or has_function_privilege('authenticated', 'close_due_lots()', 'execute')
     or has_function_privilege('anon', 'dollars(integer)', 'execute') then
    raise exception 'function grants widened by 0007';
  end if;
  if not has_function_privilege('authenticated', 'place_bid(integer, integer, boolean, text)', 'execute')
     or not has_function_privilege('authenticated', 'buy_now(integer, boolean, text)', 'execute')
     or not has_function_privilege('authenticated', 'my_positions()', 'execute')
     or has_function_privilege('anon', 'my_positions()', 'execute') then
    raise exception 'bidding grants lost by 0007';
  end if;
  if has_column_privilege('anon', 'public.lots', 'reserve_cents', 'select')
     or has_column_privilege('anon', 'public.lots', 'high_bidder', 'select')
     or has_column_privilege('anon', 'public.lots', 'import_key', 'select') then
    raise exception 'a withheld column on lots is readable by anon';
  end if;
  if not has_column_privilege('anon', 'public.lots', 'sold', 'select') then
    raise exception 'lots.sold is not readable';
  end if;
  raise notice 'rules verified: opens_at, reserve, suspended buy_now, grade D protection, dollar messages';
end $$;
