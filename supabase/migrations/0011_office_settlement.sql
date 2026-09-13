-- Hughes Living Auctions — the office needs to see the settlement clock
--
-- staff_lots() was written before 0010 existed, so it answers "who won" but
-- not "who still owes me" or "whose window runs out tonight". That second
-- question is the one you have at nine on a Sunday.
--
-- Postgres will not let CREATE OR REPLACE change a function's OUT columns, so
-- this drops and recreates. The grants go with it and are restated below.

drop function if exists staff_lots();

create function staff_lots()
returns table (
  lot_no              integer,
  title               text,
  grade               lot_grade,
  pallet              text,
  status              lot_status,
  ends_at             timestamptz,
  current_price_cents integer,
  retail_cents        integer,
  bid_count           integer,
  bidder_count        integer,
  winner_paddle       integer,
  winner_email        text,
  winner_name         text,
  reserve_cents       integer,
  met_reserve         boolean,
  protection          boolean,
  protection_cents    integer,
  -- new in 0011
  sold                boolean,
  settle_by           timestamptz,
  settled_at          timestamptz,
  declined_at         timestamptz,
  forfeited_at        timestamptz,
  relist_of_lot_no    integer,
  tax_cents           integer,
  due_cents           integer
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;

  return query
  select l.lot_no, l.title, l.grade, l.pallet, l.status, l.ends_at,
         l.current_price_cents, l.retail_cents, l.bid_count,
         (select count(distinct b.bidder_id)::integer from bids b where b.lot_id = l.id),
         w.paddle, w.email, w.display_name,
         l.reserve_cents,
         (l.reserve_cents is null or l.current_price_cents >= l.reserve_cents),
         coalesce(tb.protection, false),
         case when coalesce(tb.protection, false)
              then protection_cents(l.current_price_cents) else 0 end,
         l.sold, l.settle_by, l.settled_at, l.declined_at, l.forfeited_at,
         (select o.lot_no from lots o where o.id = l.relist_of),
         case when l.sold then tax_cents(l.current_price_cents) else 0 end,
         -- What to take at the counter: hammer + protection + tax on the goods.
         case when l.sold
              then l.current_price_cents
                   + case when coalesce(tb.protection, false)
                          then protection_cents(l.current_price_cents) else 0 end
                   + tax_cents(l.current_price_cents)
              else 0 end
    from lots l
    left join bidders w on w.id = l.high_bidder
    left join lateral (
      select b.protection
        from bids b
       where b.lot_id = l.id and b.bidder_id = l.high_bidder
       order by b.max_cents desc, b.placed_at desc
       limit 1
    ) tb on true
   where l.status in ('open', 'closed', 'settled')
   order by l.ends_at;
end;
$$;

-- ---------------------------------------------------------------- summary
drop function if exists staff_summary();

create function staff_summary()
returns table (
  open_lots        integer,
  closing_24h      integer,
  closed_won       integer,
  closed_unsold    integer,
  hammer_total     integer,
  retail_total     integer,
  bidders_total    integer,
  -- new in 0011: the money still standing on the counter
  awaiting_pickup  integer,
  due_total_cents  integer,
  overdue          integer
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;

  return query
  select
    (select count(*)::integer from lots where status = 'open'),
    (select count(*)::integer from lots
      where status = 'open' and ends_at <= now() + interval '24 hours'),
    (select count(*)::integer from lots where status <> 'open' and high_bidder is not null),
    (select count(*)::integer from lots where status <> 'open' and high_bidder is null),
    (select coalesce(sum(current_price_cents), 0)::integer from lots
      where status <> 'open' and high_bidder is not null),
    (select coalesce(sum(retail_cents), 0)::integer from lots
      where status <> 'open' and high_bidder is not null),
    (select count(*)::integer from bidders),
    (select count(*)::integer from lots
      where sold and settled_at is null and declined_at is null and forfeited_at is null),
    (select coalesce(sum(current_price_cents + tax_cents(current_price_cents)), 0)::integer
       from lots
      where sold and settled_at is null and declined_at is null and forfeited_at is null),
    (select count(*)::integer from lots
      where sold and settled_at is null and forfeited_at is null
        and settle_by is not null and settle_by <= now());
end;
$$;

-- ---------------------------------------------------------------- grants
-- Restated because the drop took them with it. Revoke from PUBLIC first: a
-- fresh CREATE FUNCTION grants EXECUTE to PUBLIC, which would hand the office
-- view — winner names and email addresses — to anon.
revoke execute on function staff_lots()    from public;
revoke execute on function staff_summary() from public;
grant  execute on function staff_lots()    to authenticated;
grant  execute on function staff_summary() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'staff_lots()', 'execute')
     or has_function_privilege('anon', 'staff_summary()', 'execute') then
    raise exception 'the office view is reachable by anon after the recreate';
  end if;
  raise notice 'office view: settlement clock and amount due added, still staff only';
end $$;
