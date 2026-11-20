import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  buildJobRequest, buildJobUpdate, productChange,
  type Asset, type BuildJob, type BuildJobRequest, type BuildJobUpdate, type BuildSpec, type Business, type Draft,
  type DraftApprovalResponse, type Product, type ProductChange, type PublicCatalog, type ShopCallRepository,
} from "@/contracts/api";
import type { BuildPhase, PublicationRepository } from "@/contracts/integrations";
import { assetUrl, publicCatalogUrl } from "./config";
import { getDb } from "./db";
import { fail } from "./http";

const now = () => new Date().toISOString();
const bool = (v: number) => v === 1;

type BusinessRow = {
  id: string; owner_id: string; name: string; slug: string; description: string | null; hero_title: string | null;
  hero_subtitle: string | null; primary_color: string | null; contact_email: string | null; public_catalog_url: string | null;
  published_url: string | null; catalog_revision: number; created_at: string; updated_at: string;
};
type ProductRow = {
  id: string; business_id: string; name: string; description: string | null; category: string | null; price_cents: number;
  inventory_count: number; image_asset_id: string | null; is_published: number; is_featured: number; revision: number;
  created_at: string; updated_at: string;
};
type DraftRow = {
  id: string; business_id: string; operation: string; target_id: string | null; previous_values: string | null;
  proposed_values: string; expected_revision: number | null; status: "pending" | "approved" | "rejected";
  created_at: string; resolved_at: string | null;
};
type AssetRow = {
  id: string; business_id: string; storage_key: string; mime_type: Asset["mimeType"]; size_bytes: number;
  width: number; height: number; created_at: string;
};
type JobRow = {
  id: string; business_id: string; provider: string; provider_job_id: string | null; build_status: BuildJob["buildStatus"];
  publication_status: BuildJob["publicationStatus"]; public_url: string | null; error_message: string | null; spec: string;
  created_at: string; updated_at: string;
};

// Whitelisted API-field → column maps; patch keys never reach SQL unmapped.
const PRODUCT_PATCH_COLUMNS = { name: "name", description: "description", category: "category", isFeatured: "is_featured", isPublished: "is_published" } as const;
const STOREFRONT_COLUMNS = {
  name: "name", description: "description", heroTitle: "hero_title", heroSubtitle: "hero_subtitle",
  primaryColor: "primary_color", contactEmail: "contact_email",
} as const;

function catalogUrlOrNull(slug: string) {
  try {
    return publicCatalogUrl(slug);
  } catch {
    return null;
  }
}

