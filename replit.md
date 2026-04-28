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
- `artifacts/brief-drafter` — Mission Brief Drafter. Exchanges a launch token, then lets the user pick a brief type (SITREP / OPORD paragraph / Training brief) + topic and calls `POST /api/tools/draft-brief` (server runs profile-aware RAG and Claude `claude-sonnet-4-6`) to produce an editable, copyable markdown brief.
- `artifacts/mockup-sandbox` — design canvas (unchanged template).

### Launch token flow
1. User clicks "Launch with my context" → `POST /api/tools/:toolId/launch` mints a one-time `launchToken` (5 min TTL) and returns `launchUrl` (e.g. `/context-echo/?token=...`).
2. Marketplace opens that URL in a new tab.
3. The tool calls `POST /api/tools/context-exchange` with the token. The server **atomically** consumes the token (UPDATE…WHERE token=? AND used_at IS NULL AND expires_at > now() RETURNING *) and returns the user, sanitized profile, RAG primer queries + snippets, and a longer-lived `sessionToken` (1 hour) that the tool can use to call `/api/tools/library-query` for follow-up RAG queries.

### RAG
- Documents are paragraph-chunked (~900 chars target) on ingest and stored in `doc_chunks`.
- Search uses Postgres `to_tsquery` with OR'd prefix lexemes (e.g. `uas:* | platoon:* | recon:*`) so any matching keyword in a chunk produces a hit. Stopwords are stripped client-side before building the tsquery.
- Primer queries are generated per-launch by Gemini (`gemini-3-flash-preview` via the Replit Gemini AI integration) from `profile + tool description`, then **always merged** with profile-derived queries (primaryMission, dutyTitle+MOS, aiUseCases, unit) to guarantee personal-doc recall even when the LLM focuses on tool terminology. The same Gemini model also powers the profile intake chat. Helper module: `artifacts/api-server/src/lib/gemini-helpers.ts`.

### Library uploads (PDF/DOCX/MD/TXT)
- Binary uploads use object storage (App Storage / GCS) via presigned PUT URLs. Flow:
  1. Client → `POST /api/storage/uploads/request-url` → presigned URL + objectPath
  2. Client → PUT file directly to GCS (browser shows upload progress via XHR)
  3. Client → `POST /api/library/documents` with `{ storageObjectPath, sizeBytes, ... }`
- The server creates the document with `status="uploaded"` and kicks off async processing (`artifacts/api-server/src/lib/document-processing.ts`): downloads from GCS, runs `extractDocumentText` (pdf-parse for PDFs, mammoth for DOCX, utf-8 for MD/TXT), chunks the text, inserts chunks, and flips status to `ready` or `failed` (with `errorMessage`).
- Ownership is enforced via the object's ACL custom-metadata: when a user POSTs `storageObjectPath` to `/library/documents`, the server claims the object by writing `{ owner: userId, visibility: "private" }` if no ACL exists, or rejects with 403 if a different owner is already recorded. Random UUID object paths plus this claim defend against IDOR.
- There is intentionally no `GET /storage/objects/*` route — private files are only ever read server-side by the document-processing pipeline.
- The Library page polls `GET /api/library/documents` every 1.5s while any doc is in a non-terminal state, so users see `uploaded → processing → ready/failed` live.
- Paste-text uploads still use the synchronous `content` field on the same endpoint.

### Auth & admin
- Replit OIDC via `@workspace/replit-auth-web`. Layout fetches `/api/profile` to determine `isAdmin` (which lives on UserProfile, not AuthUser).
- The first user is a normal operator. Promote to admin with `UPDATE profiles SET is_admin = true WHERE user_id = '...'`.

### Profile autosave
- Profile edits are debounced (400ms) and use a version counter to discard out-of-order responses, so rapid typing can't cause a stale PUT response to clobber newer input.

### Admin tool builder + hosting modes
- Tools have a `hostingType` of either `cloud` (existing behavior) or `local_install`. Cloud tools open `launchUrl` in a new tab; local tools render a "Runs locally" pill, and launching opens a modal with install instructions, an installer download link, and an "Open with my context" button that navigates to `localLaunchUrlPattern` with `{token}` substituted.
- Admin form (`Admin.tsx` `ToolForm`) is sectioned: 1. Source (GitHub repo picker via `useAdminListGithubRepos` + `adminGetGithubRepoMetadata`, plus a re-sync button using `useSyncToolFromGithub`), 2. Metadata (with per-field "Generate with AI" buttons on short/long description), 3. Hosting (cloud-vs-local switch, installer file upload via presigned PUT through `/api/storage/upload-url`), 4. Context & RAG (purpose + RAG query templates, both AI-draftable), 5. Publish.
- AI drafts are produced by `POST /api/admin/tools/draft-text` (Gemini helper `draftToolText`), seeded with the tool's name/vendor and the most recently imported GitHub README (held only in form-local state, never persisted).
- GitHub access goes through `lib/github.ts`, which uses `@replit/connectors-sdk` to proxy authenticated requests via the connected GitHub integration (no PAT needed).
- Installer files land in object storage under `uploads/<uuid>` keys; the catalog/launch responses serve them as `/api/storage/objects/uploads/<uuid>`.

