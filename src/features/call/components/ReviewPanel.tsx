"use client";
import { useEffect, useRef, useState } from "react";
import type { ProposalSummary } from "../api";

type Props = {
  kind: "catalog_change" | "publish";
  proposal: ProposalSummary;
  contactEmail: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/** The only place approval happens: an explicit owner click. Voice can open this, never confirm it. */
export function ReviewPanel({ kind, proposal, contactEmail, busy, error, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [photosOk, setPhotosOk] = useState(false);
  const [contactOk, setContactOk] = useState(false);
  const expired = new Date(proposal.expiresAt).getTime() < Date.now();
  const publish = kind === "publish";
  const publicInformation = publish || proposal.publishesInformation === true;
  const canConfirm = !busy && !expired && (!publicInformation || (photosOk && (!contactEmail || contactOk)));

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  return (
    <dialog ref={ref} className="review" aria-labelledby="review-title" onCancel={e => { e.preventDefault(); onCancel(); }}>
      <h2 id="review-title" className="panel-title">{publish ? "Publish your storefront?" : "Apply these changes?"}</h2>
      <table className="changes">
        <thead><tr><th scope="col">Item</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
        <tbody>
          {proposal.items.map((it, i) => (
            <tr key={i}><th scope="row">{it.label}</th><td>{it.before}</td><td>{it.after}</td></tr>
          ))}
        </tbody>
      </table>
      {!!proposal.omittedDraftCount && <p className="muted">{proposal.omittedDraftCount} incomplete product draft{proposal.omittedDraftCount === 1 ? " is" : "s are"} saved for later and will not be published.</p>}
      {proposal.catalogApplied && proposal.batch && <p className="muted">Your reviewed listings are already saved. Retrying only starts the storefront build.</p>}
      {publicInformation && (
        <fieldset className="acks">
          <legend>This makes the following public</legend>
          <label className="check"><input type="checkbox" checked={photosOk} onChange={e => setPhotosOk(e.target.checked)} /> The product photos, names, prices and stock above</label>
          {contactEmail && <label className="check"><input type="checkbox" checked={contactOk} onChange={e => setContactOk(e.target.checked)} /> My contact email: {contactEmail}</label>}
        </fieldset>
      )}
      {expired && <p className="error" role="alert">This summary expired. Ask your assistant to prepare it again.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="draft-actions">
        <button type="button" className="btn primary" disabled={!canConfirm} onClick={onConfirm}>{busy ? "Saving and starting build…" : publish ? proposal.catalogApplied && proposal.batch ? "Retry storefront build" : "Confirm and publish" : "Confirm changes"}</button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Not yet</button>
      </div>
    </dialog>
  );
}
