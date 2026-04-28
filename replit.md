# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Project: DoD AI Tool Marketplace MVP

A TradeWinds-style marketplace where service members sign in once, build a structured operator profile + personal RAG library, then launch authorized AI tools that automatically receive their context and mission-relevant document snippets via a one-time launch token.

### Artifacts
- `artifacts/marketplace` — main storefront (React + Vite). Pages: Landing, Dashboard, Catalog (Context Block verification gate), CatalogBrowse (`/catalog/browse`, tool list), CatalogDetail, Profile, Library, Launches, Admin.
- `artifacts/api-server` — Express + Drizzle. Routes for auth, profile, catalog, library, launches, admin, dashboard.
- `artifacts/context-echo` — demonstration tool that exchanges a launch token and renders the user/profile/RAG primer payload it received.
- `artifacts/mockup-sandbox` — design canvas (unchanged template).

### Launch token flow
1. User clicks "Launch with my context" → `POST /api/tools/:toolId/launch` mints a one-time `launchToken` (5 min TTL) and returns `launchUrl` (e.g. `/context-echo/?token=...`).
2. Marketplace opens that URL in a new tab.
3. The tool calls `POST /api/tools/context-exchange` with the token. The server **atomically** consumes the token (UPDATE…WHERE token=? AND used_at IS NULL AND expires_at > now() RETURNING *) and returns the user, sanitized profile, RAG primer queries + snippets, and a longer-lived `sessionToken` (1 hour) that the tool can use to call `/api/tools/library-query` for follow-up RAG queries.

### RAG
- Documents are paragraph-chunked (~900 chars target) on ingest and stored in `doc_chunks`.
- Search uses Postgres `to_tsquery` with OR'd prefix lexemes (e.g. `uas:* | platoon:* | recon:*`) so any matching keyword in a chunk produces a hit. Stopwords are stripped client-side before building the tsquery.
- Primer queries are generated per-launch by Gemini (`gemini-3-flash-preview` via the Replit Gemini AI integration) from `profile + tool description`, then **always merged** with profile-derived queries (primaryMission, dutyTitle+MOS, aiUseCases, unit) to guarantee personal-doc recall even when the LLM focuses on tool terminology. The same Gemini model also powers the profile intake chat. Helper module: `artifacts/api-server/src/lib/gemini-helpers.ts`.

### Auth & admin
- Replit OIDC via `@workspace/replit-auth-web`. Layout fetches `/api/profile` to determine `isAdmin` (which lives on UserProfile, not AuthUser).
- The first user is a normal operator. Promote to admin with `UPDATE profiles SET is_admin = true WHERE user_id = '...'`.

### Profile autosave
- Profile edits are debounced (400ms) and use a version counter to discard out-of-order responses, so rapid typing can't cause a stale PUT response to clobber newer input.

### Smart Mission Context (Auto-ingest)
- `lib/mil-data` is the curated source of truth for branches, MOS/rate/AFSC catalogs, units, and per-(branch, MOS|unit) doctrine package URLs (public DoD doctrine PDFs).
- The Profile page's Branch dropdown drives MOS and Unit typeaheads; clearing or changing the branch resets the dependent fields.
- When `PUT /api/profile` resolves the branch+MOS or unit to a curated package, the server fires `startIngestPackage` (fire-and-forget) which downloads each PDF with bounded concurrency, dedups against existing `documents.source_url`, and records progress in `ingest_jobs`.
- Documents created this way carry `auto_source` (e.g. `mos:army:11B`, `unit:army:1id`) and `source_url`. The Library page renders an `AutoSourceBadge` next to such docs and a filter chip row (All / Uploaded / Auto-ingested) for quick triage.
- Endpoints: `POST /api/library/auto-ingest` (synchronous trigger by source string) and `GET /api/library/auto-ingest/status?source=...` (poll job state). The Profile page's `IngestStatusPanel` polls the latter every 1.5s while a job is running.
