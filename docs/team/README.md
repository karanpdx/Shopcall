# Working in parallel

Each contributor takes exactly one lane. Assign names in chat; no name is implied by A/B/C.

| Lane | Files owned | Shared-file coordinator |
|---|---|---|
| A: Call UI | `src/features/call/**`; `src/app/**` excluding `src/app/api/**`; UI tests | — |
| B: Catalog/backend | `src/server/**`; `src/app/api/**`; `migrations/**`; catalog/auth/API tests | `src/contracts/**` and `docs/api-contract.md` |
| C: Integrations/jobs | `src/integrations/**`; `scripts/**`; provider/job tests | `package.json`, `package-lock.json`, root config, `.env.example` |

Person C exports provider functions; Person B exposes them through API routes. Person A consumes routes and shared types. Person C does not edit API routes directly; Person A does not put database/provider secrets into client components. This boundary avoids three people editing the same route files.

## Start a lane

```sh
git fetch origin
git switch main
git pull --ff-only
git switch -c feat/call-ui
npm ci
```

Use `feat/catalog-backend` or `feat/integrations` for the other lanes. Each person needs their own clone/worktree, not a shared working directory. Copy `.env.example` locally and onboard credentials separately; ignored credentials do not arrive through Git.

## Shared-file changes

1. Announce the exact shared file and intended change to the coordinator before editing.
2. Coordinator makes the change in one PR. Avoid independent `npm install` and lockfile edits in different lanes.
3. Merge that PR first. Everyone rebases their branch on `origin/main`, then runs `npm ci` if dependencies changed.
4. No routine frontend request should force an API contract rewrite. Prefer existing interfaces and explicit error states.

## First integration checkpoint

- B supplies authenticated demo session, stable business/draft IDs, actual route handlers and public catalog URL.
- A supplies call screen, original photo upload/capture, product review, and explicit UI approval events.
- C supplies ElevenLabs agent/session adapter, discovered Replit tool schemas, backend OAuth callback functions, and persisted job executor through B's repository interface.

Agree on publicly reachable backend host before a generated Replit app receives a catalog URL. Never send localhost in a production generation prompt. Determine build completion separately from publication completion; a create request being accepted proves neither.

## PR handoff

Include behavior implemented, changed contracts, check results, required env names (never values), known gaps, and next owner's concrete integration action. Mark mocks and fixtures explicitly. Do not claim real provider success based on mocked tests.

Final rehearsal is shared: live create call → three real captures → owner review → automatic Replit generation/publication → anonymous URL → returning camera-off call → exact product updates at same URL without rebuild.
