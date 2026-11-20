# Shopcall

Show your products. Tell your story. Get a Replit-generated storefront you can update with another call.

## Current status

This is a **collaboration scaffold**, not a working end-to-end demo. It includes a responsive landing page, health route, shared Zod contracts, server-side ElevenLabs SDK factory, read-only connection check, and three contributor work areas. Voice calls, camera capture, authentication, catalog persistence, Replit OAuth/build/publish, URL verification, and email are still to implement. Nothing is deployed or published.

Confirmed scope: working hackathon demo, one authenticated demo merchant, **fully automatic Replit app creation and publication**, and subsequent camera-off price/stock updates at the **same public URL**. No template fallback. See [decisions](docs/decisions.md) and [requirements](docs/requirements.md).

## Local setup

Requires Node.js 22.13+ and npm. Each contributor uses their own clone, branch, and credentials.

```sh
git clone https://github.com/karanpdx/Shopcall.git
cd Shopcall
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. `GET /api/health` explicitly reports scaffold status. `.env.local` is ignored; never commit or paste keys. Only the ElevenLabs key is needed for the connection check; the landing page needs no credentials.

For ElevenLabs onboarding, run `npx -y @elevenlabs/cli@latest onboard init` and follow its output. `npm run agent:setup` currently checks read-only agent-list access; it does **not** create or modify an agent. API access is not proof of a working browser call.

## Three-person work split

| Contributor | Ownership | Suggested branch | Start here |
|---|---|---|---|
| A — Call UI | `src/features/call/**`, `src/app/**` except API routes | `feat/call-ui` | [Person A](docs/team/person-a-call-ui.md) |
| B — Catalog/backend | `src/server/**`, `src/app/api/**`, `migrations/**` | `feat/catalog-backend` | [Person B](docs/team/person-b-catalog.md) |
| C — Integrations/jobs | `src/integrations/**`, `scripts/**` | `feat/integrations` | [Person C](docs/team/person-c-integrations.md) |

Choose which person owns which area before coding. Names are unassigned. [Coordination and shared-file rules](docs/team/README.md) explain how to avoid overlap. [API contract](docs/api-contract.md) defines the handoffs. Contracts describe intended interfaces, not working routes.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

`npm run worker` intentionally exits with a not-implemented error. Person C replaces it with a durable publication worker. No fake build progress or successful publication is included.

Scaffold validation (November 20, 2026): 3 contract tests, TypeScript, and production build passed. ElevenLabs onboarding and read-only SDK agent-list request passed locally (zero agents visible); no agent was provisioned, no speech was generated, and no browser conversation was tested. Other contributors must onboard their own local credentials.

## Integration gates

1. Replit: application-owned OAuth → actual tool discovery → create → observable build readiness → publish → anonymously verify public URL and current catalog. Codex-side authentication is separate from backend credentials.
2. ElevenLabs: private/authenticated agent → backend session credential → real browser call → ID-bound photo capture and typed authenticated tool bridge.
3. Persistence: canonical catalog and original photos survive calls and deployments. SQLite dependency is available for local development; public deployment requires durable database/storage, selected by Person B. Do not deploy SQLite or uploads to ephemeral disks.
4. Email: configured real provider and sender; notification only after verified publication. Accepted mail is not proof of delivery.

See each contributor doc for acceptance criteria and integration tests. Final acceptance requires real camera photos, real voice, and a real publicly reachable Replit site; local checks cannot establish these.
