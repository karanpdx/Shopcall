"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiClient } from "../api";
import type { DraftView } from "../drafts";
import { mediaJobIsRunning, mediaJobMatchesDraft, mediaStageLabel, ownerMediaAssetUrl, type MediaChoice, type MediaJobView } from "../media";

/** Runs only inside Products. Backend work continues independently when this panel closes. */
export function DraftMediaPanel({ callId, draft, onChanged }: { callId: string; draft: DraftView; onChanged: () => Promise<void> }) {
  const api = useMemo(() => createApiClient(), []);
  const [job, setJob] = useState<MediaJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(draft); latest.current = draft;
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setJob(null); setError(null);
    if (!draft.imageAssetId) return;
    async function poll() {
      const result = await api.getDraftMedia(callId, draft.id);
      if (stopped || currentGeneration !== generation.current) return;
      if (!result.ok) { setError("Photo is saved. Processing status is unavailable; you can continue with the original."); return; }
      const next = result.data.job;
      if (next && !mediaJobMatchesDraft(next, latest.current)) return;
      setJob(next);
      if (next && mediaJobIsRunning(next)) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, callId, draft.id, draft.imageAssetId]);

  async function choose(choice: Omit<MediaChoice, "jobId" | "expectedDraftRevision">) {
    if (!job || busy || !mediaJobMatchesDraft(job, latest.current)) return;
    setBusy(true); setError(null);
    const id = job.id;
    const result = await api.chooseDraftMedia(callId, draft.id, { jobId: id, expectedDraftRevision: job.currentDraftRevision, ...choice });
    if (!result.ok) {
      setBusy(false); setError(result.error.message);
      const current = await api.getDraftMedia(callId, draft.id);
      if (current.ok && current.data.job?.id === id && mediaJobMatchesDraft(current.data.job, latest.current)) setJob(current.data.job);
      return;
    }
    await onChanged();
    const next = await api.getDraftMedia(callId, draft.id);
    if (next.ok && next.data.job?.id === id && mediaJobMatchesDraft(next.data.job, latest.current)) setJob(next.data.job);
    setBusy(false);
  }

  if (!draft.imageAssetId) return null;
  const stale = job && [job.analysisStatus, job.enhancementStatus].includes("stale");
  const suggestionsAvailable = !!job && job.analysisStatus === "ready" && !!(job.suggestedTitle || job.suggestedDescription);
  const suggestionsApplied = !!job && (!job.suggestedTitle || job.titleApplied) && (!job.suggestedDescription || job.descriptionApplied);
  const enhancementReady = !!job && job.enhancementStatus === "ready" && !!job.enhancedAssetId;
  return <section aria-label={`Photo processing for ${draft.title || "this product"}`}>
    <p className="muted" role="status">Photo saved. Original retained.</p>
    {job && <div aria-live="polite"><p className="muted">{mediaStageLabel(job.analysisStatus, "analysis")} · {mediaStageLabel(job.enhancementStatus, "enhancement")}</p></div>}
    {error && <p className="error" role="status">{error}</p>}
    {job && [job.analysisStatus, job.enhancementStatus].some(status => status === "failed" || status === "interrupted") && <p className="muted">Processing could not finish completely. Your original photo is available; you can keep going.</p>}
    {stale && <p className="muted">This photo job belongs to an earlier draft. Keep the current original and review the latest details.</p>}
    {suggestionsAvailable && <div><h3>Suggested listing</h3>{job.suggestedTitle && <p><strong>{job.suggestedTitle}</strong></p>}{job.suggestedDescription && <p>{job.suggestedDescription}</p>}<button type="button" className="btn ghost" disabled={busy || draft.approved || !!stale || suggestionsApplied} onClick={() => choose({ applyTitle: !!job.suggestedTitle && !job.titleApplied, applyDescription: !!job.suggestedDescription && !job.descriptionApplied })}>{suggestionsApplied ? "Suggestions applied" : "Apply suggestions"}</button><p className="muted">Suggestions describe the photo only. Your price and stock stay as you supplied them.</p></div>}
    {job && <div style={{ display: "grid", gridTemplateColumns: enhancementReady ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: 12 }}>
      <figure style={{ margin: 0 }}><img src={ownerMediaAssetUrl(job.originalAssetId)} alt={`Original photo of ${draft.title || "product"}`} style={{ width: "100%", height: 150, objectFit: "contain" }} /><figcaption>Original{job.selectedVariant === "original" ? " · selected" : " · retained"}</figcaption></figure>
      {enhancementReady && <figure style={{ margin: 0 }}><img src={ownerMediaAssetUrl(job.enhancedAssetId!)} alt={`Enhanced photo of ${draft.title || "product"}`} style={{ width: "100%", height: 150, objectFit: "contain" }} /><figcaption>Enhanced{job.selectedVariant === "enhanced" ? " · selected" : " · preview"}</figcaption></figure>}
    </div>}
    {enhancementReady && <div className="draft-actions" style={{ marginTop: 12 }}><button type="button" className="btn ghost" disabled={busy || draft.approved || !!stale || job.selectedVariant === "enhanced"} onClick={() => choose({ useEnhanced: true })}>Use enhanced photo</button>{job.selectedVariant === "enhanced" && <button type="button" className="btn ghost" disabled={busy || draft.approved || !!stale} onClick={() => choose({ useEnhanced: false })}>Keep original</button>}</div>}
  </section>;
}
