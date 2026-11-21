# Live-call integration fixes — November 20, 2026

Provider inspection of the latest merchant call established that product creation, detail recording and capture succeeded. The agent subsequently supplied the call's publication-review handle as a catalog-batch ID and then as a build-job ID. Both lookups failed; that did not indicate lost catalog data or an existing build blocking draft storage. The agent also asked the owner to provide cents.

## Applied fixes

- Managed prompt speaks dollars, converts minor units internally and separates publication-review, catalog-batch and build-job handles. Provider update/read-back passed; behavior still needs a fresh spoken rehearsal.
- Backend recognizes its own authenticated call's publication-review handle even if the model labels it `catalog_change`, and opens only the publication preview. No approval is inferred. The client follows the backend's corrected preview action. Arbitrary proposal IDs still fail.
- Looking up that known review handle as a build job returns an explicit non-job explanation. It never fabricates a queued build or loses saved drafts.
- Recording a complete new item's spoken facts triggers one draft-bound still while the camera is on. Camera-on after facts are recorded also triggers one attempt. Shared capture coordination prevents simultaneous automatic/model calls from uploading duplicates; explicit Retake remains available. Camera off never captures.
- Actual camera state is sent to the voice agent. Main-call progress displays queued/analysis/enhancement/ready states, the enhanced thumbnail and a description excerpt. Opening Products shows original/candidate selection without approving it or ending audio.
- Finish opens editable listing previews before the combined batch freezes. The description editor allows corrections. Later approved product additions reuse the existing verified storefront URL without creating another app; first publication still queues Replit.
- Sign out ends streams, invalidates the server session and clears the old call/job UI. Late old-call results are discarded.

## Demo accounts and ownership

Optional `DEMO_SECOND_OWNER_EMAIL`, `DEMO_SECOND_OWNER_PASSWORD` and `DEMO_SECOND_BUSINESS_NAME` configure a second fixed demo identity. It has a separate owner, business, catalog, calls and assets. There is no public signup. Private credentials stay in ignored local files. The local nonproduction Replit account alias permits only configured demo identities; production owner-bound OAuth rules remain enforced.

## Evidence boundaries

Focused tests reproduce the handle swap, authorization isolation, dollar-input tool schema, automatic capture conditions, capture deduplication and old-call response rejection. Seven synthetic browser flows cover controls, generated previews, owner media choices, signout, first publication and existing-store updates. Real provider checks proved synthetic photo analysis/editing and an ElevenLabs session surviving camera shutdown. These checks are distinct from an actual complete merchant call → verified public Replit storefront → camera-off update acceptance run.
