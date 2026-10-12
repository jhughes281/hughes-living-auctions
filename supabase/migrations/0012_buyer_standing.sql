-- Hughes Living Auctions — how many times a winner may change their mind
--
-- 0010 made walking away free and unlimited. That was the right default for a
-- buyer who says so, but it left nothing between "declined politely" and
-- "won six lots and never came". Each walk-away costs us a week of the piece
-- sitting unsold, so the allowance now depends on whether you have ever paid.
--
-- The rule, as published in the terms:
--   * Every buyer may walk away from two won lots. The lot reposts either way.
--   * Each five lots won and paid for earns one more. Five paid is gold.
--   * A buyer who has never paid for a lot and lets a win run out the window
--     without a word is suspended. Saying so on the paddle page still counts
--     as one of the two; silence does not.
--   * Anyone who uses up their walk-aways cannot hand back another lot, and a
--     no-show past the allowance suspends the paddle.
--
-- "Paid" means staff marked the lot collected (settle_lot). Nothing else stops
-- the clock, so nothing else counts.

-- ---------------------------------------------------------------- the numbers
-- Published, so they live in one place the terms page can be checked against.
create or replace function walkaways_base()
returns integer language sql immutable parallel safe as $$ select 2 $$;

create or replace function paid_lots_per_extra_walkaway()
returns integer language sql immutable parallel safe as $$ select 5 $$;

comment on function walkaways_base is
  'Won lots any buyer may walk away from. Published in the terms.';
comment on function paid_lots_per_extra_walkaway is
  'Paid lots that earn one more walk-away. Also the gold threshold.';

-- ---------------------------------------------------------------- state
alter table bidders add column if not exists suspended_at     timestamptz;
alter table bidders add column if not exists suspended_reason text;

comment on column bidders.suspended_reason is
  'Why the paddle was suspended, in words staff can read back to the buyer. Not exposed to the browser.';

-- ---------------------------------------------------------------- standing
-- The one place the count is made. decline_lot, the sweeper and the paddle
-- page all read it, so they cannot disagree about how many are left.
create or replace function buyer_standing(p_bidder uuid)
returns table (
  paid_lots      integer,
  walked_lots    integer,
  allowance      integer,
  remaining      integer,
  gold           boolean,
  suspended      boolean
)
language sql stable security definer set search_path = public, pg_temp as $$
  with c as (
    select
      (select count(*)::integer from lots
        where high_bidder = p_bidder and settled_at is not null) as paid,
      (select count(*)::integer from lots
        where high_bidder = p_bidder and settled_at is null
          and (declined_at is not null or forfeited_at is not null)) as walked
  )
  select c.paid,
         c.walked,
         walkaways_base() + c.paid / paid_lots_per_extra_walkaway(),
         greatest(0, walkaways_base() + c.paid / paid_lots_per_extra_walkaway() - c.walked),
         c.paid >= paid_lots_per_extra_walkaway(),
         coalesce((select b.suspended from bidders b where b.id = p_bidder), false)
    from c
$$;

-- What the paddle page shows. Your own numbers only; there is no argument.
create or replace function my_standing()
returns table (
  paid_lots      integer,
  walked_lots    integer,
  allowance      integer,
  remaining      integer,
  gold           boolean,
  suspended      boolean
)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from buyer_standing(auth.uid()) where auth.uid() is not null
$$;

