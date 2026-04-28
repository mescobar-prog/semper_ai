# Overview

This project is an MVP for a DoD AI Tool Marketplace, akin to a TradeWinds-style platform. Its core purpose is to enable service members to securely access and utilize authorized AI tools. Users will create structured operator profiles and personal RAG libraries. When launching an AI tool, their relevant context and mission-specific document snippets are automatically provided via a one-time launch token.

The marketplace aims to streamline the deployment and use of AI capabilities within the DoD, ensuring secure and context-aware interactions. Key capabilities include:
- Secure single sign-on for service members (Replit OIDC).
- Creation and management of operator profiles and personal RAG (Retrieval-Augmented Generation) libraries.
- A catalog of AI tools with a context block verification gate.
- A launch token flow for secure and context-aware tool execution.
- Advanced RAG implementation with semantic and keyword search capabilities.
- Document upload and processing for various formats (PDF, DOCX, MD, TXT).
- Admin tools for managing tools, including GitHub integration for source synchronization and AI-assisted content drafting.
- Smart Mission Context auto-ingestion based on military data.
- User-defined mission context presets for tailored RAG and profile snapshots.
- Pre-launch context preview and redaction capabilities to control shared information.

# User Preferences

I prefer iterative development with clear communication on major changes. Please ask before making any significant architectural or design decisions. I appreciate concise explanations and direct answers.

# System Architecture

The project is structured as a pnpm workspace monorepo utilizing TypeScript (v5.9) targeting Node.js 24. The backend is built with Express 5, using PostgreSQL and Drizzle ORM for data persistence. Zod is used for validation, and Orval handles API codegen from an OpenAPI specification. `esbuild` is used for CJS bundling.

## Monorepo Structure:
- `artifacts/marketplace`: Frontend application built with React and Vite, handling user interfaces for landing, dashboard, catalog, profile, library, launches, and admin functionalities.
- `artifacts/api-server`: Backend API built with Express 5 and Drizzle ORM, providing routes for authentication, profile management, catalog, library, launches, admin, and dashboard.
- `artifacts/context-echo`: A demonstration tool for exchanging launch tokens and rendering received context.
- `artifacts/brief-drafter`: An AI tool for drafting mission briefs using Claude (claude-sonnet-4-6) and profile-aware RAG.
- `artifacts/mockup-sandbox`: A design canvas template.

## Core Features and Implementations

### AI Tools and Marketplace
- **Marketplace Storefront**: A React + Vite frontend provides pages for Landing, Dashboard, Catalog (with context block verification), Catalog Browsing, Tool Details, Profile, Library, Launches, and Admin.
- **API Server**: An Express + Drizzle backend handles routes for authentication, user profiles, tool catalog, document library, tool launches, and administrative functions.
- **Tool Launch Flow**: Users initiate a launch, receiving a one-time `launchToken` (5 min TTL) and a `launchUrl`. The tool then exchanges this token for user context (profile, RAG primer) and a longer-lived `sessionToken` (1 hour) for follow-up RAG queries.
- **Tool Hosting**: Tools can be `cloud` hosted (standard launch URL) or `local_install` (provides installation instructions and a local launch URL pattern).
- **Admin Tool Builder**: An admin interface (`ToolForm`) allows managing tools, including integrating with GitHub for source control, generating metadata (with AI assistance), configuring hosting (including installer file uploads), and defining context/RAG settings. AI-drafted text for tool descriptions is generated using Gemini. GitHub integration uses `@replit/connectors-sdk` for authenticated requests.

### Retrieval-Augmented Generation (RAG)
- **Document Chunking**: Documents are chunked using a token-aware and structure-aware algorithm that prioritizes Markdown headings, pseudo-headings, blank lines, and sentences. Chunks store `tokenCount` and `headingTrail`.
- **Embeddings**: In-process embeddings are generated using `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2` (384-dim, quantized int8). The model downloads on first use and is warmed on startup.
- **Vector Database**: Embeddings are stored in PostgreSQL using `pgvector` with an HNSW cosine index.
- **Search Logic**: Semantic search (embed query → cosine top-K) is primary. If semantic search fails (low similarity, no hits, embedding failure), it falls back to `to_tsquery` keyword search.
- **Embedding Backfill**: A server startup job backfills missing embeddings for existing document chunks.
- **RAG Primer Queries**: Gemini (via Replit Gemini AI integration) generates primer queries based on profile and tool description, always merging them with profile-derived queries for personal document recall.

