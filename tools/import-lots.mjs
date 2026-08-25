#!/usr/bin/env node
// Hughes Living Auctions — bulk lot importer
//
// Takes the spreadsheet you already fill in off the bench and turns a pallet
// into listed lots. Validates the whole file first and writes nothing unless
// every row passes, because a half-imported pallet is worse than none.
//
//   node tools/import-lots.mjs pallet-0451.csv --images ~/photos/0451 \
//        --open "2026-08-28 09:00" --close "2026-08-30 19:00" --stagger 4
//
//   ...prints what it would do. Add --commit to actually write.
//
// Credentials come from the environment, never from a file in this repo:
//   local     PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (defaults to dev)
//   supabase  DATABASE_URL=postgres://...  (the pooled connection string)
//
// This is an operator tool. It connects to Postgres directly and does NOT go
// through the browser API, so `lots` stays unwritable by any client — which is
// a property worth keeping.

import pg from 'pg';
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : (argv[i + 1] || '').startsWith('--') ? true : argv[i + 1];
};
const has = name => argv.includes('--' + name);

const csvPath = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== undefined
  ? !argv[argv.indexOf(a) - 1].startsWith('--') || ['--commit', '--dry-run'].includes(argv[argv.indexOf(a) - 1])
  : true) || argv.find(a => a.endsWith('.csv'));

const COMMIT   = has('commit');
const IMAGES   = flag('images');
const OPEN_AT  = flag('open', 'now');
const CLOSE_AT = flag('close');
const STAGGER  = Number(flag('stagger', 4));
const PALLET   = flag('pallet');
const PREFIX   = flag('image-prefix', 'img/');

if (!csvPath || !existsSync(csvPath)) {
  console.error(`usage: node tools/import-lots.mjs <file.csv> [options]

  --images <dir>        folder holding the item photos named in the CSV
  --open  "<datetime>"  when bidding opens        (default: now)
  --close "<datetime>"  when the FIRST lot closes (required to commit)
  --stagger <minutes>   gap between closings      (default: 4)
  --pallet <id>         pallet number, if the CSV has no pallet column
  --image-prefix <p>    stored path prefix        (default: img/)
  --commit              actually write. Without it, nothing is changed.

Columns: category, title, grade, found, fixed, still
Optional: ref, pallet, retail, buy_now, reserve, image, alt, opening`);
  process.exit(1);
}

// ---------------------------------------------------------------- csv
// Small RFC4180-ish reader: quoted fields, embedded commas, doubled quotes,
// CRLF. Enough for a spreadsheet export, and no dependency.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

const raw = parseCSV(readFileSync(csvPath, 'utf8'));
if (raw.length < 2) { console.error('That file has a header and no rows.'); process.exit(1); }

const header = raw[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
const records = raw.slice(1).map((cells, i) => {
  const o = { __line: i + 2 };
  header.forEach((h, j) => { o[h] = (cells[j] ?? '').trim(); });
  return o;
});

// ---------------------------------------------------------------- helpers
const GRADES = new Set(['a', 'b', 'c', 'd']);

function toCents(v, label, line, problems, { required = false } = {}) {
  if (v === '' || v == null) {
    if (required) problems.push({ line, msg: `${label} is required` });
    return null;
  }
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0) { problems.push({ line, msg: `${label} "${v}" is not a number` }); return null; }
  return Math.round(n * 100);
}

function parseWhen(s, label) {
  if (!s || s === 'now') return new Date();
  // Treat a bare "YYYY-MM-DD HH:MM" as local time, which is what a person means.
  const t = new Date(String(s).replace(' ', 'T'));
  if (isNaN(t.getTime())) { console.error(`${label} "${s}" is not a date I understand.`); process.exit(1); }
  return t;
}

const money = c => '$' + (c / 100).toLocaleString('en-US');

// ---------------------------------------------------------------- validate
const problems = [];
const seenRef = new Map();
const seenTitle = new Map();

