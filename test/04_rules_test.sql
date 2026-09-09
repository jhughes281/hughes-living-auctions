-- The rules 0007 added. Runs after 01_engine_test.sql on the same connection,
-- so assert_eq(), as_bidder() and the four named bidders already exist.
-- Lots used here (118, 121, 125, 128, 134) are untouched by 01 (127 is not: it carries
-- Dave's idempotency bid).

\echo '== opens_at is honoured =='
update lots set opens_at = now() + interval '1 hour' where lot_no = 121;
do $$ begin
  perform as_bidder('22222222-2222-2222-2222-222222222222');
  begin perform place_bid(121, 10000); raise exception 'FAIL: bid accepted before opens_at';
  exception when sqlstate 'P0001' then raise notice '  ok  bid before opens_at rejected'; end;
end $$;
update lots set opens_at = now() + interval '1 hour' where lot_no = 128;
do $$ begin
  perform as_bidder('22222222-2222-2222-2222-222222222222');
  begin perform buy_now(128); raise exception 'FAIL: buy now accepted before opens_at';
  exception when sqlstate 'P0001' then raise notice '  ok  buy now before opens_at rejected'; end;
end $$;
update lots set opens_at = now() - interval '1 hour' where lot_no in (121, 128);
select assert_eq((place_bid(121, 10000)->>'status'), 'leading', 'same bid accepted once open');

\echo '== grade D carries no protection =='
update lots set grade = 'd' where lot_no = 125;
do $$ begin
  perform as_bidder('33333333-3333-3333-3333-333333333333');
  begin perform place_bid(125, 500, true); raise exception 'FAIL: protection sold on grade D';
  exception when sqlstate '22023' then raise notice '  ok  protection on grade D rejected'; end;
end $$;
select assert_eq((place_bid(125, 500, false)->>'protection_cents')::int, 0,
                 'grade D bid without protection goes through');

\echo '== a suspended bidder cannot buy it now =='
update bidders set suspended = true where id = '44444444-4444-4444-4444-444444444444';
do $$ begin
  perform as_bidder('44444444-4444-4444-4444-444444444444');
  begin perform buy_now(128); raise exception 'FAIL: suspended bidder bought a lot';
  exception when sqlstate '42501' then raise notice '  ok  suspended bidder refused at buy now'; end;
end $$;
update bidders set suspended = false where id = '44444444-4444-4444-4444-444444444444';

\echo '== buy it now replays instead of raising =='
select as_bidder('33333333-3333-3333-3333-333333333333');
select assert_eq((buy_now(128, false, 'buy-128-once')->>'replayed')::boolean, false, 'first purchase recorded');
select assert_eq((buy_now(128, false, 'buy-128-once')->>'replayed')::boolean, true,  'same key replays');
select assert_eq((select count(*)::int from bids where lot_id = (select id from lots where lot_no = 128)), 1,
                 'one purchase row, not two');
select assert_eq((select sold from lots where lot_no = 128), true, 'lot 128 reads as sold');

\echo '== errors speak in dollars =='
do $$
declare v_msg text;
begin
  perform as_bidder('22222222-2222-2222-2222-222222222222');
  update lots set current_price_cents = 6000, bid_count = 1 where lot_no = 118;   -- stage a $60 lot
  begin perform place_bid(118, 6100);
  exception when sqlstate '22003' then
    get stacked diagnostics v_msg = message_text;
    if v_msg like '%$70%' then raise notice '  ok  minimum quoted as $70, not 7000';
    else raise exception 'FAIL: message was "%"', v_msg; end if;
  end;
  update lots set current_price_cents = 0, bid_count = 0 where lot_no = 118;
end $$;

\echo '== reserve: met when a maximum covers it =='
update lots set reserve_cents = 5000 where lot_no = 118;
select as_bidder('22222222-2222-2222-2222-222222222222');
select assert_eq((place_bid(118, 10000)->>'price_cents')::int, 5000,
                 'sole bidder with a $100 max sits at the $50 reserve, not $1');
update lots set ends_at = now() - interval '1 second' where lot_no = 118;
select assert_eq(close_due_lots(), 1, 'sweeper closed lot 118');
select assert_eq((select sold from lots where lot_no = 118), true, 'reserve met: lot 118 sold');
select assert_eq((select high_bidder from lots where lot_no = 118),
                 '22222222-2222-2222-2222-222222222222'::uuid, 'Bob keeps lot 118');

\echo '== reserve: not met means no buyer =='
update lots set reserve_cents = 50000 where lot_no = 134;
select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq((place_bid(134, 10000)->>'price_cents')::int, 100,
                 'Alice at $100 max sits at $1 under a $500 reserve');
update lots set ends_at = now() - interval '1 second' where lot_no = 134;
select assert_eq(close_due_lots(), 1, 'sweeper closed lot 134');
select assert_eq((select status from lots where lot_no = 134), 'closed'::lot_status, 'lot 134 closed');
select assert_eq((select sold from lots where lot_no = 134), false, 'reserve unmet: lot 134 not sold');
select assert_eq((select high_bidder from lots where lot_no = 134), null::uuid, 'no winner recorded');
select assert_eq((select bid_count from lots where lot_no = 134), 1, 'the bid itself stays on record');
select assert_eq((select is_leading from my_positions() where lot_no = 134), false,
                 'Alice is not told she won');
select assert_eq((select (detail->>'met_reserve')::boolean from lot_events
                   where lot_id = (select id from lots where lot_no = 134) and kind = 'closed'),
                 false, 'close event records the unmet reserve');
