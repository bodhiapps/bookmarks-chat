export interface BookmarkFixture {
  title: string;
  url: string;
}

export const BOOKMARK_FIXTURES: BookmarkFixture[] = [
  { title: 'Rust async programming guide', url: 'https://rust-lang.example/async' },
  { title: 'Tokio runtime internals', url: 'https://tokio.example/internals' },
  { title: 'Sourdough bread recipe', url: 'https://food.example/sourdough' },
  { title: 'Postgres full text search', url: 'https://pg.example/fts' },
];

export const UNIQUE_TERM = 'Sourdough';
