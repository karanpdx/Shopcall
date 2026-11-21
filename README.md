# lit

**just call lit.** Tap one button, show what you make to the camera, say the price and how many you have, and approve once. Replit builds and publishes a real storefront, and the live link is emailed to you. A later camera-off call updates prices and stock at the same link, with no rebuild.

The repository and some code still use the working name Shopcall.

## How it works

1. **Call.** The lit web app on your phone runs a voice call with a private ElevenLabs agent. The camera is optional.
2. **Show and say.** Still photos are tied to the product they were taken for. Your voice sets the name, price and stock; the camera never does.
3. **Approve.** Every change is a draft. Only your tap in the app publishes or applies anything. The voice agent can open the review but can't approve.
4. **Build.** The backend hands the approved snapshot to Replit through its MCP server. The storefront reads the live public catalog on every load.
5. **Verify, then email.** The link is emailed only after the published shop loads correctly for a logged-out visitor.

## Current status

Hackathon project. Nothing is deployed yet.

- **On `main`:** catalog backend (owner sessions, drafts and approvals, photo uploads, public catalog API, build jobs), tested locally.
- **On `feat/integrations`:** the combined demo branch with the one-tap call app, the ElevenLabs agent and the Replit publication pipeline. The ElevenLabs agent and Replit OAuth/tool discovery are provider-verified; the full Replit build, publish and logged-out check has not run end to end yet.

Confirmed scope: one authenticated demo merchant, fully automatic Replit app creation and publication, and camera-off price/stock updates at the same public URL. No template fallback. See [decisions](docs/decisions.md) and [requirements](docs/requirements.md).

## Local setup

Requires Node.js 22.13+ and npm. Each contributor uses their own clone, branch and credentials.

```sh
git clone https://github.com/karanpdx/Shopcall.git
cd Shopcall
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. `.env.local` is ignored; never commit or paste keys.

For ElevenLabs onboarding, run `npx -y @elevenlabs/cli@latest onboard init` and follow its output. Having API access doesn't prove a browser call works.

## Team lanes

| Lane | Owns | Branch | Start here |
|---|---|---|---|
| A — Call UI | `src/features/call/**`, `src/app/**` except API routes | `feat/call-ui` | [Person A](docs/team/person-a-call-ui.md) |
| B — Catalog/backend | `src/server/**`, `src/app/api/**`, `migrations/**` | `feat/catalog-backend` | [Person B](docs/team/person-b-catalog.md) |
| C — Integrations/jobs | `src/integrations/**`, `scripts/**` | `feat/integrations` | [Person C](docs/team/person-c-integrations.md) |

[Coordination and shared-file rules](docs/team/README.md) explain how to avoid overlap. The [API contract](docs/api-contract.md) defines the handoffs.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

## Before calling it done

1. **Replit:** app-owned OAuth → tool discovery → create → observable build readiness → publish → logged-out check of the public URL and current catalog.
2. **Voice:** private agent → backend session credential → real browser call → photo capture tied to its draft → typed tool calls through authenticated routes.
3. **Data:** the catalog and original photos survive calls and deployments. Don't deploy SQLite or uploads to ephemeral disks.
4. **Email:** a real provider and sender, sent only after verified publication. Accepted mail isn't proof of delivery.

Final acceptance needs real camera photos, a real voice call and a publicly reachable Replit site; local checks can't establish these.