const lots = records.map(r => {
  const line = r.__line;
  const need = (k, label, hint) => {
    const v = (r[k] || '').trim();
    if (!v) problems.push({ line, msg: `${label} is empty${hint ? '. ' + hint : ''}` });
    return v;
  };

  const category = need('category', 'category');
  const title    = need('title', 'title');
  const found    = need('found', 'the Found line');
  const fixed    = need('fixed', 'the Fixed line');
  // The one that matters. An empty Still line removes the reason anyone
  // trusts a damaged-goods listing, so it is an error, not a warning.
  const still    = need('still', 'the Still line',
                        'Write "Nothing worth printing" if the piece genuinely came back clean');

  const grade = (r.grade || '').trim().toLowerCase();
  if (!GRADES.has(grade)) {
    problems.push({ line, msg: `grade "${r.grade}" must be one of a, b, c, d` });
  }
  if (grade === 'd' && !/no protection|as-is|as is|parts|project/i.test(still)) {
    problems.push({ line, msg: 'grade D carries no protection — the Still line should say so plainly' });
  }

  const pallet  = (r.pallet || PALLET || '').trim() || null;
  const retail  = toCents(r.retail,  'retail',  line, problems);
  const buyNow  = toCents(r.buy_now, 'buy_now', line, problems);
  const reserve = toCents(r.reserve, 'reserve', line, problems);
  const opening = toCents(r.opening, 'opening', line, problems) ?? 100;

  if (buyNow !== null && buyNow % 100 !== 0) {
    problems.push({ line, msg: `buy_now ${money(buyNow)} must be whole dollars — the published increments are` });
  }
  if (buyNow !== null && buyNow <= opening) {
    problems.push({ line, msg: `buy_now ${money(buyNow)} must be above the ${money(opening)} opening` });
  }
  if (reserve !== null && reserve < opening) {
    problems.push({ line, msg: `reserve ${money(reserve)} is below the ${money(opening)} opening` });
  }
  if (retail !== null && buyNow !== null && buyNow > retail) {
    problems.push({ line, msg: `buy_now ${money(buyNow)} is above retail ${money(retail)} — nobody buys that` });
  }

  // Images
  let imagePath = null, imageSource = null;
  const imageName = (r.image || '').trim();
  if (imageName) {
    if (IMAGES && IMAGES !== true) {
      const src = join(resolve(String(IMAGES)), imageName);
      if (!existsSync(src)) problems.push({ line, msg: `image "${imageName}" not found in ${IMAGES}` });
      else imageSource = src;
    } else if (!existsSync(join(SITE, PREFIX, imageName))) {
      problems.push({ line, msg: `image "${imageName}" not in ${PREFIX} and no --images folder given` });
    }
    imagePath = PREFIX + imageName;
  } else {
    problems.push({ line, msg: 'no image — a damaged-goods lot without a photo will not sell' });
  }

  const alt = (r.alt || '').trim() || `${title}.`;

  // Stable key for re-import
  const ref = (r.ref || '').trim() ||
              `${pallet || 'nopallet'}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (seenRef.has(ref)) {
    problems.push({ line, msg: `duplicate ref "${ref}" — also on line ${seenRef.get(ref)}` });
  } else seenRef.set(ref, line);

  const tkey = title.toLowerCase();
  if (seenTitle.has(tkey) && !(r.ref || '').trim()) {
    problems.push({ line, msg: `same title as line ${seenTitle.get(tkey)} — give both a ref column to tell them apart` });
  } else seenTitle.set(tkey, line);

  return { line, ref, category, title, alt, grade, pallet, found, fixed, still,
           retail, buyNow, reserve, opening, imagePath, imageSource, imageName };
});

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${basename(csvPath)}. Nothing was written.\n`);
  problems.sort((a, b) => a.line - b.line)
          .forEach(p => console.error(`  line ${String(p.line).padStart(3)}   ${p.msg}`));
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------- schedule
const opensAt = parseWhen(OPEN_AT, '--open');
if (!CLOSE_AT && COMMIT) {
  console.error('--close is required to commit: every lot needs a closing time.');
  process.exit(1);
}
const firstClose = CLOSE_AT ? parseWhen(CLOSE_AT, '--close') : new Date(Date.now() + 3 * 86400e3);
lots.forEach((l, i) => {
  l.endsAt = new Date(firstClose.getTime() + i * STAGGER * 60000);
});
if (lots[0].endsAt <= opensAt) {
  console.error('The first lot closes before bidding opens. Check --open and --close.');
  process.exit(1);
}

// ---------------------------------------------------------------- report
const fmt = d => d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric',
                                             hour: 'numeric', minute: '2-digit' });
console.log(`\n${basename(csvPath)} — ${lots.length} lots, all valid`);
console.log(`  opens   ${fmt(opensAt)}`);
console.log(`  closes  ${fmt(lots[0].endsAt)} to ${fmt(lots[lots.length - 1].endsAt)}, ${STAGGER} min apart\n`);
const w = Math.min(46, Math.max(...lots.map(l => l.title.length)));
lots.forEach(l => {
  console.log(`  ${l.grade.toUpperCase()}  ${l.title.slice(0, w).padEnd(w)}  ` +
              `${(l.retail ? money(l.retail) : '—').padStart(8)}` +
              `${l.buyNow ? '  BIN ' + money(l.buyNow) : ''}` +
              `${l.reserve ? '  reserve ' + money(l.reserve) : ''}`);
});

if (!COMMIT) {
  console.log(`\nNothing written. Re-run with --commit to list these.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- write
const conn = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : { host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5433),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'hla_dev' };

const db = new pg.Client(conn);
await db.connect();

let created = 0, updated = 0;
try {
  await db.query('begin');
  for (const l of lots) {
    // Copy the photo in before the row references it.
    if (l.imageSource) {
      const destDir = join(SITE, PREFIX);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(l.imageSource, join(destDir, l.imageName));
    }

    const { rows } = await db.query(`
      insert into lots (import_key, category, title, alt_text, image_path, grade, pallet,
                        found, fixed, still, retail_cents, buy_now_cents, reserve_cents,
                        opening_cents, status, opens_at, ends_at, original_ends_at)
      values ($1,$2,$3,$4,$5,$6::lot_grade,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16,$16)
      on conflict (import_key) where import_key is not null do update set
        category = excluded.category, title = excluded.title, alt_text = excluded.alt_text,
        image_path = excluded.image_path, grade = excluded.grade, pallet = excluded.pallet,
        found = excluded.found, fixed = excluded.fixed, still = excluded.still,
        retail_cents = excluded.retail_cents, reserve_cents = excluded.reserve_cents
        -- Deliberately NOT updated on re-import: buy_now_cents, opening_cents, ends_at,
        -- status. Those change the deal under people who have already bid.
      where lots.bid_count = 0
      returning lot_no, (xmax = 0) as inserted`,
      [l.ref, l.category, l.title, l.alt, l.imagePath, l.grade, l.pallet,
       l.found, l.fixed, l.still, l.retail, l.buyNow, l.reserve, l.opening,
       opensAt.toISOString(), l.endsAt.toISOString()]);

    if (!rows.length) {
      console.log(`  skipped  ${l.title} — already has bids, not touching it`);
      continue;
    }
    rows[0].inserted ? created++ : updated++;
    console.log(`  ${rows[0].inserted ? 'listed ' : 'updated'}  lot ${rows[0].lot_no}  ${l.title}`);
  }
  await db.query('commit');
  console.log(`\n${created} listed, ${updated} updated.\n`);
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(`\nRolled back, nothing written: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
