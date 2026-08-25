// Hughes Living Auctions — LOCAL DEVELOPMENT SERVER
//
// Stands in for Supabase while there is no cloud project: it serves the static
// site and exposes the same handful of calls the front end will make against
// Supabase later. Every auction decision still happens inside place_bid() in
// Postgres — this process only carries requests to it and streams changes back.
//
// DEV ONLY, and it means it:
//   * sign-in takes an email and no password. It exists so you can open two
//     browsers and bid against yourself. It is not authentication.
//   * it binds to 127.0.0.1 and refuses to start otherwise.
// Neither is acceptable anywhere but this machine. Supabase Auth replaces both.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SITE = join(HERE, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8754);
const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'hla_dev',
};

const pool = new pg.Pool({ ...PG, max: 12 });
pool.on('error', () => {});

// ---------------------------------------------------------------- sessions
// In memory on purpose: restarting the server signs everyone out, which is the
// correct blast radius for a fake login.
const sessions = new Map();           // token -> { uid, email, paddle }

// A stable uuid per email so signing in twice is the same bidder.
const uidFor = email =>
  (h => `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`)
  (createHash('sha256').update(email.trim().toLowerCase()).digest('hex'));

// ---------------------------------------------------------------- db helpers

// Run fn with the bidder's identity set for the transaction only. `set_config`
// with is_local = true dies with the transaction, so a pooled connection can
// never hand one bidder's uid to the next request that borrows it.
async function asBidder(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('test.uid', $1, true)`, [uid ?? '']);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// The column list anon is granted in 0001. Kept in one place so the local API
// cannot accidentally serve a column the cloud would withhold.
const PUBLIC_LOT_COLUMNS = `
  lot_no, status, category, title, alt_text, image_path, grade, pallet,
  found, fixed, still, retail_cents, opening_cents, buy_now_cents,
  opens_at, ends_at, extension_count, current_price_cents, bid_count`;

async function listLots() {
  const { rows } = await pool.query(
    `select ${PUBLIC_LOT_COLUMNS},
            min_next_cents(id) as min_next_cents
       from lots
      where status in ('open','closed','settled')
      order by ends_at asc`);
  return rows;
}

// ---------------------------------------------------------------- realtime
// One dedicated LISTEN connection fanned out to every browser over SSE.
const streams = new Set();
async function startListener() {
  const c = new pg.Client(PG);
  await c.connect();
  await c.query('listen lot_change');
  c.on('notification', msg => {
    const frame = `event: lot\ndata: ${msg.payload}\n\n`;
    for (const res of streams) res.write(frame);
  });
  c.on('error', async () => {           // reconnect rather than go silently deaf
    try { await c.end(); } catch {}
    setTimeout(startListener, 1000);
  });
}

// pg_cron is not available locally, so the sweeper runs here. place_bid already
// refuses a lot past ends_at, so this only settles status.
function startSweeper() {
  setInterval(async () => {
    try {
      const { rows: [r] } = await pool.query('select close_due_lots() as n');
      if (r.n > 0) console.log(`  swept ${r.n} lot(s) closed`);
    } catch {}
  }, 2000);
}

// ---------------------------------------------------------------- http utils
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
};

const readBody = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', d => {
    n += d.length;
    if (n > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
    catch { reject(new Error('bad json')); }
  });
  req.on('error', reject);
});

const sessionOf = req => {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? sessions.get(m[1]) : undefined;
};

// Turn a Postgres error into something the bid dialog can show a person.
// The rules live in SQL; these are only the words.
function bidError(e) {
  const code = e.code || '';
  if (code === '28000') return { status: 401, message: 'Sign in to bid.' };
  if (code === '42501') return { status: 403, message: 'This paddle cannot bid. Contact the office.' };
  if (code === 'P0002') return { status: 404, message: 'That lot does not exist.' };
  if (code === 'P0001') return { status: 409, message: e.message };
  if (code === '22003') return { status: 400, message: e.message };
  return { status: 500, message: 'Something went wrong placing that bid.' };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  // normalize first, then confirm the result is still inside SITE
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = join(SITE, rel === '' ? 'index.html' : rel);
  if (!file.startsWith(SITE)) { json(res, 403, { error: 'nope' }); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // --- server clock. The front end renders every countdown against this,
    // never against the browser's own clock, which can be wrong by minutes.
    if (p === '/api/time') return json(res, 200, { now: new Date().toISOString() });

    if (p === '/api/lots' && req.method === 'GET') {
      return json(res, 200, { now: new Date().toISOString(), lots: await listLots() });
    }

    if (p === '/api/signin' && req.method === 'POST') {
      const { email } = await readBody(req);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json(res, 400, { error: 'Enter an email address.' });
      }
      const uid = uidFor(email);
      const paddle = await asBidder(null, async c => {
        await c.query('insert into auth.users(id, email) values ($1,$2) on conflict do nothing', [uid, email]);
        await c.query(
          `insert into bidders (id, email, display_name) values ($1,$2,$3)
             on conflict (id) do nothing`, [uid, email, email.split('@')[0]]);
        const { rows: [b] } = await c.query('select paddle from bidders where id=$1', [uid]);
        return b.paddle;
      });
      const token = randomUUID();
      sessions.set(token, { uid, email, paddle });
      return json(res, 200, { token, email, paddle });
    }

    if (p === '/api/signout' && req.method === 'POST') {
      const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      sessions.delete(h);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const s = sessionOf(req);
      if (!s) return json(res, 200, { signedIn: false });
      const positions = await asBidder(s.uid, async c =>
        (await c.query('select * from my_positions()')).rows);
      return json(res, 200, { signedIn: true, email: s.email, paddle: s.paddle, positions });
    }

    if (p === '/api/bid' && req.method === 'POST') {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'Sign in to bid.' });
      const { lot_no, max_cents, protection, idempotency_key } = await readBody(req);
      try {
        const out = await asBidder(s.uid, async c =>
          (await c.query('select place_bid($1,$2,$3,$4) as r',
            [lot_no, max_cents, !!protection, idempotency_key || null])).rows[0].r);
        return json(res, 200, out);
      } catch (e) {
        const { status, message } = bidError(e);
        return json(res, status, { error: message });
      }
    }

    if (p === '/api/buy' && req.method === 'POST') {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'Sign in to buy.' });
      const { lot_no, protection, idempotency_key } = await readBody(req);
      try {
        const out = await asBidder(s.uid, async c =>
          (await c.query('select buy_now($1,$2,$3) as r',
            [lot_no, !!protection, idempotency_key || null])).rows[0].r);
        return json(res, 200, out);
      } catch (e) {
        const { status, message } = bidError(e);
        return json(res, status, { error: message });
      }
    }

    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      streams.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); streams.delete(res); });
      return;
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

if (HOST !== '127.0.0.1') { console.error('refusing to bind anywhere but loopback'); process.exit(1); }

await startListener();
startSweeper();
server.listen(PORT, HOST, () => {
  console.log(`Hughes Living Auctions — local dev server`);
  console.log(`  site  http://${HOST}:${PORT}`);
  console.log(`  db    ${PG.user}@${PG.host}:${PG.port}/${PG.database}`);
  console.log(`  NOTE  sign-in is passwordless and this is dev only.`);
});
