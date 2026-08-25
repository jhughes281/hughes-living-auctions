// Rebuild a throwaway DB, apply the auction core, run the whole suite.
// Replaces test/run.sh + 02_race_test.sh, which need psql and bash; the
// embedded Postgres build ships only server binaries, so we drive it over
// the wire with node-postgres instead. Same SQL, same assertions.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const { Client } = pg;
const PORT = 5433;
const base = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres' };
const DB = 'hla_test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
// psql meta-commands (\set, \pset, \echo) are not SQL; strip them, keep \echo as a header
const strip = sql => sql.split('\n').map(l => {
  const m = l.match(/^\\echo\s+'(.*)'\s*$/);
  if (m) return `do $ECHO$ begin raise notice '%', ${JSON.stringify(m[1]).replace(/^"|"$/g, "'")}; end $ECHO$;`;
  return /^\\/.test(l) ? '' : l;
}).join('\n');

let pass = 0, fail = 0;
const notices = [];
function attach(c, collect = true) {
  c.on('notice', n => { if (collect) { notices.push(n.message); console.log(n.message); } });
  c.on('error', () => {});
}

async function connect(database) {
  const c = new Client({ ...base, database });
  await c.connect();
  return c;
}

// ---------------------------------------------------------------- rebuild
const admin = await connect('postgres');
await admin.query(`drop database if exists ${DB} with (force)`);
await admin.query(`create database ${DB}`);
await admin.end();

const db = await connect(DB);
attach(db, false);
console.log('== applying the auction core ==');
for (const f of ['./00_auth_shim.sql',
                 '../supabase/migrations/0001_auction_core.sql',
                 '../supabase/migrations/0002_realtime_and_close.sql',
                 '../supabase/migrations/0003_auth_bridge.sql',
                 '../supabase/migrations/0004_hardening.sql',
                 '../supabase/seed.sql']) {
  try {
    await db.query(read(f));
    console.log(`  applied  ${f.split('/').pop()}`);
  } catch (e) {
    console.log(`  FAILED   ${f.split('/').pop()}: ${e.message}`);
    if (e.position) console.log(`           at char ${e.position}`);
    process.exit(1);
  }
}
const { rows: [seeded] } = await db.query('select count(*)::int n from lots');
console.log(`  seeded   ${seeded.n} lots\n`);

// ---------------------------------------------------------------- engine
console.log('== engine rules ==');
db.removeAllListeners('notice');
attach(db);
try {
  await db.query(strip(read('./01_engine_test.sql')));
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
  fail++;
}
await db.end();

// ---------------------------------------------------------------- exposure
console.log('\n== exposure: what anon and a signed-in bidder can read ==');
const exp = await connect(DB);
attach(exp);
try {
  await exp.query(strip(read('./03_exposure_test.sql')));
} catch (e) {
  console.log(`  ERROR: ${e.message}`);
  fail++;
}
await exp.end();

for (const n of notices) {
  if (/^\s*ok\b/.test(n) || /\bok\b/.test(n)) pass++;
  if (/FAIL/i.test(n)) fail++;
}

// ---------------------------------------------------------------- race
const N = 20;
const LOT = 135;
console.log(`\n== ${N} bidders storming lot ${LOT} ==`);
const setup = await connect(DB);
attach(setup, false);
await setup.query(`
  delete from lot_events where lot_id=(select id from lots where lot_no=${LOT});
  delete from bids       where lot_id=(select id from lots where lot_no=${LOT});
  update lots set current_price_cents=0, bid_count=0, high_bidder=null,
         status='open', extension_count=0,
         ends_at=now()+interval '1 hour' where lot_no=${LOT};`);
const uid = i => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
for (let i = 1; i <= N; i++) {
  await setup.query(`insert into auth.users(id, email) values ($1,$2) on conflict do nothing`, [uid(i), `racer${i}@test.local`]);
  await setup.query(`insert into bidders(id, display_name) values ($1,$2) on conflict do nothing`, [uid(i), `racer${i}`]);
}

