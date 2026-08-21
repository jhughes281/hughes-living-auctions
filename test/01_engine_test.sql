\set ON_ERROR_STOP on
set client_min_messages = notice;
\pset tuples_only on
\pset format unaligned

create or replace function assert_eq(got anyelement, want anyelement, label text)
returns void language plpgsql as $$
begin
  if got is distinct from want then
    raise exception 'FAIL %: got %, want %', label, got, want;
  end if;
  raise notice '  ok  %  (%)', label, got;
end $$;

create or replace function as_bidder(u uuid) returns void language sql as
$$ select set_config('test.uid', u::text, false)::void $$;

-- four bidders
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');
insert into bidders (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'Bob'),
  ('33333333-3333-3333-3333-333333333333', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'Dave');

\echo '== published increments =='
select assert_eq(bid_increment_cents(   100),  500, '$1 -> $5');
select assert_eq(bid_increment_cents(  4900),  500, '$49 -> $5');
select assert_eq(bid_increment_cents(  5000), 1000, '$50 -> $10');
select assert_eq(bid_increment_cents( 24900), 1000, '$249 -> $10');
select assert_eq(bid_increment_cents( 25000), 2500, '$250 -> $25');
select assert_eq(bid_increment_cents( 99900), 2500, '$999 -> $25');
select assert_eq(bid_increment_cents(100000), 5000, '$1000 -> $50');

\echo '== bench protection: 6%, $8 floor =='
select assert_eq(protection_cents(  1000),  800, '$10 bid -> $8 floor');
select assert_eq(protection_cents( 13400),  804, '$134 bid -> 6%');
select assert_eq(protection_cents(100000), 6000, '$1000 bid -> $60');

\echo '== proxy resolution on lot 119 =='
select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq((place_bid(119, 10000)->>'price_cents')::int, 100,
                 'sole bidder holds at the $1 opening');
select assert_eq((select high_bidder from lots where lot_no=119),
                 '11111111-1111-1111-1111-111111111111'::uuid, 'Alice leads');

select as_bidder('22222222-2222-2222-2222-222222222222');
do $$ declare r jsonb; begin
  r := place_bid(119, 5000);
  perform assert_eq((r->>'price_cents')::int, 6000, 'Bob $50 max -> one increment over him');
  perform assert_eq(r->>'status', 'outbid', 'Bob is outbid');
end $$;

select as_bidder('33333333-3333-3333-3333-333333333333');
-- Bob's max put the price at $60, so the floor for anyone new is now $70.
select assert_eq((place_bid(119, 7000)->>'price_cents')::int, 8000,
                 'Carol $70 max -> $80');

\echo '== exact tie: earlier bidder holds =='
select as_bidder('44444444-4444-4444-4444-444444444444');
select assert_eq((place_bid(119, 10000)->>'status'), 'outbid',
                 'Dave ties Alice and loses on time');
select assert_eq((select current_price_cents from lots where lot_no=119), 10000,
                 'tie settles at the tied amount');

\echo '== leader raising their own ceiling =='
select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq((place_bid(119, 20000)->>'status'), 'leading', 'Alice still leads');
select assert_eq((select current_price_cents from lots where lot_no=119), 11000,
                 'price clears Dave''s max by one increment');

\echo '== rejections =='
do $$ begin
  perform as_bidder('22222222-2222-2222-2222-222222222222');
  begin perform place_bid(119, 11500); raise exception 'FAIL: below minimum accepted';
  exception when sqlstate '22003' then raise notice '  ok  below minimum rejected'; end;

  begin perform place_bid(119, 50050); raise exception 'FAIL: cents accepted';
  exception when sqlstate '22003' then raise notice '  ok  non-dollar amount rejected'; end;

  perform as_bidder('11111111-1111-1111-1111-111111111111');
  begin perform place_bid(119, 15000); raise exception 'FAIL: lowering own max accepted';
  exception when sqlstate '22003' then raise notice '  ok  cannot lower your own max'; end;

  perform set_config('test.uid', '', false);
  begin perform place_bid(119, 99999900); raise exception 'FAIL: anonymous bid accepted';
  exception when sqlstate '28000' then raise notice '  ok  anonymous bid rejected'; end;
end $$;

\echo '== two-minute rule =='
update lots set ends_at = now() + interval '40 seconds' where lot_no = 122;
select as_bidder('22222222-2222-2222-2222-222222222222');
select assert_eq((place_bid(122, 5000)->>'extended')::boolean, true, 'clock extended');
select assert_eq(
  (select ends_at - now() between interval '119 seconds' and interval '121 seconds'
     from lots where lot_no = 122), true, 'exactly two minutes remain');
select assert_eq((select extension_count from lots where lot_no=122), 1, 'extension logged');

-- push the close back out, then bid well clear of the window
update lots set ends_at = now() + interval '10 minutes' where lot_no = 122;
select as_bidder('33333333-3333-3333-3333-333333333333');
select assert_eq((place_bid(122, 9000)->>'extended')::boolean, false,
                 'a bid outside the window does not extend');

\echo '== closed lot =='
update lots set ends_at = now() - interval '1 second' where lot_no = 124;
do $$ begin
  perform as_bidder('22222222-2222-2222-2222-222222222222');
  begin perform place_bid(124, 10000); raise exception 'FAIL: bid on closed lot accepted';
  exception when sqlstate 'P0001' then raise notice '  ok  closed lot rejects bids'; end;
end $$;
select assert_eq(close_due_lots(), 1, 'sweeper closed one lot');
select assert_eq((select status from lots where lot_no=124), 'closed'::lot_status,
                 'lot 124 is closed');

\echo '== buy it now comes off at the first bid =='
select assert_eq((select buy_now_cents from lots where lot_no=133), 34000, 'BIN present');
select as_bidder('22222222-2222-2222-2222-222222222222');
select place_bid(133, 5000) is not null;
select assert_eq((select buy_now_cents from lots where lot_no=133), null::integer,
                 'BIN removed after a bid');

select as_bidder('33333333-3333-3333-3333-333333333333');
select assert_eq((buy_now(131)->>'price_cents')::int, 6000, 'buy it now takes lot 131');
select assert_eq((select status from lots where lot_no=131), 'closed'::lot_status,
                 'lot 131 closed on purchase');

\echo '== idempotency =='
select as_bidder('44444444-4444-4444-4444-444444444444');
select place_bid(127, 5000, false, 'key-abc') is not null;
select assert_eq((place_bid(127, 5000, false, 'key-abc')->>'replayed')::boolean, true,
                 'replayed key does not bid twice');
select assert_eq((select count(*)::int from bids b join lots l on l.id=b.lot_id
                   where l.lot_no=127), 1, 'only one bid recorded');

\echo '== the audit trail is intact =='
select assert_eq((select count(*)::int from lot_events
                   where kind='extended'), 1, 'one extension event');
select assert_eq((select count(*)::int from bids b join lots l on l.id=b.lot_id
                   where l.lot_no=119), 5, 'lot 119 kept every submitted max');
