# 05 — Search tool & agent wiring

A **local** `search_bookmarks` AgentTool (pi-agent-core), **not** an MCP server — mirroring
yt-chat `apps/web/src/hooks/useYouTubeSearchTool.ts`, `services/search.ts`, `hooks/useAgent.ts`.
The only difference from yt-chat: the tool lives in the UI but PGlite lives in the offscreen
doc, so `execute()` queries via a `db:query` message instead of calling PGlite directly.

## Tool definition — `src/hooks/useBookmarkSearchTool.ts`

```ts
import { Type } from '@sinclair/typebox';            // (same TypeBox helper yt-chat uses)
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { queryOffscreen } from '@/lib/messages';      // db:query request/response helper

const parameters = Type.Object({
  query: Type.Optional(Type.String({ description: 'Free-text terms; ranked by BM25 relevance.' })),
  folder: Type.Optional(Type.String({ description: 'Filter to bookmarks whose folder path contains this text.' })),
  sort: Type.Optional(StringEnum(['relevance', 'recent'], {
    description: "'relevance' (default, needs query) or 'recent' (newest first).",
  })),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10, max 25).' })),
});

const DESCRIPTION =
  "Search the user's own browser bookmarks (title, URL, folder, and — for recent ones — the " +
  'page content as markdown) indexed locally. Returns ranked rows with title, folder, date ' +
  'added, and the URL. Present results as a GitHub-flavored Markdown table.';

export function useBookmarkSearchTool(): AgentTool[] {
  return useMemo(() => {
    const tool: AgentTool = {
      name: 'search_bookmarks',
      label: 'search_bookmarks',
      description: DESCRIPTION,
      parameters,
      execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
        const { documents } = await queryOffscreen('db:count', {});
        if (documents === 0) {
          return textResult('No bookmarks are indexed yet. Wait for indexing to finish and try again.');
        }
        const rows = await queryOffscreen('db:query', params); // SearchHit[]
        if (rows.length === 0) return textResult('No matching bookmarks found.');
        return { content: [{ type: 'text', text: JSON.stringify(rows) }], details: rows };
      },
    };
    return [tool];
  }, []);
}
```

## Query (offscreen) — `src/services/search.ts`

Runs in the offscreen doc against PGlite. Parameterized (no SQL injection), port yt-chat
`search.ts` 1:1 with bookmark columns:

```ts
export interface SearchParams { query?: string; folder?: string; sort?: 'relevance'|'recent'; limit?: number; }
export interface SearchHit { title: string; folder: string; dateAdded: number; url: string; }

const DEFAULT_LIMIT = 10, MAX_LIMIT = 25;

export async function searchDocuments(ns: string, p: SearchParams): Promise<SearchHit[]> {
  const q = p.query?.trim(); const folder = p.folder?.trim();
  const useRelevance = p.sort !== 'recent' && !!q;
  const where: string[] = []; const args: unknown[] = [];
  if (folder) { args.push(folder); where.push(`folder ILIKE '%' || $${args.length} || '%'`); }

  let orderBy: string;
  if (useRelevance) {
    args.push(q);
    orderBy = `content <@> to_bm25query($${args.length}, 'idx_documents_bm25')`; // BM25 distance, best first
  } else {
    orderBy = `date_added DESC`;
  }
  args.push(Math.min(p.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sql = `
    SELECT title, folder, date_added AS "dateAdded", url
    FROM documents
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT $${args.length}`;
  return query<SearchHit>(ns, sql, args);
}
```

Wire `db:query`/`db:count` in `src/offscreen/offscreen.ts` to call `searchDocuments` /
`documentCount` and reply over `chrome.runtime`.

> Helpers `StringEnum`, `textResult`, and the offscreen `query`/`documentCount` primitives are
> ported from yt-chat (`apps/web/src/lib/*`, `services/search.ts`) — copy them over rather than
> reinventing.

## Agent wiring — `src/hooks/useAgent.ts`

Merge the bookmark tool into `agent.state.tools` alongside any MCP tools (yt-chat does exactly
this), and set a bookmark-aware system prompt:

```ts
agent.state.tools = [...bookmarkTools, ...mcpTools];   // bookmarkTools from useBookmarkSearchTool()
agent.state.systemPrompt = BOOKMARK_SYSTEM_PROMPT;
```

`BOOKMARK_SYSTEM_PROMPT` (adapt yt-chat's):
```
You are a helpful assistant for the user's browser bookmarks.

When the user asks to find, recall, or summarize bookmarks, call the `search_bookmarks` tool.
- For "latest"/"recent"/"newest", pass sort='recent'.
- For topical questions ("about X", "find ... on Y"), rely on relevance (default) via query.
- Use folder to narrow to a folder by name.

Present results as a GitHub-flavored Markdown table with columns: Title | Folder | Added | Link.
Render Link as a Markdown link to the row's url. If there are no results, say so plainly.
```

## Rendering
Ensure assistant markdown (tables) renders: add `react-markdown` + `remark-gfm` if the chat
components don't already render markdown (yt-chat uses both). Reuse existing `MessageBubble`/
`ToolCallMessage` components; only the renderer needs GFM table support.

## Acceptance criteria
- Asking *"search my bookmarks for <term> and show a table"* triggers a `search_bookmarks` tool
  call (visible in `ToolCallMessage`) and renders a GFM table of matching fixture bookmarks.
- `sort='recent'` returns newest-first; `folder` filters; `limit` is clamped to ≤ 25.
- With nothing indexed, the tool returns the friendly "no bookmarks indexed yet" message.
