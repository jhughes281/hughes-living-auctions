-- Hughes Living Auctions — auth bridge
--
-- 0001 stops at the edge of authentication on purpose: bidders.id references
-- auth.users, but nothing fills bidders in. This is that slice. Supabase only —
-- the local dev server issues its own paddles in server.mjs.

-- ---------------------------------------------------------------- paddle handout
-- A paddle is issued once, when the account is created, and never reused.
-- security definer because the trigger runs as the signing-up user, who has
-- no rights on bidders.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into bidders (id, email, display_name)
  values (new.id, new.email, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Anyone who signed up before this migration still needs a paddle.
insert into bidders (id, email, display_name)
select u.id, u.email, split_part(coalesce(u.email, ''), '@', 1)
  from auth.users u
 where not exists (select 1 from bidders b where b.id = u.id);

-- ---------------------------------------------------------------- server clock
-- Every countdown on the site is drawn against this, never against the
-- browser's clock, which can be wrong by minutes and is trivially changed.
create or replace function server_now()
returns timestamptz
language sql stable
as $$ select now() $$;

grant execute on function server_now() to anon, authenticated;

-- ---------------------------------------------------------------- min_next by lot_no
-- The browser knows lots by lot_no; min_next_cents() takes the internal id,
-- which is not on the wire. This exposes the published minimum without
-- exposing the key, and without the client computing the rule itself.
create or replace function min_next_for(p_lot_no integer)
returns integer
language sql stable
as $$ select min_next_cents(l.id) from lots l where l.lot_no = p_lot_no $$;

grant execute on function min_next_for(integer) to anon, authenticated;
