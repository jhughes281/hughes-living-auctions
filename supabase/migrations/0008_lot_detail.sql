-- Hughes Living Auctions — the things a furniture buyer actually asks
--
-- Done now, at thirteen lots, because it is the cheap moment. These columns
-- have to be filled in per lot from the piece in front of you; retrofitting
-- them across three hundred already-sold lots means guessing from memory.
--
--   1. photographs, plural, with a role for each
--   2. dimensions — the single most common question about furniture
--   3. attributes worth filtering on: room, style, brand, material
--   4. a watchlist that survives changing device

-- ---------------------------------------------------------------- photographs
-- The site's whole argument is that the flaw is published. Until now there was
-- one image_path per lot and the flaw was described but never shown, so every
-- lot page had to print "the flaw is not pictured". A photograph of the scuff,
-- beside the sentence describing the scuff, turns a claim into evidence.
--
-- kind is not decoration: it is the piece / flaw / repair trio the listing
-- promises, so a lot missing a flaw shot is answerable in SQL.
create table if not exists lot_images (
  id         bigint generated always as identity primary key,
  lot_id     bigint not null references lots (id) on delete cascade,
  path       text   not null,
  alt        text   not null default '',
  kind       text   not null default 'piece'
             check (kind in ('piece', 'flaw', 'repair', 'detail')),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists lot_images_lot on lot_images (lot_id, position, id);
create unique index if not exists lot_images_path on lot_images (lot_id, path);

comment on column lot_images.kind is
  'piece = the whole thing; flaw = what the Still line describes; repair = what the bench did; detail = joinery, label, hardware.';

-- Carry the existing single photo across as the first "piece" shot, so no lot
-- loses its image and the importer has something to append to.
insert into lot_images (lot_id, path, alt, kind, position)
select l.id, l.image_path, coalesce(l.alt_text, ''), 'piece', 0
  from lots l
 where l.image_path is not null and l.image_path <> ''
   and not exists (select 1 from lot_images i where i.lot_id = l.id and i.path = l.image_path);

-- A one-off backfill only covers lots that already exist. Every lot the
-- importer creates afterwards would have arrived with no gallery row at all —
-- caught by the test suite, because seed.sql runs after the migrations and the
-- backfill found nothing to copy. A trigger holds the invariant for whoever
-- writes the lot: seed, importer, or a hand-written update.
create or replace function sync_piece_image()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.image_path is not null and new.image_path <> '' then
    insert into lot_images (lot_id, path, alt, kind, position)
    values (new.id, new.image_path, coalesce(new.alt_text, ''), 'piece', 0)
    on conflict (lot_id, path) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists lots_piece_image on lots;
create trigger lots_piece_image
  after insert or update of image_path on lots
  for each row execute function sync_piece_image();

-- lots.image_path stays as the card thumbnail. One source of truth for the
-- grid, the gallery for the lot page.
comment on column lots.image_path is
  'The card thumbnail. The full gallery lives in lot_images; this is deliberately still here so the list does not need a join.';

-- ---------------------------------------------------------------- dimensions
-- Whole inches, matching the custom.width_inches / depth_inches /
-- height_inches metafields already in use on hugheslivingco.com, so a piece
-- carries the same numbers on both sites.
alter table lots add column if not exists width_in  integer check (width_in  > 0 and width_in  < 400);
alter table lots add column if not exists depth_in  integer check (depth_in  > 0 and depth_in  < 400);
alter table lots add column if not exists height_in integer check (height_in > 0 and height_in < 400);

comment on column lots.width_in is
  'Whole inches. Bounds catch the usual typo of entering millimetres or a decimal.';

-- ---------------------------------------------------------------- attributes
-- Free text rather than enums on purpose: a pallet arrives with whatever it
-- arrives with, and a constraint that rejects a real sofa at listing time
-- costs more than a tidy vocabulary is worth. The importer normalises case and
-- reports unknown values so drift is visible without blocking a listing.
alter table lots add column if not exists room     text;
alter table lots add column if not exists style    text;
alter table lots add column if not exists brand    text;
alter table lots add column if not exists material text;

create index if not exists lots_room     on lots (room)     where status = 'open';
create index if not exists lots_style    on lots (style)    where status = 'open';
create index if not exists lots_material on lots (material) where status = 'open';
create index if not exists lots_brand    on lots (brand)    where status = 'open';

-- ---------------------------------------------------------------- watchlist
-- Was localStorage, so a bidder who starred lots on a phone saw nothing on a
-- laptop. It belongs to the account.
create table if not exists watchlist (
  bidder_id  uuid   not null references bidders (id) on delete cascade,
  lot_id     bigint not null references lots (id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bidder_id, lot_id)
);

alter table watchlist enable row level security;

create policy watchlist_own on watchlist
  for select to authenticated using (bidder_id = auth.uid());

-- No direct writes. Same rule as bids: the RPCs are the only door.
revoke insert, update, delete on watchlist from anon, authenticated;

create or replace function watch_lot(p_lot_no integer, p_on boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_bidder uuid := auth.uid();
  v_lot_id bigint;
begin
  if v_bidder is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select id into v_lot_id from lots where lot_no = p_lot_no;
  if not found then
    raise exception 'no such lot %', p_lot_no using errcode = 'P0002';
  end if;

  if p_on then
    insert into watchlist (bidder_id, lot_id) values (v_bidder, v_lot_id)
      on conflict do nothing;
  else
    delete from watchlist where bidder_id = v_bidder and lot_id = v_lot_id;
  end if;
  return p_on;
end;
$$;

create or replace function my_watchlist()
returns table (lot_no integer)
language sql stable security definer set search_path = public as $$
  select l.lot_no
    from watchlist w join lots l on l.id = w.lot_id
   where w.bidder_id = auth.uid()
   order by l.ends_at
$$;

-- ---------------------------------------------------------------- exposure
-- New columns are NOT covered by the grant in 0001, so they are invisible
-- until named here. Dimensions and attributes are product facts and public;
-- the images are public; the watchlist is per-bidder and never public.
grant select (width_in, depth_in, height_in, room, style, brand, material)
  on lots to anon, authenticated;

grant select on lot_images to anon, authenticated;
revoke insert, update, delete on lot_images from anon, authenticated;

alter table lot_images enable row level security;
create policy lot_images_public on lot_images
  for select using (
    exists (select 1 from lots l
             where l.id = lot_images.lot_id
               and l.status in ('open', 'closed', 'settled'))
  );

-- CREATE FUNCTION grants EXECUTE to PUBLIC. Revoke before granting, or anon
-- keeps it — the mistake 0004 exists to correct.
revoke execute on function watch_lot(integer, boolean) from public;
revoke execute on function my_watchlist()                from public;
grant  execute on function watch_lot(integer, boolean) to authenticated;
grant  execute on function my_watchlist()                to authenticated;

-- ---------------------------------------------------------------- verify
do $$
begin
  if has_function_privilege('anon', 'watch_lot(integer, boolean)', 'execute')
     or has_function_privilege('anon', 'my_watchlist()', 'execute') then
    raise exception 'the watchlist is reachable by anon';
  end if;
  if has_table_privilege('anon', 'watchlist', 'select') then
    raise exception 'anon can read the watchlist table';
  end if;
  raise notice 'lot detail: galleries, dimensions and attributes public; watchlist per bidder';
end $$;
