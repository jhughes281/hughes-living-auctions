-- Hughes Living Auctions — what happens after the hammer
--
-- A lot closed with a winner and the site stopped. Nothing recorded whether
-- they ever paid, nothing said when their claim on it expired, and a buyer who
-- changed their mind had no way to say so except by not turning up. The only
-- remedy for a no-show was chasing someone.
--
-- A deadline replaces the chase. Every won lot gets a settlement window. Miss
-- it and the lot relists itself; say so early and it relists immediately, with
-- no hard feelings and no phone call.

-- ---------------------------------------------------------------- the window
-- Published like every other rule, and changing it is a migration. The page
-- says four days; this is that number, in one place, where the sweeper and the
-- interface both read it.
create or replace function settlement_days()
returns integer language sql immutable parallel safe as $$
  select 4
$$;

comment on function settlement_days is
  'Days a winner has to settle and collect. Published in the fine print; the relist sweeper reads the same number.';

-- ---------------------------------------------------------------- state
alter table lots add column if not exists settle_by   timestamptz;
alter table lots add column if not exists settled_at  timestamptz;
alter table lots add column if not exists declined_at timestamptz;
alter table lots add column if not exists forfeited_at timestamptz;

-- Provenance. A relist is a NEW lot pointing back at the one that did not
-- settle, rather than the old row reopened: the original sale really happened,
-- somebody really bid, and an append-only bid table should not have its
-- history rewritten because a buyer went quiet.
alter table lots add column if not exists relist_of bigint references lots (id);

create index if not exists lots_settlement
  on lots (settle_by) where status = 'closed' and sold and settled_at is null;
create index if not exists lots_relist_of on lots (relist_of) where relist_of is not null;

comment on column lots.settle_by is
  'When the winner''s claim expires. Set at close from settlement_days(). Null on lots nobody won.';
comment on column lots.relist_of is
  'The lot this one is a second chance at. The original keeps its bids and its winner; this is a fresh listing.';

-- ---------------------------------------------------------------- closing
-- Same as 0007, plus the settlement clock. A lot that sold starts its window
-- the moment it closes; a lot nobody won has nothing to settle.
create or replace function close_due_lots()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot   lots%rowtype;
  v_met   boolean;
  v_sold  boolean;
  v_count integer := 0;
begin
  for v_lot in
    select * from lots
     where status = 'open' and ends_at <= now()
     order by ends_at
     for update skip locked
  loop
    v_met  := v_lot.reserve_cents is null
              or v_lot.current_price_cents >= v_lot.reserve_cents;
    v_sold := v_met and v_lot.high_bidder is not null;

    update lots
       set status      = 'closed',
           high_bidder = case when v_met then high_bidder else null end,
           sold        = v_sold,
           settle_by   = case when v_sold
                              then now() + (settlement_days() || ' days')::interval
                              else null end
     where id = v_lot.id;

    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'closed', v_lot.high_bidder,
            jsonb_build_object(
              'price_cents', v_lot.current_price_cents,
              'met_reserve', v_met,
              'reserve_cents', v_lot.reserve_cents,
              'would_have_won', case when v_met then null else v_lot.high_bidder end,
              'settle_by', case when v_sold
                                then now() + (settlement_days() || ' days')::interval
                                else null end,
              'bid_count',   v_lot.bid_count));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- declining
-- The dignified exit. A winner who has changed their mind says so and the lot
-- goes back up straight away, which is better for everyone than a no-show:
-- they are not chased, and the piece is earning again days sooner.
create or replace function decline_lot(p_lot_no integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bidder uuid := auth.uid();
  v_lot    lots%rowtype;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  if v_lot.high_bidder is distinct from v_bidder then
    -- Deliberately the same message whether they lost or the lot does not
    -- concern them: "you are not the winner" tells a stranger who is not.
    raise exception 'that lot is not yours to decline' using errcode = '42501';
  end if;
  if v_lot.settled_at is not null then
    raise exception 'lot % is already settled', p_lot_no using errcode = 'P0001';
  end if;
  if v_lot.declined_at is not null then
    return jsonb_build_object('lot_no', p_lot_no, 'declined', true, 'already', true);
  end if;

  update lots set declined_at = now() where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'declined', v_bidder,
          jsonb_build_object('price_cents', v_lot.current_price_cents));

  return jsonb_build_object('lot_no', p_lot_no, 'declined', true, 'already', false);
end;
$$;

