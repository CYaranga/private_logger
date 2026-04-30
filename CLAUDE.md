# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Monorepo, two independently deployed Cloudflare Workers:

- `backend/` — Hono API on Workers, D1 SQLite. Single-file router at `src/index.ts` (~1500 lines, all routes live there). Replay subsystem split into `src/replay/{handler,ssrf,sanitize}.ts`.
- `frontend/` — React 18 + Vite, deployed as a Worker with static assets. Main UI in `src/App.tsx` (single ~1900-line component file containing the modals, mobile + desktop layouts, filter sheets, charts).
- `docs/`, `API_DOCUMENTATION.md`, `FLUTTER_INTEGRATION.md` — integration docs for mobile clients.

There is also a per-directory `frontend/CLAUDE.md`. Read it before frontend work — it contains live URLs and deploy specifics.

## Common commands

Always run scripts from inside the relevant subdir (`backend/` or `frontend/`). Bun is the package manager.

Backend (`cd backend`):
```bash
bun run dev          # wrangler dev → http://localhost:8787
bun run deploy       # wrangler deploy
bun run db:migrate   # applies schema.sql to local D1
bun run test         # vitest run (uses @cloudflare/vitest-pool-workers)
bun run test:watch
bunx vitest run src/replay/ssrf.test.ts        # single test file
bunx vitest run -t "rejects private IPs"        # single test by name
```

Frontend (`cd frontend`):
```bash
bun run dev          # Vite on http://localhost:3000 (talks to PROD API — no local proxy)
bun run build        # tsc -b && vite build
bun run deploy       # build + wrangler deploy
bun run test
bunx vitest run src/replayVersions.test.ts
```

D1 prod queries: `bunx wrangler d1 execute private_logs_db --remote --command "SELECT ..."` from `backend/`.

## Architecture (cross-file picture)

**Data flow**

```
Mobile/Web client ─POST /logs─▶ backend Worker (Hono) ─▶ D1 (private_logs_db)
                                       │
                                       ├─ cron 0 3 * * * ─▶ archives table (logs > 7d)
                                       │
                Frontend Worker ◀─GET /logs?filters─┘
                (logger.chrisyaranga.dev)
```

**Two D1 databases bound to the backend Worker** (`backend/wrangler.toml`):
- `DB` → `private_logs_db` — logs, archives, users, sessions, log_replays.
- `ANALYTICS_DB` → `behaviour_analytics_db` — separate behaviour tracking schema (migration `0003`).

Migrations live in `backend/migrations/` numbered `000N_*.sql`. Apply with wrangler d1 execute against the right binding. They are not auto-run by deploy.

**Auth model**: cookie-based sessions for the dashboard. `POST /auth/login` issues an HttpOnly session token stored in `sessions` table; `authMiddleware` gates replay endpoints (`/logs/:id/replays`, `/replay`, `/replays/:id`). Public ingestion (`POST /logs`) is unauthenticated by design — clients send freely. Admin user seeded via `backend/scripts/create-admin.ts`.

**Source resolution**: `resolveSource()` in `backend/src/index.ts` derives `LogSource` from the incoming payload's `source` field, then falls back to `payload.app` (recent fix — see commit `6071692`). Don't bypass it; mobile clients rely on the fallback.

**Replay subsystem** (`backend/src/replay/`): re-executes logged HTTP requests against the original endpoint. SSRF guard (`ssrf.ts`) blocks private IPs / localhost / link-local before fetch; `sanitize.ts` strips auth headers before persisting; `handler.ts` does the actual fetch and stores a versioned `log_replays` row. Frontend surfaces this via `Replay.tsx` + `ReplayPanel`/`ReplayEditor`/`ReplayTabs`.

**Archiving**: cron `0 3 * * *` moves logs older than 7 days into the `archives` table (one row per date, JSON blob). `/archives/export-all` and `/archives/:date/download` serve them as JSON. The frontend has both an "Export All" (archives → JSON) and a client-side "Export CSV" (current filtered logs, paginates `fetchLogs` and builds CSV in-browser).

