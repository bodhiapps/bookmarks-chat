import { query } from '@/db/pglite';

export interface SearchParams {
  query?: string;
  folder?: string;
  sort?: 'relevance' | 'recent';
  limit?: number;
}
export interface SearchHit {
  title: string;
  folder: string;
  dateAdded: number;
  url: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export function buildSearchQuery(p: SearchParams): { sql: string; args: unknown[] } {
  const q = p.query?.trim();
  const folder = p.folder?.trim();
  const useRelevance = p.sort !== 'recent' && !!q;

  const where: string[] = [];
  const args: unknown[] = [];
  if (folder) {
    args.push(folder);
    where.push(`folder ILIKE '%' || $${args.length} || '%'`);
  }

  let orderBy: string;
  if (useRelevance) {
    args.push(q);
    orderBy = `content <@> to_bm25query($${args.length}, 'idx_documents_bm25')`;
  } else {
    orderBy = `date_added DESC`;
  }

  args.push(Math.min(p.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sql = `
    SELECT title, folder, date_added AS "dateAdded", url
    FROM documents
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT $${args.length}`;
  return { sql, args };
}

export async function searchDocuments(ns: string, p: SearchParams): Promise<SearchHit[]> {
  const { sql, args } = buildSearchQuery(p);
  return query<SearchHit>(ns, sql, args);
}
