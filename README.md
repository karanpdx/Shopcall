# Shopcall

Show your products. Tell your story. Get a Replit-generated storefront you can update with another call.

## Current status

A/B/C are integrated on `feat/integrations`. Browser calling, authenticated persistent catalog, draft-bound still capture, combined owner review and the durable Replit publication worker are implemented. The simpler phone frontend is deployed at **https://shopcall-demo.vercel.app**. The API/storage/worker still run on the demo Mac behind temporary HTTPS tunnels; keep the Mac and processes running. See [demo topology](docs/team/local-public-demo.md).

Provider evidence (November 20, 2026): a short real ElevenLabs session through the deployed frontend returned greeting audio with a synthetic microphone. A real, explicitly synthetic Replit probe was automatically created and published, then independently verified in an anonymous mobile browser and through its fresh server endpoint. Neither establishes a complete real merchant demo. Physical-phone audio, three real product photos, merchant publication and same-URL voice updates still need end-to-end acceptance. Photo analysis/enhancement is being integrated; saved photos alone are not evidence of generation. Real email is not configured.
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

Open http://localhost:3000. `GET /api/health` reports service health. `.env.local` is ignored; never commit or paste keys. Only the ElevenLabs key is needed for the connection check; the landing page needs no credentials.

For ElevenLabs onboarding, run `npx -y @elevenlabs/cli@latest onboard init` and follow its output. `npm run agent:setup` provisions or reuses a dedicated private agent; `npm run agent:sync` updates its managed prompt and tools. API access is not proof of a working browser call.

## Three-person work split

| Contributor | Ownership | Suggested branch | Start here |
|---|---|---|---|
| A — Call UI | `src/features/call/**`, `src/app/**` except API routes | `feat/call-ui` | [Person A](docs/team/person-a-call-ui.md) |
| B — Catalog/backend | `src/server/**`, `src/app/api/**`, `migrations/**` | `feat/catalog-backend` | [Person B](docs/team/person-b-catalog.md) |
| C — Integrations/jobs | `src/integrations/**`, `scripts/**` | `feat/integrations` | [Person C](docs/team/person-c-integrations.md) |

Choose which person owns which area before coding. Names are unassigned. [Coordination and shared-file rules](docs/team/README.md) explain how to avoid overlap. [API contract](docs/api-contract.md) defines the handoffs. Use `src/contracts/api.ts` for the integrated backend and the handoff docs for call workspace and publication interfaces.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Run `npm run demo:setup` to fill missing local defaults and write generated credentials to private ignored `.shopcall/demo-login.txt`. Run `npm run replit:connect` for application-owned OAuth, then `npm run replit:check` to discover actual tools. Configure public HTTPS catalog origin, persistent storage, observed Replit response profile and Chrome before starting `npm run worker -- --loop`.

Phone: open the frontend directly in Safari (iPhone) or Chrome (Android), sign in, tap **Start call**, allow microphone access and turn on camera when showing a product. Give name, USD price and quantity together. **Products** shows saved drafts. **Finish & review** ends audio and prepares the final listing review. Only explicit owner confirmation applies catalog changes and queues publication. Wait for real observed status; do not submit duplicate builds.

Additional opt-in checks:

```sh
UI_BROWSER_TEST_URL=http://localhost:3000 node --import tsx --test tests/ui/browser-media.test.ts
npm run demo:smoke
node --env-file=.env.local --import tsx scripts/verify-browser-voice.ts --live
npm run replit:probe -- verify
```

The voice check starts one short real session with synthetic microphone input and logs connection/audio-receipt booleans only. The Replit check verifies the existing synthetic probe; never recreate an app to retry an unknown create/publish outcome.
## Integration gates

1. Replit: application-owned OAuth → actual tool discovery → create → observable build readiness → publish → anonymously verify public URL and current catalog. Codex-side authentication is separate from backend credentials.
2. ElevenLabs: private/authenticated agent → backend session credential → real browser call → ID-bound photo capture and typed authenticated tool bridge.
3. Persistence: canonical catalog and original photos survive calls and deployments. SQLite dependency is available for local development; public deployment requires durable database/storage, selected by Person B. Do not deploy SQLite or uploads to ephemeral disks.
4. Email: configured real provider and sender; notification only after verified publication. Accepted mail is not proof of delivery.

See each contributor doc for acceptance criteria and integration tests. Final acceptance requires real camera photos, real voice, and a real publicly reachable Replit site; local checks cannot establish these.