### Smart Mission Context (Auto-ingest)
- `lib/mil-data` is the curated source of truth for branches, MOS/rate/AFSC catalogs, units, and per-(branch, MOS|unit) doctrine package URLs (public DoD doctrine PDFs).
- The Profile page's Branch dropdown drives MOS and Unit typeaheads; clearing or changing the branch resets the dependent fields.
- When `PUT /api/profile` resolves the branch+MOS or unit to a curated package, the server fires `startIngestPackage` (fire-and-forget) which downloads each PDF with bounded concurrency, dedups against existing `documents.source_url`, and records progress in `ingest_jobs`.
- Documents created this way carry `auto_source` (e.g. `mos:army:11B`, `unit:army:1id`) and `source_url`. The Library page renders an `AutoSourceBadge` next to such docs and a filter chip row (All / Uploaded / Auto-ingested) for quick triage.
- Endpoints: `POST /api/library/auto-ingest` (synchronous trigger by source string) and `GET /api/library/auto-ingest/status?source=...` (poll job state). The Profile page's `IngestStatusPanel` polls the latter every 1.5s while a job is running.

### Mission context presets
- Each user has one or more **presets** (named profile snapshot + scoped library doc IDs). Tables: `presets` (jsonb `profileSnapshot`, unique `[userId,name]`) and `preset_documents` (composite PK `[presetId,documentId]`). `profiles.activePresetId` points at the user's current preset.
- `ensureActivePreset(userId)` lazy-backfills a "Default" preset from the existing profile + all the user's existing docs whenever `activePresetId` is null. Used at every preset-aware entry point so existing users get migrated transparently. There is no migrations dir — schema is `drizzle-kit push`'d.
- API: `GET/POST /api/profile/presets`, `PUT/DELETE /api/profile/presets/:id`, `POST /api/profile/presets/:id/duplicate`, `POST /api/profile/presets/:id/activate`. Per-doc tagging: `PUT /api/library/documents/:id/presets`. `DocumentSummary.presetIds` and `UserProfile.activePresetId` are part of the API surface.
- Launches and library-query use `getActiveContext(userId)` to read the snapshot back as a profile and pass `preset.documentIds` to RAG. RAG's `documentIds` filter early-returns `[]` on an empty list so a deliberately empty preset returns no chunks (instead of falling back to all docs).
- Frontend: header switcher in `Layout.tsx`, presets management section in `Profile.tsx`, per-doc tag editor + "active preset only" filter in `Library.tsx`. Switching invalidates profile, presets, library, and dashboard query keys.
- Invariant: a user can never have zero presets — DELETE rejects when only one remains, and deleting the active preset hands off `activePresetId` to another preset before removing the row.

### Pre-launch context preview & redaction
- `POST /api/tools/:toolId/launch-preview` returns the candidate payload (profile fields with redactable display values, top RAG snippets, the queries that produced them, and the user's `launchPreference`) WITHOUT minting a token or recording a launch. Profile fields and snippets reflect the user's **active preset** (snapshot + preset doc scope) so the preview matches what would actually be sent.
- `POST /api/tools/:toolId/launch` accepts an optional body `{selectedFieldKeys?, selectedSnippetIds?, additionalNote?}`. When present, only those keys/snippets are stored on the launch row and surfaced via context-exchange. When omitted (e.g. preference="direct"), the server includes everything (full snapshot profile, top snippets scoped to preset docs).
- Snippets are snapshotted into `launches.shared_snippets` (jsonb) at mint time, so the context-exchange step is fully deterministic and library edits after launch don't change what the tool sees.
- At `/api/tools/context-exchange`, the snapshot profile is passed through `redactProfileForLaunch(snapshotProfile, sharedFieldKeys)` so excluded fields are nulled out before being serialized. The Context Block (cb_*) rides on the live profile and is not subject to redaction. Primer queries are empty (no fresh RAG) — only the user-approved snippets are sent.
- `profiles.launchPreference` ("preview" | "direct", default "preview") controls whether the marketplace shows the redaction dialog or launches immediately. Toggle lives on /profile and inside the dialog.
- /launches surfaces `sharedFieldKeys`, `sharedSnippets`, and `additionalNote` per row so users can audit exactly what each tool received.
