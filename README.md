# Semper AI

Semper AI is a Department of War (DoW) AI Tool Marketplace MVP — a TradeWinds-style platform that lets service members securely launch authorized AI tools with their personal context (operator profile + RAG library) attached automatically via a one-time launch token.

The goal is to make AI tools inside the DoW easy to discover, easy to launch, and **context-aware by default**, while keeping every launch auditable and every shared field under the operator's control.

---

## What's in the platform

- **Marketplace storefront** — landing, dashboard, catalog, tool detail, profile, library, launches, and admin pages.
- **Operator profile + Context Block** — persistent identity (branch, rank, MOS, duty title, …) and a 6-element task-dependent Context Block (who/what/when/where/risk/experience).
- **Personal RAG library** — upload PDF / DOCX / MD / TXT documents; chunked, embedded with `Xenova/all-MiniLM-L6-v2` (384-dim, int8), stored in Postgres + `pgvector` with HNSW cosine.
- **Smart Mission Context** — auto-ingestion of curated military doctrine based on branch / MOS / unit.
- **Mission Context presets** — named profile snapshots scoped to specific library documents; one is "active" at a time.
- **Pre-launch preview & redaction** — see exactly what profile fields and RAG snippets a tool would receive, redact anything you don't want to share, and (optionally) require an affirmation of the active preset + Context Block before each launch.
- **One-time launch tokens** — tools receive a short-lived `launchToken` (5 min) that they exchange for the user's selected context plus a `sessionToken` (1 h) for follow-up RAG queries.
- **Admin tool builder** — create / update tools, attach a GitHub source repo, AI-draft descriptions with Gemini, configure cloud or `local_install` hosting, upload installers.
- **Auditability** — every launch records the active preset, Context Block version, affirmation timestamp, and the exact context payload that was shared.

---

## Repository layout

This is a **pnpm workspace monorepo**. Code is split between **artifacts** (deployable apps) and **lib** (shared TypeScript packages).

```
artifacts/
  api-server/          Express 5 + Drizzle ORM backend (auth, profiles, catalog,
                       library, launches, admin, dashboard)
  marketplace/         React + Vite frontend — the main Semper AI storefront
  brief-drafter/       AI tool: drafts mission briefs with Gemini
                       (Gemini-3-flash-preview) + profile-aware RAG
  context-echo/        Demo tool that exchanges a launch token and renders the
                       received context (useful for verifying the launch flow)
  mission-chat/        AI chat tool that uses the user's profile + library
  mockup-sandbox/      Design canvas / component preview Vite app

lib/
  api-spec/            OpenAPI source of truth
  api-client-react/    Generated React Query client (Orval)
  api-zod/             Generated Zod schemas
  db/                  Drizzle schema, migrations, db client
  integrations/        Shared integration helpers
  integrations-gemini-ai/      Gemini helper used by api-server / admin draft
  mil-data/            Curated military reference data for Smart Mission Context
  replit-auth-web/     Replit OIDC auth helpers (used as @workspace/replit-auth-web)

scripts/               Repo-level scripts (incl. post-merge.sh)
```

The full pnpm packages list lives in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml).

---

## Tech stack

| Layer            | Choice                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Language         | TypeScript ~5.9                                                       |
| Runtime          | Node.js 24                                                            |
| Package manager  | pnpm (workspace)                                                      |
| Backend          | Express 5                                                             |
| ORM              | Drizzle ORM                                                           |
| Database         | PostgreSQL with `pgvector`                                            |
| Validation       | Zod (+ drizzle-zod)                                                   |
| API codegen      | Orval (from `lib/api-spec` OpenAPI)                                   |
| Bundler          | esbuild (api-server) / Vite 7 (frontends)                             |
| Frontend         | React 19 + Vite + Tailwind 4                                          |
| Embeddings       | `@xenova/transformers` — `Xenova/all-MiniLM-L6-v2` (384-dim, int8)    |
| LLMs             | Gemini (`gemini-3-flash-preview`)                                     |
| Auth             | Replit OIDC via `@workspace/replit-auth-web`                          |
| Object storage   | Replit App Storage (Google Cloud Storage)                             |
| Tests            | Vitest (forked pool, `singleFork: true`) against a real Postgres      |

