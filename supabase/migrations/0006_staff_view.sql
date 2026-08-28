-- Hughes Living Auctions — the operator's view
--
-- Everything the office needs on a Sunday night: what closed, who won, what to
-- collect, and what got no bids and needs relisting.
--
-- All of it already exists. lots.high_bidder records the winner and lot_events
-- records every close. Nothing displayed it, and high_bidder is deliberately
-- withheld from the browser — correct for bidders, useless for you. This adds
-- one door, and only staff have the key.

-- ---------------------------------------------------------------- the flag
alter table bidders add column if not exists is_staff boolean not null default false;

comment on column bidders.is_staff is
  'Office access. Grants sight of winner identities and contact details, which no bidder can see. Set it by hand; there is deliberately no way to grant it from the browser.';

-- is_staff is NOT added to the column grants in 0001, so a bidder cannot read
-- it — not even their own. Nothing in the browser needs to know.

-- ---------------------------------------------------------------- the guard
create or replace function is_staff()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select b.is_staff from bidders b where b.id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------- the view
-- Returns winner emails, so it checks staff first and raises otherwise. A
-- security definer function runs as its owner: without this check it would
-- hand every bidder's address to anyone who called it.
create or replace function staff_lots()
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
  protection_cents    integer
)
language plpgsql stable security definer set search_path = public as $$
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
              then protection_cents(l.current_price_cents) else 0 end
    from lots l
    left join bidders w on w.id = l.high_bidder
    -- the winner's own top bid, for whether they took protection
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

-- ---------------------------------------------------------------- the numbers
create or replace function staff_summary()
returns table (
  open_lots        integer,
  closing_24h      integer,
  closed_won       integer,
  closed_unsold    integer,
  hammer_total     integer,
  retail_total     integer,
  bidders_total    integer
)
language plpgsql stable security definer set search_path = public as $$
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
    (select count(*)::integer from bidders);
end;
$$;

-- ---------------------------------------------------------------- grants
-- Revoke from PUBLIC first. CREATE FUNCTION grants EXECUTE to PUBLIC, so
-- granting to authenticated without this leaves the door open to anon — the
-- exact mistake 0004 was written to correct.
revoke execute on function is_staff()      from public;
revoke execute on function staff_lots()    from public;
revoke execute on function staff_summary() from public;

grant execute on function is_staff()      to authenticated;
grant execute on function staff_lots()    to authenticated;
grant execute on function staff_summary() to authenticated;

-- ---------------------------------------------------------------- verify
do $$
begin
  if has_function_privilege('anon', 'staff_lots()', 'execute')
     or has_function_privilege('anon', 'staff_summary()', 'execute') then
    raise exception 'the staff view is reachable by anon';
  end if;
  raise notice 'staff view: authenticated only, and gated on is_staff inside';
end $$;