const toBusiness = (r: BusinessRow): Business => ({
  id: r.id, ownerId: r.owner_id, name: r.name, slug: r.slug, description: r.description, heroTitle: r.hero_title,
  heroSubtitle: r.hero_subtitle, primaryColor: r.primary_color, contactEmail: r.contact_email,
  publicCatalogUrl: catalogUrlOrNull(r.slug) ?? r.public_catalog_url, publishedUrl: r.published_url,
  catalogRevision: r.catalog_revision, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toProduct = (r: ProductRow): Product => ({
  id: r.id, businessId: r.business_id, name: r.name, description: r.description, category: r.category,
  priceCents: r.price_cents, inventoryCount: r.inventory_count, soldOut: r.inventory_count === 0,
  imageAssetId: r.image_asset_id, imageUrl: r.image_asset_id ? assetUrl(r.image_asset_id) : null,
  isPublished: bool(r.is_published), isFeatured: bool(r.is_featured), revision: r.revision,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const toDraft = (r: DraftRow): Draft => ({
  id: r.id, businessId: r.business_id, operation: r.operation as Draft["operation"], targetId: r.target_id,
  previousValues: r.previous_values ? JSON.parse(r.previous_values) : null,
  proposedValues: JSON.parse(r.proposed_values), expectedRevision: r.expected_revision, status: r.status,
  createdAt: r.created_at, resolvedAt: r.resolved_at,
});

const toAsset = (r: AssetRow): Asset => ({
  id: r.id, businessId: r.business_id, mimeType: r.mime_type, sizeBytes: r.size_bytes, width: r.width, height: r.height,
  url: assetUrl(r.id), createdAt: r.created_at,
});

const toJob = (r: JobRow): BuildJob => ({
  id: r.id, businessId: r.business_id, provider: r.provider, providerJobId: r.provider_job_id, buildStatus: r.build_status,
  publicationStatus: r.publication_status, publicUrl: r.public_url, errorMessage: r.error_message,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "store";
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export class SqliteRepository implements ShopCallRepository {
  constructor(private readonly db: Database.Database) {}

  // ---- Owners, businesses, sessions ----

  /** Idempotently provisions the single demo owner and their business. */
  ensureOwnerBusiness(email: string, businessName: string) {
    return this.db.transaction(() => {
      const t = now();
      let owner = this.db.prepare("SELECT id, email FROM owners WHERE email = ?").get(email) as { id: string; email: string } | undefined;
      if (!owner) {
        owner = { id: randomUUID(), email };
        this.db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").run(owner.id, email, t);
      }
      let row = this.db.prepare("SELECT * FROM businesses WHERE owner_id = ?").get(owner.id) as BusinessRow | undefined;
      if (!row) {
        let slug = slugify(businessName);
        if (this.db.prepare("SELECT 1 FROM businesses WHERE slug = ?").get(slug)) slug = `${slug}-${randomUUID().slice(0, 6)}`;
        const id = randomUUID();
        this.db.prepare(`INSERT INTO businesses (id, owner_id, name, slug, public_catalog_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, owner.id, businessName, slug, catalogUrlOrNull(slug), t, t);
        row = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as BusinessRow;
      } else {
        const url = catalogUrlOrNull(row.slug);
        if (url && url !== row.public_catalog_url) this.db.prepare("UPDATE businesses SET public_catalog_url = ? WHERE id = ?").run(url, row.id);
      }
      return { owner, business: toBusiness(row) };
    }).immediate();
  }

  createSession(ownerId: string, tokenHash: string, expiresAt: string) {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    this.db.prepare("INSERT INTO sessions (id, owner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), ownerId, tokenHash, expiresAt, now());
  }

  findSession(tokenHash: string) {
    return this.db.prepare(`SELECT o.id AS ownerId, o.email, b.id AS businessId, b.slug, b.name, s.expires_at AS expiresAt
      FROM sessions s JOIN owners o ON o.id = s.owner_id JOIN businesses b ON b.owner_id = o.id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, now()) as
      { ownerId: string; email: string; businessId: string; slug: string; name: string; expiresAt: string } | undefined;
  }

  deleteSession(tokenHash: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  async getBusiness(businessId: string) {
    const r = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId) as BusinessRow | undefined;
    return r ? toBusiness(r) : null;
  }

  // ---- Products ----

  async listProducts(businessId: string) {
    const rows = this.db.prepare("SELECT * FROM products WHERE business_id = ? ORDER BY created_at, id").all(businessId) as ProductRow[];
    return rows.map(toProduct);
  }

  async getProduct(businessId: string, productId: string) {
    if (!isUuid(productId)) return null;
    const r = this.db.prepare("SELECT * FROM products WHERE id = ? AND business_id = ?").get(productId, businessId) as ProductRow | undefined;
    return r ? toProduct(r) : null;
  }

  private productRow(businessId: string, productId: string) {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ? AND business_id = ?").get(productId, businessId) as ProductRow | undefined;
    return r ?? fail(404, "NOT_FOUND", "Product not found");
  }

  // ---- Assets ----

  createAsset(a: { id: string; businessId: string; storageKey: string; mimeType: Asset["mimeType"]; sizeBytes: number; width: number; height: number }) {
    this.db.prepare(`INSERT INTO assets (id, business_id, storage_key, mime_type, size_bytes, width, height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.businessId, a.storageKey, a.mimeType, a.sizeBytes, a.width, a.height, now());
    return toAsset(this.db.prepare("SELECT * FROM assets WHERE id = ?").get(a.id) as AssetRow);
  }

  /** Internal: includes storage key. `isPublic` = attached to a published product. */
  getAssetForServing(assetId: string) {
    if (!isUuid(assetId)) return null;
    const r = this.db.prepare(`SELECT a.*, EXISTS (SELECT 1 FROM products p WHERE p.image_asset_id = a.id AND p.is_published = 1) AS is_public
      FROM assets a WHERE a.id = ?`).get(assetId) as (AssetRow & { is_public: number }) | undefined;
    return r ? { businessId: r.business_id, storageKey: r.storage_key, mimeType: r.mime_type, isPublic: r.is_public === 1 } : null;
  }

  // ---- Drafts ----

  async createDraft(businessId: string, input: ProductChange): Promise<Draft> {
    const change = productChange.parse(input); // repository is a trust boundary for Lane C callers too
    return this.db.transaction(() => {
      let targetId: string | null = null;
      let previous: Record<string, unknown> | null = null;
      let expectedRevision: number | null = null;
      if (change.type === "create_product") {
        if (change.product.imageAssetId) this.assertOwnedAsset(businessId, change.product.imageAssetId);
      } else if (change.type === "update_storefront") {
        const b = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId) as BusinessRow | undefined;
        if (!b) fail(404, "NOT_FOUND", "Business not found");
        const current = toBusiness(b!);
        targetId = businessId;
        previous = Object.fromEntries(Object.keys(change.patch).map(k => [k, current[k as keyof typeof STOREFRONT_COLUMNS]]));
      } else {
        const p = toProduct(this.productRow(businessId, change.productId));
        if (p.revision !== change.expectedRevision) staleRevision(p);
        targetId = p.id;
        expectedRevision = change.expectedRevision;
        previous = change.type === "update_price" ? { priceCents: p.priceCents }
          : change.type === "update_product" ? Object.fromEntries(Object.keys(change.patch).map(k => [k, p[k as keyof typeof PRODUCT_PATCH_COLUMNS]]))
          : { inventoryCount: p.inventoryCount };
        if (change.type === "adjust_stock" && p.inventoryCount + change.delta < 0) {
          fail(409, "CONFLICT", `Cannot remove ${-change.delta}; only ${p.inventoryCount} in stock.`);
        }
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO drafts (id, business_id, operation, target_id, previous_values, proposed_values, expected_revision, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(id, businessId, change.type, targetId, previous && JSON.stringify(previous), JSON.stringify(change), expectedRevision, now());
      return this.draftRow(businessId, id);
    }).immediate();
  }

  async getDraft(businessId: string, draftId: string) {
    if (!isUuid(draftId)) return null;
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ? AND business_id = ?").get(draftId, businessId) as DraftRow | undefined;
    return r ? toDraft(r) : null;
  }

  private draftRow(businessId: string, draftId: string) {
    const r = isUuid(draftId) ? this.db.prepare("SELECT * FROM drafts WHERE id = ? AND business_id = ?").get(draftId, businessId) as DraftRow | undefined : undefined;
    return r ? toDraft(r) : fail(404, "NOT_FOUND", "Draft not found");
  }

  private assertOwnedAsset(businessId: string, assetId: string) {
    if (!this.db.prepare("SELECT 1 FROM assets WHERE id = ? AND business_id = ?").get(assetId, businessId)) {
      fail(404, "NOT_FOUND", "Image asset not found");
    }
  }

  /**
   * Applies the exact stored change in one IMMEDIATE transaction (write lock held from the start), so two
   * concurrent approvals serialize and the second sees status != pending. Any failure rolls everything back.
   */
  async approveDraft(businessId: string, draftId: string): Promise<DraftApprovalResponse> {
    return this.db.transaction(() => {
      const draft = this.draftRow(businessId, draftId);
      if (draft.status !== "pending") fail(409, "CONFLICT", `Draft is already ${draft.status}.`);
      const change = productChange.parse(draft.proposedValues);
      const t = now();
      let productId: string | null = null;

      switch (change.type) {
        case "create_product": {
          const p = change.product;
          if (p.imageAssetId) this.assertOwnedAsset(businessId, p.imageAssetId);
          productId = randomUUID();
          this.db.prepare(`INSERT INTO products (id, business_id, name, description, category, price_cents, inventory_count,
            image_asset_id, is_published, is_featured, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`)
            .run(productId, businessId, p.name, p.description ?? null, p.category ?? null, p.priceCents, p.inventoryCount, p.imageAssetId ?? null, t, t);
          break;
        }
        case "update_price":
          productId = this.applyProductUpdate(businessId, change.productId, change.expectedRevision, { price_cents: change.priceCents }, t);
          break;
        case "update_stock":
          productId = this.applyProductUpdate(businessId, change.productId, change.expectedRevision, { inventory_count: change.inventoryCount }, t);
          break;
        case "adjust_stock": {
          const current = this.productRow(businessId, change.productId);
          if (current.revision !== change.expectedRevision) staleRevision(toProduct(current));
          const next = current.inventory_count + change.delta;
          if (next < 0) fail(409, "CONFLICT", `Cannot remove ${-change.delta}; only ${current.inventory_count} in stock.`);
          productId = this.applyProductUpdate(businessId, change.productId, change.expectedRevision, { inventory_count: next }, t);
          break;
        }
        case "update_product": {
          const cols: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(change.patch)) cols[PRODUCT_PATCH_COLUMNS[k as keyof typeof PRODUCT_PATCH_COLUMNS]] = typeof v === "boolean" ? Number(v) : v;
          productId = this.applyProductUpdate(businessId, change.productId, change.expectedRevision, cols, t);
          break;
        }
        case "update_storefront": {
          const entries = Object.entries(change.patch).map(([k, v]) => [STOREFRONT_COLUMNS[k as keyof typeof STOREFRONT_COLUMNS], v] as const);
          this.db.prepare(`UPDATE businesses SET ${entries.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`)
            .run(...entries.map(([, v]) => v), businessId);
          break;
        }
      }

      this.db.prepare("UPDATE businesses SET catalog_revision = catalog_revision + 1, updated_at = ? WHERE id = ?").run(t, businessId);
      const res = this.db.prepare(`UPDATE drafts SET status = 'approved', resolved_at = ?, target_id = COALESCE(target_id, ?)
        WHERE id = ? AND business_id = ? AND status = 'pending'`).run(t, productId, draftId, businessId);
      if (res.changes !== 1) fail(409, "CONFLICT", "Draft was resolved concurrently.");

      const business = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId) as BusinessRow;
      return {
        draft: this.draftRow(businessId, draftId),
        product: productId ? toProduct(this.productRow(businessId, productId)) : null,
        business: change.type === "update_storefront" ? toBusiness(business) : null,
      };
    }).immediate();
  }

  private applyProductUpdate(businessId: string, productId: string, expectedRevision: number, cols: Record<string, unknown>, t: string) {
    const current = this.productRow(businessId, productId);
    if (current.revision !== expectedRevision) staleRevision(toProduct(current));
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE products SET ${keys.map(k => `${k} = ?`).join(", ")}, revision = revision + 1, updated_at = ?
      WHERE id = ? AND business_id = ? AND revision = ?`).run(...keys.map(k => cols[k]), t, productId, businessId, expectedRevision);
    return productId;
  }

  async rejectDraft(businessId: string, draftId: string): Promise<Draft> {
    return this.db.transaction(() => {
      const draft = this.draftRow(businessId, draftId);
      if (draft.status !== "pending") fail(409, "CONFLICT", `Draft is already ${draft.status}.`);
      this.db.prepare("UPDATE drafts SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now(), draftId);
      return this.draftRow(businessId, draftId);
    }).immediate();
  }

  // ---- Public catalog ----

  getPublicCatalog(slug: string): PublicCatalog {
    const b = this.db.prepare("SELECT * FROM businesses WHERE slug = ?").get(slug) as BusinessRow | undefined;
    if (!b) return fail(404, "NOT_FOUND", "Store not found");
    const rows = this.db.prepare("SELECT * FROM products WHERE business_id = ? AND is_published = 1 ORDER BY is_featured DESC, created_at, id")
      .all(b.id) as ProductRow[];
    return {
      business: {
        slug: b.slug, name: b.name, description: b.description, heroTitle: b.hero_title, heroSubtitle: b.hero_subtitle,
        primaryColor: b.primary_color, contactEmail: b.contact_email, currencyCode: "USD",
      },
      catalogRevision: b.catalog_revision,
      // Explicit allowlist: no business/owner IDs, storage keys, drafts or jobs.
      products: rows.map(r => ({
        id: r.id, name: r.name, description: r.description, category: r.category, priceCents: r.price_cents,
        inventoryCount: r.inventory_count, soldOut: r.inventory_count === 0, isFeatured: bool(r.is_featured),
        imageUrl: r.image_asset_id ? assetUrl(r.image_asset_id, true) : null, revision: r.revision, updatedAt: r.updated_at,
      })),
      generatedAt: now(),
    };
  }

  // ---- Build jobs ----

  async createBuildJob(businessId: string, ownerId: string, input: BuildJobRequest): Promise<BuildJob> {
    const req = buildJobRequest.parse(input);
    return this.db.transaction(() => {
      const b = this.db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId) as BusinessRow | undefined;
      if (!b) return fail(404, "NOT_FOUND", "Business not found");
      const active = this.db.prepare(`SELECT id FROM build_jobs WHERE business_id = ?
        AND (build_status IN ('queued', 'running') OR (build_status = 'completed' AND publication_status = 'pending'))`).get(businessId);
      if (active) fail(409, "CONFLICT", "A build is already in progress for this store.");
      const id = randomUUID();
      const t = now();
      const spec: BuildSpec = {
        jobId: id, businessId, businessName: b.name, slug: b.slug, publicCatalogUrl: publicCatalogUrl(b.slug),
        catalogRevision: b.catalog_revision, designBrief: req.designBrief ?? "", approvedByOwnerId: ownerId, approvedAt: t,
      };
      this.db.prepare(`INSERT INTO build_jobs (id, business_id, provider, build_status, publication_status, spec, created_at, updated_at)
        VALUES (?, ?, 'replit', 'queued', 'pending', ?, ?, ?)`).run(id, businessId, JSON.stringify(spec), t, t);
      return this.getBuildJobById(id);
    }).immediate();
  }

  async getBuildJob(businessId: string, jobId: string) {
    if (!isUuid(jobId)) return null;
    const r = this.db.prepare("SELECT * FROM build_jobs WHERE id = ? AND business_id = ?").get(jobId, businessId) as JobRow | undefined;
    return r ? toJob(r) : null;
  }

  getBuildJobById(jobId: string) {
    const r = this.db.prepare("SELECT * FROM build_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return r ? toJob(r) : fail(404, "NOT_FOUND", "Build job not found");
  }

  async getBuildSpec(jobId: string): Promise<BuildSpec | null> {
    const r = this.db.prepare("SELECT spec FROM build_jobs WHERE id = ?").get(jobId) as { spec: string } | undefined;
    return r ? JSON.parse(r.spec) : null;
  }

  async claimNextBuildJob() {
    return this.db.transaction(() => {
      const r = this.db.prepare("SELECT * FROM build_jobs WHERE build_status = 'queued' ORDER BY created_at, id LIMIT 1").get() as JobRow | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE build_jobs SET build_status = 'running', updated_at = ? WHERE id = ? AND build_status = 'queued'").run(now(), r.id);
      return { job: this.getBuildJobById(r.id), spec: JSON.parse(r.spec) as BuildSpec };
    }).immediate();
  }

  /**
   * Build: queued → running → completed|failed (forward only; terminal states are final).
   * Publication: pending → completed|failed, only after build completed. publicUrl only with publication completed.
   */
  async updateBuildJob(jobId: string, input: BuildJobUpdate): Promise<BuildJob> {
    const u = buildJobUpdate.parse(input);
    return this.db.transaction(() => {
      const cur = this.getBuildJobById(jobId);
      const build = u.buildStatus ?? cur.buildStatus;
      const pub = u.publicationStatus ?? cur.publicationStatus;
      const order = { queued: 0, running: 1, completed: 2, failed: 2 } as const;
      if (build !== cur.buildStatus && (order[build] < order[cur.buildStatus] || order[cur.buildStatus] === 2)) {
        fail(409, "CONFLICT", `Illegal build transition ${cur.buildStatus} → ${build}.`);
      }
      if (pub !== cur.publicationStatus) {
        if (cur.publicationStatus !== "pending") fail(409, "CONFLICT", `Publication already ${cur.publicationStatus}.`);
        if (build !== "completed") fail(409, "CONFLICT", "Publication status can change only after the build completed.");
      }
      if (u.publicUrl !== undefined && pub !== "completed") fail(400, "INVALID_INPUT", "publicUrl requires publicationStatus \"completed\".");
      if (pub === "completed" && !(u.publicUrl ?? cur.publicUrl)) fail(400, "INVALID_INPUT", "Completed publication requires the verified publicUrl.");
      if (u.publicUrl && process.env.NODE_ENV === "production" && !u.publicUrl.startsWith("https://")) fail(400, "INVALID_INPUT", "publicUrl must be https.");
      const t = now();
      this.db.prepare(`UPDATE build_jobs SET provider_job_id = COALESCE(?, provider_job_id), build_status = ?, publication_status = ?,
        public_url = COALESCE(?, public_url), error_message = COALESCE(?, error_message), updated_at = ? WHERE id = ?`)
        .run(u.providerJobId ?? null, build, pub, u.publicUrl ?? null, u.errorMessage ?? null, t, jobId);
      if (u.publicUrl) this.db.prepare("UPDATE businesses SET published_url = ?, updated_at = ? WHERE id = ?").run(u.publicUrl, t, cur.businessId);
      return this.getBuildJobById(jobId);
    }).immediate();
  }
}

function staleRevision(p: Product): never {
  return fail(409, "STALE_REVISION", `Product changed since it was read (current revision ${p.revision}). Re-read and re-confirm.`);
}

let instance: SqliteRepository | undefined;
export const repository = () => (instance ??= new SqliteRepository(getDb()));

/** Adapter for the pre-existing v0 `PublicationRepository` seam (approvalId = build job ID). */
export const publicationRepository: PublicationRepository = {
  async getApprovedSnapshot(businessId, approvalId) {
    const spec = await repository().getBuildSpec(approvalId);
    if (!spec || spec.businessId !== businessId) return fail(404, "NOT_FOUND", "Approved build snapshot not found");
    return { businessName: spec.businessName, catalogRevision: spec.catalogRevision, publicCatalogUrl: spec.publicCatalogUrl, approvedDesignBrief: spec.designBrief };
  },
  async updateJob(id, patch) {
    const map: Record<BuildPhase, BuildJobUpdate> = {
      queued: {}, preparing: { buildStatus: "running" }, creating: { buildStatus: "running" }, building: { buildStatus: "running" },
      publishing: { buildStatus: "completed" }, verifying: { buildStatus: "completed" },
      ready: { buildStatus: "completed", publicationStatus: "completed" }, failed: {},
    };
    const update: BuildJobUpdate = { ...(patch.phase ? map[patch.phase] : {}) };
    if (patch.phase === "failed") {
      const cur = repository().getBuildJobById(id);
      if (cur.buildStatus === "completed") update.publicationStatus = "failed";
      else update.buildStatus = "failed";
    }
    if (patch.replId) update.providerJobId = patch.replId;
    if (patch.publicUrl) update.publicUrl = patch.publicUrl;
    if (patch.error) update.errorMessage = patch.error;
    await repository().updateBuildJob(id, update);
  },
};