// every worker connects first, then all fire at one wall-clock instant
const racers = [];
for (let i = 1; i <= N; i++) { const c = await connect(DB); attach(c, false); racers.push(c); }
const GO = Date.now() + 1500;
await Promise.all(racers.map(async (c, idx) => {
  const i = idx + 1, MAX = 20000 + i * 1000;
  await new Promise(r => setTimeout(r, Math.max(0, GO - Date.now())));
  await c.query(`select set_config('test.uid',$1,false)`, [uid(i)]);
  // retry past our own "you were outbid" until the max cannot clear the floor
  await c.query(`
    do $$ declare tries int := 0;
    begin
      loop
        tries := tries + 1;
        begin
          perform place_bid(${LOT}, ${MAX});
          exit;
        exception
          when sqlstate '22003' then
            if tries > 40 then exit; end if;
            perform pg_sleep(0.02 * random());
          when sqlstate 'P0001' then exit;
        end;
      end loop;
    end $$;`).catch(() => {});
}));
await Promise.all(racers.map(c => c.end()));

const check = await connect(DB);
attach(check, false);
const { rows: [r] } = await check.query(`
  with best as (
    select distinct on (bidder_id) bidder_id, max_cents, placed_at, id
      from bids where lot_id=(select id from lots where lot_no=${LOT})
     order by bidder_id, max_cents desc, placed_at asc, id asc),
  r as (select *, row_number() over (order by max_cents desc, placed_at asc, id asc) rn from best)
  select (select count(*) from r)::int                                              as distinct_bidders,
         (select count(*) from bids where lot_id=(select id from lots where lot_no=${LOT}))::int as bid_rows,
         (select l.bid_count = (select count(*) from bids b where b.lot_id=l.id) from lots l where lot_no=${LOT}) as count_agrees,
         (select high_bidder is not null from lots where lot_no=${LOT})              as has_leader,
         (select l.high_bidder = (select bidder_id from r where rn=1) from lots l where lot_no=${LOT}) as leader_is_top,
         (select l.current_price_cents = (select price_cents from resolve_price(l.id)) from lots l where lot_no=${LOT}) as cache_matches,
         (select current_price_cents from lots where lot_no=${LOT})::int             as final_price,
         (select max_cents from r where rn=2)::int                                   as runner_up`);

const assert = (label, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${label}  (${got})`);
};
console.log(`  distinct bidders on the lot: ${r.distinct_bidders}`);
console.log(`  rows in bids (nothing lost): ${r.bid_rows}`);
assert('lot.bid_count agrees with the bids table', r.count_agrees, true);
assert('exactly one high bidder', r.has_leader, true);
assert('leader is the top max', r.leader_is_top, true);
assert('stored price = derived price', r.cache_matches, true);
console.log(`  final price $${r.final_price / 100}  (runner-up max $${r.runner_up / 100})`);

// ---------------------------------------------------------------- clock
console.log(`\n== 10 simultaneous bids inside the two-minute window on lot 130 ==`);
await check.query(`
  delete from lot_events where lot_id=(select id from lots where lot_no=130);
  delete from bids       where lot_id=(select id from lots where lot_no=130);
  update lots set current_price_cents=0, bid_count=0, high_bidder=null,
         status='open', extension_count=0,
         ends_at=now()+interval '30 seconds' where lot_no=130;`);

const clockers = [];
for (let i = 1; i <= 10; i++) { const c = await connect(DB); attach(c, false); clockers.push(c); }
const GO2 = Date.now() + 1500;
await Promise.all(clockers.map(async (c, idx) => {
  const i = idx + 1, MAX = 100000 + i * 5000;
  await new Promise(r => setTimeout(r, Math.max(0, GO2 - Date.now())));
  await c.query(`select set_config('test.uid',$1,false)`, [uid(i)]);
  await c.query(`do $$ begin begin perform place_bid(130, ${MAX}); exception when others then null; end; end $$;`).catch(() => {});
}));
await Promise.all(clockers.map(c => c.end()));

const { rows: [k] } = await check.query(`
  select extension_count::int,
         extract(epoch from (ends_at - now()))::int as secs_left
    from lots where lot_no=130`);
console.log(`  extensions recorded: ${k.extension_count}`);
const sane = k.secs_left <= 121 && k.secs_left > 100;
sane ? pass++ : fail++;
console.log(`  ${sane ? 'ok  ' : 'FAIL'}  time left is ~2 min, not 20  (${k.secs_left}s)`);

await check.end();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