-- ---------------------------------------------------------------- suspending
create or replace function suspend_bidder(p_bidder uuid, p_lot_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update bidders
     set suspended = true,
         suspended_at = coalesce(suspended_at, now()),
         suspended_reason = coalesce(suspended_reason, p_reason)
   where id = p_bidder and not suspended;

  if found then
    insert into lot_events (lot_id, kind, actor, detail)
    values (p_lot_id, 'suspended', p_bidder, jsonb_build_object('reason', p_reason));
  end if;
end;
$$;

-- ---------------------------------------------------------------- declining
-- Same as 0010, plus one check: you cannot hand back more than you are allowed.
-- Past that, the lot is yours to collect.
create or replace function decline_lot(p_lot_no integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bidder uuid := auth.uid();
  v_lot    lots%rowtype;
  v_left   integer;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  if v_lot.high_bidder is distinct from v_bidder then
    raise exception 'that lot is not yours to decline' using errcode = '42501';
  end if;
  if v_lot.settled_at is not null then
    raise exception 'lot % is already settled', p_lot_no using errcode = 'P0001';
  end if;
  if v_lot.declined_at is not null then
    return jsonb_build_object('lot_no', p_lot_no, 'declined', true, 'already', true);
  end if;
  if v_lot.forfeited_at is not null then
    raise exception 'lot % has already been relisted', p_lot_no using errcode = 'P0001';
  end if;

  -- Serialise this buyer's declines so two tabs cannot both spend the last one.
  perform 1 from bidders where id = v_bidder for update;

  select remaining into v_left from buyer_standing(v_bidder);
  if v_left <= 0 then
    raise exception 'no walk-aways left' using errcode = 'P0001',
      hint = 'This lot needs to be collected.';
  end if;

  update lots set declined_at = now() where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'declined', v_bidder,
          jsonb_build_object('price_cents', v_lot.current_price_cents,
                             'walkaways_left_after', v_left - 1));

  return jsonb_build_object('lot_no', p_lot_no, 'declined', true, 'already', false,
                            'remaining', v_left - 1);
end;
$$;

-- ---------------------------------------------------------------- relisting
-- Same as 0010, plus the consequence. After a lot is forfeited the winner's
-- standing is re-read, and a no-show is suspended when either:
--   they have never paid for a lot, or
--   this walk-away took them past their allowance.
-- A declined lot never suspends anyone: decline_lot already refused the one
-- that would have gone over.
create or replace function relist_unsettled_lots(p_hours_open integer default 72)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lot   lots%rowtype;
  v_new   bigint;
  v_st    record;
  v_count integer := 0;
begin
  for v_lot in
    select * from lots
     where status in ('closed')
       and sold
       and settled_at is null
       and forfeited_at is null
       and (declined_at is not null or (settle_by is not null and settle_by <= now()))
     order by settle_by
     for update skip locked
  loop
    update lots set forfeited_at = now() where id = v_lot.id;

    insert into lots (category, title, alt_text, image_path, grade, pallet,
                      found, fixed, still, retail_cents, opening_cents,
                      reserve_cents, buy_now_cents, status, opens_at,
                      ends_at, original_ends_at,
                      width_in, depth_in, height_in, room, style, brand, material,
                      relist_of)
    values (v_lot.category, v_lot.title, v_lot.alt_text, v_lot.image_path,
            v_lot.grade, v_lot.pallet, v_lot.found, v_lot.fixed, v_lot.still,
            v_lot.retail_cents, v_lot.opening_cents, v_lot.reserve_cents,
            v_lot.buy_now_cents, 'open', now(),
            now() + (p_hours_open || ' hours')::interval,
            now() + (p_hours_open || ' hours')::interval,
            v_lot.width_in, v_lot.depth_in, v_lot.height_in,
            v_lot.room, v_lot.style, v_lot.brand, v_lot.material,
            v_lot.id)
    returning id into v_new;

    insert into lot_images (lot_id, path, alt, kind, position)
    select v_new, i.path, i.alt, i.kind, i.position
      from lot_images i where i.lot_id = v_lot.id
    on conflict (lot_id, path) do nothing;

    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'forfeited', v_lot.high_bidder,
            jsonb_build_object(
              'reason', case when v_lot.declined_at is not null
                             then 'declined' else 'window expired' end,
              'price_cents', v_lot.current_price_cents,
              'relisted_as', (select lot_no from lots where id = v_new)));

    if v_lot.declined_at is null then
      select * into v_st from buyer_standing(v_lot.high_bidder);
      if v_st.paid_lots = 0 then
        perform suspend_bidder(v_lot.high_bidder, v_lot.id,
          'Won lot ' || v_lot.lot_no || ' and did not pay or collect it, with no paid lots on the account.');
      elsif v_st.walked_lots > v_st.allowance then
        perform suspend_bidder(v_lot.high_bidder, v_lot.id,
          'Did not pay or collect lot ' || v_lot.lot_no || ' after using all '
          || v_st.allowance || ' walk-aways.');
      end if;
    end if;

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- exposure
revoke execute on function walkaways_base()                     from public;
revoke execute on function paid_lots_per_extra_walkaway()       from public;
revoke execute on function buyer_standing(uuid)                 from public;
revoke execute on function my_standing()                        from public;
revoke execute on function suspend_bidder(uuid, bigint, text)   from public;
revoke execute on function decline_lot(integer)                 from public;
revoke execute on function relist_unsettled_lots(integer)       from public;

grant execute on function walkaways_base()               to anon, authenticated;
grant execute on function paid_lots_per_extra_walkaway() to anon, authenticated;
grant execute on function my_standing()                  to authenticated;
grant execute on function decline_lot(integer)           to authenticated;
-- buyer_standing takes any uuid and suspend_bidder writes; neither is a
-- browser's to call. They run inside the functions above.

-- ---------------------------------------------------------------- verify
do $$
begin
  if has_function_privilege('authenticated', 'buyer_standing(uuid)', 'execute') then
    raise exception 'buyer_standing is reachable from the browser — it would read anyone''s record';
  end if;
  if has_function_privilege('authenticated', 'suspend_bidder(uuid, bigint, text)', 'execute') then
    raise exception 'suspend_bidder is reachable from the browser';
  end if;
  if has_column_privilege('authenticated', 'bidders', 'suspended_reason', 'select') then
    raise exception 'suspended_reason is readable from the browser';
  end if;
  raise notice 'standing: % walk-aways, +1 per % paid, gold at %',
    walkaways_base(), paid_lots_per_extra_walkaway(), paid_lots_per_extra_walkaway();
end $$;
