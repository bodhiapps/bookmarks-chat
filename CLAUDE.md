# bookmarks-chat

## Development workflow

- **Trunk-based development.** Commit directly to `main`; do not create long-lived feature branches. Keep changes small and integrate frequently.
- **Type checking:** `npm run typecheck` is a no-op (the root `tsconfig.json` is references-only). Use `npm run build` (`tsc -b && vite build`) to catch type errors.
- **Code style:** minimal to no comments — let the code speak.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — type-check + build
- `npm test` — unit tests (vitest)
- `npm run test:e2e` — Playwright e2e (starts an in-process Bodhi server; uses real OAuth)
