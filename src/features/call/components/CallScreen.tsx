"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation, useConversationClientTool } from "@elevenlabs/react";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, ShoppingBag, SwitchCamera, X } from "lucide-react";
import { CLIENT_TOOL_NAMES } from "../../../contracts/integrations";
import type { ProductChange } from "../../../contracts/api";
import { createApiClient, flattenWorkingDraft, type CallSnapshot, type DraftPatch, type OwnerSession, type ProposalSummary } from "../api";
import { useCamera } from "../camera";
import { createClientTools } from "../clientTools";
import { draftsReducer, initialDrafts, formatMoney } from "../drafts";
import { DraftTray } from "./DraftTray";
import { ReviewPanel } from "./ReviewPanel";
import { ConsentNotice } from "./ConsentNotice";
import { Shell } from "./Shell";

type Load = { state: "loading" | "login" } | { state: "error"; message: string } | { state: "ready"; session: OwnerSession };
type Pending = { kind: "catalog_change" | "publish"; proposal: ProposalSummary; idempotencyKey: string; draftId?: string; continueReview?: boolean };
const CALL_STORAGE = "shopcall:working-call";
const JOB_STORAGE = "shopcall:last-job";

export function CallScreen() { return <ConversationProvider><CallRoom /></ConversationProvider>; }

