export interface BookmarkNode {
  id: string;
  title: string;
  url: string;
  folderPath: string;
  dateAdded: number;
}

interface RawNode {
  id: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: RawNode[];
}

export function flattenBookmarks(tree: RawNode[]): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  const walk = (nodes: RawNode[], path: string[]): void => {
    for (const n of nodes) {
      if (n.url) {
        out.push({
          id: n.id,
          title: n.title ?? '',
          url: n.url,
          folderPath: path.join('/'),
          dateAdded: n.dateAdded ?? 0,
        });
      } else if (n.children) {
        walk(n.children, n.title ? [...path, n.title] : path);
      }
    }
  };
  walk(tree, []);
  return out;
}
