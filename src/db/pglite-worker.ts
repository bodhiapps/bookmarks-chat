import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch } from '@electric-sql/pglite/pg_textsearch';
import { worker } from '@electric-sql/pglite/worker';

worker({
  async init(options) {
    return PGlite.create({
      ...options,
      extensions: { pg_textsearch },
      initialMemory: 128 * 1024 * 1024,
    });
  },
});
