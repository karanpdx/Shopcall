"use client";
import { useId, useState } from "react";
import { Camera, RotateCcw, Trash2, Upload } from "lucide-react";
import type { DraftPatch } from "../api";
import { formatMoney, missingFields, parsePriceToMinor, type DraftView, type DraftsState } from "../drafts";
import { DraftMediaPanel } from "./DraftMediaPanel";

type Props = {
  state: DraftsState;
  cameraOn: boolean;
  onSelect: (draftId: string) => void;
  onCapture: (draftId: string) => void;
  onUpload: (draftId: string, file: File) => void;
  onRemoveCapture: (draftId: string, localId: string) => void;
  onSave: (draftId: string, patch: DraftPatch) => Promise<string | null>;
  callId: string | null;
  onMediaChanged: () => Promise<void>;
};

const LABELS = { name: "name", price: "price", stock: "stock", photo: "photo" } as const;

export function DraftTray({ state, ...handlers }: Props) {
  const complete = state.order.filter(id => missingFields(state.byId[id]).length === 0).length;
  return (
    <section className="tray" aria-labelledby="tray-title">
      <header className="tray-head">
        <h2 id="tray-title" className="panel-title">Products</h2>
        <span className="pill">{state.order.length === 0 ? "None yet" : `${complete} of ${state.order.length} ready`}</span>
      </header>
      {state.order.length === 0 ? (
        <p className="muted">Your assistant adds products as you show and describe them.</p>
      ) : (
        <ol className="draft-list">
          {state.order.map(id => (
            <DraftCard key={id} draft={state.byId[id]} active={state.activeId === id} {...handlers} />
          ))}
        </ol>
      )}
    </section>
  );
}

function DraftCard({ draft, active, cameraOn, onSelect, onCapture, onUpload, onRemoveCapture, onSave, callId, onMediaChanged }: Omit<Props, "state"> & { draft: DraftView; active: boolean }) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const missing = missingFields(draft);
  return (
    <li className={`draft ${active ? "active" : ""}`}>
      <button type="button" className="draft-select" aria-pressed={active} onClick={() => onSelect(draft.id)}>
        <span className="draft-name">{draft.title || "Untitled product"}</span>
        <span className="draft-meta">
          {draft.priceMinor !== null ? formatMoney(draft.priceMinor, draft.currencyCode) : "No price"}
          {" · "}
          {draft.inventoryTracked === false ? "Stock not tracked" : draft.quantityOnHand !== null ? `${draft.quantityOnHand} in stock` : "No stock"}
        </span>
      </button>
      {missing.length > 0 && <p className="missing">Still needs: {missing.map(m => LABELS[m]).join(", ")}</p>}
      {draft.approved && <p className="muted">Approved and saved to your catalog. Use a new call to change this listing.</p>}
      {draft.description && <p>{draft.description}</p>}

      <ul className="thumbs" aria-label={`Photos for ${draft.title || "this product"}`}>
        {draft.captures.map(c => (
          <li key={c.localId} className={`thumb ${c.status}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URLs and backend thumbnails */}
            <img src={c.thumbnailUrl ?? c.previewUrl} alt={`Photo of ${draft.title || "product"}`} />
            <span className="thumb-status">{c.status === "uploading" ? "Saving…" : c.status === "saved" ? "Saved" : "Not saved"}</span>
            {c.error && <span className="sr-only">{c.error}</span>}
            {c.status !== "saved" && <button type="button" className="icon-btn small" aria-label="Dismiss this unsaved photo" onClick={() => onRemoveCapture(draft.id, c.localId)}>
              <Trash2 size={14} aria-hidden="true" />
            </button>}
          </li>
        ))}
      </ul>
      {draft.captures.some(c => c.status === "failed") && (
        <p className="error" role="status">{draft.captures.find(c => c.status === "failed")?.error ?? "A photo didn't save."} Retake or upload instead.</p>
      )}
      {callId && draft.imageAssetId && <DraftMediaPanel callId={callId} draft={draft} onChanged={onMediaChanged} />}

      <div className="draft-actions">
        <button type="button" className="btn ghost" disabled={!cameraOn || draft.approved} onClick={() => onCapture(draft.id)} title={cameraOn ? undefined : "Turn your camera on to take a photo"}>
          {draft.captures.length ? <RotateCcw size={16} aria-hidden="true" /> : <Camera size={16} aria-hidden="true" />}
          {draft.captures.length ? "Retake" : "Take photo"}
        </button>
        <label className="btn ghost" htmlFor={`${uid}-file`}>
          <Upload size={16} aria-hidden="true" /> Upload
        </label>
        <input id={`${uid}-file`} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={draft.approved}
          onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(draft.id, f); e.target.value = ""; }} />
        <button type="button" className="btn ghost" aria-expanded={editing} disabled={draft.approved} onClick={() => setEditing(v => !v)}>Edit details</button>
      </div>
      {editing && <DraftEditor draft={draft} onDone={() => setEditing(false)} onSave={patch => onSave(draft.id, patch)} />}
    </li>
  );
}

function DraftEditor({ draft, onSave, onDone }: { draft: DraftView; onSave: (p: DraftPatch) => Promise<string | null>; onDone: () => void }) {
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description);
  const [price, setPrice] = useState(draft.priceMinor !== null ? (draft.priceMinor / 100).toFixed(2) : "");
  const [qty, setQty] = useState(draft.quantityOnHand?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const priceMinor = price.trim() === "" ? undefined : parsePriceToMinor(price);
    if (priceMinor === null) return setError("Enter a price like 24 or 24.50.");
    const quantity = Number(qty);
    if (!/^\d+$/.test(qty.trim()) || !Number.isSafeInteger(quantity)) return setError("Enter the exact whole number of items available. Zero means sold out.");
    setBusy(true);
    const err = await onSave({ title: title.trim() || undefined, description: description.trim(), priceMinor, inventoryTracked: true, quantityOnHand: quantity });
    setBusy(false);
    if (err) setError(err);
    else onDone();
  }

  return (
    <form className="draft-editor" onSubmit={submit}>
      <label className="field"><span>Name</span><input value={title} maxLength={160} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field"><span>Description</span><textarea value={description} maxLength={4000} rows={3} onChange={e => setDescription(e.target.value)} /></label>
      <label className="field"><span>Price ({draft.currencyCode})</span><input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label>
      <label className="field"><span>In stock</span><input inputMode="numeric" value={qty} onChange={e => setQty(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="draft-actions">
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button className="btn ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