-- ---------------------------------------------------------------- settling
-- Staff marks a lot collected. This is the only thing that stops the clock.
create or replace function settle_lot(p_lot_no integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot lots%rowtype;
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;

  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  if not v_lot.sold then
    raise exception 'lot % has no buyer to settle', p_lot_no using errcode = 'P0001';
  end if;

  update lots set settled_at = coalesce(settled_at, now()), status = 'settled'
   where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'settled', v_lot.high_bidder,
          jsonb_build_object('price_cents', v_lot.current_price_cents));

  return jsonb_build_object('lot_no', p_lot_no, 'settled', true);
end;
$$;

-- ---------------------------------------------------------------- relisting
-- The sweeper. A lot whose window has run out, or that was declined, goes back
-- up as a new lot. The original keeps its status, its winner and its bids —
-- the sale happened, it just was not completed.
create or replace function relist_unsettled_lots(p_hours_open integer default 72)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot   lots%rowtype;
  v_new   bigint;
  v_count integer := 0;
begin
  for v_lot in
    select * from lots
     where status in ('closed')
       and sold
       and settled_at is null
       and forfeited_at is null
       and (declined_at is not null or (settle_by is not null and settle_by <= now()))
     order by settle_by
     for update skip locked
  loop
    update lots set forfeited_at = now() where id = v_lot.id;

    -- A fresh listing: same piece, same words, same photographs, no history.
    insert into lots (category, title, alt_text, image_path, grade, pallet,
                      found, fixed, still, retail_cents, opening_cents,
                      reserve_cents, buy_now_cents, status, opens_at,
                      ends_at, original_ends_at,
                      width_in, depth_in, height_in, room, style, brand, material,
                      relist_of)
    values (v_lot.category, v_lot.title, v_lot.alt_text, v_lot.image_path,
            v_lot.grade, v_lot.pallet, v_lot.found, v_lot.fixed, v_lot.still,
            v_lot.retail_cents, v_lot.opening_cents, v_lot.reserve_cents,
            v_lot.buy_now_cents, 'open', now(),
            now() + (p_hours_open || ' hours')::interval,
            now() + (p_hours_open || ' hours')::interval,
            v_lot.width_in, v_lot.depth_in, v_lot.height_in,
            v_lot.room, v_lot.style, v_lot.brand, v_lot.material,
            v_lot.id)
    returning id into v_new;

    -- Carry the gallery. The trigger in 0008 files the piece shot from
    -- image_path; the rest are copied here so a relisted lot is not suddenly
    -- missing its flaw photograph.
    insert into lot_images (lot_id, path, alt, kind, position)
    select v_new, i.path, i.alt, i.kind, i.position
      from lot_images i where i.lot_id = v_lot.id
    on conflict (lot_id, path) do nothing;

    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'forfeited', v_lot.high_bidder,
            jsonb_build_object(
              'reason', case when v_lot.declined_at is not null
                             then 'declined' else 'window expired' end,
              'price_cents', v_lot.current_price_cents,
              'relisted_as', (select lot_no from lots where id = v_new)));

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- exposure
grant select (settle_by, settled_at, declined_at, forfeited_at, relist_of)
  on lots to anon, authenticated;

revoke execute on function settlement_days()              from public;
revoke execute on function decline_lot(integer)           from public;
revoke execute on function settle_lot(integer)            from public;
revoke execute on function relist_unsettled_lots(integer) from public;

grant execute on function settlement_days()    to anon, authenticated;
grant execute on function decline_lot(integer) to authenticated;
grant execute on function settle_lot(integer)  to authenticated;   -- gated on is_staff inside
-- The sweeper is nobody's to call from a browser.
-- pg_cron runs it; no grant to anon or authenticated.

-- ---------------------------------------------------------------- schedule
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('relist-unsettled', '*/10 * * * *',
                          'select relist_unsettled_lots();');
  else
    raise notice 'pg_cron not here; schedule relist_unsettled_lots() yourself';
  end if;
end $$;

-- ---------------------------------------------------------------- verify
do $$
begin
  if has_function_privilege('anon', 'relist_unsettled_lots(integer)', 'execute') then
    raise exception 'the relist sweeper is reachable by anon';
  end if;
  if has_function_privilege('anon', 'decline_lot(integer)', 'execute') then
    raise exception 'decline_lot is reachable by anon';
  end if;
  raise notice 'settlement: % day window, decline and relist wired', settlement_days();
end $$;
