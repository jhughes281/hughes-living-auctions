#!/usr/bin/env node
// Move the photographs that are already in the repo into Supabase Storage,
// and repoint the rows at them.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... \
//     node tools/images-to-storage.mjs           # says what it would do
//   ...add --commit to actually upload and repoint.
//
// Why: git is not an image host. Deleting a photo does not shrink the
// repository — every version stays in history forever, and every clone drags
// the lot. Sixteen files migrate in a minute; nine hundred do not.
//
// Safe to re-run. Uploads use upsert, and rows already pointing at a storage
// URL are left alone.

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE   = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COMMIT = process.argv.includes('--commit');
const BUCKET = 'lots';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SB_URL || !SB_KEY) {
  console.error(`Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

  SUPABASE_URL         Settings -> API -> Project URL
  SUPABASE_SERVICE_KEY Settings -> API Keys -> a SECRET key

The secret key bypasses row level security. Set it in your shell for this run;
never put it in a file in this repo.`);
  process.exit(1);
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
               '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

const conn = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : { host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5433),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'hla_dev' };

const db = new pg.Client(conn);
await db.connect();

// Everything the site currently points at, from both places that hold a path.
const { rows: images } = await db.query(`
  select i.id, i.path, i.kind, l.lot_no, l.pallet
    from lot_images i join lots l on l.id = i.lot_id
   where i.path not like 'http%'
   order by l.lot_no, i.position`);

const { rows: thumbs } = await db.query(`
  select lot_no, pallet, image_path
    from lots
   where image_path is not null and image_path <> '' and image_path not like 'http%'
   order by lot_no`);

if (!images.length && !thumbs.length) {
  console.log('\nNothing to move — every path is already a URL.\n');
  await db.end();
  process.exit(0);
}

const key = (pallet, path) =>
  `${(pallet || 'nopallet').replace(/[^\w-]/g, '')}/${path.split('/').pop()}`;
const publicUrl = k => `${SB_URL}/storage/v1/object/public/${BUCKET}/${k}`;

// Check every file exists before sending anything, so a missing photo stops
// the run rather than leaving half the lots repointed.
const missing = [];
for (const r of images) if (!existsSync(join(SITE, r.path))) missing.push(r.path);
for (const t of thumbs) if (!existsSync(join(SITE, t.image_path))) missing.push(t.image_path);
if (missing.length) {
  console.error(`\n${missing.length} file(s) referenced by the database are not on disk:\n`);
  [...new Set(missing)].forEach(m => console.error('  ' + m));
  console.error('\nNothing was uploaded.\n');
  await db.end();
  process.exit(1);
}

const bytes = [...new Set([...images.map(i => i.path), ...thumbs.map(t => t.image_path)])]
  .reduce((n, p) => n + readFileSync(join(SITE, p)).length, 0);

console.log(`\n${images.length} gallery row(s), ${thumbs.length} card thumbnail(s)`);
console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB to ${BUCKET} on ${SB_URL}\n`);
for (const r of images) {
  console.log(`  lot ${String(r.lot_no).padEnd(4)} ${r.kind.padEnd(7)} ${r.path}  ->  ${key(r.pallet, r.path)}`);
}

if (!COMMIT) {
  console.log('\nNothing uploaded. Re-run with --commit.\n');
  await db.end();
  process.exit(0);
}

async function upload(localPath, k) {
  const body = readFileSync(join(SITE, localPath));
  const res = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${k}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SB_KEY}`,
      'content-type': MIME[extname(localPath).toLowerCase()] || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
}

let moved = 0;
try {
  await db.query('begin');

  for (const r of images) {
    const k = key(r.pallet, r.path);
    await upload(r.path, k);
    await db.query('update lot_images set path = $1 where id = $2', [publicUrl(k), r.id]);
    moved++;
    console.log(`  moved  lot ${r.lot_no}  ${r.kind}`);
  }

  for (const t of thumbs) {
    const k = key(t.pallet, t.image_path);
    await upload(t.image_path, k);           // upsert: usually the same object
    await db.query('update lots set image_path = $1 where lot_no = $2', [publicUrl(k), t.lot_no]);
  }

  await db.query('commit');
  console.log(`\n${moved} photograph(s) moved. The files in img/ are now unused —`);
  console.log('check the site renders, then remove them in a separate commit.\n');
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(`\nRolled back, no rows repointed: ${e.message}`);
  console.error('Anything already uploaded is harmless; re-running upserts over it.\n');
  process.exitCode = 1;
} finally {
  await db.end();
}
