-- Hughes Living Auctions — suspended paddles on the office screen
--
-- 0012 suspends a no-show automatically, and the only way to see who or why,
-- or to let someone bid again, was a row in the Supabase table editor. That is
-- a job for the office page, behind the same is_staff gate as everything else
-- on it.

alter table bidders add column if not exists restored_at timestamptz;
alter table bidders add column if not exists restored_by uuid references bidders (id);

comment on column bidders.restored_at is
  'When staff last lifted a suspension. Kept so a repeat suspension can be seen as a repeat.';

-- ---------------------------------------------------------------- the list
create or replace function staff_suspended()
returns table (
  paddle            integer,
  display_name      text,
  email             text,
  suspended_at      timestamptz,
  suspended_reason  text,
  paid_lots         integer,
  walked_lots       integer,
  allowance         integer,
  restored_before   boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;

  return query
  select b.paddle, b.display_name, b.email, b.suspended_at, b.suspended_reason,
         s.paid_lots, s.walked_lots, s.allowance,
         b.restored_at is not null
    from bidders b
    cross join lateral buyer_standing(b.id) s
   where b.suspended
   order by b.suspended_at desc nulls last;
end;
$$;

-- ---------------------------------------------------------------- restoring
-- Lifts the suspension and nothing else. Their walk-aways are still spent, so
-- they still cannot hand a lot back, and the next lapse suspends them again.
create or replace function staff_restore_bidder(p_paddle integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not is_staff() then
    raise exception 'not staff' using errcode = '42501';
  end if;

  update bidders
     set suspended = false,
         suspended_at = null,
         suspended_reason = null,
         restored_at = now(),
         restored_by = auth.uid()
   where paddle = p_paddle and suspended
  returning id into v_id;

  if v_id is null then
    raise exception 'paddle % is not suspended', p_paddle using errcode = 'P0002';
  end if;

  return jsonb_build_object('paddle', p_paddle, 'restored', true);
end;
$$;

-- ---------------------------------------------------------------- exposure
revoke execute on function staff_suspended()              from public;
revoke execute on function staff_restore_bidder(integer)  from public;
grant  execute on function staff_suspended()              to authenticated;  -- gated on is_staff inside
grant  execute on function staff_restore_bidder(integer)  to authenticated;  -- gated on is_staff inside

do $$
begin
  if has_function_privilege('anon', 'staff_restore_bidder(integer)', 'execute') then
    raise exception 'staff_restore_bidder is reachable by anon';
  end if;
  if has_column_privilege('authenticated', 'bidders', 'restored_by', 'select') then
    raise exception 'restored_by is readable from the browser';
  end if;
  raise notice 'office: suspended list and restore wired';
end $$;
