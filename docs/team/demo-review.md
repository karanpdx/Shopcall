# Demo rehearsal review

Reviewed November 20, 2026, against `origin/feat/integrations` at `8f4ede9` and the caller-experience framing in `docs/team/part-a-critical-update.md` ("Call experience: thorough without trapping the caller"). For UI context I also read `origin/feat/call-ui` at `1221026` and `origin/c/conversation-policy` at `6ff20aa`. Those branches are not merged into `feat/integrations`. This is a docs-only review: no code was changed and nothing was run against a live provider.

Status key: **scaffold** = types or seams only · **implemented** = code exists · **tested locally** = mocked or unit tests · **provider-verified** = observed against the real provider · **deployed** = running in the demo environment.

## 1. Observed behavior (from code and handoff docs)

| # | Area | Observation | Source | Status |
|---|------|-------------|--------|--------|
| O1 | Questioning | The agent prompt says "Ask one question at a time" and "Ask owner for name, exact price, currency, and stock". That produces up to four turns per item and asks for currency on every item. The framing asks for name, price and count to be given together, with the store currency reused. | `src/integrations/elevenlabs/config.ts` | implemented |
| O2 | Questioning | A concise policy that drops the per-item currency question and omits camera tools when the camera is off exists only on `c/conversation-policy` (`0bf1801`, `6ff20aa`). `feat/integrations` still ships the older prompt above. | branch graph | tested locally (policy branch) |
| O3 | Confirmations | The prompt has no rule calling for a single combined readback. Its only rule is "Voice agreement alone is not approval", so nothing stops the agent from confirming each field by voice and then repeating everything before the click. On return calls, nothing tells the agent to batch several edits into one `preview_catalog_changes`. | `config.ts`, `tools.ts` | implemented |
| O4 | Finish & review | The prompt and tools never mention Finish & review. The agent is told to "ask owner to use Review in the app". On `feat/call-ui`, the only review entry point is "Review and publish", inside the Products sheet. It shows only when `mode === "create"` and at least one draft exists. The main call controls are mute, camera, flip and End call, so there is no Finish & review button there. | `feat/call-ui` `CallScreen.tsx` | implemented (A lane) |
| O5 | Dead end | An expired publish summary tells the owner "Ask your assistant to prepare it again". The agent cannot create proposals and is told to send the owner back to Review, so the two point at each other. | `ReviewPanel.tsx` vs `config.ts` | implemented |
| O6 | Contact approval | The publish dialog's checkbox reads "My contact email" and shows the address only if one exists. With `contactEmail === null` the owner can still tick it and confirm, which approves a contact that doesn't exist. | `ReviewPanel.tsx` | implemented |
| O7 | Contact approval | `contactEmail` is nullable in `api.ts` but a required email in `catalog.ts`, `observer.ts` and `verification.ts`. A store published without contact info fails late, during QA or public verification after the Replit build, not before approval. | contracts + verifier | tested locally |
| O8 | Contact accuracy | `upsert_business_brief.contactEmail` says "not an inferred address", but no check confirms that the email shown at review is the one the owner spoke or typed. A speech-to-text spelling error would be published as-is. | `tools.ts` | implemented |
| O9 | Replit publication | The OAuth, MCP client, sequential task workflow, deploy gate and anonymous verifier exist. However, `results.ts` ships **no response profile**, so every real create/build/publish result is treated as unknown and blocked. Project OAuth, account tool discovery, build readiness and publication are **not provider-verified**. | `replit-handoff.md`, `results.ts` | tested locally only |
| O10 | Dead end | Once a run is `blocked` (for example `REMOTE_OUTCOME_UNKNOWN` or `TASK_TIMEOUT_RECONCILE`), `step()` returns it unchanged and the workflow exposes no reconcile or resume action. The business reservation is released only on `ready` or `failed`, so a blocked run also stops any new build for that business. | `workflow.ts`, `store.ts` | implemented |
| O11 | Status mapping | The workflow's `RunPhase` (`dispatching`, `awaiting_task`, `ready_to_publish`, `blocked`) does not match the shared `BuildPhase` (`preparing`, `creating`, `building`, …, no `blocked`). The UI's status page has nothing to show for "blocked, needs reconciliation". | `workflow.ts`, `contracts/integrations.ts`, `status.ts` | scaffold (mapping owed by B) |
| O12 | Worker | `scripts/worker.ts` runs one tick per invocation and needs `SHOPCALL_RUNTIME_MODULE`. No runtime factory or loop is committed. It points to `publication-handoff.md`, which is not on the branch. | `scripts/worker.ts` | scaffold |
| O13 | Leave/resume | End call is always visible and stops the camera. Per the API contract it also preserves drafts. After ending, a status link appears only if `latestJobId` exists. With no job yet, the only option is "Tap to call", and the code does not show whether drafts come back. | `CallScreen.tsx` | implemented |
| O14 | Camera-off | Returning calls start with the camera off, and toggling the camera is separate from the voice session. The client tool returns `CAMERA_OFF` instead of capturing. However, `feat/integrations` still registers `capture_product_photo` without telling the agent whether the camera is on, so the agent may offer a photo and then hit the error. | `CallScreen.tsx`, `clientTools.ts`, `config.ts` | implemented |
| O15 | Same-URL update | The storefront contract requires uncached server rendering plus a no-store `/api/shopcall/catalog` proxy. Email copy says "future updates appear at the same address". The handoff itself lists the same-URL camera-off update as an **unrun** acceptance gate. | `orchestrator-handoff.md`, `template.ts` | tested locally only |
| O16 | Voice | The private agent, signed URL and tool set are provider-verified. No browser conversation, microphone, capture or end-to-end tool call has been run. The call cap is 900 s. | `voice-handoff.md` | provider-verified (setup only) |
| O17 | Truthful claims | The prompt allows "published" only after `get_build_status` returns ready with a verified URL, and "sent" only after a provider result. The email is sent only after `evaluatePublishedGate` passes and the owner email is verified. This is the strongest part of the branch. | `config.ts`, `publication/notifications.ts` | tested locally |

