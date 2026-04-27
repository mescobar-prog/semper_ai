# semper_ai

Vue 3 + FastAPI + Postgres (FIPS) monorepo scaffold.

## Layout

```
.
├── apps/
│   ├── web/          Vue 3 + Vite + TS frontend
│   └── api/          FastAPI backend
├── infra/
│   ├── caddy/        Reverse proxy / TLS termination
│   └── postgres/     DB init scripts
├── docs/
│   └── compliance/   NIST 800-53 control mapping
├── docker-compose.yml
└── .env.example
```

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

- Web: https://localhost
- API: https://localhost/api
- Postgres: localhost:5432 (internal only in prod)

## Compliance posture

- **Postgres:** Docker Hardened Image `dhi.io/postgres:18-alpine3.22-dev`.
- **API:** UBI9 Python base; runs in FIPS mode when host kernel is FIPS-enabled.
- **TLS:** Caddy terminates TLS 1.2+; auto-renews certs.
- **Auth:** OIDC via Keycloak (add separately for full deployment).
- See `docs/compliance/nist-800-53-mapping.md`.
