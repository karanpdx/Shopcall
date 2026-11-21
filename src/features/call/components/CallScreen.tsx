"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConversationProvider, useConversation, useConversationClientTool } from "@elevenlabs/react";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, ShoppingBag, SwitchCamera, X } from "lucide-react";
import { CLIENT_TOOL_NAMES } from "../../../contracts/integrations";
import { createApiClient, flattenWorkingDraft, summarizeBatch, type CallSnapshot, type DraftPatch, type OwnerSession, type ProposalSummary } from "../api";
import { useCamera } from "../camera";
import { checkMicrophone } from "../mediaPermission";
import { createDraftCaptureGuard, type DraftCaptureResult } from "../captureGuard";
import { createClientTools } from "../clientTools";
import { draftsReducer, initialDrafts, formatMoney } from "../drafts";
import { DraftTray } from "./DraftTray";
import { ReviewPanel } from "./ReviewPanel";
import { ConsentNotice } from "./ConsentNotice";
import { Shell } from "./Shell";
import { PhotoProgress } from "./PhotoProgress";

type Load = { state: "loading" | "login" } | { state: "error"; message: string } | { state: "ready"; session: OwnerSession };
type Pending = { kind: "catalog_change" | "publish"; proposal: ProposalSummary; idempotencyKey: string; draftId?: string; productDraftIds?: string[]; approvedRevision?: number };
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
  const [existingStoreUrl, setExistingStoreUrl] = useState<string | null>(null);
  const startGeneration = useRef(0);
  const session = load.state === "ready" ? load.session : null;
  const live = useRef({ snapshot, session, drafts, cameraState: camera.state, ownerName, contactEmail });
  live.current = { snapshot, session, drafts, cameraState: camera.state, ownerName, contactEmail };
  const approvedDrafts = useRef(new Set<string>());
  const profileEdited = useRef({ name: false, contact: false });
  const objectUrls = useRef(new Set<string>());
  const reviewRequestKeys = useRef(new Map<string, string>());
  const automaticCaptureAttempts = useRef(new Set<string>());
  const lastCameraContext = useRef<boolean | null>(null);
  const captureImplementation = useRef<(draftId: string) => Promise<DraftCaptureResult>>(async () => ({ ok: false, error: "Camera is not ready." }));
  const captureGuard = useMemo(() => createDraftCaptureGuard(id => captureImplementation.current(id), id => {
    const saved = live.current.drafts.byId[id]?.imageAssetId;
    return saved ? { ok: true, captureId: saved, thumbnailUrl: `/api/assets/${encodeURIComponent(saved)}` } : null;
  }), []);

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
    if (response.ok && live.current.snapshot?.call.id === callId) await hydrate(response.data);
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
    dispatch({ type: "reset" }); approvedDrafts.current.clear(); automaticCaptureAttempts.current.clear(); captureGuard.clearSaved();
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
    if (live.current.snapshot?.call.id !== callId) return { ok: false as const, error: "This capture belongs to the earlier saved call; the current call was not changed." };
    dispatch({ type: "capture_settled", draftId, localId, result: response.ok ? response : { ok: false, message: response.error.message } });
    if (response.ok && response.data.productDraftId === draftId) {
      dispatch({ type: "draft_saved", draft: response.data.draft ? flattenWorkingDraft(response.data.draft) : { id: draftId, imageAssetId: response.data.captureId, imageUrl: response.data.thumbnailUrl } });
      return { ok: true as const, captureId: response.data.captureId, thumbnailUrl: response.data.thumbnailUrl };
    }
    return { ok: false as const, error: response.ok ? "The server returned a different draft identity." : response.error.message };
  }, [api]);
  captureImplementation.current = async draftId => {
    if (live.current.cameraState !== "on") return { ok: false, error: "Camera is off. Turn it on or upload a photo in Products." };
    try { return await uploadToDraft(draftId, await camera.grab()); }
    catch { return { ok: false, error: "Camera is off or not ready. Upload a photo instead." }; }
  };
  const captureForDraft = useCallback((draftId: string, reuseExisting = false) => captureGuard.run(draftId, reuseExisting), [captureGuard]);

  const openCatalogReview = useCallback(async (proposalId: string, extra: Partial<Pending> = {}) => {
    const response = await api.reviewCatalogProposal(proposalId);
    if (!response.ok) { setCallError(response.error.message); return false; }
    setReviewError(null); setSheetOpen(false); setReview({ kind: "catalog_change", proposal: response.data, idempotencyKey: crypto.randomUUID(), ...extra });
    return true;
  }, [api]);
  const tools = useMemo(() => createClientTools({
    api, callId: () => live.current.snapshot?.call.id ?? null, businessId: () => live.current.session?.business.id ?? null,
    catalogRevision: () => live.current.session?.catalogRevision ?? 0, drafts: () => live.current.drafts, dispatch,
    captureForDraft: id => captureForDraft(id, true), isCameraOn: () => live.current.cameraState === "on", newIdempotencyKey: () => crypto.randomUUID(),
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
    setPhase("starting"); setCallError(null); setExistingStoreUrl(null);
    try {
      const microphoneError = await checkMicrophone(navigator.mediaDevices);
      if (generation !== startGeneration.current) return;
      if (microphoneError) { setPhase("idle"); setCallError(microphoneError); return; }
      const current = await ensureWorkspace();
      if (generation !== startGeneration.current) return;
      const credential = await api.createVoiceSession(current.call.id);
      if (generation !== startGeneration.current) return;
      if (!credential.ok) { setPhase("idle"); setCallError(credential.error.message); return; }
      await conversation.startSession({ signedUrl: credential.data.signedUrl, connectionType: "websocket" });
      if (generation !== startGeneration.current) { await conversation.endSession(); return; }
      setPhase("live");
      const cameraOn = live.current.cameraState === "on";
      lastCameraContext.current = cameraOn;
      tell(`Camera is ${cameraOn ? "ON and available for still capture" : "OFF; no captures are allowed"}. Ask only essential inventory details; business story and styling questions are optional. Owner may finish anytime. Never claim publication without backend success.`);
    } catch { setPhase("idle"); setCallError("Couldn't start voice. Your drafts are saved; retry, or add and review products below."); }
  }

  useEffect(() => {
    if (phase !== "live" || conversation.status !== "connected") return;
    const enabled = camera.state === "on";
    if (lastCameraContext.current === enabled) return;
    lastCameraContext.current = enabled;
    tell(enabled ? "Camera is now ON. Owner opted in; capture completed product details directly without another photo permission question." : "Camera is now OFF. Do not attempt captures. Audio continues; existing saved photos remain available.");
  }, [phase, conversation.status, camera.state, tell]);

  const activeDraft = drafts.activeId ? drafts.byId[drafts.activeId] : null;
  useEffect(() => {
    if (phase !== "live" || camera.state !== "on" || !activeDraft || activeDraft.imageAssetId || automaticCaptureAttempts.current.has(activeDraft.id)
      || !activeDraft.title.trim() || activeDraft.priceMinor === null || activeDraft.quantityOnHand === null) return;
    const video = camera.videoRef.current;
    const id = activeDraft.id;
    const originalCallId = live.current.snapshot?.call.id;
    const capture = () => {
      if (live.current.cameraState !== "on" || automaticCaptureAttempts.current.has(id)) return;
      automaticCaptureAttempts.current.add(id);
      void captureForDraft(id, true).then(result => {
        if (live.current.snapshot?.call.id !== originalCallId) return;
        if (!result.ok) { setCallError(result.error); return; }
        tell(`Photo saved for draft ${id}. Continue collecting products. Photo processing is visible in the app; do not request another photo or open full-store review for this item.`);
      });
    };
    if (video && video.readyState >= 2) capture();
    else video?.addEventListener("loadeddata", capture, { once: true });
    return () => video?.removeEventListener("loadeddata", capture);
  }, [phase, camera.state, camera.videoRef, activeDraft?.id, activeDraft?.title, activeDraft?.priceMinor, activeDraft?.quantityOnHand, activeDraft?.imageAssetId, captureForDraft, tell]);

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
  async function signOut() {
    await endCall();
    const result = await api.logout();
    if (!result.ok) { setCallError(result.error.message); return; }
    sessionStorage.removeItem(CALL_STORAGE); sessionStorage.removeItem(JOB_STORAGE);
    captureGuard.clearSaved(); approvedDrafts.current.clear(); automaticCaptureAttempts.current.clear();
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear(); dispatch({ type: "reset" });
    setSnapshot(null); live.current.snapshot = null; setReview(null); setSheetOpen(false); setLatestJob(null); setExistingStoreUrl(null);
    setEmail(""); setPassword(""); setCallError(null); setLoad({ state: "login" });
    await loadOwner();
  }
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
    const business = await api.getBusiness();
    if (!business.ok) { setCallError(business.error.message); return; }
    const name = (profileEdited.current.name ? live.current.ownerName.trim() : latest.data.call.brief.name) || live.current.ownerName.trim() || business.data.name;
    const contact = (profileEdited.current.contact ? live.current.contactEmail.trim() : latest.data.call.brief.contactEmail) || live.current.contactEmail.trim() || business.data.contactEmail;
    if (!contact || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) { setCallError("Enter your public contact email below, then review once."); return; }
    const signature = JSON.stringify({ callId: current.call.id, name, contactEmail: contact, drafts: latest.data.drafts.map(draft => [draft.id, draft.revision]) });
    let requestKey = reviewRequestKeys.current.get(signature);
    if (!requestKey) { requestKey = crypto.randomUUID(); reviewRequestKeys.current.set(signature, requestKey); }
    const combined = await api.proposeCallReview(current.call.id, { name, contactEmail: contact, idempotencyKey: requestKey });
    if (!combined.ok) { setCallError(combined.error.message); return; }
    const products = await api.getProducts();
    if (!products.ok) { setCallError(products.error.message); return; }
    const currentProducts = products.data.filter(product => product.isPublished);
    const batch = combined.data.proposal;
    if (!batch && !currentProducts.length) { setCallError("Add a complete product with its photo, price and stock before publishing. Incomplete drafts stay saved for later."); return; }
    const summary: ProposalSummary = batch ? summarizeBatch(batch) : {
      id: latest.data.call.publicationReviewId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), approvalNonce: "",
      items: currentProducts.map(product => ({ label: product.name, before: "Saved listing", after: `${formatMoney(product.priceCents, "USD")} · ${product.inventoryCount === 0 ? "Sold out" : `${product.inventoryCount} in stock`}` })),
    };
    summary.snapshotRevision = business.data.catalogRevision;
    if (batch && batch.status !== "approved") summary.items.push(...currentProducts.map(product => ({ label: product.name, before: "Existing saved listing", after: `${formatMoney(product.priceCents, "USD")} · ${product.inventoryCount} in stock` })));
    summary.omittedDraftCount = combined.data.incompleteDraftIds.length;
    summary.catalogApplied = !batch || batch.status === "approved";
    setContactEmail(combined.data.business.contactEmail); setOwnerName(combined.data.business.name);
    setSheetOpen(false);
    setReview({ kind: "publish", idempotencyKey: crypto.randomUUID(), proposal: summary, productDraftIds: combined.data.productDraftIds, approvedRevision: summary.catalogApplied ? business.data.catalogRevision : undefined });
  }
  async function finishAndReview() {
    await endCall(); await refreshWorkspace(); setCallError(null); setSheetOpen(true);
  }
  async function preparePublicationReview() { await endCall(); await reviewNext(); }
  async function confirmReview() {
    if (!review) return;
    setReviewBusy(true); setReviewError(null);
    if (review.kind === "catalog_change") {
      const response = await api.confirmCatalogProposal(review.proposal.id, review.proposal.approvalNonce, review.idempotencyKey);
      setReviewBusy(false);
      if (!response.ok) { setReviewError(response.error.message); return; }
      setReview(null); tell("Owner clicked confirmation. Backend applied the reviewed changes successfully.");
      const owner = await api.getSession(); if (owner.ok) setLoad({ state: "ready", session: owner.data });
      await refreshWorkspace();
      return;
    }
    let approved = review;
    if (review.proposal.batch && !review.proposal.catalogApplied) {
      const nonce = await api.reviewCatalogProposal(review.proposal.id);
      const apply = nonce.ok ? await api.confirmCatalogProposal(review.proposal.id, nonce.data.approvalNonce, review.idempotencyKey) : nonce;
      if (!apply.ok) {
        // A lost response may hide a committed batch. Read its durable status before retrying mutations.
        const persisted = await api.getCatalogProposal(review.proposal.id);
        if (!persisted.ok || persisted.data.status !== "approved") { setReviewBusy(false); setReviewError(apply.error.message); return; }
      }
      for (const draftId of review.productDraftIds ?? []) approvedDrafts.current.add(draftId);
      approved = { ...review, approvedRevision: review.proposal.batch.expectedCatalogRevision + review.proposal.batch.changes.length, proposal: { ...review.proposal, catalogApplied: true } };
      setReview(approved);
    }
    const business = await api.getBusiness();
    if (!business.ok) { setReviewBusy(false); setReviewError("Your approved details are saved. Couldn't read the current store revision; retry the build."); return; }
    if (approved.approvedRevision !== undefined && approved.approvedRevision !== business.data.catalogRevision) {
      setReviewBusy(false); setReviewError("Your catalog changed after this review. Close this summary and review the current listings before publishing."); return;
    }
    approved = { ...approved, approvedRevision: business.data.catalogRevision };
    setReview(approved);
    // Inventory/contact edits read through the canonical catalog; retain an already verified storefront.
    let published: URL | null = null;
    try { if (business.data.publishedUrl) published = new URL(business.data.publishedUrl); } catch { /* No verified public endpoint. */ }
    if (published?.protocol === "https:" && !published.username && !published.password) {
      await endCall();
      const owner = await api.getSession(); if (owner.ok) setLoad({ state: "ready", session: owner.data });
      await refreshWorkspace();
      setExistingStoreUrl(business.data.publishedUrl);
      setReviewBusy(false); setReviewError(null); setReview(null); setSheetOpen(false); setCallError(null);
      return;
    }
    const style = live.current.snapshot?.call.brief.style ?? "A clear responsive storefront using the approved business story and original product photos.";
    const response = await api.createBuild(style, business.data.catalogRevision);
    setReviewBusy(false);
    if (!response.ok) { setReviewError(`Your approved details are saved. The build was not confirmed: ${response.error.message}`); return; }
    await endCall(); sessionStorage.setItem(JOB_STORAGE, response.data.id); setLatestJob(response.data.id); setReview(null);
    router.push(`/status?job=${encodeURIComponent(response.data.id)}`);
  }
  async function cancelReview() {
    if (!review) return;
    if ((review.kind === "catalog_change" || review.proposal.batch) && !review.proposal.catalogApplied) {
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
  const photoDraft = activeDraft && (activeDraft.imageAssetId || activeDraft.captures.length) ? activeDraft : [...drafts.order].reverse().map(id => drafts.byId[id]).find(draft => draft.imageAssetId || draft.captures.length);
  return <div className={`ft ${camera.state === "on" ? "cam-on" : "cam-off"}`}>
    <video ref={camera.videoRef} className={`ft-video ${camera.facing === "user" ? "mirror" : ""}`} playsInline muted autoPlay aria-label="Your camera" hidden={camera.state !== "on"} />
    {camera.state !== "on" && <div className="ft-avatar" aria-hidden="true"><span className={`orb ${!inCall ? "idle" : voice === "connected" ? conversation.isSpeaking ? "speaking" : "listening" : "connecting"}`} style={{ pointerEvents: "none", cursor: "default" }}><span className="orb-face"><i /><i /></span></span></div>}
    <header className="ft-top"><span className="ft-spacer" aria-hidden="true" /><div className="ft-title"><strong>{session?.business.name ?? "lit"}</strong><span role="status" aria-live="polite">{statusText}</span></div><button type="button" className="ft-bag" aria-label={`Products: ${drafts.order.length}`} onClick={() => setSheetOpen(true)}><ShoppingBag size={20} aria-hidden="true" />{drafts.order.length > 0 && <span className="ft-badge">{drafts.order.length}</span>}</button></header>
    {drafts.activeId && camera.state === "on" && <span className="ft-chip">Showing: {drafts.byId[drafts.activeId]?.title || "new product"}</span>}
    <div className="ft-bottom">
      {captures.length > 0 && <ul className="ft-strip" aria-label="Captured photos">{captures.slice(-6).map(capture => <li key={capture.localId} className={capture.status}><button type="button" onClick={() => { dispatch({ type: "set_active", draftId: capture.draftId }); setSheetOpen(true); }} aria-label={`Photo of ${drafts.byId[capture.draftId].title || "product"}, ${capture.status}`}><img src={capture.thumbnailUrl ?? capture.previewUrl} alt="" /></button></li>)}</ul>}
      {snapshot && photoDraft && <PhotoProgress key={photoDraft.id} callId={snapshot.call.id} draft={photoDraft} onOpen={() => { dispatch({ type: "set_active", draftId: photoDraft.id }); setSheetOpen(true); }} />}
      {callError && <p className="ft-notice" role="alert">{callError}</p>}
      {!inCall && <div className="ft-start"><p className="ft-fine">Start a call. Show one product at a time.</p><button type="button" className="btn primary big" onClick={startCall}>Start call</button>{existingStoreUrl && <><p className="ft-fine" role="status">Approved changes saved. Your storefront keeps the same address.</p><a className="ft-link" href={existingStoreUrl} target="_blank" rel="noreferrer">Open storefront</a></>}{latestJob && <Link className="ft-link" href={`/status?job=${encodeURIComponent(latestJob)}`}>Storefront status</Link>}</div>}
      {camera.state === "denied" && <p className="ft-fine">Camera blocked. Keep talking and upload product photos instead.</p>}
      <div className="ft-controls" role="group" aria-label="Call controls"><button type="button" className="ft-round" disabled={voice !== "connected"} aria-pressed={voice === "connected" && conversation.isMuted} aria-label={voice !== "connected" ? "Microphone (start a call first)" : conversation.isMuted ? "Unmute microphone" : "Mute microphone"} onClick={() => conversation.setMuted(!conversation.isMuted)}>{conversation.isMuted ? <MicOff /> : <Mic />}</button><button type="button" className="ft-round" aria-pressed={camera.state === "on"} aria-label={camera.state === "on" ? "Turn camera off" : "Turn camera on"} onClick={() => camera.state === "on" ? camera.stop() : camera.start()} disabled={camera.state === "starting"}>{camera.state === "on" ? <Camera /> : <CameraOff />}</button><button type="button" className="ft-round" aria-label="Switch camera" onClick={camera.flip} disabled={camera.state !== "on" || !camera.canSwitch}><SwitchCamera /></button><button type="button" className="ft-round end" aria-label="End call" onClick={endCall}><PhoneOff /></button></div>
      {snapshot && !sheetOpen && <div className="draft-actions"><button type="button" className="btn primary" onClick={finishAndReview}>Finish &amp; review</button></div>}
    </div>
    {sheetOpen && <div className="ft-sheet" role="dialog" aria-modal="true" aria-label="Review listings"><div className="ft-sheet-head"><span className="ft-grabber" aria-hidden="true" /><button type="button" className="ft-close" aria-label="Close products" onClick={() => setSheetOpen(false)}><X size={20} /></button></div><DraftTray state={drafts} callId={snapshot?.call.id ?? null} onMediaChanged={refreshWorkspace} cameraOn={camera.state === "on"} onSelect={id => dispatch({ type: "set_active", draftId: id })} onCapture={id => { void captureForDraft(id); }} onUpload={(id, file) => { void uploadToDraft(id, file); }} onRemoveCapture={(id, localId) => dispatch({ type: "capture_removed", draftId: id, localId })} onSave={saveDraft} /><button type="button" className="btn ghost" onClick={addProduct}>Add manually</button><div className="auth-form"><label className="field">Business name<input value={ownerName} onChange={event => { profileEdited.current.name = true; setOwnerName(event.target.value); }} maxLength={160} /></label><label className="field">Public contact email<input type="email" value={contactEmail} onChange={event => { profileEdited.current.contact = true; setContactEmail(event.target.value); }} /></label></div><p className="muted">Ending the call saves drafts. Nothing is approved or published until you review and confirm. Optional story and style can wait.</p><button type="button" className="btn primary ft-publish" onClick={preparePublicationReview} disabled={!snapshot}>Review &amp; publish</button>{callError && <p className="error" role="alert">{callError}</p>}<button type="button" className="btn ghost" onClick={signOut}>Sign out</button></div>}
    {review && <ReviewPanel key={review.proposal.id} kind={review.kind} proposal={review.proposal} contactEmail={contactEmail || session?.business.contactEmail || null} busy={reviewBusy} error={reviewError} onConfirm={confirmReview} onCancel={cancelReview} />}
  </div>;
}
