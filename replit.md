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
- Launch-time confirmation gate so each launch is tied to an affirmed preset and Context Block version.

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

### Launch-time Affirmation Gate (Task #45)
- `context_blocks.version` is a monotonic integer bumped on every CB confirm.
- `launch_affirmations` (PK userId) caches `{presetId, contextBlockVersion, affirmedAt, expiresAt}` for 30 minutes.
- `POST /api/tools/:toolId/launch` returns 409 `code: needs_affirmation` (with full preset + CB payload) when no valid affirmation exists.
- `GET /api/launches/affirmation` returns current status; `POST /api/launches/affirm` upserts after the user confirms.
- The affirmation row is deleted on every active-preset change path (activate / create-with-activate / delete-active / PUT profile.activePresetId), and invalidated by version mismatch on every CB confirm.
- Frontend: `LaunchAffirmationDialog` renders the active preset + 6-element CB; `AffirmationIndicator` on each tool detail shows a green "Preset confirmed for this session" pill with a "Re-confirm" link.
- `launches` audit row stores `presetId`, `contextBlockVersion`, `affirmedAt` for every launch.

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
