import { describe, expect, it } from 'vitest';
import { flattenBookmarks } from './bookmarks';

describe('flattenBookmarks', () => {
  it('flattens url nodes with folder paths and skips folders', () => {
    const tree = [
      { id: '0', title: '', children: [
        { id: '1', title: 'Bookmarks Bar', children: [
          { id: '10', title: 'Dev', children: [
            { id: '100', title: 'Rust', url: 'https://rust-lang.org', dateAdded: 3 },
          ]},
          { id: '11', title: 'Direct', url: 'https://example.com', dateAdded: 2 },
        ]},
      ]},
    ];
    const flat = flattenBookmarks(tree);
    expect(flat).toEqual([
      { id: '100', title: 'Rust', url: 'https://rust-lang.org', folderPath: 'Bookmarks Bar/Dev', dateAdded: 3 },
      { id: '11', title: 'Direct', url: 'https://example.com', folderPath: 'Bookmarks Bar', dateAdded: 2 },
    ]);
  });
});
