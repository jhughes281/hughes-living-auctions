\set ON_ERROR_STOP on
set client_min_messages = notice;

\echo '== the existing photo became the first gallery shot =='
select assert_eq(
  (select count(*)::int from lot_images where kind = 'piece'),
  (select count(*)::int from lots where image_path is not null and image_path <> ''),
  'every lot with a photo has a piece shot');

select assert_eq(
  (select position from lot_images i join lots l on l.id = i.lot_id
    where l.lot_no = 119 and i.kind = 'piece'),
  0, 'the carried-over shot sits first');

\echo '== a gallery holds the piece, the flaw and the repair =='
insert into lot_images (lot_id, path, alt, kind, position)
select id, 'img/lot-recliner-flaw.jpg', 'Scuff on the outside left arm.', 'flaw', 1
  from lots where lot_no = 119;
insert into lot_images (lot_id, path, alt, kind, position)
select id, 'img/lot-recliner-repair.jpg', 'New release cable fitted.', 'repair', 2
  from lots where lot_no = 119;

select assert_eq((select count(*)::int from lot_images i join lots l on l.id = i.lot_id
                   where l.lot_no = 119), 3, 'lot 119 has three photographs');

\echo '== which lots still have no flaw photograph =='
-- The question the whole design rests on, answerable in one query. Asserted
-- against named lots rather than a count: the suites before this one close and
-- sell lots, so any total here would drift every time one of them changes.
select assert_eq(
  exists (select 1 from lots l
           where l.lot_no = 119
             and not exists (select 1 from lot_images i
                              where i.lot_id = l.id and i.kind = 'flaw')),
  false, 'lot 119 has its flaw shot, so it is off the list');

select assert_eq(
  exists (select 1 from lots l
           where l.lot_no = 121
             and not exists (select 1 from lot_images i
                              where i.lot_id = l.id and i.kind = 'flaw')),
  true, 'lot 121 has none, so it is still on the list');

\echo '== the same photo cannot be filed twice on one lot =='
do $$
begin
  begin
    insert into lot_images (lot_id, path, kind)
    select id, 'img/lot-recliner-flaw.jpg', 'detail' from lots where lot_no = 119;
    raise exception 'FAIL duplicate photo was accepted';
  exception when unique_violation then
    raise notice '  ok  a duplicate path on the same lot is refused';
  end;
end $$;

\echo '== dimensions are whole inches, and typos are caught =='
update lots set width_in = 118, depth_in = 68, height_in = 34 where lot_no = 118;
select assert_eq((select width_in from lots where lot_no = 118), 118, 'width recorded');

do $$
begin
  begin
    update lots set width_in = 3000 where lot_no = 118;   -- millimetres by mistake
    raise exception 'FAIL a millimetre value was accepted';
  exception when check_violation then
    raise notice '  ok  a millimetre-sized number is refused';
  end;
end $$;

\echo '== attributes are filterable =='
update lots set room = 'living', style = 'modern', brand = 'Ariana', material = 'velvet'
 where lot_no = 118;
-- No status filter: lot 118 is sold by the time this runs, and the point here
-- is that the attribute is stored and searchable, not what state the lot is in.
select assert_eq((select count(*)::int from lots where room = 'living'),
                 1, 'one lot filed under the living room');
select assert_eq((select brand from lots where lot_no = 118), 'Ariana', 'brand recorded');
select assert_eq((select material from lots where lot_no = 118), 'velvet', 'material recorded');

\echo '== the watchlist belongs to the bidder, not the browser =='
select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq(watch_lot(121, true), true, 'Alice watches lot 121');
select assert_eq(watch_lot(122, true), true, 'Alice watches lot 122');
select assert_eq((select count(*)::int from my_watchlist()), 2, 'Alice sees two');

select as_bidder('22222222-2222-2222-2222-222222222222');
select assert_eq((select count(*)::int from my_watchlist()), 0,
                 'Bob sees none of Alice''s');

select as_bidder('11111111-1111-1111-1111-111111111111');
select assert_eq(watch_lot(121, false), false, 'Alice unwatches lot 121');
select assert_eq((select count(*)::int from my_watchlist()), 1, 'one left');

\echo '== watching twice is not an error =='
select assert_eq(watch_lot(122, true), true, 'watching an already-watched lot is fine');
select assert_eq((select count(*)::int from my_watchlist()), 1, 'still one');

\echo '== an anonymous visitor has no watchlist =='
select set_config('test.uid', '', false);
do $$
begin
  begin
    perform watch_lot(121, true);
    raise exception 'FAIL anonymous watch was accepted';
  exception when sqlstate '28000' then
    raise notice '  ok  anonymous watching is refused';
  end;
end $$;
