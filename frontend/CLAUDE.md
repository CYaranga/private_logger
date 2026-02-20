# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Private Logger is a full-stack logging system for mobile applications. This is the **frontend** directory containing a React log viewer UI that displays logs from a Hono API backend.

- **Frontend**: React 18 + TypeScript + Vite, deployed to Cloudflare Workers
- **Backend**: Hono on Cloudflare Workers with D1 SQLite database (in `/backend`)
- **Live URLs**: Frontend at `logger.chrisyaranga.dev`, API at `private-logger-api.christian-yaranga-05.workers.dev`

## Commands

```bash
# Development
bun run dev          # Start Vite dev server on http://localhost:3000

# Build & Deploy
bun run build        # TypeScript check + Vite build + restructure for Workers
bun run deploy       # Build and deploy to Cloudflare Workers

# Backend (from /backend directory)
bun run dev          # Start Hono server on http://localhost:8787
bun run deploy       # Deploy API to Cloudflare Workers
bun run db:migrate   # Run D1 database migrations
```

## Architecture

```
Mobile App (Flutter/React Native)
    ↓ POST /logs
Cloudflare Workers (Hono API) ← D1 SQLite Database
    ↑ GET /logs, /stats, etc.
React Frontend (this directory)
```

**Key files:**
- `src/App.tsx` - Main component: log table, filters, pagination, archives, stats dashboard
- `src/api.ts` - API client functions (fetchLogs, fetchStats, deleteLog, etc.)
- `src/types.ts` - TypeScript interfaces (Log, Stats, Filters, Archive, etc.)
- `wrangler.toml` - Cloudflare Workers config with custom domain routing

**Frontend connects to production API by default**, even in dev mode. The base path is `/`.

## Build Process

The build script (`bun run build`) does:
1. TypeScript compilation with `tsc -b`
2. Vite bundling into `dist/`

Deployed to `logger.chrisyaranga.dev` via Cloudflare Workers with static assets.

## Database Schema

Two tables in D1:
- `logs` - Main log entries with fields: id, user_id, message, metadata, environment (dev/test/prod), level (debug/info/warn/error), category, http_method, endpoint, request_data, response_data, status_code, duration_ms, created_at
- `archives` - Archived logs older than 7 days (auto-archived daily at 3 AM UTC via cron)

## CI/CD

GitHub Actions workflows:
- `ci.yml` - Type checks and builds on push/PR
- `deploy.yml` - Auto-deploys when commit message contains "frontend"/"ui" or "backend"/"api"

Uses conventional commit prefixes: feat:, fix:, ci:, docs:, style:, refactor:, etc.
