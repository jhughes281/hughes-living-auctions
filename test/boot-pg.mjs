// Start an embedded Postgres and leave it running for the test runner.
import EmbeddedPostgres from 'embedded-postgres';
import { rmSync, existsSync } from 'node:fs';

const DATA = process.env.PGDATA_DIR || './pgdata';
const PORT = 5433;

if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

await pg.initialise();
await pg.start();
console.log(JSON.stringify({ started: true, port: PORT }));

// keep alive until killed
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