## 2. Proposed checks (rehearsal checklist)

These are not yet observed passing. Tick each one only with live evidence (screen recording, network log or provider metadata), not with agent speech.

### A. First-call inventory intake
- [ ] Opener is one broad question. The owner volunteers the store name, style and the first item's name, price and count in one breath, and the agent asks nothing already given (fixes O1/O2: merge the concise policy first).
- [ ] Currency is asked at most once per store and shown at final review.
- [ ] For 3 items: no more than one follow-up per item, and only for a missing required field or a real ambiguity.
- [ ] Each item shows as a product card, complete or incomplete, as soon as it is saved. Fixing a photo label by touch takes one tap and no spoken turns.
- [ ] No default stock of 1 and no inferred price. Untracked stock is an explicit choice.
- [ ] Optional enrichment (story, shipping, variants) is not offered before the starter store is ready.
- [ ] Speaking time stays near the ~2 min target. That is a design target to watch, not a claim.

### B. Visible Finish & review
- [ ] Finish & review and End call are visible on the main call controls the whole time, not only inside the Products sheet (O4).
- [ ] Finish & review opens even with incomplete drafts and shows the missing fields inline.
- [ ] Ending the call and reloading brings the same drafts back with the same draft IDs (O13).
- [ ] An expired summary has a one-tap "Refresh summary" action in the UI. It does not send the owner back to the assistant (O5).
- [ ] Exactly one combined readback is spoken before the click, with no per-field verbal confirmations before it (O3).

### C. Accurate public contact approval
- [ ] With no contact on file, publish confirm is disabled and the screen asks for an email. The contact checkbox cannot be ticked against nothing (O6).
- [ ] The review shows the exact email string that will be public, editable by typing (O8).
- [ ] Missing or invalid contact is caught before approval, not by the post-build verifier (O7).
- [ ] Owner email (for notifications) and public contact email are labelled as separate fields.

### D. Real Replit publication
- [ ] Project OAuth completed through the backend callback, not through Codex-side login (O9).
- [ ] Live tool discovery recorded and the response profile filled from observed output (O9).
- [ ] One app ID persists across design → frontend → catalog → QA, and publish happens on that same app.
- [ ] The public URL loads in a logged-out browser with real products, prices, stock, images and the contact-to-buy link. No checkout.
- [ ] The status screen shows real phases, including blocked or failed with plain-language next steps. No percentages (O11).
- [ ] An operator can resolve a blocked run without editing files. The business is not left locked for new builds (O10).
- [ ] The worker loop runs unattended for the demo, or the operator step is disclosed (O12).
- [ ] The audio call has ended before the build starts. The caller is released to the status screen.
- [ ] "Email sent" appears only if Resend is configured and returned a result. Otherwise nothing about email is said.

### E. Second call, camera off, price/stock update
- [ ] The returning call starts with the camera off, the agent loads the catalog first, and it doesn't offer to start a new store.
- [ ] The agent doesn't offer photo capture while the camera is off (O14).
- [ ] "Mugs are $28 now and the blue bowl sold out" produces one before/after table and one apply click (O3).
- [ ] "Sold it" gets exactly one clarifying question.
- [ ] Toggling the camera mid-call doesn't drop audio.
- [ ] After apply, a hard refresh of the **same** public URL shows the new price and the sold-out state with no Replit rebuild. Confirm no new build job was created (O15).

## 3. Flags summary

| Risk | Items |
|------|-------|
| Excessive questioning | O1, O2 |
| Repeated confirmations | O3 |
| Unsupported claims | O9 and O15: don't say "automatically published by Replit" or "updates live at the same URL" until D and E pass live |
| Dead-end states | O5, O7, O10, O11 |
| Cannot leave/resume | O4, O13 |

## 4. Demo and pitch wording

Use these lines once the checks in section 2 back them. Don't claim novelty, "first", checkout, payments or order handling.

**One-liner:** "Shopcall turns a phone call into a working storefront. You hold up what you make, say the price and how many you have, and it builds a real store on Replit. Later, you call back to keep prices and stock current."

**Intake (camera on):** "No forms. The owner shows each item and says what it is, what it costs and how many are on the shelf. Shopcall drafts the listing and attaches the photo. The owner reviews everything once, including the contact email buyers will see, and approves with one tap."

**Publication:** "After approval, the call ends and Replit builds and publishes the store. We show the link only after we've loaded the page ourselves as an anonymous visitor."

**Ongoing maintenance (camera off):** "The next week, the owner calls back with the camera off: 'mugs are 28 now, the blue bowl sold out.' One summary, one tap, and the same link shows the new price and stock. No rebuild."

**Boundaries to say out loud if asked:** "Buyers contact the seller directly. There's no checkout. The voice agent can't publish or apply changes by itself. The owner's tap in the app is the approval."

Avoid: "instantly", "fully automated" (until D passes unattended), "AI-verified", "email sent" (until Resend is confirmed), and any "first" or "only" claims.
