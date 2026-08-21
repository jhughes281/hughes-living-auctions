\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

-- What a logged-out visitor can and cannot see.
do $$
begin
  set local role anon;
  perform lot_no, current_price_cents, ends_at from lots where status = 'open';
  raise notice '  ok  anon reads open lots';

  begin
    perform reserve_cents from lots;
    raise exception 'FAIL: anon read reserve_cents';
  exception when insufficient_privilege then
    raise notice '  ok  anon cannot read reserve_cents';
  end;

  begin
    perform high_bidder from lots;
    raise exception 'FAIL: anon read high_bidder';
  exception when insufficient_privilege then
    raise notice '  ok  anon cannot read high_bidder (identity stays private)';
  end;

  begin
    perform max_cents from bids;
    raise exception 'FAIL: anon read bid maximums';
  exception when insufficient_privilege then
    raise notice '  ok  anon cannot read the bids table at all';
  end;

  begin
    insert into lots (lot_no, category, title, grade, found, fixed, still,
                      ends_at, original_ends_at)
      values (999, 'x', 'x', 'a', 'x', 'x', 'x', now(), now());
    raise exception 'FAIL: anon inserted a lot';
  exception when insufficient_privilege then
    raise notice '  ok  anon cannot write lots';
  end;
  reset role;
end $$;

-- What a signed-in bidder can see about other people.
do $$
declare v_other uuid := '22222222-2222-2222-2222-222222222222';  -- Bob
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', false);  -- Alice
  set local role authenticated;

  begin
    perform max_cents from bids where bidder_id = v_other;
    if found then raise exception 'FAIL: read another bidder''s max'; end if;
    raise notice '  ok  a bidder sees no rows for anyone else''s bids';
  exception when insufficient_privilege then
    raise notice '  ok  blocked from other bidders'' bids';
  end;

  if exists (select 1 from bids where bidder_id = current_setting('test.uid')::uuid) then
    raise notice '  ok  a bidder can read their own bid history';
  else
    raise exception 'FAIL: bidder cannot see own bids';
  end if;

  begin
    perform high_bidder from lots;
    raise exception 'FAIL: authenticated read high_bidder';
  exception when insufficient_privilege then
    raise notice '  ok  even signed in, high_bidder is not on the wire';
  end;
  reset role;
end $$;

-- The "am I winning" path works without exposing anyone else.
do $$
declare n int;
begin
  perform set_config('test.uid', '11111111-1111-1111-1111-111111111111', false);  -- Alice
  set local role authenticated;
  select count(*) into n from my_positions();
  raise notice '  ok  my_positions() returns % of my own lots', n;
  reset role;
end $$;
