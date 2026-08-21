-- Hughes Living Auctions — auction core
-- Bids are append-only. A lot's price is DERIVED from the standing maxes,
-- never written by a client. Every rule the site publishes lives in this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums

create type lot_grade  as enum ('a', 'b', 'c', 'd');
create type lot_status as enum ('draft', 'open', 'closed', 'settled', 'withdrawn');
create type bid_kind   as enum ('proxy', 'buy_now');

-- ---------------------------------------------------------------- bidders

create sequence paddle_seq start with 4001;

create table bidders (
  id            uuid primary key references auth.users (id) on delete cascade,
  paddle        integer not null unique default nextval('paddle_seq'),
  display_name  text,
  email         text,
  suspended     boolean not null default false,
  created_at    timestamptz not null default now()
);

comment on column bidders.suspended is
  'Set true to block bidding without deleting history. place_bid rejects suspended bidders.';

-- ---------------------------------------------------------------- lots

create table lots (
  id                  bigint generated always as identity primary key,
  lot_no              integer not null unique,
  status              lot_status not null default 'draft',

  category            text not null,
  title               text not null,
  alt_text            text not null default '',
  image_path          text,
  grade               lot_grade not null,
  pallet              text,

  -- the three-line condition ledger; the reason the rest of the listing is believable
  found               text not null,
  fixed               text not null,
  still               text not null,

  retail_cents        integer check (retail_cents  >= 0),
  opening_cents       integer not null default 100 check (opening_cents > 0),
  reserve_cents       integer check (reserve_cents >= 0),
  buy_now_cents       integer check (buy_now_cents > 0),

  opens_at            timestamptz,
  ends_at             timestamptz not null,
  original_ends_at    timestamptz not null,
  extension_count     integer not null default 0,
  max_extensions      integer,               -- null = uncapped

  -- derived cache, only ever written inside place_bid / close_lot
  current_price_cents integer not null default 0,
  bid_count           integer not null default 0,
  high_bidder         uuid references bidders (id),

  created_at          timestamptz not null default now(),

  constraint reserve_at_least_opening
    check (reserve_cents is null or reserve_cents >= opening_cents),
  constraint buy_now_above_opening
    check (buy_now_cents is null or buy_now_cents > opening_cents)
);

create index lots_open_by_close on lots (ends_at) where status = 'open';
create index lots_status_idx    on lots (status);

-- ---------------------------------------------------------------- bids

-- One row per submitted maximum. Never updated, never deleted.
-- The public price is computed from the top two rows; there are no
-- synthetic "auto bid" rows, so this table is exactly what people did.
create table bids (
  id              bigint generated always as identity primary key,
  lot_id          bigint not null references lots (id) on delete restrict,
  bidder_id       uuid   not null references bidders (id) on delete restrict,
  kind            bid_kind not null default 'proxy',

  max_cents       integer not null check (max_cents > 0),
  price_at_bid    integer not null,      -- public price immediately after this bid
  protection      boolean not null default false,

  idempotency_key text,
  placed_at       timestamptz not null default now(),
  placed_ip       inet,
  user_agent      text
);

create index bids_lot_rank on bids (lot_id, max_cents desc, placed_at asc, id asc);
create index bids_bidder   on bids (bidder_id, placed_at desc);
create unique index bids_idempotency
  on bids (bidder_id, idempotency_key) where idempotency_key is not null;

revoke update, delete on bids from public;

-- ---------------------------------------------------------------- audit

