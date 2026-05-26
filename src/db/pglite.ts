import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch } from '@electric-sql/pglite/pg_textsearch';
import { live } from '@electric-sql/pglite/live';
import { PGliteWorker } from '@electric-sql/pglite/worker';

export interface DocumentRow {
  id: string;
  title: string;
  url: string;
  folder: string;
  content: string;
  date_added: number;
}

const DOCUMENT_COLUMNS = [
  'id',
  'title',
  'url',
  'folder',
  'content',
  'date_added',
] as const satisfies readonly (keyof DocumentRow)[];

const UPSERT_BATCH = 200;
const SCHEMA_VERSION = '1';

const DOCUMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    folder      TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    date_added  BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_documents_bm25
    ON documents USING bm25 (content)
    WITH (text_config='english', k1=1.2, b=0.75);
`;

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pg_textsearch;
  ${DOCUMENTS_DDL}
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
    ON CONFLICT (key) DO NOTHING;
`;

export function buildPlaceholders(rowCount: number, cols: number): string {
  return Array.from({ length: rowCount }, (_, j) => {
    const offset = j * cols;
    return `(${Array.from({ length: cols }, (_, k) => `$${offset + k + 1}`).join(', ')})`;
  }).join(',');
}

type DbHandle = PGliteWorker | PGlite;
let current: { ns: string; promise: Promise<DbHandle> } | undefined;

function createDb(ns: string): Promise<DbHandle> {
  const dataDir = `idb://pglite-bookmarks-${ns}`;
  // In a worker-capable context (offscreen doc) use the worker; vitest/node falls back to in-process.
  try {
    return PGliteWorker.create(
      new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' }),
      { dataDir, extensions: { live } }
    );
  } catch {
    return PGlite.create({ dataDir, extensions: { pg_textsearch } });
  }
}

async function openDb(ns: string): Promise<DbHandle> {
  const db = await createDb(ns);
  await db.waitReady;
  await db.exec(SCHEMA_SQL);
  await migrateSchema(db);
  await db.query('SELECT 1');
  return db;
}

async function migrateSchema(db: DbHandle): Promise<void> {
  const res = await db.query<{ value: string }>(
    `SELECT value FROM meta WHERE key = 'schema_version'`
  );
  if (res.rows[0]?.value === SCHEMA_VERSION) return;
  await db.exec(`
    DROP TABLE IF EXISTS documents;
    ${DOCUMENTS_DDL}
    UPDATE meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema_version';
  `);
}

export function ensureDb(ns: string): Promise<DbHandle> {
  if (current?.ns === ns) return current.promise;
  if (current) {
    const prev = current.promise;
    void prev.then(db => db.close()).catch(() => {});
    current = undefined;
  }
  const promise = (async () => {
    try {
      return await openDb(ns);
    } catch (err) {
      console.warn('PGlite init failed; deleting volume and rebuilding', err);
      await deleteVolume(ns);
      return await openDb(ns);
    }
  })();
  promise.catch(() => {
    if (current?.promise === promise) current = undefined;
  });
  current = { ns, promise };
  return promise;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function deleteVolume(ns: string): Promise<void> {
  const marker = `pglite-bookmarks-${ns}`;
  const dbs = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    dbs
      .map(d => d.name)
      .filter((n): n is string => !!n && n.includes(marker))
      .map(deleteDatabase)
  );
}

export async function recoverPGlite(ns: string): Promise<void> {
  if (current?.ns === ns) {
    const prev = current.promise;
    current = undefined;
    try {
      await (await prev).close();
    } catch {
      /* already broken */
    }
  }
  await deleteVolume(ns);
}

export async function query<T>(ns: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await ensureDb(ns);
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function upsertDocuments(ns: string, rows: DocumentRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await ensureDb(ns);
  const columnList = DOCUMENT_COLUMNS.join(', ');
  const updateSet = DOCUMENT_COLUMNS.filter(c => c !== 'id')
    .map(c => `${c} = EXCLUDED.${c}`)
    .join(', ');
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    await db.transaction(async tx => {
      const placeholders = buildPlaceholders(batch.length, DOCUMENT_COLUMNS.length);
      const params = batch.flatMap(r => DOCUMENT_COLUMNS.map(c => r[c]));
      await tx.query(
        `INSERT INTO documents (${columnList}) VALUES ${placeholders}
         ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
        params
      );
    });
  }
}

export async function deleteDocuments(ns: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await ensureDb(ns);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  await db.query(`DELETE FROM documents WHERE id IN (${placeholders})`, ids);
}

export async function documentCount(ns: string): Promise<number> {
  const rows = await query<{ n: number }>(ns, 'SELECT COUNT(*)::int AS n FROM documents');
  return rows[0]?.n ?? 0;
}

export async function optimizeBm25Index(ns: string): Promise<void> {
  const db = await ensureDb(ns);
  await db.exec('REINDEX INDEX idx_documents_bm25');
  await db.exec('CHECKPOINT');
}
