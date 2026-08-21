// Build the local dev database from scratch: shim, core migrations, seed.
// Safe to re-run; it drops and rebuilds.
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE = join(HERE, '..');
const base = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};
const DB = process.env.PGDATABASE || 'hla_dev';

const admin = new pg.Client({ ...base, database: 'postgres' });
await admin.connect();
await admin.query(`drop database if exists ${DB} with (force)`);
await admin.query(`create database ${DB}`);
await admin.end();

const db = new pg.Client({ ...base, database: DB });
db.on('notice', n => { if (/pg_cron/.test(n.message)) console.log(`  note   ${n.message}`); });
await db.connect();

const steps = [
  ['local_1_auth.sql',                            join(HERE, 'local_1_auth.sql')],
  ['0001_auction_core.sql',   join(SITE, 'supabase/migrations/0001_auction_core.sql')],
  ['0002_realtime_and_close.sql', join(SITE, 'supabase/migrations/0002_realtime_and_close.sql')],
  ['local_2_realtime.sql',                    join(HERE, 'local_2_realtime.sql')],
  ['seed.sql',                             join(SITE, 'supabase/seed.sql')],
];
for (const [label, path] of steps) {
  await db.query(readFileSync(path, 'utf8'));
  console.log(`  applied  ${label}`);
}

const { rows: [c] } = await db.query('select count(*)::int n from lots');
console.log(`  seeded   ${c.n} lots`);

// Export the seeded lots as the demo backend's data, so the static build and
// the database can never drift apart in wording, grades or condition ledger.
const { rows } = await db.query(`
  select lot_no, category, title, alt_text, image_path, grade, pallet,
         found, fixed, still, retail_cents, opening_cents, buy_now_cents,
         extract(epoch from (ends_at - now()))::int as ends_in_s
    from lots order by lot_no`);
writeFileSync(join(SITE, 'lots-demo.json'), JSON.stringify(rows, null, 1) + '\n');
console.log(`  wrote    lots-demo.json (${rows.length} lots)`);

await db.end();
