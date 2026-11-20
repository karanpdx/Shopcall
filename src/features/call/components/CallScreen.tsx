"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation, useConversationClientTool } from "@elevenlabs/react";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, ShoppingBag, SwitchCamera, X } from "lucide-react";
import { CLIENT_TOOL_NAMES } from "../../../contracts/integrations";
import { createApiClient, type DraftPatch, type OwnerSession, type ProposalSummary } from "../api";
import { useCamera } from "../camera";
import { createClientTools } from "../clientTools";
import { draftsReducer, initialDrafts, missingFields } from "../drafts";
import { DraftTray } from "./DraftTray";
import { ReviewPanel } from "./ReviewPanel";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; session: OwnerSession };
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [review, setReview] = useState<Pending | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const session = load.state === "ready" ? load.session : null;
  const mode: "create" | "update" = session?.business && session.catalogRevision > 0 ? "update" : "create";

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

  // No sign-in screen: reuse this device's owner session, or ask the backend to start one.
  useEffect(() => {
    (async () => {
      let res = await api.getSession();
      if (!res.ok && res.error.code === "UNAUTHORIZED") res = await api.startOwnerSession();
      setLoad(res.ok ? { state: "ready", session: res.data } : { state: "error", message: res.error.message });
    })();
  }, [api]);

  const uploadToDraft = useCallback(async (draftId: string, image: Blob) => {
    // draftId is fixed before any await: the result can only land on this draft.
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
    if (load.state === "error") return setCallError(load.message);
    setPhase("starting");
    // One tap: first call brings the camera up with the call. Returning calls stay camera-off.
    if (mode === "create" && camera.state === "off") void camera.start();
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
    setSheetOpen(false);
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

  const businessName = session?.business?.name;
  const inCall = phase === "live" || phase === "starting";
  const voice = conversation.status;
  const statusText =
    load.state === "loading" ? "Getting ready…"
    : phase === "ended" ? "Call ended"
    : phase === "starting" || voice === "connecting" ? "Calling…"
    : voice === "connected" ? (conversation.isSpeaking ? "Speaking" : "Listening")
    : voice === "error" ? "Connection problem"
    : mode === "update" ? "Ready to update your store" : "Ready when you are";
  const captures = drafts.order.flatMap(id => drafts.byId[id].captures.map(c => ({ ...c, draftId: id })));
  const readyCount = drafts.order.filter(id => missingFields(drafts.byId[id]).length === 0).length;
  const notice = callError;

  return (
    <div className={`ft ${camera.state === "on" ? "cam-on" : "cam-off"}`}>
      <video ref={camera.videoRef} className={`ft-video ${camera.facing === "user" ? "mirror" : ""}`} playsInline muted autoPlay aria-label="Your camera" hidden={camera.state !== "on"} />

      {camera.state !== "on" && (
        <div className="ft-avatar">
          {!inCall ? (
            <button type="button" className="orb idle" onClick={startCall} disabled={load.state === "loading"} aria-label={phase === "ended" ? "Call again" : "Tap to call"}>
              <span className="orb-face" aria-hidden="true"><i /><i /></span>
            </button>
          ) : (
            <span className={`orb ${voice === "connected" ? (conversation.isSpeaking ? "speaking" : "listening") : "connecting"}`} aria-hidden="true">
              <span className="orb-face"><i /><i /></span>
            </span>
          )}
        </div>
      )}

      <header className="ft-top">
        <span className="ft-spacer" aria-hidden="true" />
        <div className={`ft-title ${inCall ? "" : "sr-only"}`}>
          <strong>{businessName ?? "Shopcall"}</strong>
          <span role="status" aria-live="polite">{statusText}</span>
        </div>
        {drafts.order.length > 0 ? (
          <button type="button" className="ft-bag" aria-label={`Products: ${drafts.order.length}`} onClick={() => setSheetOpen(true)}>
            <ShoppingBag size={20} aria-hidden="true" />
            <span className="ft-badge">{drafts.order.length}</span>
          </button>
        ) : <span className="ft-spacer" aria-hidden="true" />}
      </header>

      {drafts.activeId && camera.state === "on" && inCall && (
        <span className="ft-chip">Showing: {drafts.byId[drafts.activeId]?.title || "new product"}</span>
      )}

      {camera.state !== "on" && !inCall && camera.state !== "off" && camera.state !== "starting" && (
        <p className="ft-hint">
          {camera.state === "denied" ? "Camera blocked. You can still talk, and add photos from the products button."
            : camera.state === "unavailable" ? "No camera found. You can still talk and upload photos."
            : "The camera couldn't start."}
        </p>
      )}

      <div className="ft-bottom">
        {captures.length > 0 && (
          <ul className="ft-strip" aria-label="Captured photos">
            {captures.slice(-6).map(c => (
              <li key={c.localId} className={c.status}>
                <button type="button" onClick={() => { dispatch({ type: "set_active", draftId: c.draftId }); setSheetOpen(true); }} aria-label={`Photo of ${drafts.byId[c.draftId].title || "product"}, ${c.status === "saved" ? "saved" : c.status === "uploading" ? "saving" : "not saved"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URLs and backend thumbnails */}
                  <img src={c.thumbnailUrl ?? c.previewUrl} alt="" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {notice && <p className="ft-notice" role="alert">{notice}</p>}

        {!inCall ? (
          <div className="ft-start">
            <span className="ft-cta">Tap to call</span>
            {phase === "ended" && session?.latestJobId && <Link className="ft-link" href={`/status?job=${encodeURIComponent(session.latestJobId)}`}>See storefront status</Link>}
          </div>
        ) : (
          <div className="ft-controls" role="group" aria-label="Call controls">
            <button type="button" className="ft-round" aria-pressed={conversation.isMuted} aria-label={conversation.isMuted ? "Unmute" : "Mute"} onClick={() => conversation.setMuted(!conversation.isMuted)}>
              {conversation.isMuted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
            <button type="button" className="ft-round" aria-pressed={camera.state !== "on"} aria-label={camera.state === "on" ? "Turn camera off" : "Turn camera on"} onClick={() => (camera.state === "on" ? camera.stop() : camera.start())} disabled={camera.state === "starting"}>
              {camera.state === "on" ? <Camera aria-hidden="true" /> : <CameraOff aria-hidden="true" />}
            </button>
            <button type="button" className="ft-round" aria-label="Flip camera" onClick={camera.flip} disabled={camera.state !== "on" || !camera.canSwitch}>
              <SwitchCamera aria-hidden="true" />
            </button>
            <button type="button" className="ft-round end" aria-label="End call" onClick={endCall}>
              <PhoneOff aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {sheetOpen && (
        <div className="ft-sheet" role="dialog" aria-modal="true" aria-label="Products">
          <div className="ft-sheet-head">
            <span className="ft-grabber" aria-hidden="true" />
            <button type="button" className="ft-close" aria-label="Close products" onClick={() => setSheetOpen(false)}><X size={20} aria-hidden="true" /></button>
          </div>
          <DraftTray
            state={drafts}
            cameraOn={camera.state === "on"}
            onSelect={id => { dispatch({ type: "set_active", draftId: id }); tell(`Owner selected product draft ${id} in the app.`); }}
            onCapture={id => { setSheetOpen(false); void captureForDraft(id); }}
            onUpload={(id, file) => { void uploadToDraft(id, file); }}
            onRemoveCapture={(id, localId) => dispatch({ type: "capture_removed", draftId: id, localId })}
            onSave={saveDraft}
          />
          {mode === "create" && drafts.order.length > 0 && (
            <button type="button" className="btn primary ft-publish" onClick={openPublishReview}>
              Review and publish {readyCount > 0 ? `(${readyCount} ready)` : ""}
            </button>
          )}
        </div>
      )}

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
