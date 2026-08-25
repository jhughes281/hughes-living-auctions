-- Hughes Living Auctions — bulk listing support
--
-- Lots arrive thirty at a time off a pallet, from a spreadsheet, and the same
-- file gets imported twice more often than anyone admits. This adds the two
-- things that makes safe: a stable key per lot, and a number nobody has to
-- track by hand.

-- ---------------------------------------------------------------- import key
-- A natural key that survives re-import. The importer sets it from the CSV's
-- `ref` column, or derives it from pallet + title when there is no ref.
--
-- Deliberately NOT in the anon column grants in 0001, so it stays off the wire
-- like reserve_cents and high_bidder. It is an operations detail, not a fact
-- about the auction.
alter table lots add column if not exists import_key text;

create unique index if not exists lots_import_key
  on lots (import_key) where import_key is not null;

comment on column lots.import_key is
  'Stable per-lot key from the listing spreadsheet. Re-importing the same row updates that lot instead of creating a second one. Never exposed to clients.';

-- ---------------------------------------------------------------- lot numbers
-- lot_no is unique and NOT NULL with no default, which means every insert had
-- to know what the last one was. Hand it out from a sequence instead, starting
-- above the seeded bench lots so nothing collides.
do $$
declare
  v_max integer;
begin
  if not exists (select 1 from pg_class where relname = 'lot_no_seq') then
    select coalesce(max(lot_no), 100) into v_max from lots;
    execute format('create sequence lot_no_seq start with %s', v_max + 1);
  end if;
end $$;

alter table lots alter column lot_no set default nextval('lot_no_seq');
alter sequence lot_no_seq owned by lots.lot_no;

-- Same reasoning as paddle_seq in 0004: reading it leaks how much stock there
-- is, and burning it is nobody's business but the importer's.
revoke usage, select, update on sequence lot_no_seq from anon, authenticated;

-- ---------------------------------------------------------------- guard rails
-- The "Still" line is the reason anyone trusts a damaged-goods auction. A lot
-- listed with an empty one is worse than not listing it, so it is a constraint
-- rather than a note in a README. Same for the other two ledger lines.
alter table lots drop constraint if exists ledger_lines_are_written;
alter table lots add constraint ledger_lines_are_written check (
  length(btrim(found)) > 0 and
  length(btrim(fixed)) > 0 and
  length(btrim(still)) > 0
);

comment on constraint ledger_lines_are_written on lots is
  'Found/Fixed/Still must all say something. Publishing the remaining flaw is the trust mechanism; a blank Still line quietly removes it.';

-- No constraint on ends_at vs opens_at. It was tried and removed: expiring a
-- lot by setting ends_at into the past is a legitimate operator action, and
-- buy_now() does exactly that when someone takes a lot outright. Bad SCHEDULING
-- is an input mistake, caught by the importer where the operator can still fix
-- it; it is not a fact the table can be wrong about.