create table lot_events (
  id         bigint generated always as identity primary key,
  lot_id     bigint not null references lots (id),
  kind       text   not null,           -- bid | extended | closed | buy_now | reopened
  actor      uuid   references bidders (id),
  detail     jsonb  not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index lot_events_lot on lot_events (lot_id, created_at desc);

-- ---------------------------------------------------------------- rules

-- Published increments: $5 under $50, $10 to $249, $25 to $999, $50 above.
create or replace function bid_increment_cents(price_cents integer)
returns integer language sql immutable parallel safe as $$
  select case
    when price_cents <   5000 then  500
    when price_cents <  25000 then 1000
    when price_cents < 100000 then 2500
    else                            5000
  end;
$$;

-- Bench protection: 6% of the bid, $8 minimum.
create or replace function protection_cents(amount_cents integer)
returns integer language sql immutable parallel safe as $$
  select greatest(800, ceil(amount_cents * 0.06)::integer);
$$;

-- Resolve a lot's public price from the standing maxes.
-- Each bidder counts once, at their highest max (earliest submission of it).
-- Leader pays one increment over the runner-up, capped at their own max.
-- Exact tie: the earlier bidder leads, at that amount.
create or replace function resolve_price(p_lot_id bigint)
returns table (price_cents integer, leader uuid, bidder_count integer)
language sql stable as $$
  with best as (
    select distinct on (bidder_id)
           bidder_id, max_cents, placed_at, id
      from bids
     where lot_id = p_lot_id
     order by bidder_id, max_cents desc, placed_at asc, id asc
  ),
  ranked as (
    select bidder_id, max_cents,
           row_number() over (order by max_cents desc, placed_at asc, id asc) as rn,
           count(*)    over () as n
      from best
  ),
  top as (select * from ranked where rn = 1),
  snd as (select * from ranked where rn = 2)
  select
    case
      when (select n from top) is null then (select opening_cents from lots where id = p_lot_id)
      when (select n from top) = 1     then (select opening_cents from lots where id = p_lot_id)
      else least((select max_cents from top),
                 (select max_cents from snd) + bid_increment_cents((select max_cents from snd)))
    end::integer,
    (select bidder_id from top),
    coalesce((select n from top), 0)::integer;
$$;

-- Smallest max the lot will accept from a bidder who is not already leading.
create or replace function min_next_cents(p_lot_id bigint)
returns integer language sql stable as $$
  select case
           when l.bid_count = 0 then l.opening_cents
           else l.current_price_cents + bid_increment_cents(l.current_price_cents)
         end
    from lots l where l.id = p_lot_id;
$$;

-- ---------------------------------------------------------------- place a bid

create or replace function place_bid(
  p_lot_no          integer,
  p_max_cents       integer,
  p_protection      boolean default false,
  p_idempotency_key text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bidder     uuid := auth.uid();
  v_lot        lots%rowtype;
  v_now        timestamptz := now();
  v_min_next   integer;
  v_my_max     integer;
  v_price      integer;
  v_leader     uuid;
  v_count      integer;
  v_extended   boolean := false;
  v_existing   bids%rowtype;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not exists (select 1 from bidders b where b.id = v_bidder and not b.suspended) then
    raise exception 'bidder not registered or suspended' using errcode = '42501';
  end if;

  -- Replay of a bid we already accepted: return the current state, do not bid twice.
  if p_idempotency_key is not null then
    select * into v_existing
      from bids
     where bidder_id = v_bidder and idempotency_key = p_idempotency_key;
    if found then
      select * into v_lot from lots where id = v_existing.lot_id;
      select price_cents, leader into v_price, v_leader from resolve_price(v_lot.id);
      return jsonb_build_object(
        'status',     case when v_leader = v_bidder then 'leading' else 'outbid' end,
        'replayed',   true,
        'lot_no',     v_lot.lot_no,
        'price_cents', v_price,
        'ends_at',    v_lot.ends_at,
        'min_next_cents', min_next_cents(v_lot.id));
    end if;
  end if;

  -- Serialize everything for this lot behind one row lock.
  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;

  if v_lot.status <> 'open' then
    raise exception 'lot % is not open for bidding', p_lot_no using errcode = 'P0001';
  end if;

  if v_now >= v_lot.ends_at then
    raise exception 'lot % has closed', p_lot_no using errcode = 'P0001';
  end if;

  if p_max_cents % 100 <> 0 then
    raise exception 'bids are in whole dollars' using errcode = '22003';
  end if;

  select max(max_cents) into v_my_max
    from bids where lot_id = v_lot.id and bidder_id = v_bidder;

  v_min_next := min_next_cents(v_lot.id);

  -- Raising your own ceiling must actually be a raise...
  if v_my_max is not null and p_max_cents <= v_my_max then
    raise exception 'your maximum is already %, raise it to bid again', v_my_max
      using errcode = '22003';
  end if;

  -- ...and anyone who does not already hold the lot must clear the published
  -- minimum. The current leader is exempt: they hold it at the current price
  -- already, so lifting their own ceiling needs no increment.
  if v_lot.high_bidder is distinct from v_bidder
     and p_max_cents < v_min_next then
    raise exception 'minimum bid is %', v_min_next using errcode = '22003';
  end if;

  -- Two-minute rule, transactional with the bid so simultaneous bids
  -- cannot each extend the clock separately.
  if v_lot.ends_at - v_now < interval '2 minutes'
     and (v_lot.max_extensions is null or v_lot.extension_count < v_lot.max_extensions)
  then
    v_lot.ends_at         := v_now + interval '2 minutes';
    v_lot.extension_count := v_lot.extension_count + 1;
    v_extended            := true;
  end if;

  insert into bids (lot_id, bidder_id, kind, max_cents, price_at_bid,
                    protection, idempotency_key)
  values (v_lot.id, v_bidder, 'proxy', p_max_cents, 0, p_protection, p_idempotency_key);

  select price_cents, leader, bidder_count
    into v_price, v_leader, v_count
    from resolve_price(v_lot.id);

  update bids set price_at_bid = v_price
   where id = (select max(id) from bids where lot_id = v_lot.id);

  update lots
     set current_price_cents = v_price,
         high_bidder         = v_leader,
         bid_count           = (select count(*) from bids where lot_id = v_lot.id),
         ends_at             = v_lot.ends_at,
         extension_count     = v_lot.extension_count,
         buy_now_cents       = null          -- buy-it-now comes off at the first bid
   where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'bid', v_bidder,
          jsonb_build_object('price_cents', v_price, 'extended', v_extended));

  if v_extended then
    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'extended', v_bidder,
            jsonb_build_object('ends_at', v_lot.ends_at,
                               'extension_count', v_lot.extension_count));
  end if;

  return jsonb_build_object(
    'status',         case when v_leader = v_bidder then 'leading' else 'outbid' end,
    'replayed',       false,
    'lot_no',         v_lot.lot_no,
    'price_cents',    v_price,
    'ends_at',        v_lot.ends_at,
    'extended',       v_extended,
    'bidder_count',   v_count,
    'protection_cents', case when p_protection
                             then protection_cents(v_price) else 0 end,
    'min_next_cents', v_price + bid_increment_cents(v_price));
