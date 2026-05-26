import { PGliteWorker } from '@electric-sql/pglite/worker';
import { live } from '@electric-sql/pglite/live';

async function spike() {
  const db = await PGliteWorker.create(
    new Worker(new URL('../db/pglite-worker.ts', import.meta.url), { type: 'module' }),
    { dataDir: 'idb://pglite-bookmarks-spike', extensions: { live } },
  );
  await db.waitReady;
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_textsearch;`);
  const res = await db.query<{ n: number }>('SELECT 1::int AS n');
  console.log('[offscreen-spike] pglite OK, SELECT 1 =', res.rows[0]?.n);
}
spike().catch((e) => console.error('[offscreen-spike] FAILED:', e));
