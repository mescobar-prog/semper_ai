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
- `artifacts/marketplace` — main storefront (React + Vite). Pages: Landing, Dashboard, Catalog, CatalogDetail, Profile, Library, Launches, Admin.
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
- Primer queries are generated per-launch by Anthropic from `profile + tool description`, then **always merged** with profile-derived queries (primaryMission, dutyTitle+MOS, aiUseCases, unit) to guarantee personal-doc recall even when the LLM focuses on tool terminology.

### Auth & admin
- Replit OIDC via `@workspace/replit-auth-web`. Layout fetches `/api/profile` to determine `isAdmin` (which lives on UserProfile, not AuthUser).
- The first user is a normal operator. Promote to admin with `UPDATE profiles SET is_admin = true WHERE user_id = '...'`.

### Profile autosave
- Profile edits are debounced (400ms) and use a version counter to discard out-of-order responses, so rapid typing can't cause a stale PUT response to clobber newer input.
