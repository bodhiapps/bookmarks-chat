import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './search';

describe('buildSearchQuery', () => {
  it('uses BM25 relevance order when query present', () => {
    const { sql, args } = buildSearchQuery({ query: 'rust async' });
    expect(sql).toContain('to_bm25query');
    expect(sql).toContain('<@>');
    expect(args).toContain('rust async');
  });

  it('orders by date_added desc for recent sort or empty query', () => {
    expect(buildSearchQuery({ sort: 'recent', query: 'x' }).sql).toContain('date_added DESC');
    expect(buildSearchQuery({}).sql).toContain('date_added DESC');
  });

  it('adds folder ILIKE filter and clamps limit to 25', () => {
    const { sql, args } = buildSearchQuery({ folder: 'Dev', limit: 1000 });
    expect(sql).toContain('folder ILIKE');
    expect(args[args.length - 1]).toBe(25);
  });
});