**Frontend state shape**: `App.tsx` owns everything — `filters`, `logs`, `page`, `perPage`, mobile/desktop branching via `useIsMobile()`. Filter changes reset page to 1; `loadData()` is `useCallback`-memoized on `[filters, page, perPage]` and re-runs on a 30s auto-refresh interval. Same `Filters` object is passed to `fetchLogs`, `bulkDeleteLogs`, and the CSV exporter — keep that contract when adding filters.

## CI/CD

Two workflows in `.github/workflows/`:

- `ci.yml` — typecheck + tests on push/PR to `main`, both backend and frontend in parallel jobs.
- `deploy.yml` — **commit-message-gated**. Backend deploys only if HEAD message contains `backend` or `api`; frontend only if it contains `frontend` or `ui`. `workflow_dispatch` deploys both. Use conventional prefixes (`feat:`, `fix:`, `ci:`, `docs:`, etc.) and put the keyword in the subject — otherwise nothing ships.

Local git tooling under `.githooks/` and `scripts/` (commit reminder launchd plist, quick-commit, git-stats). `setup-git-tools.sh` wires them up; not required for normal work.

## Related projects (cross-repo references)

These projects sit alongside this one and exchange data with it. Paths are absolute on this machine.

- **`rebeca-mobile-app`** — `/Users/chrisyaranga/Documents/EulerInnovations/rebeca-mobile-app`
  React Native / Expo monorepo (`packages/{api,i18n,stores,theme,ui,unity}` + `app/`). Primary client of this logger: sends logs via `POST /logs` and is the canonical source of `LogSource` values like `rebeca-web-desktop`, `rebeca-web-mobile`. Owns the **user-behaviour analytics** feature — see `docs/superpowers/plans/2026-04-19-expand-user-behaviour-analytics.md`. Behaviour events land in `behaviour_analytics_db` (the `ANALYTICS_DB` binding on this Worker, migration `backend/migrations/0003_create_analytics_tables.sql`).
- **`rebeca-backend`** — `/Users/chrisyaranga/Documents/EulerInnovations/rebeca-backend`
  Hasura + custom services backing the Rebeca product. Independent of this logger but shares user IDs that flow through `logs.user_id`. Touch this when investigating end-to-end traces from mobile → backend → logger.

When tracking/logging schema changes here affect either project (new fields, new `LogSource` values, breaking payload changes), update the corresponding client there in lockstep.

### Worktree rule for cross-repo edits

**If a task requires changes in `rebeca-mobile-app` or `rebeca-backend`, always work inside a git worktree of that project, never the main checkout.** Both projects are actively developed and a stray edit on `main` will collide with in-flight work.

```bash
# example for rebeca-mobile-app
cd /Users/chrisyaranga/Documents/EulerInnovations/rebeca-mobile-app
git worktree add .worktrees/<task-slug> -b <task-branch>
cd .worktrees/<task-slug>
# ... make edits, commit, push, open PR ...
```

`rebeca-mobile-app` already uses `.worktrees/` (see existing `.worktrees/ios-test`). Mirror that convention. Same rule for `rebeca-backend` — create the worktree dir if missing. Do not edit either repo's primary working tree directly from a private_logger session.

## Gotchas

- Frontend dev server hits **production API** — there's no proxy. To test against local backend, change `API_BASE` in `frontend/src/api.ts` temporarily.
- `backend/src/index.ts` is one giant file by choice; resist splitting it without a clear plan — routes share helpers and types defined inline.
- D1 has no migrations runner; new SQL files in `backend/migrations/` must be applied manually via `wrangler d1 execute` against both `--local` and `--remote`.
- Replay requests are network-egressing from a Worker. Any change to `ssrf.ts` is security-critical — keep its tests passing.
- The `logs` table has grown columns over time (level, category, http_method, endpoint, status_code, duration_ms, source, device_id). `CreateLogInput` accepts them all as optional; the README's tiny schema example is outdated — read the migrations for truth.
