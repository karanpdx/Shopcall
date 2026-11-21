/** One in-flight still/upload per stable draft, shared by model, automatic and manual paths. */
export type DraftCaptureResult = { ok: true; captureId: string; thumbnailUrl: string; reused?: boolean } | { ok: false; error: string };
export function createDraftCaptureGuard(capture: (draftId: string) => Promise<DraftCaptureResult>, existing: (draftId: string) => DraftCaptureResult | null) {
  const inFlight = new Map<string, Promise<DraftCaptureResult>>();
  const saved = new Map<string, Extract<DraftCaptureResult, { ok: true }>>();
  return {
    run(draftId: string, reuseExisting = false): Promise<DraftCaptureResult> {
      const active = inFlight.get(draftId);
      if (active) return active;
      if (reuseExisting) {
        const found = existing(draftId) ?? saved.get(draftId);
        if (found?.ok) return Promise.resolve({ ...found, reused: true });
      }
      const request = Promise.resolve().then(() => capture(draftId)).then(result => {
        if (result.ok) saved.set(draftId, result);
        return result;
      }).finally(() => { inFlight.delete(draftId); });
      inFlight.set(draftId, request);
      return request;
    },
    clearSaved() { saved.clear(); },
  };
}
