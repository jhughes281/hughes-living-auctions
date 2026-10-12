\set ON_ERROR_STOP on
set client_min_messages = notice;

-- Four buyers of our own, so nothing earlier in the suite counts against them.
insert into auth.users (id) values
  ('aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000003'),
  ('aaaaaaaa-0000-4000-8000-000000000004');
insert into bidders (id, display_name) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Nora (new, declines)'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'Ned (new, no-show)'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'Gail (gold)'),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'Paul (one paid)')
on conflict (id) do update set display_name = excluded.display_name;

-- A lot the given buyer has just won.
create or replace function test_win(p_no integer, p_bidder uuid) returns void
language plpgsql as $$
begin
  insert into lots (lot_no, category, title, grade, pallet, found, fixed, still,
                    retail_cents, opening_cents, status, opens_at, ends_at, original_ends_at)
  values (p_no, 'Side table', 'Standing Test ' || p_no, 'c', '0452',
          'Chipped.', 'Filled.', 'Repair reads close up.',
          12000, 100, 'open', now() - interval '1 hour', now() + interval '5 minutes',
          now() + interval '5 minutes');
  perform as_bidder(p_bidder);
  perform place_bid(p_no, 5000);
  update lots set ends_at = now() - interval '1 second' where lot_no = p_no;
  perform close_due_lots();
end $$;

-- Let a won lot's window run out, then sweep.
create or replace function test_expire(p_no integer) returns integer
language sql as $$
  update lots set settle_by = now() - interval '1 minute' where lot_no = p_no;
  select relist_unsettled_lots();
$$;

-- Staff marks it collected.
create or replace function test_pay(p_no integer) returns void
language plpgsql as $$
begin
  perform as_bidder('44444444-4444-4444-4444-444444444444');
  perform settle_lot(p_no);
end $$;

\echo '== the published numbers =='
select assert_eq(walkaways_base(), 2, 'two walk-aways for everyone');
select assert_eq(paid_lots_per_extra_walkaway(), 5, 'one more per five paid');

\echo '== a new buyer may hand back two lots, and not a third =='
select test_win(950, 'aaaaaaaa-0000-4000-8000-000000000001');
select test_win(951, 'aaaaaaaa-0000-4000-8000-000000000001');
select test_win(952, 'aaaaaaaa-0000-4000-8000-000000000001');
select as_bidder('aaaaaaaa-0000-4000-8000-000000000001');
select assert_eq((select remaining from my_standing()), 2, 'Nora starts with two');
select assert_eq((decline_lot(950)->>'remaining')::int, 1, 'first hand-back leaves one');
select assert_eq((decline_lot(951)->>'remaining')::int, 0, 'second hand-back leaves none');
do $$
begin
  begin
    perform decline_lot(952);
    raise exception 'FAIL a third hand-back was accepted';
  exception when sqlstate 'P0001' then
    raise notice '  ok  the third hand-back is refused';
  end;
end $$;
select assert_eq((select declined_at is null from lots where lot_no = 952), true,
                 'lot 952 is still hers to collect');

\echo '== handing back never suspends anyone =='
select relist_unsettled_lots();
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000001'), false,
                 'Nora is not suspended for two polite hand-backs');

\echo '== a new buyer who goes quiet on a win is suspended =='
select assert_eq(test_expire(952), 1, 'lot 952 runs out and relists');
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000001'), true,
                 'Nora is suspended');

select test_win(960, 'aaaaaaaa-0000-4000-8000-000000000002');
select assert_eq(test_expire(960), 1, 'Ned''s first win runs out');
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000002'), true,
                 'Ned is suspended on his first no-show — he has never paid');
select assert_eq((select suspended_reason like '%no paid lots%' from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000002'), true,
                 'and the reason says why');
select assert_eq(
  (select count(*)::int from lot_events e join lots l on l.id = e.lot_id
    where l.lot_no = 960 and e.kind = 'suspended'), 1,
  'the suspension is in the audit trail');

\echo '== a suspended buyer cannot bid =='
insert into lots (lot_no, category, title, grade, pallet, found, fixed, still,
                  retail_cents, opening_cents, status, opens_at, ends_at, original_ends_at)
values (970, 'Stool', 'Standing Test Open Lot', 'a', '0452',
        'Nothing.', 'Nothing.', 'Nothing worth printing.',
        9000, 100, 'open', now() - interval '1 hour', now() + interval '1 hour',
        now() + interval '1 hour');
select as_bidder('aaaaaaaa-0000-4000-8000-000000000002');
do $$
begin
  begin
    perform place_bid(970, 5000);
    raise exception 'FAIL a suspended buyer placed a bid';
  exception when sqlstate '42501' then
    raise notice '  ok  a suspended buyer''s bid is refused';
  end;
end $$;

\echo '== five paid lots make a gold buyer with a third walk-away =='
select test_win(961, 'aaaaaaaa-0000-4000-8000-000000000003');
select test_win(962, 'aaaaaaaa-0000-4000-8000-000000000003');
select test_win(963, 'aaaaaaaa-0000-4000-8000-000000000003');
select test_win(964, 'aaaaaaaa-0000-4000-8000-000000000003');
select test_win(965, 'aaaaaaaa-0000-4000-8000-000000000003');
select test_pay(961); select test_pay(962); select test_pay(963);
select test_pay(964); select test_pay(965);
select as_bidder('aaaaaaaa-0000-4000-8000-000000000003');
select assert_eq((select gold from my_standing()), true, 'Gail is gold');
select assert_eq((select allowance from my_standing()), 3, 'with three walk-aways');

select test_win(966, 'aaaaaaaa-0000-4000-8000-000000000003');
select assert_eq(test_expire(966), 1, 'Gail misses one');
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000003'), false,
                 'a buyer with a paid record is not suspended for one no-show');
select as_bidder('aaaaaaaa-0000-4000-8000-000000000003');
select assert_eq((select remaining from my_standing()), 2, 'it cost her one walk-away');

\echo '== past the allowance, a no-show suspends even a paying buyer =='
select test_win(980, 'aaaaaaaa-0000-4000-8000-000000000004');
select test_pay(980);
select test_win(981, 'aaaaaaaa-0000-4000-8000-000000000004');
select test_win(982, 'aaaaaaaa-0000-4000-8000-000000000004');
select test_win(983, 'aaaaaaaa-0000-4000-8000-000000000004');
select test_expire(981);
select test_expire(982);
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000004'), false,
                 'Paul has used both walk-aways and is still in');
select test_expire(983);
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000004'), true,
                 'his third no-show suspends him');

\echo '== the counts are private =='
select as_bidder('aaaaaaaa-0000-4000-8000-000000000004');
select assert_eq((select paid_lots || ' paid, ' || walked_lots || ' walked' from my_standing()),
                 '1 paid, 3 walked', 'my_standing answers for the caller — Paul sees Paul');
select as_bidder('aaaaaaaa-0000-4000-8000-000000000003');
select assert_eq((select paid_lots from my_standing()), 5, 'and Gail sees Gail');
