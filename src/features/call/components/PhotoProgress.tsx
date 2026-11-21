"use client";
import { useEffect, useMemo, useState } from "react";
import { createApiClient } from "../api";
import type { DraftView } from "../drafts";
import { mediaJobIsRunning, mediaJobMatchesDraft, ownerMediaAssetUrl, type MediaJobView } from "../media";

export function photoProgressLabel(job: MediaJobView | null, saving: boolean, failed: boolean) {
  if (saving) return "Saving photo…";
  if (failed) return "Photo was not saved";
  if (!job) return "Photo saved";
  if (job.enhancementStatus === "ready" && job.enhancedAssetId) return "Enhanced preview ready";
  if (job.analysisStatus === "running") return "Analyzing photo…";
  if (job.analysisStatus === "queued") return "Photo queued for analysis";
  if (job.enhancementStatus === "running" || job.enhancementStatus === "queued") return "Enhancing photo…";
  if (job.analysisStatus === "ready") return "Description suggestion ready";
  return "Original saved · processing unavailable";
}

/** Passive evidence during the call. Opening details never stops audio or selects generated output. */
export function PhotoProgress({ callId, draft, onOpen }: { callId: string; draft: DraftView; onOpen: () => void }) {
  const api = useMemo(() => createApiClient(), []);
  const [job, setJob] = useState<MediaJobView | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setJob(null);
    if (!draft.imageAssetId) return;
    async function poll() {
      const response = await api.getDraftMedia(callId, draft.id);
      if (stopped || !response.ok) return;
      const next = response.data.job;
      if (next && !mediaJobMatchesDraft(next, draft)) return;
      setJob(next);
      if (next && mediaJobIsRunning(next)) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, callId, draft.id, draft.imageAssetId]);
  const capture = draft.captures.at(-1);
  const saving = capture?.status === "uploading";
  const failed = !draft.imageAssetId && capture?.status === "failed";
  const enhanced = job?.enhancementStatus === "ready" ? job.enhancedAssetId : null;
  const preview = saving ? capture?.previewUrl : enhanced ? ownerMediaAssetUrl(enhanced) : draft.imageAssetId ? ownerMediaAssetUrl(draft.imageAssetId) : capture?.previewUrl;
  if (!preview) return null;
  const label = photoProgressLabel(job, saving, failed);
  const suggestion = job?.suggestedDescription?.trim();
  return <button type="button" onClick={onOpen} aria-label={`${label} for ${draft.title || "product"}. Open products`} style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr)", gap: 10, alignItems: "center", textAlign: "left", maxWidth: 360, width: "100%", padding: 8, border: "1px solid var(--line)", borderRadius: 12, color: "var(--ink)", background: "var(--paper)", cursor: "pointer" }}>
    <img src={preview} alt={enhanced ? "Generated preview" : "Latest saved photo"} width={48} height={48} style={{ objectFit: "cover", borderRadius: 8 }} />
    <span><strong style={{ display: "block", fontSize: 13 }} role="status" aria-live="polite">{label}</strong><span style={{ fontSize: 11 }}>{suggestion ? `Suggested: ${suggestion.slice(0, 100)}${suggestion.length > 100 ? "…" : ""}` : "Tap to see photos and suggestions"}</span></span>
  </button>;
}
