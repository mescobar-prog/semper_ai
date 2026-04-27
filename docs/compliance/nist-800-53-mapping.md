# NIST 800-53 Control Mapping (Moderate Baseline — partial)

| Control | Implementation |
|---|---|
| AC-2 Account Management | Keycloak (planned) — OIDC, MFA, role-based |
| AU-2 Audit Events | FastAPI structured JSON logs to stdout |
| AU-9 Protection of Audit Info | Logs shipped to append-only sink (TBD) |
| IA-2 Identification & Authentication | OIDC Auth Code + PKCE via Keycloak |
| SC-8 Transmission Confidentiality | TLS 1.2+ via Caddy; HSTS enforced |
| SC-13 Cryptographic Protection | DHI Postgres (Alpine 3.22) + UBI9 Python in FIPS mode on FIPS-enabled host |
| SC-23 Session Authenticity | Secure, HttpOnly, SameSite cookies |
| SI-2 Flaw Remediation | `trivy` scan in CI; pinned deps |
| SI-10 Information Input Validation | Pydantic models on every endpoint |
| CM-6 Configuration Settings | Hardened container images (DHI / UBI9) |
| RA-5 Vulnerability Scanning | `trivy`, `semgrep`, `pip-audit` in CI |
