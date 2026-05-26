import { useMemo } from 'react';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { StringEnum, Type } from '@mariozechner/pi-ai';
import { documentCount } from '@/db/pglite';
import { searchDocuments, type SearchParams } from '@/services/search';

const NS = 'default';

export const BOOKMARK_SYSTEM_PROMPT = `You are a helpful assistant for the user's browser bookmarks.

When the user asks to find, recall, or summarize bookmarks, call the \`search_bookmarks\` tool.
- For "latest"/"recent"/"newest", pass sort='recent'.
- For topical questions ("about X", "find ... on Y"), rely on relevance (default) via query.
- Use folder to narrow to a folder by name.

Present results as a GitHub-flavored Markdown table with columns: Title | Folder | Added | Link.
Render Link as a Markdown link to the row's url. If there are no results, say so plainly.`;

const parameters = Type.Object({
  query: Type.Optional(Type.String({ description: 'Free-text terms; ranked by BM25 relevance.' })),
  folder: Type.Optional(
    Type.String({ description: 'Filter to bookmarks whose folder path contains this text.' })
  ),
  sort: Type.Optional(
    StringEnum(['relevance', 'recent'], {
      description: "'relevance' (default, needs query) or 'recent' (newest first).",
    })
  ),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10, max 25).' })),
});

const DESCRIPTION =
  "Search the user's own browser bookmarks (title, URL, folder) indexed locally. Returns ranked " +
  'rows with title, folder, date added, and the URL. Present results as a GitHub-flavored Markdown table.';

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: null };
}

export function useBookmarkSearchTool(): AgentTool[] {
  return useMemo(() => {
    const tool: AgentTool = {
      name: 'search_bookmarks',
      label: 'search_bookmarks',
      description: DESCRIPTION,
      parameters,
      execute: async (_id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
        if ((await documentCount(NS)) === 0) {
          return textResult(
            'No bookmarks are indexed yet. Wait for indexing to finish and try again.'
          );
        }
        const rows = await searchDocuments(NS, (params ?? {}) as SearchParams);
        if (rows.length === 0) return textResult('No matching bookmarks found.');
        return { content: [{ type: 'text', text: JSON.stringify(rows) }], details: rows };
      },
    };
    return [tool];
  }, []);
}
