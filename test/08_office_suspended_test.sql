\set ON_ERROR_STOP on
set client_min_messages = notice;

-- Runs after 07, which left Nora, Ned and Paul suspended.

\echo '== only staff see the suspended list =='
select as_bidder('22222222-2222-2222-2222-222222222222');
do $$
begin
  begin
    perform * from staff_suspended();
    raise exception 'FAIL a bidder read the suspended list';
  exception when sqlstate '42501' then
    raise notice '  ok  a bidder cannot read the suspended list';
  end;
  begin
    perform staff_restore_bidder(4001);
    raise exception 'FAIL a bidder restored a paddle';
  exception when sqlstate '42501' then
    raise notice '  ok  a bidder cannot restore a paddle';
  end;
end $$;

\echo '== the office sees who and why =='
select as_bidder('44444444-4444-4444-4444-444444444444');
select assert_eq((select count(*)::int from staff_suspended() where display_name ~ '^(Nora|Ned|Gail|Paul)'), 3,
                 'Nora, Ned and Paul are on the list, Gail is not');
select assert_eq(
  (select suspended_reason like '%no paid lots%' from staff_suspended()
    where display_name like 'Ned%'), true, 'Ned''s reason is shown');
select assert_eq(
  (select paid_lots || '/' || walked_lots || '/' || allowance from staff_suspended()
    where display_name like 'Paul%'), '1/3/2', 'Paul''s paid, walked and allowance are shown');

\echo '== restoring lifts the suspension and leaves a trace =='
select assert_eq(
  (staff_restore_bidder((select paddle from bidders
     where id = 'aaaaaaaa-0000-4000-8000-000000000002'))->>'restored')::boolean,
  true, 'staff restores Ned');
select assert_eq((select suspended from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000002'), false, 'Ned can bid again');
select assert_eq((select restored_at is not null and suspended_reason is null from bidders
                   where id = 'aaaaaaaa-0000-4000-8000-000000000002'), true,
                 'restored_at is set and the old reason cleared');
select assert_eq((select count(*)::int from staff_suspended() where display_name like 'Ned%'), 0, 'he is off the list');

select as_bidder('aaaaaaaa-0000-4000-8000-000000000002');
select place_bid(970, 5000);
select assert_eq((select high_bidder from lots where lot_no = 970),
                 'aaaaaaaa-0000-4000-8000-000000000002'::uuid, 'and his bid now goes through');

select as_bidder('44444444-4444-4444-4444-444444444444');
do $$
begin
  begin
    perform staff_restore_bidder((select paddle from bidders
              where id = 'aaaaaaaa-0000-4000-8000-000000000002'));
    raise exception 'FAIL restored a paddle that was not suspended';
  exception when sqlstate 'P0002' then
    raise notice '  ok  restoring a paddle that is not suspended is refused';
  end;
end $$;