end;
$$;

-- ---------------------------------------------------------------- buy it now

create or replace function buy_now(
  p_lot_no          integer,
  p_protection      boolean default false,
  p_idempotency_key text    default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_bidder uuid := auth.uid();
  v_lot    lots%rowtype;
  v_price  integer;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_lot from lots where lot_no = p_lot_no for update;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;
  if v_lot.status <> 'open' or now() >= v_lot.ends_at then
    raise exception 'lot % is not open', p_lot_no using errcode = 'P0001';
  end if;
  if v_lot.buy_now_cents is null then
    raise exception 'buy it now is no longer available on lot %', p_lot_no
      using errcode = 'P0001';
  end if;

  v_price := v_lot.buy_now_cents;

  insert into bids (lot_id, bidder_id, kind, max_cents, price_at_bid,
                    protection, idempotency_key)
  values (v_lot.id, v_bidder, 'buy_now', v_price, v_price, p_protection,
          p_idempotency_key);

  update lots
     set status = 'closed', current_price_cents = v_price, high_bidder = v_bidder,
         bid_count = bid_count + 1, buy_now_cents = null, ends_at = now()
   where id = v_lot.id;

  insert into lot_events (lot_id, kind, actor, detail)
  values (v_lot.id, 'buy_now', v_bidder, jsonb_build_object('price_cents', v_price));

  return jsonb_build_object('status', 'won', 'lot_no', p_lot_no,
                            'price_cents', v_price,
                            'protection_cents',
                              case when p_protection
                                   then protection_cents(v_price) else 0 end);
end;
$$;

-- ---------------------------------------------------------------- closing

create or replace function close_due_lots()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_lot   lots%rowtype;
  v_count integer := 0;
begin
  for v_lot in
    select * from lots
     where status = 'open' and ends_at <= now()
     order by ends_at
     for update skip locked
  loop
    update lots set status = 'closed' where id = v_lot.id;

    insert into lot_events (lot_id, kind, actor, detail)
    values (v_lot.id, 'closed', v_lot.high_bidder,
            jsonb_build_object(
              'price_cents', v_lot.current_price_cents,
              'met_reserve', v_lot.reserve_cents is null
                             or v_lot.current_price_cents >= v_lot.reserve_cents,
              'bid_count',   v_lot.bid_count));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- exposure

alter table lots       enable row level security;
alter table bids       enable row level security;
alter table bidders    enable row level security;
alter table lot_events enable row level security;

-- Row policy lets the public see live and finished lots...
create policy lots_public_read on lots
  for select using (status in ('open', 'closed', 'settled'));

-- ...and column grants keep reserve_cents and high_bidder off the wire entirely.
-- RLS is row-level only; this is the half people forget.
grant select (
  id, lot_no, status, category, title, alt_text, image_path, grade, pallet,
  found, fixed, still, retail_cents, opening_cents, buy_now_cents,
  opens_at, ends_at, extension_count, current_price_cents, bid_count, created_at
) on lots to anon, authenticated;

-- A bidder sees only their own bids. Nobody ever reads anyone else's max.
create policy bids_own_read on bids
  for select to authenticated using (bidder_id = auth.uid());
grant select on bids to authenticated;

-- No client writes to bids or lots. The RPCs are the only door.
revoke insert, update, delete on bids, lots from anon, authenticated;

create policy bidders_self on bidders
  for select to authenticated using (id = auth.uid());
grant select (id, paddle, display_name, created_at) on bidders to authenticated;

grant execute on function place_bid(integer, integer, boolean, text) to authenticated;
grant execute on function buy_now(integer, boolean, text)            to authenticated;
grant execute on function bid_increment_cents(integer) to anon, authenticated;
grant execute on function protection_cents(integer)    to anon, authenticated;
grant execute on function min_next_cents(bigint)       to anon, authenticated;
revoke execute on function close_due_lots() from anon, authenticated;

-- "Am I winning?" without leaking who else is or what they bid.
create or replace function my_positions()
returns table (lot_no integer, my_max_cents integer, price_cents integer,
               is_leading boolean, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.lot_no,
         max(b.max_cents)::integer,
         l.current_price_cents,
         l.high_bidder = auth.uid(),
         l.ends_at
    from bids b join lots l on l.id = b.lot_id
   where b.bidder_id = auth.uid()
   group by l.lot_no, l.current_price_cents, l.high_bidder, l.ends_at;
$$;

grant execute on function my_positions() to authenticated;
