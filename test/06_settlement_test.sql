\set ON_ERROR_STOP on
set client_min_messages = notice;

-- A lot of our own, so the suites before this one cannot disturb it.
insert into lots (lot_no, category, title, grade, pallet, found, fixed, still,
                  retail_cents, opening_cents, status, opens_at, ends_at, original_ends_at,
                  image_path, alt_text)
values (900, 'Armchair', 'Settlement Test Chair', 'b', '0451',
        'Arm loose.', 'Re-glued and clamped.', 'Faint mark where the glue was cleaned.',
        40000, 100, 'open', now() - interval '1 hour', now() + interval '5 minutes',
        now() + interval '5 minutes', 'img/test-chair.jpg', 'A test chair.');

insert into lot_images (lot_id, path, alt, kind, position)
select id, 'img/test-chair-flaw.jpg', 'The mark.', 'flaw', 1 from lots where lot_no = 900;

\echo '== a won lot starts a settlement clock =='
select as_bidder('11111111-1111-1111-1111-111111111111');
select place_bid(900, 20000);

update lots set ends_at = now() - interval '1 second' where lot_no = 900;
select close_due_lots();

select assert_eq((select sold from lots where lot_no = 900), true, 'lot 900 sold');
select assert_eq((select settle_by is not null from lots where lot_no = 900), true,
                 'a settlement deadline was set');
select assert_eq(
  (select date_trunc('day', settle_by) = date_trunc('day', now() + interval '4 days')
     from lots where lot_no = 900),
  true, 'the deadline is settlement_days() out');

\echo '== inside the window, nothing relists =='
select assert_eq(relist_unsettled_lots(), 0, 'nothing is due yet');
select assert_eq((select forfeited_at is null from lots where lot_no = 900), true,
                 'lot 900 is untouched');

\echo '== only the winner may decline =='
select as_bidder('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    perform decline_lot(900);
    raise exception 'FAIL a stranger declined someone else''s lot';
  exception when sqlstate '42501' then
    raise notice '  ok  a non-winner cannot decline the lot';
  end;
end $$;

\echo '== the winner can hand it back =='
select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq((decline_lot(900)->>'declined')::boolean, true, 'the winner declines');
select assert_eq((decline_lot(900)->>'already')::boolean, true, 'declining twice is not an error');

\echo '== a declined lot relists straight away, as a new lot =='
select assert_eq(relist_unsettled_lots(), 1, 'one lot relisted');
select assert_eq((select forfeited_at is not null from lots where lot_no = 900), true,
                 'the original is marked forfeited');
select assert_eq((select status::text from lots where lot_no = 900), 'closed',
                 'the original stays closed, not reopened');
select assert_eq((select high_bidder from lots where lot_no = 900),
                 '11111111-1111-1111-1111-111111111111'::uuid,
                 'the original keeps its winner — the sale did happen');
select assert_eq((select bid_count from lots where lot_no = 900), 1,
                 'and keeps its bids');

\echo '== the relisted lot is a fresh listing =='
select assert_eq((select count(*)::int from lots where relist_of =
                   (select id from lots where lot_no = 900)), 1, 'exactly one successor');
select assert_eq((select status::text from lots where relist_of =
                   (select id from lots where lot_no = 900)), 'open', 'it is open');
select assert_eq((select bid_count from lots where relist_of =
                   (select id from lots where lot_no = 900)), 0, 'with no bids carried over');
select assert_eq((select title from lots where relist_of =
                   (select id from lots where lot_no = 900)), 'Settlement Test Chair',
                 'same piece, same words');
select assert_eq((select still from lots where relist_of =
                   (select id from lots where lot_no = 900)),
                 'Faint mark where the glue was cleaned.', 'the Still line carries over');

\echo '== and it keeps its photographs, flaw shot included =='
select assert_eq(
  (select count(*)::int from lot_images i
     where i.lot_id = (select id from lots where relist_of =
                        (select id from lots where lot_no = 900))
       and i.kind = 'flaw'),
  1, 'the relisted lot still shows the flaw');

\echo '== relisting is not repeated on the next sweep =='
select assert_eq(relist_unsettled_lots(), 0, 'the forfeited lot is not swept twice');

\echo '== an expired window relists without anyone declining =='
insert into lots (lot_no, category, title, grade, pallet, found, fixed, still,
                  retail_cents, opening_cents, status, opens_at, ends_at, original_ends_at)
values (901, 'Side table', 'Expiry Test Table', 'c', '0451',
        'Chipped.', 'Filled.', 'Repair reads close up.',
        12000, 100, 'open', now() - interval '1 hour', now() + interval '5 minutes',
        now() + interval '5 minutes');

select as_bidder('33333333-3333-3333-3333-333333333333');
select place_bid(901, 5000);
update lots set ends_at = now() - interval '1 second' where lot_no = 901;
select close_due_lots();

-- walk the clock past the window
update lots set settle_by = now() - interval '1 minute' where lot_no = 901;
select assert_eq(relist_unsettled_lots(), 1, 'the expired lot relisted');
select assert_eq((select declined_at is null from lots where lot_no = 901), true,
                 'nobody declined it — the window simply ran out');

\echo '== settling stops the clock =='
insert into lots (lot_no, category, title, grade, pallet, found, fixed, still,
                  retail_cents, opening_cents, status, opens_at, ends_at, original_ends_at)
values (902, 'Stool', 'Settled Test Stool', 'a', '0451',
        'Nothing.', 'Nothing.', 'Nothing worth printing.',
        9000, 100, 'open', now() - interval '1 hour', now() + interval '5 minutes',
        now() + interval '5 minutes');

select as_bidder('11111111-1111-1111-1111-111111111111');
select place_bid(902, 3000);
update lots set ends_at = now() - interval '1 second' where lot_no = 902;
select close_due_lots();

-- staff only
select as_bidder('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    perform settle_lot(902);
    raise exception 'FAIL a bidder settled a lot';
  exception when sqlstate '42501' then
    raise notice '  ok  a bidder cannot settle a lot';
  end;
end $$;

update bidders set is_staff = true where id = '44444444-4444-4444-4444-444444444444';
select as_bidder('44444444-4444-4444-4444-444444444444');
select assert_eq((settle_lot(902)->>'settled')::boolean, true, 'staff settles it');
select assert_eq((select status::text from lots where lot_no = 902), 'settled', 'status is settled');

update lots set settle_by = now() - interval '1 day' where lot_no = 902;
select assert_eq(relist_unsettled_lots(), 0, 'a settled lot never relists, even past its window');

\echo '== the audit trail explains every outcome =='
select assert_eq(
  (select count(*)::int from lot_events e join lots l on l.id = e.lot_id
    where l.lot_no = 900 and e.kind in ('closed','declined','forfeited')), 3,
  'lot 900 recorded closed, declined and forfeited');
select assert_eq(
  (select detail->>'reason' from lot_events e join lots l on l.id = e.lot_id
    where l.lot_no = 900 and e.kind = 'forfeited'), 'declined',
  'and says which of the two reasons it was');
