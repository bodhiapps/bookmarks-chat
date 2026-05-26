import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { documentCount, optimizeBm25Index, query, recoverPGlite, upsertDocuments } from './pglite';

const NS = 'test';
afterEach(async () => {
  await recoverPGlite(NS);
});

describe('pglite documents store', () => {
  it('upserts, counts, and BM25-ranks bookmarks', async () => {
    await upsertDocuments(NS, [
      {
        id: 'a',
        title: 'Rust async book',
        url: 'https://rust-lang.org/async',
        folder: 'Dev/Rust',
        content: 'Rust async book https://rust-lang.org/async Dev/Rust',
        date_added: 2,
      },
      {
        id: 'b',
        title: 'Cooking pasta',
        url: 'https://food.example/pasta',
        folder: 'Food',
        content: 'Cooking pasta https://food.example/pasta Food',
        date_added: 1,
      },
    ]);
    await optimizeBm25Index(NS);
    expect(await documentCount(NS)).toBe(2);

    const hits = await query<{ id: string }>(
      NS,
      `SELECT id FROM documents ORDER BY content <@> to_bm25query($1, 'idx_documents_bm25') LIMIT 5`,
      ['rust async']
    );
    expect(hits[0]?.id).toBe('a');
  });

  it('upsert replaces on conflicting id', async () => {
    await upsertDocuments(NS, [
      { id: 'a', title: 'v1', url: 'u', folder: '', content: 'v1 u', date_added: 1 },
    ]);
    await upsertDocuments(NS, [
      { id: 'a', title: 'v2', url: 'u', folder: '', content: 'v2 u', date_added: 1 },
    ]);
    const rows = await query<{ title: string }>(NS, 'SELECT title FROM documents WHERE id=$1', [
      'a',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('v2');
  });
});
