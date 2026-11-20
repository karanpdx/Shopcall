import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import { productFields } from "../../contracts/catalog";
import { allowedPublicUrl } from "../publication/verification";
import type { BuildRun, TaskObservation } from "../publication/workflow";
import { assertPlanIntegrity, type StorefrontPlan, type StorefrontTask } from "./plan";
import { evaluateTaskGate, type TaskEvidence } from "./evidence";

export interface PreviewLocator { locate(replId: string): Promise<string | null> }
export class ConfiguredPreviewLocator implements PreviewLocator {
  constructor(private readonly previewByApp: Readonly<Record<string, string>>, private readonly trustedOrigins: readonly string[]) {}
  async locate(replId: string) {
    const value = this.previewByApp[replId];
    return value ? allowedPublicUrl(value, this.trustedOrigins).href : null;
  }
}

export type PreviewInspection = { observedChecks: string[]; observedAt: string; artifactRef: string };
export interface PreviewInspector { inspect(url: string, plan: StorefrontPlan, replId: string): Promise<PreviewInspection> }
export interface PreviewNetworkVerifier {
  verify(url: string, plan: StorefrontPlan, replId: string): Promise<{ passed: boolean; checks: string[] }>;
}

const canonicalSchema = z.object({
  business: z.object({ id: z.uuid(), name: z.string(), description: z.string(), contactEmail: z.email(), currencyCode: z.string() }).strict(),
  revision: z.number().int().nonnegative(),
  products: z.array(productFields.safeExtend({ id: z.uuid(), imageUrl: z.url().nullable() })).min(1).max(500),
}).strict();