function CallRoom() {
  const api = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const camera = useCamera();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "ended">("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<CallSnapshot | null>(null);
  const [drafts, dispatch] = useReducer(draftsReducer, initialDrafts);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [review, setReview] = useState<Pending | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [latestJob, setLatestJob] = useState<string | null>(null);
  const startGeneration = useRef(0);
  const session = load.state === "ready" ? load.session : null;
  const live = useRef({ snapshot, session, drafts, cameraState: camera.state, ownerName, contactEmail });
  live.current = { snapshot, session, drafts, cameraState: camera.state, ownerName, contactEmail };
  const approvedDrafts = useRef(new Set<string>());
  const profileEdited = useRef({ name: false, contact: false });
  const objectUrls = useRef(new Set<string>());

  const conversation = useConversation({
    onError: () => setCallError("Voice connection interrupted. Your saved drafts remain available; reconnect or finish and review."),
    onDisconnect: () => setPhase(current => current === "live" ? "ended" : current),
  });
  const convRef = useRef(conversation); convRef.current = conversation;
  const tell = useCallback((text: string) => { try { convRef.current.sendContextualUpdate(text); } catch { /* Not connected. */ } }, []);

  const hydrate = useCallback(async (current: CallSnapshot) => {
    setSnapshot(current);
    for (const draft of current.drafts) {
      if (draft.proposalId) {
        const proposal = await api.getCatalogProposal(draft.proposalId);
        if (proposal.ok && proposal.data.status === "approved") approvedDrafts.current.add(draft.id);
      }
      dispatch({ type: "draft_saved", draft: { ...flattenWorkingDraft(draft), approved: approvedDrafts.current.has(draft.id) } });
    }
    if (current.call.brief.name && !profileEdited.current.name) setOwnerName(current.call.brief.name);
    if (current.call.brief.contactEmail && !profileEdited.current.contact) setContactEmail(current.call.brief.contactEmail);
  }, [api]);

  const refreshWorkspace = useCallback(async () => {
    const callId = live.current.snapshot?.call.id;
    if (!callId) return;
    const response = await api.getCall(callId);
    if (response.ok) await hydrate(response.data);
  }, [api, hydrate]);

  const loadOwner = useCallback(async () => {
    const result = await api.getSession();
    if (!result.ok) { setLoad(result.error.code === "UNAUTHORIZED" ? { state: "login" } : { state: "error", message: result.error.message }); return; }
    setLoad({ state: "ready", session: result.data });
    setOwnerName(result.data.business.name); setContactEmail(result.data.business.contactEmail ?? "");
    setLatestJob(sessionStorage.getItem(JOB_STORAGE));
    const savedCall = sessionStorage.getItem(CALL_STORAGE);
    if (savedCall) {
      const saved = await api.getCall(savedCall);
      if (saved.ok) { await hydrate(saved.data); setPhase("ended"); }
      else sessionStorage.removeItem(CALL_STORAGE);
    }
  }, [api, hydrate]);
  useEffect(() => { void loadOwner(); }, [loadOwner]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setLoginBusy(true); setCallError(null);
    const response = await api.login(email, password);
    setPassword(""); setLoginBusy(false);
    if (!response.ok) { setCallError(response.error.message); return; }
    await loadOwner();
  }

  async function ensureWorkspace() {
    if (live.current.snapshot?.call.status === "active") return live.current.snapshot;
    const mode = (live.current.session?.catalogRevision ?? 0) > 0 ? "update" : "create";
    const response = await api.createCall(mode, crypto.randomUUID());
    if (!response.ok) throw new Error(response.error.message);
    dispatch({ type: "reset" }); approvedDrafts.current.clear();
    setSnapshot(response.data); live.current.snapshot = response.data;
    sessionStorage.setItem(CALL_STORAGE, response.data.call.id);
    return response.data;
  }

  const uploadToDraft = useCallback(async (draftId: string, image: Blob) => {
    const callId = live.current.snapshot?.call.id;
    if (!callId) return { ok: false as const, error: "Start a call or add a product first." };
    const localId = crypto.randomUUID(); const previewUrl = URL.createObjectURL(image);
    objectUrls.current.add(previewUrl);
    dispatch({ type: "capture_started", draftId, localId, previewUrl });
    const response = await api.uploadDraftImage(callId, draftId, image, new Date().toISOString());
    dispatch({ type: "capture_settled", draftId, localId, result: response.ok ? response : { ok: false, message: response.error.message } });
    if (response.ok && response.data.productDraftId === draftId) return { ok: true as const, captureId: response.data.captureId, thumbnailUrl: response.data.thumbnailUrl };
    return { ok: false as const, error: response.ok ? "The server returned a different draft identity." : response.error.message };
  }, [api]);
  const captureForDraft = useCallback(async (draftId: string) => {
    try { return uploadToDraft(draftId, await camera.grab()); }
    catch { return { ok: false as const, error: "Camera is off or not ready. Upload a photo instead." }; }
  }, [camera, uploadToDraft]);

  const openCatalogReview = useCallback(async (proposalId: string, extra: Partial<Pending> = {}) => {
    const response = await api.reviewCatalogProposal(proposalId);
    if (!response.ok) { setCallError(response.error.message); return false; }
    setReviewError(null); setSheetOpen(false); setReview({ kind: "catalog_change", proposal: response.data, idempotencyKey: crypto.randomUUID(), ...extra });
    return true;
  }, [api]);
  const tools = useMemo(() => createClientTools({
    api, callId: () => live.current.snapshot?.call.id ?? null, businessId: () => live.current.session?.business.id ?? null,
    catalogRevision: () => live.current.session?.catalogRevision ?? 0, drafts: () => live.current.drafts, dispatch,
    captureForDraft, isCameraOn: () => live.current.cameraState === "on", newIdempotencyKey: () => crypto.randomUUID(),
    rememberProposal: () => {}, refreshWorkspace,
    openConfirmation: async (kind, id) => {
      if (kind === "catalog_change") return openCatalogReview(id);
      if (id !== live.current.snapshot?.call.publicationReviewId) return false;
      setSheetOpen(true); return true;
    },
  }), [api, captureForDraft, refreshWorkspace, openCatalogReview]);
  for (const name of CLIENT_TOOL_NAMES) {
    // Constant tuple preserves hook order.
    useConversationClientTool(name, (args: Record<string, unknown>) => tools[name](args));
  }

  async function startCall() {
    const generation = ++startGeneration.current;
    setPhase("starting"); setCallError(null);
    try {
      const current = await ensureWorkspace();
      if (generation !== startGeneration.current) return;
      const credential = await api.createVoiceSession(current.call.id);
      if (generation !== startGeneration.current) return;
      if (!credential.ok) { setPhase("idle"); setCallError(credential.error.message); return; }
      await conversation.startSession({ signedUrl: credential.data.signedUrl, connectionType: "websocket" });
      if (generation !== startGeneration.current) { await conversation.endSession(); return; }
      setPhase("live");
      tell("Camera starts off. Ask only essential inventory details; business story and styling questions are optional. Owner may skip questions or finish anytime. Never claim publication without backend success.");
    } catch { setPhase("idle"); setCallError("Couldn't start voice. Your drafts are saved; retry, or add and review products below."); }
  }

  const endCall = useCallback(async () => {
    startGeneration.current++;
    camera.stop(); setPhase("ended");
    try { await convRef.current.endSession(); } catch { /* Already disconnected. */ }
    const id = live.current.snapshot?.call.id;
    if (id) {
      const result = await api.endCall(id);
      if (!result.ok) setCallError(`Audio ended. Call status couldn't sync: ${result.error.message}`);
      else setSnapshot(current => current ? { ...current, call: result.data } : current);
    }
  }, [api, camera]);
  useEffect(() => () => {
    startGeneration.current++; void Promise.resolve(convRef.current.endSession()).catch(() => {});
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
  }, []);

  async function addProduct() {
    try {
      const current = live.current.snapshot ?? await ensureWorkspace();
      const response = await api.createDraft(current.call.id, crypto.randomUUID());
      if (!response.ok) { setCallError(response.error.message); return; }
      dispatch({ type: "draft_saved", draft: response.data }); setSheetOpen(true);
    } catch { setCallError("Unable to create product draft. Sign in and retry."); }
  }
  async function saveDraft(draftId: string, patch: DraftPatch) {
    const callId = live.current.snapshot?.call.id;
    if (!callId) return "No saved call is available.";
    const response = await api.patchDraft(callId, draftId, patch);
    if (!response.ok) return response.error.message;
    dispatch({ type: "draft_saved", draft: response.data }); tell(`Owner corrected draft ${draftId}; use the backend's saved values.`);
    return null;
  }

  async function reviewNext() {
    setReviewError(null); setCallError(null); setSheetOpen(true);
    const current = live.current.snapshot;
    if (!current) { setCallError("Add a product or start a call first."); return; }
    const latest = await api.getCall(current.call.id);
    if (!latest.ok) { setCallError(latest.error.message); return; }
    await hydrate(latest.data);
    for (const draft of latest.data.drafts) {
      if (approvedDrafts.current.has(draft.id)) continue;
      if (!draft.ready) { setCallError("Complete each product's name, price, stock and photo before review. You can edit below without another call."); return; }
      const proposed = await api.proposeProduct(current.call.id, draft.id);
      if (!proposed.ok) { setCallError(proposed.error.message); return; }
      await openCatalogReview(proposed.data.proposal.id, { draftId: draft.id, continueReview: true }); return;
    }
    const business = await api.getBusiness();
    if (!business.ok) { setCallError(business.error.message); return; }
    const name = (profileEdited.current.name ? live.current.ownerName.trim() : latest.data.call.brief.name) || live.current.ownerName.trim() || business.data.name;
    const contact = (profileEdited.current.contact ? live.current.contactEmail.trim() : latest.data.call.brief.contactEmail) || live.current.contactEmail.trim() || business.data.contactEmail;
    if (!contact || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) { setCallError("Enter the public contact email below before publishing."); return; }
    const patch: Record<string, string> = {};
    if (name !== business.data.name) patch.name = name;
    if (contact !== business.data.contactEmail) patch.contactEmail = contact;
    if (latest.data.call.brief.description && latest.data.call.brief.description !== business.data.description) patch.description = latest.data.call.brief.description;
    if (Object.keys(patch).length) {
      const proposed = await api.proposeCatalogChanges({ callId: current.call.id, expectedCatalogRevision: business.data.catalogRevision, idempotencyKey: crypto.randomUUID(), changes: [{ type: "update_storefront", patch } as ProductChange] });
      if (!proposed.ok) { setCallError(proposed.error.message); return; }
      await openCatalogReview(proposed.data.id, { continueReview: true }); return;
    }
    const products = await api.getProducts();
    if (!products.ok) { setCallError(products.error.message); return; }
    const published = products.data.filter(product => product.isPublished);
    if (!published.length) { setCallError("Approve at least one product before building the storefront."); return; }
    setSheetOpen(false);
    setReview({ kind: "publish", idempotencyKey: crypto.randomUUID(), proposal: {
      id: latest.data.call.publicationReviewId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), approvalNonce: "", snapshotRevision: business.data.catalogRevision,
      items: published.map(product => ({ label: product.name, before: "Saved listing", after: `${formatMoney(product.priceCents, "USD")} · ${product.inventoryCount === 0 ? "Sold out" : `${product.inventoryCount} in stock`}` })),
    } });
  }
  async function finishAndReview() { await endCall(); await reviewNext(); }
  async function confirmReview() {
    if (!review) return;
    setReviewBusy(true); setReviewError(null);
    if (review.kind === "catalog_change") {
      const response = await api.confirmCatalogProposal(review.proposal.id, review.proposal.approvalNonce, review.idempotencyKey);
      setReviewBusy(false);
      if (!response.ok) { setReviewError(response.error.message); return; }
      if (review.draftId) approvedDrafts.current.add(review.draftId);
      setReview(null); tell("Owner clicked confirmation. Backend applied the reviewed changes successfully.");
      const owner = await api.getSession(); if (owner.ok) setLoad({ state: "ready", session: owner.data });
      if (review.continueReview) await reviewNext();
      else await refreshWorkspace();
    } else {
      const style = live.current.snapshot?.call.brief.style ?? "A clear responsive storefront using the approved business story and original product photos.";
      const response = await api.createBuild(style, review.proposal.snapshotRevision!);
      setReviewBusy(false);
      if (!response.ok) { setReviewError(response.error.message); return; }
      await endCall(); sessionStorage.setItem(JOB_STORAGE, response.data.id); setLatestJob(response.data.id); setReview(null);
      router.push(`/status?job=${encodeURIComponent(response.data.id)}`);
    }
  }
  async function cancelReview() {
    if (!review) return;
    if (review.kind === "catalog_change") {
      const rejected = await api.rejectCatalogProposal(review.proposal.id);
      if (!rejected.ok) { setReviewError(rejected.error.message); return; }
    }
    setReview(null); setSheetOpen(true); tell("Owner declined this proposal. No proposed changes were applied.");
  }

  if (load.state !== "ready") return <Shell label="Demo owner"><div className="auth-grid"><section className="panel"><h1 className="page-title">Show your inventory.<br />Keep it current.</h1><p className="muted">Capture physical products through a call, then maintain your Replit storefront by voice. Contact-to-buy; no checkout.</p><ConsentNotice /></section><section className="panel">{load.state === "loading" ? <p role="status">Checking your session…</p> : <form className="auth-form" onSubmit={signIn}><h2 className="panel-title">Sign in to your store</h2><p className="muted">Use the configured demo-owner credentials. Your product and publication changes require approval.</p><label className="field">Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label><label className="field">Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>{(callError || load.state === "error") && <p className="error" role="alert">{callError ?? (load.state === "error" ? load.message : "")}</p>}<button className="btn primary" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in"}</button></form>}</section></div></Shell>;

  const inCall = phase === "live" || phase === "starting";
  const voice = conversation.status;
  const statusText = phase === "starting" ? "Connecting…" : voice === "connected" ? conversation.isSpeaking ? "Speaking" : "Listening" : phase === "ended" ? "Drafts saved · ready to review" : "Voice first · camera optional";
  const captures = drafts.order.flatMap(id => drafts.byId[id].captures.map(capture => ({ ...capture, draftId: id })));
  return <div className={`ft ${camera.state === "on" ? "cam-on" : "cam-off"}`}>
    <video ref={camera.videoRef} className={`ft-video ${camera.facing === "user" ? "mirror" : ""}`} playsInline muted autoPlay aria-label="Your camera" hidden={camera.state !== "on"} />
    {camera.state !== "on" && <div className="ft-avatar">{!inCall ? <button type="button" className="orb idle" onClick={startCall} aria-label={phase === "ended" ? "Call again" : "Start voice call"}><span className="orb-face" aria-hidden="true"><i /><i /></span></button> : <span className={`orb ${voice === "connected" ? conversation.isSpeaking ? "speaking" : "listening" : "connecting"}`} aria-hidden="true"><span className="orb-face"><i /><i /></span></span>}</div>}
    <header className="ft-top"><span className="ft-spacer" aria-hidden="true" /><div className="ft-title"><strong>{session?.business.name ?? "Shopcall"}</strong><span role="status" aria-live="polite">{statusText}</span></div><button type="button" className="ft-bag" aria-label={`Products: ${drafts.order.length}`} onClick={() => setSheetOpen(true)}><ShoppingBag size={20} aria-hidden="true" />{drafts.order.length > 0 && <span className="ft-badge">{drafts.order.length}</span>}</button></header>
    {drafts.activeId && camera.state === "on" && <span className="ft-chip">Showing: {drafts.byId[drafts.activeId]?.title || "new product"}</span>}
    <div className="ft-bottom">
      {captures.length > 0 && <ul className="ft-strip" aria-label="Captured photos">{captures.slice(-6).map(capture => <li key={capture.localId} className={capture.status}><button type="button" onClick={() => { dispatch({ type: "set_active", draftId: capture.draftId }); setSheetOpen(true); }} aria-label={`Photo of ${drafts.byId[capture.draftId].title || "product"}, ${capture.status}`}><img src={capture.thumbnailUrl ?? capture.previewUrl} alt="" /></button></li>)}</ul>}
      {callError && <p className="ft-notice" role="alert">{callError}</p>}
      {!inCall && <div className="ft-start"><span className="ft-cta">{phase === "ended" ? "Review now, or call again" : "Tap to show what you sell"}</span><p className="ft-fine">Physical inventory in. A storefront you can maintain by voice. Powered by Replit.</p>{latestJob && <Link className="ft-link" href={`/status?job=${encodeURIComponent(latestJob)}`}>Storefront status</Link>}</div>}
      {camera.state === "denied" && <p className="ft-fine">Camera blocked. Keep talking and upload product photos instead.</p>}
      <div className="ft-controls" role="group" aria-label="Call controls"><button type="button" className="ft-round" disabled={!inCall} aria-pressed={conversation.isMuted} aria-label={conversation.isMuted ? "Unmute" : "Mute"} onClick={() => conversation.setMuted(!conversation.isMuted)}>{conversation.isMuted ? <MicOff /> : <Mic />}</button><button type="button" className="ft-round" aria-pressed={camera.state === "on"} aria-label={camera.state === "on" ? "Turn camera off" : "Turn camera on"} onClick={() => camera.state === "on" ? camera.stop() : camera.start()} disabled={camera.state === "starting"}>{camera.state === "on" ? <Camera /> : <CameraOff />}</button><button type="button" className="ft-round" aria-label="Switch camera" onClick={camera.flip} disabled={camera.state !== "on" || !camera.canSwitch}><SwitchCamera /></button><button type="button" className="ft-round end" aria-label="End call" onClick={endCall}><PhoneOff /></button></div>
      <div className="draft-actions"><button type="button" className="btn primary" onClick={finishAndReview} disabled={!snapshot}>Finish &amp; review</button><button type="button" className="btn ghost" onClick={addProduct}>Add product</button>{inCall && <button type="button" className="btn ghost" onClick={() => tell("Owner chose to skip optional story/style questions. Capture only product identity, exact price, quantity and photos, then offer review. Do not require optional answers.")}>Skip optional questions</button>}</div>
    </div>
    {sheetOpen && <div className="ft-sheet" role="dialog" aria-modal="true" aria-label="Review inventory"><div className="ft-sheet-head"><span className="ft-grabber" aria-hidden="true" /><button type="button" className="ft-close" aria-label="Close products" onClick={() => setSheetOpen(false)}><X size={20} /></button></div><DraftTray state={drafts} cameraOn={camera.state === "on"} onSelect={id => dispatch({ type: "set_active", draftId: id })} onCapture={id => { void captureForDraft(id); }} onUpload={(id, file) => { void uploadToDraft(id, file); }} onRemoveCapture={(id, localId) => dispatch({ type: "capture_removed", draftId: id, localId })} onSave={saveDraft} /><div className="auth-form"><label className="field">Business name<input value={ownerName} onChange={event => { profileEdited.current.name = true; setOwnerName(event.target.value); }} maxLength={160} /></label><label className="field">Public contact email<input type="email" value={contactEmail} onChange={event => { profileEdited.current.contact = true; setContactEmail(event.target.value); }} /></label></div><p className="muted">Ending the call saves drafts. Nothing is approved or published until you review and confirm. Optional story and style can wait.</p><button type="button" className="btn primary ft-publish" onClick={finishAndReview}>Review saved products &amp; storefront</button>{callError && <p className="error" role="alert">{callError}</p>}</div>}
    {review && <ReviewPanel key={review.proposal.id} kind={review.kind} proposal={review.proposal} contactEmail={contactEmail || session?.business.contactEmail || null} busy={reviewBusy} error={reviewError} onConfirm={confirmReview} onCancel={cancelReview} />}
  </div>;
}
