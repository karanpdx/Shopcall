"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { BuildJob, BuildPhase } from "../../../contracts/integrations";
import { createApiClient, type ApiError } from "../api";
import { isTerminal, phaseSteps, verifiedUrl } from "../status";

const POLL_MS = 4000;

const LABEL: Record<BuildPhase, string> = {
  queued: "Received", preparing: "Preparing your products", creating: "Creating the site",
  building: "Building", publishing: "Publishing", verifying: "Checking the public link",
  ready: "Live", failed: "Failed",
};

export function StatusView({ jobId }: { jobId: string | null }) {
  const api = useMemo(() => createApiClient(), []);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const res = await api.getJob(jobId!);
      if (stopped) return;
      if (res.ok) { setJob(res.data); setError(null); if (isTerminal(res.data.phase)) return; }
      else { setError(res.error); if (res.error.code === "UNAUTHORIZED" || res.error.code === "NOT_FOUND") return; }
      timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, jobId]);

  if (!jobId) return <div className="panel"><p>No storefront build to show yet.</p><Link className="btn primary" href="/call">Go to your call</Link></div>;

  const url = job ? verifiedUrl(job) : null;
  return (
    <div className="panel status-panel">
      <h1 className="page-title">{job?.phase === "ready" ? "Your storefront is live" : job?.phase === "failed" ? "Your storefront wasn't published" : "Your storefront is being built"}</h1>
      {error && <p className="error" role="alert">{error.code === "UNAUTHORIZED" ? "Please sign in to see this status." : error.message}</p>}
      {!job && !error && <p className="muted" role="status">Checking status…</p>}
      {job && (
        <>
          <ol className="phases" aria-label="Build progress">
            {phaseSteps(job.phase).map(s => (
              <li key={s.phase} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>{LABEL[s.phase]}</li>
            ))}
          </ol>
          <p className="muted" role="status" aria-live="polite">Updated {new Date(job.updatedAt).toLocaleTimeString()}</p>
          {url && <a className="btn primary" href={url} target="_blank" rel="noreferrer">Open your storefront <ExternalLink size={16} aria-hidden="true" /></a>}
          {job.phase === "failed" && (
            <div className="failure">
              <p>Your store details are saved, but nothing is live yet.</p>
              {job.error && <p className="error">{job.error}</p>}
              <Link className="btn ghost" href="/call">Back to your call</Link>
            </div>
          )}
          {!isTerminal(job.phase) && <p className="muted">You can leave this page. We&apos;ll email you when the link is verified.</p>}
        </>
      )}
    </div>
  );
}
