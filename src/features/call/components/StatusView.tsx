"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { BuildPhase } from "../../../contracts/integrations";
import { buildStageLabel, createApiClient, type ApiError, type UiBuildStatus } from "../api";
import { isTerminal, phaseSteps, verifiedUrl } from "../status";

const POLL_MS = 4000;

const LABEL: Record<BuildPhase, string> = {
  queued: "Received", preparing: "Preparing your products", creating: "Creating the site",
  building: "Building", publishing: "Publishing", verifying: "Checking the public link",
  ready: "Live", failed: "Failed",
};

export function StatusView({ jobId }: { jobId: string | null }) {
  const api = useMemo(() => createApiClient(), []);
  const [job, setJob] = useState<UiBuildStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const res = await api.getJob(jobId!);
      if (stopped) return;
      if (res.ok) { setJob(res.data); setError(null); if (isTerminal(res.data.phase) && !res.data.requiresAttention) return; }
      else { setError(res.error); if (res.error.code === "UNAUTHORIZED" || res.error.code === "NOT_FOUND") return; }
      timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, jobId]);

  if (!jobId) return <div className="panel"><p>No storefront build to show yet.</p><Link className="btn primary" href="/">Back to call</Link></div>;

  const url = job ? verifiedUrl(job) : null;
  return (
    <div className="panel status-panel">
      <h1 className="page-title">{job?.requiresAttention ? "Your build needs attention" : job?.phase === "ready" ? "Your storefront is live" : job?.phase === "failed" ? "Your storefront wasn't published" : "Your storefront is being built"}</h1>
      {error && <p className="error" role="alert">{error.code === "UNAUTHORIZED" ? "Please sign in to see this status." : error.message}</p>}
      {!job && !error && <p className="muted" role="status">Checking status…</p>}
      {job && !job.requiresAttention && !isTerminal(job.phase) && buildStageLabel(job.task) && <p className="muted" role="status">{buildStageLabel(job.task)}</p>}
      {job && (
        <>
          {!job.requiresAttention && <ol className="phases" aria-label="Build progress">
            {phaseSteps(job.phase).map(s => (
              <li key={s.phase} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>{LABEL[s.phase]}</li>
            ))}
          </ol>}
          <p className="muted" role="status" aria-live="polite">Updated {new Date(job.updatedAt).toLocaleTimeString()}</p>
          {url && <a className="btn primary" href={url} target="_blank" rel="noreferrer">Open your storefront <ExternalLink size={16} aria-hidden="true" /></a>}
          {job.phase === "failed" && (
            <div className="failure">
              <p>{job.requiresAttention ? "The build is waiting for another check. Your listings are saved, and this page will keep checking for progress." : "Your listings are saved. This attempt did not produce a verified public link."}</p>
              {job.error && <p className="error">{job.error}</p>}
              <Link className="btn ghost" href="/">Call again</Link>
            </div>
          )}
          {!isTerminal(job.phase) && <p className="muted">You can leave this page and return for the verified link. Email delivery depends on the configured sender.</p>}
        </>
      )}
    </div>
  );
}
