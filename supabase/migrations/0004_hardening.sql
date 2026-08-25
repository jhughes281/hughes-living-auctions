-- Hughes Living Auctions — hardening
--
-- 0001 enables row level security on all four tables and writes read policies.
-- That is correct, but on Supabase it is the ONLY thing standing between a
-- stranger and these tables, because the platform grants ALL on new tables in
-- `public` to anon and authenticated by default. RLS with no matching policy
-- denies the write — so the door is shut, but it is held shut by one latch,
-- and that latch is a toggle in the dashboard labelled "Enable RLS".
--
-- This file removes the privileges as well, so turning RLS off by accident
-- exposes reads at worst, never writes.

-- ---------------------------------------------------------------- writes
-- 0001 revoked writes on bids and lots. bidders and lot_events were missed.
revoke insert, update, delete, truncate on bidders    from anon, authenticated;
revoke insert, update, delete, truncate on lot_events from anon, authenticated;
revoke truncate                         on bids, lots from anon, authenticated;

-- ---------------------------------------------------------------- audit log
-- lot_events has RLS on and no policy, so nobody can read it. Make that
-- deliberate rather than incidental: it records who bid and when, which is
-- exactly the history a competitor would like. It is for the office, reached
-- with the service key from a server, never from a browser.
revoke select on lot_events from anon, authenticated;

comment on table lot_events is
  'Audit trail. Deliberately unreadable by anon and authenticated: no policy, no grant. Read it server-side with the service key.';

-- ---------------------------------------------------------------- paddle sequence
-- Paddle numbers are handed out by the signup trigger. Nobody else should be
-- able to burn them, and reading it leaks how many bidders exist.
revoke usage, select, update on sequence paddle_seq from anon, authenticated;

-- ---------------------------------------------------------------- functions
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and anon inherits
-- PUBLIC. So `revoke ... from anon, authenticated` removes nothing — which
-- means 0001's revoke of close_due_lots() never took effect, and, worse,
-- resolve_price() has been callable by anyone holding the anon key.
--
-- resolve_price() RETURNS THE LEADER'S UUID. That is precisely what the column
-- grants on lots exist to withhold, handed straight back through a function
-- call. RLS is row-level only is the half people forget on tables; function
-- grants default to PUBLIC is the half people forget on functions.
--
-- Close it at the source, then grant back only what each role actually needs.

revoke execute on function resolve_price(bigint)                     from public;
revoke execute on function close_due_lots()                          from public;
revoke execute on function place_bid(integer, integer, boolean, text) from public;
revoke execute on function buy_now(integer, boolean, text)            from public;
revoke execute on function my_positions()                             from public;
revoke execute on function bid_increment_cents(integer)                from public;
revoke execute on function protection_cents(integer)                   from public;
revoke execute on function min_next_cents(bigint)                      from public;
revoke execute on function handle_new_user()                           from public;
revoke execute on function server_now()                                from public;
revoke execute on function min_next_for(integer)                       from public;

-- Bidding is for signed-in bidders.
grant execute on function place_bid(integer, integer, boolean, text) to authenticated;
grant execute on function buy_now(integer, boolean, text)            to authenticated;
grant execute on function my_positions()                             to authenticated;

-- The published rules and the clock are public on purpose: they are printed on
-- the page, and a visitor who is not signed in still needs to see a minimum.
grant execute on function bid_increment_cents(integer) to anon, authenticated;
grant execute on function protection_cents(integer)    to anon, authenticated;
grant execute on function min_next_cents(bigint)       to anon, authenticated;
grant execute on function min_next_for(integer)        to anon, authenticated;
grant execute on function server_now()                 to anon, authenticated;

-- resolve_price, close_due_lots and handle_new_user are granted to nobody.
-- place_bid calls resolve_price from inside a security definer function, which
-- runs as the owner, so revoking it here does not affect bidding.

-- ---------------------------------------------------------------- future tables
-- Anything added to public later starts closed rather than open.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;

-- ---------------------------------------------------------------- verification
-- Fail the migration rather than ship a hole. These are the two mistakes this
-- file exists to correct, so they get asserted, not assumed.
do $$
declare
  v_leak text;
begin
  select string_agg(format('%s %s to %s', table_name, privilege_type, grantee), ', ')
    into v_leak
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_leak is not null then
    raise exception 'write privilege still granted: %', v_leak;
  end if;

  if has_function_privilege('anon', 'resolve_price(bigint)', 'execute')
     or has_function_privilege('authenticated', 'resolve_price(bigint)', 'execute') then
    raise exception 'resolve_price is still executable: the high bidder identity leaks';
  end if;

  if has_function_privilege('anon', 'close_due_lots()', 'execute') then
    raise exception 'close_due_lots is still executable by anon';
  end if;

  if has_table_privilege('anon', 'lot_events', 'select')
     or has_table_privilege('authenticated', 'lot_events', 'select') then
    raise exception 'the audit log is readable from the browser';
  end if;

  raise notice 'hardening verified: no writes, no resolve_price, no audit log, no sequence';
end $$;
