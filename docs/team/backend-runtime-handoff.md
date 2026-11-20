# Integrated backend publication runtime

## Default worker

`scripts/worker.ts` now composes B's actual queue, immutable build snapshots, C's persisted publication workflow, Replit OAuth/client/artifact observer, anonymous browser verifier, and optional durable notification outbox. It no longer needs `SHOPCALL_RUNTIME_MODULE` or a deployment-specific stub module.

```sh
npm run worker -- --once
npm run worker -- --run <B-build-job-uuid>
npm run worker -- --loop
```

`--once` advances one queue/workflow tick, not an entire build. `--loop` advances every five seconds until interrupted. Provider sessions close after each tick; storage persists. Graceful interrupt stops after the current bounded provider operation. Worker logs only job ID, phase, task/error code and safe notification summary, never owner email, frozen merchant brief, OAuth/session URLs or raw provider payloads.

## Required configuration

- B configuration: `DATABASE_URL` points to persistent SQLite, durable asset storage, configured fixed `DEMO_OWNER_EMAIL`; backend and original asset URLs publicly reachable over HTTPS.
- `APP_BASE_URL` is the owner app origin; `PUBLIC_API_BASE` is the public backend HTTPS origin used by generated catalog fetches.
- `REPLIT_RESPONSE_PROFILE_PATH` defaults `.shopcall/replit-response-profile.json`. It must contain the schema profile derived from actual observed provider output. No guessed default ready states are injected.
- `CHROME_EXECUTABLE_PATH` points to an installed Chrome/Chromium executable for independent postpublication browser QA.
- Actual owner Replit connection stored via the app's encrypted OAuth store. Production requires managed `REPLIT_CREDENTIAL_KEY` and a persistent private `.shopcall` volume.
- Local fixed-demo bridge only: explicitly set `REPLIT_CONNECTION_OWNER_ID=shopcall-local-demo-owner` to reuse an existing CLI connection. This alias is permitted only for the canonical configured demo owner and never for a different owner in production. It is not silently selected.
- Optional real email: `RESEND_API_KEY`, `EMAIL_FROM` and optional `EMAIL_REPLY_TO`. Missing email configuration is reported as `not_configured`; it does not fabricate a sent message or invalidate a verified storefront. Idle loop ticks continue retries and delivery polling after publication, without a second build.

## Queue/auth/persistence seams

`SqliteBackendJobSource` implements `PublicationAuthorization` and `VerifiedOwnerDirectory` from B's actual records. It loads B's frozen `BuildSpec`, matches job/business/`approvedByOwnerId`, and rechecks canonical business ownership before handing a brief to C. Blank owner-approved design brief maps to an explicit neutral implementation default, not an invented merchant preference.

The email directory joins owner/business records and accepts only configured fixed-demo identity. This is authenticated demo identity, not a claim that an inbox verification flow ran.

`BackendQueueRuntime` always uses **B job UUID = C run UUID = approval ID**. It first recovers B `running`/build-completed-publication-pending rows, including a process crash between B queue claim and C run persistence. Existing C dispatch intent/unknown mutation outcome blocks replay. Blocked rows stay active in B, so another storefront/app cannot be queued over an uncertain remote result. No DB transaction spans a network call.

B's `publicUrl` remains null until C run is genuinely ready with persisted provider publication, complete evidence gate, final anonymous browser verification, matching business/revision, HTTP success and exact verified URL. A `ready` flag without proof is rejected. Publishing/verifying mirrors build completed but publication pending. Definitive C failure mirrors the appropriate B failure state; unknown outcome stays active with a safe reconciliation code.

`createBackendRuntime()` exports `{ tick({ runId? }), close() }`. `getBackendBuildStatus(owner, jobId)` is ready for parent to use in B `GET /api/builds/:id`; it performs actual owner checks then returns B job fields plus safe workflow/task and notification projections. It never serializes private frozen plan/approval data.

## Web OAuth

- `POST /api/replit/connect`: cookie-derived owner and same-origin browser request; starts owner-bound OAuth, returns `{ state: "redirect", authorizationUrl }` or `{ state: "connected" }` in B API wrapper.
- `GET /api/replit/callback`: requires same authenticated owner, state and code; validates/consumes owner-bound PKCE attempt via C OAuth service, then redirects to app root with `?replit=connected`. Errors never echo raw OAuth response/code.
- Web callback defaults to **`APP_BASE_URL/api/replit/callback`**, independently of CLI port 8788. Optional `REPLIT_WEB_REDIRECT_URI` must have exact app origin and callback path. No request-supplied callback, owner, arbitrary redirect or forwarded-host expansion.

## Validation and remaining live gates

Seven tests use actual B SQLite/repository plus a mocked Replit port/verifier, covering all seven C workflow phases and B projection, claimed-job restart recovery, unknown remote mutation replay blocking, missing config recovery, forged owner approval, web/CLI callback distinction, production alias rejection and forged-ready proof rejection.

No actual new Replit app, publication, email, voice or TTS was triggered while implementing/testing this runtime. Real merchant call, public backend host, observed response profile, browser QA and genuine published URL remain live demo gates. Parent owns deployment setup and final combined app rehearsal.