async function canonicalJson(response: Response) {
  if (!response.ok || !response.body) throw new Error("Canonical catalog unavailable.");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error("Catalog response too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return canonicalSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
}

/** Actual read-only network + desktop/mobile DOM inspection, without relying on Agent claims. */
export class PlaywrightPreviewInspector implements PreviewInspector {
  constructor(
    private readonly trustedOrigins: readonly string[],
    private readonly network: PreviewNetworkVerifier,
    private readonly request: typeof fetch = fetch,
    private readonly launch: () => Promise<Browser> = () => chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true, timeout: 20_000 }),
    private readonly now = () => new Date(),
  ) {}

  async inspect(value: string, plan: StorefrontPlan, replId: string): Promise<PreviewInspection> {
    assertPlanIntegrity(plan);
    const url = allowedPublicUrl(value, this.trustedOrigins);
    const catalogUrl = allowedPublicUrl(plan.brief.publicCatalogUrl, this.trustedOrigins);
    const checks = new Set<string>();
    const proof = await this.network.verify(url.href, plan, replId);
    const observed = (key: string) => proof.passed && proof.checks.includes(key);
    if (observed("same-origin-live-catalog-proxy") && observed("correct-live-business-catalog") && observed("usable-original-images")) {
      ["canonical-api-runtime-fetch", "correct-business-identity", "fresh-revision", "no-private-data", "original-product-images", "same-origin-catalog-proxy", "live-catalog-network-request", "correct-prices-stock-images"].forEach(check => checks.add(check));
    }
    const get = (target: string) => this.request(target, { redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const canonical = await canonicalJson(await get(catalogUrl.href));
    if (canonical.business.id !== plan.brief.businessId || canonical.revision < plan.brief.catalogRevision) throw new Error("Canonical snapshot identity mismatch.");
    const proxy = await get(new URL("/api/shopcall/catalog", url).href);
    const proxyNoStore = /(?:^|,)\s*no-store(?:\s*,|$)/i.test(proxy.headers.get("cache-control") ?? "");
    await proxy.body?.cancel();
    const browser = await this.launch();
    try {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      await context.routeWebSocket("**/*", socket => socket.close());
      await context.route("**/*", async route => {
        const target = new URL(route.request().url());
        if (target.protocol === "https:" && this.trustedOrigins.includes(target.origin) && !target.username && !target.password) await route.continue();
        else await route.abort();
      });
      const page = await context.newPage();
      context.on("page", popup => { void popup.close().catch(() => {}); });
      page.setDefaultTimeout(10_000);
      let allLayouts = true;
      let controlsNamed = true;
      let planMatched = true;
      let normalReady = true;
      let noStore = true;
      let contact = true;
      let noCheckout = true;
      for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        const response = await page.goto(url.href, { waitUntil: "networkidle", timeout: 30_000 });
        if (!response?.ok() || page.url() !== url.href) throw new Error("Preview unavailable or redirected.");
        noStore &&= /(?:^|,)\s*no-store(?:\s*,|$)/i.test(response.headers()["cache-control"] ?? "");
        const result = await page.evaluate(({ planId, expected }) => {
          const visible = (node: Element) => {
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            for (let current: Element | null = node; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
            }
            return true;
          };
          const roots = [...document.querySelectorAll<HTMLElement>("[data-shopcall-business]")].filter(visible);
          const root = roots.length === 1 ? roots[0] : null;
          const items = [...document.querySelectorAll<HTMLElement>("[data-shopcall-product]")].filter(visible);
          const ids = items.map(item => item.dataset.shopcallProduct).sort();
          const expectedIds = expected.products.map(product => product.id).sort();
          const exactProducts = Boolean(root && items.every(item => root.contains(item))) && JSON.stringify(ids) === JSON.stringify(expectedIds) && expected.products.every(product => items.some(item => item.dataset.shopcallProduct === product.id && item.innerText.includes(product.title)));
          const controls = [...document.querySelectorAll<HTMLElement>("button,a[href],input:not([type=hidden]),select,textarea")].filter(visible);
          const named = controls.every(control => {
            const labelled = control.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
            const labels = (control as HTMLInputElement).labels;
            return Boolean(control.getAttribute("aria-label")?.trim() || labelled?.trim() || control.innerText?.trim() || (labels && [...labels].some(label => label.textContent?.trim())) || (control instanceof HTMLInputElement && control.type === "submit" && control.value.trim()));
          });
          const email = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]')].some(anchor => visible(anchor) && anchor.href === `mailto:${expected.business.contactEmail}`);
          const fakeCheckout = controls.some(control => /^(?:checkout|add to cart|pay now)$/i.test((control.textContent ?? "").trim()));
          return {
            layout: document.documentElement.scrollWidth <= innerWidth + 1 && Boolean(document.querySelector('meta[name="viewport"]')?.getAttribute("content")?.includes("width=device-width")),
            named,
            matched: root?.dataset.shopcallPlan === planId,
            ready: Boolean(root && root.dataset.shopcallBusiness === expected.business.id && root.dataset.shopcallRevision === String(expected.revision) && root.innerText.includes(expected.business.name) && exactProducts),
            email, noCheckout: !fakeCheckout,
          };
        }, { planId: plan.id, expected: canonical });
        allLayouts &&= result.layout;
        controlsNamed &&= result.named;
        planMatched &&= result.matched;
        normalReady &&= result.ready;
        contact &&= result.email;
        noCheckout &&= result.noCheckout;
      }
      if (allLayouts && normalReady) checks.add("responsive-design").add("responsive-render");
      if (planMatched && normalReady) checks.add("approved-style-reference");
      if (controlsNamed && normalReady) checks.add("accessible-controls");
      if (contact && normalReady) checks.add("contact-to-buy");
      if (noCheckout && normalReady) checks.add("no-checkout");
      if (normalReady && proof.passed) checks.add("anonymous-preview");
      if (normalReady && noStore && proxyNoStore && proof.passed) checks.add("uncached-server-render");
      let scenariosPassed = true;
      for (const [scenario, state] of [["empty", "empty"], ["upstream-error", "error"]]) {
        const scenarioUrl = new URL(url);
        scenarioUrl.searchParams.set("shopcall_verify", scenario);
        const response = await page.goto(scenarioUrl.href, { waitUntil: "networkidle", timeout: 30_000 });
        if (!response || page.url() !== scenarioUrl.href || !/(?:^|,)\s*no-store(?:\s*,|$)/i.test(response.headers()["cache-control"] ?? "")) { scenariosPassed = false; continue; }
        scenariosPassed &&= await page.evaluate(({ state }) => {
          const notice = document.querySelector<HTMLElement>(`[data-shopcall-state="${state}"]`);
          const rect = notice?.getBoundingClientRect();
          let visible = Boolean(notice && rect && rect.width > 0 && rect.height > 0);
          for (let node: Element | null = notice; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") visible = false;
          }
          const message = notice?.innerText ?? "";
          const honestMessage = state === "empty" ? /no products|nothing|empty|coming soon|not yet/i.test(message) : /unable|unavailable|try again|could not|failed|error|problem/i.test(message);
          return Boolean(visible && document.body.innerText.includes("Verification scenario") && honestMessage && document.querySelectorAll("[data-shopcall-product]").length === 0);
        }, { state });
      }
      if (scenariosPassed) checks.add("honest-empty-error-states");
      const after = await canonicalJson(await get(catalogUrl.href));
      if (JSON.stringify(after) !== JSON.stringify(canonical)) throw new Error("Catalog changed during preview inspection.");
      return { observedChecks: [...checks], observedAt: this.now().toISOString(), artifactRef: url.href };
    } finally { await browser.close(); }
  }
}

/** Converts concrete read-only observations into task-scoped evidence, not arbitrary completion flags. */
export class AutomaticStorefrontTaskObserver {
  constructor(private readonly locator: PreviewLocator, private readonly inspector: PreviewInspector, private readonly now = () => new Date()) {}
  async observe(run: BuildRun, task: StorefrontTask): Promise<TaskObservation> {
    assertPlanIntegrity(run.plan);
    if (!run.replId || task.id === "deploy" || run.plan.tasks.find(item => item.id === task.id)?.role !== task.role) return { state: "blocked", code: "TASK_OBSERVER_SCOPE_INVALID" };
    const preview = await this.locator.locate(run.replId);
    if (!preview) return { state: "blocked", code: "REPLIT_PREVIEW_UNAVAILABLE" };
    try {
      const observation = await this.inspector.inspect(preview, run.plan, run.replId);
      const evidence: TaskEvidence = { planId: run.plan.id, taskId: task.id, replId: run.replId, source: task.id === "catalogIntegration" ? "network-check" : "browser-check", observedAt: observation.observedAt, outcome: "passed", artifactRef: observation.artifactRef, checks: task.acceptanceCriteria.filter(check => observation.observedChecks.includes(check)) };
      if (!evaluateTaskGate(run.plan, [...run.evidence, evidence], run.replId, task.id, this.now()).allowed) return { state: "pending" };
      return { state: "passed", evidence };
    } catch { return { state: "pending" }; }
  }
}
