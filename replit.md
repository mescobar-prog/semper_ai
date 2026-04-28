# Overview

This project is an MVP for a DoD AI Tool Marketplace, akin to a TradeWinds-style platform. Its core purpose is to enable service members to securely access and utilize authorized AI tools. Users will create structured operator profiles and personal RAG libraries. When launching an AI tool, their relevant context and mission-specific document snippets are automatically provided via a one-time launch token.

The marketplace aims to streamline the deployment and use of AI capabilities within the DoD, ensuring secure and context-aware interactions. Key capabilities include user authentication, profile management, a catalog of AI tools, personal RAG (Retrieval-Augmented Generation) document libraries, and a secure token-based launch mechanism for AI tools.

# User Preferences

I prefer iterative development with clear communication on major changes. Please ask before making any significant architectural or design decisions. I appreciate concise explanations and direct answers.

# System Architecture

The project is structured as a pnpm workspace monorepo utilizing TypeScript (v5.9). The backend is built with Express 5, using PostgreSQL and Drizzle ORM for data persistence. Zod is used for validation, and Orval handles API codegen from an OpenAPI specification. `esbuild` is used for CJS bundling.

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
- **Auto-Ingest**: Curated military doctrine (PDFs) can be automatically ingested based on user's branch/MOS/unit. Ingestion status is tracked and displayed.
- **Retry Mechanism**: Failed auto-ingested documents can be retried, with an option to manually upload a replacement.

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