### User Profile and Context Management
- **Persistent Profile**: User identity information (branch, rank, MOS, dutyTitle, etc.) is stored in `profiles`.
- **Context Block**: A task-dependent 6-element Context Block (who/what/when/where/risk/experience + lastEvaluation) is stored separately in `context_blocks`.
- **Profile API**: `GET/PUT /api/profile` manages the `ProfileEnvelope` containing `UserProfile` and `ContextBlockState`.
- **Profile Autosave**: Debounced saving with version countering prevents stale data from clobbering newer input.

### Document Library and Processing
- **Binary Uploads**: Uses presigned PUT URLs for object storage (App Storage / GCS). Client uploads directly, then notifies the server to create a document entry.
- **Async Document Processing**: Documents are processed asynchronously: downloaded from object storage, text extracted (pdf-parse, mammoth, utf-8), chunked, embedded, and indexed. Status updates (`uploaded`, `processing`, `ready`, `failed`) are reflected in the UI.
- **Ownership Enforcement**: Document ownership is enforced via object ACL custom-metadata, preventing IDOR.
- **Smart Mission Context (Auto-ingest)**: Curated military doctrine (PDFs) can be automatically ingested based on user's branch/MOS/unit. Ingestion status is tracked and displayed.
- **Retry Mechanism**: Failed documents can be retried with `POST /api/library/documents/:id/retry`. The endpoint dispatches on metadata: auto-ingested rows (`autoSource` + `sourceUrl`) re-fetch and re-extract from the source URL, while user-uploaded rows (`storageObjectPath`) re-run the async extraction pipeline against the existing GCS blob. User-upload retries are capped at 2 attempts; after that the UI prompts the user to delete and re-upload the file.

### Authentication and Administration
- **Replit OIDC**: Authentication uses Replit OIDC via `@workspace/replit-auth-web`.
- **Admin Promotion**: The first user is an operator. Subsequent users can be promoted to admin by listing their email in `ADMIN_EMAILS` workspace secret. Admin status is checked on every login.
- **Admin/Operator View Toggle**: Admins can switch between `admin` and `operator` views. This is a presentation-only toggle; server-side gates (`requireAdmin`) still check the true `isAdmin` status.

### Mission Context Presets
- **Presets**: Users can create named profile snapshots with scoped library document IDs. `profiles.activePresetId` tracks the current active preset.
- **Preset Management API**: Endpoints for creating, retrieving, updating, deleting, duplicating, and activating presets, as well as associating documents with presets.
- **Active Context**: `getActiveContext(userId)` retrieves the snapshot profile and document IDs from the active preset for launches and library queries.

### Pre-launch Context Preview & Redaction
- **Launch Preview**: `POST /api/tools/:toolId/launch-preview` provides a preview of the candidate payload (profile fields, RAG snippets, queries) based on the active preset, without minting a token.
- **Context Redaction**: When launching, users can select specific profile fields and snippets to share. Unselected fields are redacted, and snippets are snapshotted.
- **Launch Preference**: Users can set a `launchPreference` ("preview" or "direct") to control whether the redaction dialog appears or if the tool launches immediately.
- **Auditability**: The `/launches` page displays exactly what context (shared fields, snippets, additional notes) each tool received.

### Tests
- API-level tests live in `artifacts/api-server/src/__tests__/` and run with `vitest run` (script: `pnpm --filter @workspace/api-server test`, or `pnpm test` from the repo root which fans out via `pnpm -r --if-present run test`).
- They exercise the real Postgres DB pointed to by `DATABASE_URL` (no schema mocking — they create per-test users/tools with random IDs and clean them up in `afterAll`).
- External integrations are mocked at the module boundary with `vi.mock` (see `admin-sync-github.test.ts` for `lib/github` and `admin-draft-text.test.ts` for `lib/gemini-helpers`), so tests don't hit GitHub or Gemini. Vitest is configured (in `vitest.config.ts`) with `pool: "forks"` and `singleFork: true` so DB-touching tests don't race each other, and with `resolve.conditions: ["workspace"]` to match the TS `customConditions` setup.
- Auth in tests goes through `createTestUser`, which inserts a real `users` + `profiles` row, calls `createSession`, and returns an `Authorization: Bearer <sid>` header — exactly the wire path that production uses.