---

## Running the project

This project is designed to run on Replit, which provisions Postgres, secrets, and the dev servers automatically. To run it elsewhere:

### Prerequisites

- Node.js 24
- pnpm (any recent version)
- A PostgreSQL database with the `pgvector` extension enabled
- A `DATABASE_URL` pointing at that database

### Install

```bash
pnpm install
```

### Apply the database schema

```bash
pnpm --filter @workspace/db run db:push
```

### Start an artifact

Each artifact has a `dev` script. Examples:

```bash
pnpm --filter @workspace/api-server run dev      # backend API
pnpm --filter @workspace/marketplace run dev     # main frontend
pnpm --filter @workspace/brief-drafter run dev   # brief drafter tool
pnpm --filter @workspace/context-echo  run dev   # context echo demo tool
pnpm --filter @workspace/mission-chat  run dev   # mission chat tool
pnpm --filter @workspace/mockup-sandbox run dev  # component preview
```

The Vite frontends bind to `0.0.0.0` and read the `PORT` environment variable so they work behind Replit's path-based preview proxy.

### Build everything

```bash
pnpm run build         # typecheck + per-package builds
pnpm run typecheck     # typecheck only
pnpm test              # runs every package's test script
```

---

## Environment / secrets

The platform reads its configuration from environment variables. The most important ones:

| Variable                          | Used by                | Purpose                                                        |
| --------------------------------- | ---------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                    | api-server, lib/db     | Postgres connection string (must have `pgvector` enabled)      |
| `ADMIN_EMAILS`                    | api-server             | Comma-separated emails to auto-promote to admin on login       |
| `SESSION_SECRET`                  | api-server             | Session signing                                                |
| Replit OIDC env (auto-injected)   | replit-auth-web        | Provided by Replit when the artifact runs on Replit            |
| Replit Connectors env (injected)  | api-server             | Used by `@replit/connectors-sdk` for GitHub + Gemini calls     |

On Replit these are managed via the workspace secrets UI. Outside Replit, set them in your shell or a `.env` file your process manager loads.

---

## Authentication & roles

- Login is **Replit OIDC** via `@workspace/replit-auth-web`.
- The first user to sign in becomes an operator.
- Anyone whose email is in `ADMIN_EMAILS` is promoted to admin on login.
- Admins can toggle between `admin` and `operator` views in the UI; the toggle is presentation-only — server gates always check the real `isAdmin`.

---

## How a tool launch works

1. User picks a tool in the marketplace.
2. (Optional) the **launch preview** shows the candidate payload — profile fields, RAG snippets, and queries — based on the active preset.
3. (If required) the user re-affirms the active preset + Context Block.
4. User can redact specific profile fields and snippets.
5. The platform mints a **`launchToken`** (5 min TTL) and a **`launchUrl`**, then redirects the user to the tool.
6. The tool POSTs the `launchToken` back to the API in exchange for the selected context plus a longer-lived **`sessionToken`** (1 h) used for follow-up RAG queries.
7. The launch is recorded (`launches` row) with `presetId`, `contextBlockVersion`, `affirmedAt`, and the exact context payload that was shared — visible to the user on `/launches`.

The flow is implemented end-to-end in `artifacts/api-server` and demonstrated by `artifacts/context-echo`.

---

## Tests

API-level tests live in `artifacts/api-server/src/__tests__/` and run with Vitest:

```bash
pnpm --filter @workspace/api-server test
# or fan out across the whole repo
pnpm test
```

The tests exercise the real Postgres pointed to by `DATABASE_URL` (no schema mocking; they create per-test users / tools with random IDs and clean up in `afterAll`). External integrations (GitHub, Gemini) are mocked at the module boundary with `vi.mock`. Vitest is configured with `pool: "forks"` and `singleFork: true` so DB-touching tests don't race each other.

Auth in tests goes through `createTestUser`, which inserts a real `users` + `profiles` row, calls `createSession`, and returns an `Authorization: Bearer <sid>` header — exactly the wire path production uses.

---

## License

MIT (see [`package.json`](./package.json)).
