# Call UI ownership

Person A owns this folder and `src/app` except `src/app/api`.
See `docs/team/person-a-call-ui.md`. Import shared contracts from `src/contracts`.

## Photo evidence and optional choices

The visible product is branded **lit**; internal API paths, cookies and storage keys retain their existing names. Photo processing stays inside the Products sheet. `DraftMediaPanel` reads the durable, draft-bound media projection and polls only queued/running jobs. It shows actual analysis/enhancement state, suggested listing text and original/enhanced images when real outputs exist. Results from another draft or a replaced capture are ignored. Applying suggestions or selecting an enhancement requires an owner click with the current draft revision; prices and quantities never come from these suggestions. The original remains available and is the default.

Finish & review ends audio/video and opens listing previews before freezing a publication batch. Review & publish then prepares the one final combined confirmation. Optional processing can continue in the background; keeping the original never blocks completion or forces another conversation question.

`tests/ui/media.test.ts` checks association/state/API flags. Opt-in `browser-media-evidence.test.ts` renders explicitly mocked generated outputs and checks preview-before-click, text/image owner choices, retained original, unchanged price/stock and camera-off behavior. These UI tests do not claim a real image model ran.