# External Dependencies

- **pnpm**: Monorepo management.
- **Node.js**: Runtime environment (version 24).
- **TypeScript**: Programming language (version 5.9).
- **Express**: Web application framework (version 5).
- **PostgreSQL**: Relational database (with `pgvector` extension).
- **Drizzle ORM**: TypeScript ORM for PostgreSQL.
- **Zod**: Schema declaration and validation library.
- **drizzle-zod**: Integration between Drizzle ORM and Zod.
- **Orval**: OpenAPI client code generator.
- **esbuild**: JavaScript bundler.
- **@xenova/transformers**: In-process embedding model (`Xenova/all-MiniLM-L6-v2`).
- **Replit Gemini AI integration**: Used for Gemini models (`gemini-3-flash-preview` to generate RAG primer queries and power profile intake chat).
- **App Storage / GCS (Google Cloud Storage)**: Object storage for binary uploads.
- **pdf-parse**: PDF text extraction.
- **mammoth**: DOCX to HTML converter (used for text extraction).
- **@replit/connectors-sdk**: For GitHub integration and proxying authenticated requests.
- **Claude**: AI model (`claude-sonnet-4-6`) used in `brief-drafter`.
- **Authentication**: Replit OIDC via `@workspace/replit-auth-web`.

### Admin tool builder + hosting modes
- Tools have a `hostingType` of either `cloud` (existing behavior) or `local_install`. Cloud tools open `launchUrl` in a new tab; local tools render a "Runs locally" pill, and launching opens a modal with install instructions, an installer download link, and an "Open with my context" button that navigates to `localLaunchUrlPattern` with `{token}` substituted.
- Admin form (`Admin.tsx` `ToolForm`) is sectioned: 1. Source (GitHub repo picker via `useAdminListGithubRepos` + `adminGetGithubRepoMetadata`, plus a re-sync button using `useSyncToolFromGithub`), 2. Metadata (with per-field "Generate with AI" buttons on short/long description), 3. Hosting (cloud-vs-local switch, resumable installer upload — see below), 4. Context & RAG (purpose + RAG query templates, both AI-draftable), 5. Publish.
- Installer uploads are resumable: client init → `POST /api/admin/tools/installer-upload-init` (with `fileFingerprint = name|size|lastModified`) returns `{ uploadId, bytesUploaded, chunkSize, resumed }`. Client then PUTs 8 MB chunks of the file Blob to `/api/admin/tools/installer-upload/:id/chunk?offset=N` (raw octet-stream). The server proxies each chunk to a GCS resumable session URI with the appropriate `Content-Range`, persisting `bytesUploaded` in the `installer_uploads` table after each chunk. A re-init with the same `(userId, fileFingerprint)` returns the existing in-progress session so the upload resumes from the last persisted offset (verified at runtime against GCS via `Range: bytes=`). On offset drift the chunk endpoint returns 409 with `expectedOffset` so the client can resync. `POST /api/admin/tools/installer-upload/:id/complete` finalises the row and returns the durable `objectKey`. The legacy presigned-URL endpoint is kept for back-compat but marked deprecated.
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

### Dependencies summary
- **Database**: PostgreSQL (with `pgvector` extension)
- **Object Storage**: App Storage / Google Cloud Storage (GCS)
- **AI Models**:
    - `Xenova/all-MiniLM-L6-v2` (for in-process embeddings)
    - Replit Gemini AI integration (for `gemini-3-flash-preview` to generate RAG primer queries and power profile intake chat)
    - Claude (`claude-sonnet-4-6`) (used by `brief-drafter` for generating briefs)
- **GitHub**: Integrated via `@replit/connectors-sdk` for tool source management.
- **Document Parsing Libraries**:
    - `pdf-parse` (for PDF text extraction)
    - `mammoth` (for DOCX text extraction)
- **Authentication**: Replit OIDC via `@workspace/replit-auth-web`
