"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation, useConversationClientTool } from "@elevenlabs/react";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, Phone, SwitchCamera, Store } from "lucide-react";
import { CLIENT_TOOL_NAMES } from "../../../contracts/integrations";
import { createApiClient, type DraftPatch, type OwnerSession, type ProposalSummary } from "../api";
import { useCamera } from "../camera";
import { createClientTools } from "../clientTools";
import { draftsReducer, initialDrafts } from "../drafts";
import { ConsentNotice } from "./ConsentNotice";
import { DraftTray } from "./DraftTray";
import { ReviewPanel } from "./ReviewPanel";

type Load = { state: "loading" } | { state: "signed_out" } | { state: "error"; message: string } | { state: "ready"; session: OwnerSession };
type CallPhase = "idle" | "starting" | "live" | "ended";
type Pending = { kind: "catalog_change" | "publish"; proposal: ProposalSummary; idempotencyKey: string };

export function CallScreen() {
  return (
    <ConversationProvider>
      <CallRoom />
    </ConversationProvider>
  );
}

function CallRoom() {
  const api = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const camera = useCamera();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [drafts, dispatch] = useReducer(draftsReducer, initialDrafts);
  const [review, setReview] = useState<Pending | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const session = load.state === "ready" ? load.session : null;
  const mode: "create" | "update" = session?.business && session.catalogRevision > 0 ? "update" : "create";

  // Refs so tool handlers always read current values.
  const live = useRef({ callId, drafts, session, cameraState: camera.state });
  live.current = { callId, drafts, session, cameraState: camera.state };
  const proposals = useRef(new Map<string, Pending>());

  const conversation = useConversation({
    onError: (message: string) => setCallError(typeof message === "string" ? message : "Voice connection error."),
    onDisconnect: () => setPhase(p => (p === "live" ? "ended" : p)),
  });
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const tell = useCallback((text: string) => {
    try { convRef.current.sendContextualUpdate(text); } catch { /* not connected */ }
  }, []);

  useEffect(() => {
    api.getSession().then(res => {
      if (res.ok) setLoad({ state: "ready", session: res.data });
      else if (res.error.code === "UNAUTHORIZED") setLoad({ state: "signed_out" });
      else setLoad({ state: "error", message: res.error.message });
    });
  }, [api]);

  const uploadToDraft = useCallback(async (draftId: string, image: Blob) => {
    // draftId is fixed here, before any await: the result can only land on this draft.
    const localId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(image);
    dispatch({ type: "capture_started", draftId, localId, previewUrl });
    const res = await api.uploadDraftImage(draftId, image, new Date().toISOString());
    dispatch({ type: "capture_settled", draftId, localId, result: res.ok ? res : { ok: false, message: res.error.message } });
    if (res.ok && res.data.productDraftId === draftId) {
      return { ok: true as const, captureId: res.data.captureId, thumbnailUrl: res.data.thumbnailUrl };
    }
    return { ok: false as const, error: res.ok ? "Photo was attached to a different draft by the server." : res.error.message };
  }, [api]);

  const captureForDraft = useCallback(async (draftId: string) => {
    let still: Blob;
    try { still = await camera.grab(); } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "Camera is off." }; }
    return uploadToDraft(draftId, still);
  }, [camera, uploadToDraft]);

  const tools = useMemo(() => createClientTools({
    api,
    callId: () => live.current.callId,
    businessId: () => live.current.session?.business?.id ?? null,
    catalogRevision: () => live.current.session?.catalogRevision ?? 0,
    drafts: () => live.current.drafts,
    dispatch,
    captureForDraft,
    isCameraOn: () => live.current.cameraState === "on",
    rememberProposal: (kind, proposal) => proposals.current.set(proposal.id, { kind, proposal, idempotencyKey: crypto.randomUUID() }),
    openConfirmation: (kind, proposalId) => {
      const p = proposals.current.get(proposalId);
      if (!p || p.kind !== kind) return false;
      setReviewError(null);
      setReview(p);
      return true;
    },
    newIdempotencyKey: () => crypto.randomUUID(),
  }), [api, captureForDraft]);

  for (const name of CLIENT_TOOL_NAMES) {
    // CLIENT_TOOL_NAMES is a constant tuple, so hook order is stable.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useConversationClientTool(name, (params: Record<string, unknown>) => tools[name](params));
  }

  async function startCall() {
    setCallError(null);
    setPhase("starting");
    const call = await api.createCall(mode);
    if (!call.ok) { setPhase("idle"); return setCallError(call.error.message); }
    setCallId(call.data.callId);
    const cred = await api.createVoiceSession(call.data.callId);
    if (!cred.ok) { setPhase("idle"); return setCallError(cred.error.message); }
    try {
      if ("conversationToken" in cred.data) conversation.startSession({ conversationToken: cred.data.conversationToken, connectionType: "webrtc" });
      else conversation.startSession({ signedUrl: cred.data.signedUrl, connectionType: "websocket" });
      setPhase("live");
    } catch (e) {
      setPhase("idle");
      setCallError(e instanceof Error ? e.message : "Couldn't start the voice call.");
    }
  }

  const endCall = useCallback(async () => {
    try { convRef.current.endSession(); } catch { /* already ended */ }
    camera.stop();
    setPhase("ended");
    const id = live.current.callId;
    if (id) await api.endCall(id);
  }, [api, camera]);

  // Leaving the page ends voice and releases camera (camera hook also cleans itself up).
  useEffect(() => () => { try { convRef.current.endSession(); } catch { /* noop */ } }, []);

  async function saveDraft(draftId: string, patch: DraftPatch) {
    const res = await api.patchDraft(draftId, patch);
    if (!res.ok) return res.error.message;
    dispatch({ type: "draft_saved", draft: res.data });
    tell(`Owner edited product draft ${draftId} in the app: ${JSON.stringify(patch)}. Treat these as the owner's explicit values.`);
    return null;
  }

  async function openPublishReview() {
    setReviewError(null);
    const res = await api.proposePublication();
    if (!res.ok) return setCallError(res.error.message);
    const pending: Pending = { kind: "publish", proposal: res.data, idempotencyKey: crypto.randomUUID() };
    proposals.current.set(res.data.id, pending);
    setReview(pending);
  }

  async function confirmReview() {
    if (!review) return;
    setReviewBusy(true);
    setReviewError(null);
    const { kind, proposal, idempotencyKey } = review;
    if (kind === "catalog_change") {
      const res = await api.confirmCatalogProposal(proposal.id, proposal.approvalNonce, idempotencyKey);
      setReviewBusy(false);
      if (!res.ok) {
        setReviewError(res.error.code === "CONFLICT" ? "Your catalog changed since this summary. Ask your assistant to check again." : res.error.message);
        return;
      }
      setLoad(l => (l.state === "ready" ? { state: "ready", session: { ...l.session, catalogRevision: res.data.catalogRevision } } : l));
      tell(`Owner confirmed proposal ${proposal.id} in the app. Backend applied it; catalog revision is now ${res.data.catalogRevision}.`);
      setReview(null);
    } else {
      const res = await api.confirmPublication(proposal.id, proposal.approvalNonce, idempotencyKey);
      setReviewBusy(false);
      if (!res.ok) return setReviewError(res.error.message);
      tell(`Owner confirmed publication. Build job ${res.data.id} is queued. It is NOT live yet; use get_build_status for real progress.`);
      setReview(null);
      router.push(`/status?job=${encodeURIComponent(res.data.id)}`);
    }
  }

  if (load.state === "loading") return <p className="muted" role="status">Loading your store…</p>;
  if (load.state === "signed_out") return <div className="panel"><p>Please sign in to start a call.</p><Link className="btn primary" href="/login">Sign in</Link></div>;
  if (load.state === "error") return <div className="panel"><p className="error" role="alert">{load.message}</p><p className="muted">The call can&apos;t start until the session service is available.</p></div>;

  const businessName = session?.business?.name;
  const voiceStatus = conversation.status;
  const inCall = phase === "live" || phase === "starting";

  return (
    <div className="call-layout">
      <section className="stage" aria-label="Call">
        <div className="stage-head">
          <div>
            <p className="eyebrow">{mode === "update" ? "Update call" : "New store call"}</p>
            <h1 className="page-title">{businessName ?? "Your new store"}</h1>
          </div>
          <span className={`pill status-${voiceStatus}`} role="status" aria-live="polite">
            {phase === "ended" ? "Call ended" : voiceStatus === "connected" ? (conversation.isSpeaking ? "Assistant speaking" : "Listening") : voiceStatus === "connecting" || phase === "starting" ? "Connecting…" : voiceStatus === "error" ? "Connection problem" : "Not connected"}
          </span>
        </div>

        <div className={`preview ${camera.state === "on" ? "on" : ""}`}>
          <video ref={camera.videoRef} playsInline muted autoPlay aria-label="Your camera preview" hidden={camera.state !== "on"} />
          {camera.state !== "on" && (
            <div className="preview-empty">
              <CameraOff size={28} strokeWidth={1.4} aria-hidden="true" />
              <p>
                {camera.state === "starting" ? "Starting camera…"
                  : camera.state === "denied" ? "Camera access was blocked. You can keep talking and upload photos instead."
                  : camera.state === "unavailable" ? "No camera found. You can keep talking and upload photos instead."
                  : camera.state === "error" ? "The camera couldn't start. Try again or upload photos."
                  : mode === "update" ? "Camera is off. You can update prices and stock by voice." : "Camera is off. Turn it on when you're ready to show a product."}
              </p>
            </div>
          )}
          {drafts.activeId && camera.state === "on" && (
            <span className="active-chip">Capturing {drafts.byId[drafts.activeId]?.title || "new product"}</span>
          )}
        </div>

        {callError && <p className="error" role="alert">{callError}</p>}

        <div className="controls" role="group" aria-label="Call controls">
          {!inCall ? (
            <button type="button" className="btn primary big" onClick={startCall}>
              <Phone size={18} aria-hidden="true" /> {phase === "ended" ? "Call again" : "Start call"}
            </button>
          ) : (
            <>
              <button type="button" className="icon-btn" aria-pressed={conversation.isMuted} aria-label={conversation.isMuted ? "Unmute microphone" : "Mute microphone"} onClick={() => conversation.setMuted(!conversation.isMuted)}>
                {conversation.isMuted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
              </button>
              <button type="button" className="icon-btn" aria-pressed={camera.state === "on"} aria-label={camera.state === "on" ? "Turn camera off" : "Turn camera on"} onClick={() => (camera.state === "on" ? camera.stop() : camera.start())} disabled={camera.state === "starting"}>
                {camera.state === "on" ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}
              </button>
              {camera.state === "on" && camera.canSwitch && (
                <button type="button" className="icon-btn" aria-label={`Switch to ${camera.facing === "user" ? "back" : "front"} camera`} onClick={camera.flip}>
                  <SwitchCamera aria-hidden="true" />
                </button>
              )}
              <button type="button" className="icon-btn danger" aria-label="End call" onClick={endCall}>
                <PhoneOff aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        {phase === "idle" && <ConsentNotice />}
      </section>

      <aside className="side">
        <DraftTray
          state={drafts}
          cameraOn={camera.state === "on"}
          onSelect={id => { dispatch({ type: "set_active", draftId: id }); tell(`Owner selected product draft ${id} in the app.`); }}
          onCapture={id => { void captureForDraft(id); }}
          onUpload={(id, file) => { void uploadToDraft(id, file); }}
          onRemoveCapture={(id, localId) => dispatch({ type: "capture_removed", draftId: id, localId })}
          onSave={saveDraft}
        />
        {mode === "create" && drafts.order.length > 0 && (
          <button type="button" className="btn primary" onClick={openPublishReview}><Store size={16} aria-hidden="true" /> Review and publish</button>
        )}
        {session?.latestJobId && <Link className="text-link" href={`/status?job=${encodeURIComponent(session.latestJobId)}`}>Storefront status</Link>}
      </aside>

      {review && (
        <ReviewPanel
          kind={review.kind}
          proposal={review.proposal}
          contactEmail={session?.business?.contactEmail ?? null}
          busy={reviewBusy}
          error={reviewError}
          onConfirm={confirmReview}
          onCancel={() => { setReview(null); tell(`Owner closed the confirmation for proposal ${review.proposal.id} without confirming. Nothing was applied.`); }}
        />
      )}
    </div>
  );
}
