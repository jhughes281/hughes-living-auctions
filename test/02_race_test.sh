#!/usr/bin/env bash
# Fire N real connections at one lot at the same instant and check the invariants.
# This is the test the whole design exists for: if the row lock is wrong,
# two bidders both "win", or a max gets lost, or the clock runs away.
set -euo pipefail
export PATH=/usr/lib/postgresql/16/bin:$PATH
HOST=${PGHOST:-/tmp}; PORT=${PGPORT:-5433}; DB=${PGDATABASE:-hla_test}
HERE="$(cd "$(dirname "$0")" && pwd)"
N=${N:-20}
Q="psql -h $HOST -p $PORT -U postgres -d $DB -qtA -v ON_ERROR_STOP=1"

echo "== $N bidders storming lot 135 =="

$Q -c "delete from lot_events where lot_id=(select id from lots where lot_no=135);
       delete from bids       where lot_id=(select id from lots where lot_no=135);
       update lots set current_price_cents=0, bid_count=0, high_bidder=null,
              status='open', extension_count=0,
              ends_at=now()+interval '1 hour' where lot_no=135;" >/dev/null

for i in $(seq 1 "$N"); do
  U=$(printf '%08d-0000-4000-8000-000000000000' "$i")
  $Q -c "insert into auth.users(id) values ('$U') on conflict do nothing;
         insert into bidders(id, display_name) values ('$U','racer$i')
           on conflict do nothing;" >/dev/null
done

# every worker starts at the same wall-clock moment
GO=$(( $(date +%s) + 3 ))
for i in $(seq 1 "$N"); do
  U=$(printf '%08d-0000-4000-8000-000000000000' "$i")
  MAX=$(( 20000 + i * 1000 ))
  (
    while [ "$(date +%s)" -lt "$GO" ]; do :; done
    $Q -c "select set_config('test.uid','$U',false);
           do \$\$
           declare tries int := 0;
           begin
             loop
               tries := tries + 1;
               begin
                 perform place_bid(135, $MAX);
                 exit;
               exception
                 when sqlstate '22003' then
                   if tries > 40 then exit; end if;   -- outbid past our max
                   perform pg_sleep(0.02 * random());
                 when sqlstate 'P0001' then exit;     -- lot closed
               end;
             end loop;
           end \$\$;" >/dev/null 2>&1
  ) &
done
wait

echo "-- results"
$Q -c "
with best as (
  select distinct on (bidder_id) bidder_id, max_cents, placed_at, id
    from bids where lot_id=(select id from lots where lot_no=135)
   order by bidder_id, max_cents desc, placed_at asc, id asc),
r as (select *, row_number() over (order by max_cents desc, placed_at asc, id asc) rn
        from best)
select
  'distinct bidders on the lot: ' || (select count(*) from r) ||
  E'\n' || 'rows in bids (nothing lost): ' ||
    (select count(*) from bids where lot_id=(select id from lots where lot_no=135)) ||
  E'\n' || 'lot.bid_count agrees: ' ||
    (select (l.bid_count = (select count(*) from bids b where b.lot_id=l.id))::text
       from lots l where lot_no=135) ||
  E'\n' || 'exactly one high bidder: ' ||
    (select (high_bidder is not null)::text from lots where lot_no=135) ||
  E'\n' || 'leader is the top max: ' ||
    (select (l.high_bidder = (select bidder_id from r where rn=1))::text
       from lots l where lot_no=135) ||
  E'\n' || 'stored price = derived price: ' ||
    (select (l.current_price_cents = (select price_cents from resolve_price(l.id)))::text
       from lots l where lot_no=135) ||
  E'\n' || 'final price: \$' ||
    (select current_price_cents/100 from lots where lot_no=135) ||
    '  (runner-up max \$' || (select max_cents/100 from r where rn=2) || ')';"

echo
echo "== 10 simultaneous bids inside the two-minute window on lot 130 =="
$Q -c "delete from lot_events where lot_id=(select id from lots where lot_no=130);
       delete from bids       where lot_id=(select id from lots where lot_no=130);
       update lots set current_price_cents=0, bid_count=0, high_bidder=null,
              status='open', extension_count=0,
              ends_at=now()+interval '30 seconds' where lot_no=130;" >/dev/null

GO=$(( $(date +%s) + 3 ))
for i in $(seq 1 10); do
  U=$(printf '%08d-0000-4000-8000-000000000000' "$i")
  MAX=$(( 100000 + i * 5000 ))
  (
    while [ "$(date +%s)" -lt "$GO" ]; do :; done
    $Q -c "select set_config('test.uid','$U',false);
           do \$\$ begin
             begin perform place_bid(130, $MAX);
             exception when others then null; end;
           end \$\$;" >/dev/null 2>&1
  ) &
done
wait

$Q -c "select 'extensions recorded: ' || extension_count ||
              E'\n' || 'time left is still ~2 min, not 20: ' ||
              date_trunc('second', ends_at - now())::text
         from lots where lot_no=130;"
