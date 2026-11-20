import { chromium, type Browser } from "playwright-core";
import { parseCanonicalCatalog, type NormalizedPublicCatalog, type StorefrontPlan, type TaskEvidence } from "../orchestrator";
import type { StorefrontVerifier } from "./workflow";

export type VerificationCatalog = NormalizedPublicCatalog;

class CatalogChanged extends Error {}
function requireUncached(response: Response) {
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) throw new Error("Live catalog and storefront responses must declare Cache-Control: no-store.");
  return response;
}

/** Origins must come from deployment configuration, never merchant text or model output. */
export function allowedPublicUrl(value: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || !allowedOrigins.includes(url.origin)
    || !host.includes(".") || /[:\[\]]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /\.(?:localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error("Verification URL is outside configured public HTTPS origins.");
  }
  return url;
}

async function body(response: Response, limit: number) {
  if (!response.ok || response.status >= 300 || !response.body) throw new Error("Anonymous verification request failed.");
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("Verification response exceeded limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export interface AnonymousBrowserCheck {
  inspect(url: string, catalog: VerificationCatalog, allowedOrigins: readonly string[]): Promise<boolean>;
}

/** Fresh isolated context, no owner cookies. Deployment image needs Chrome/Chromium configured. */
export class PlaywrightStorefrontCheck implements AnonymousBrowserCheck {
  constructor(private readonly launch: () => Promise<Browser> = () => chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true, timeout: 20_000 })) {}

  async inspect(url: string, catalog: VerificationCatalog, allowedOrigins: readonly string[]): Promise<boolean> {
    const browser = await this.launch();
    try {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 390, height: 844 } });
      await context.addInitScript("globalThis.__name ??= (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true });");
      const errors: string[] = [];
      await context.routeWebSocket("**/*", socket => socket.close());
      await context.route("**/*", async route => {
        const requested = new URL(route.request().url());
        // Allow only configured storefront/catalog/image hosts. No private network or arbitrary third-party calls.
        if (requested.protocol === "https:" && allowedOrigins.includes(requested.origin) && !requested.username && !requested.password) await route.continue();
        else await route.abort();
      });
      const page = await context.newPage();
      page.on("popup", popup => { void popup.close(); });
      page.setDefaultTimeout(10_000);
      page.on("pageerror", () => errors.push("PAGE_ERROR"));
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      if (!response?.ok() || new URL(page.url()).origin !== new URL(url).origin) return false;
      const expected = catalog;
      const passed = await page.evaluate(({ expected }) => {
        const root = document.querySelector<HTMLElement>("[data-shopcall-business]");
        const visible = (node: HTMLElement) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        if (!root || !visible(root) || root.dataset.shopcallBusiness !== expected.business.id || root.dataset.shopcallRevision !== String(expected.revision) || !root.innerText.includes(expected.business.name)) return false;
        const rendered = [...document.querySelectorAll<HTMLElement>("[data-shopcall-product]")].filter(visible);
        const actualIds = rendered.map(item => item.dataset.shopcallProduct).sort();
        const expectedIds = expected.products.map(item => item.id).sort();
        if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds) || rendered.some(item => !root.contains(item))) return false;
        if (document.documentElement.scrollWidth > window.innerWidth + 1) return false;
        for (const product of expected.products) {
          const item = rendered.find(node => node.dataset.shopcallProduct === product.id);
          if (!item || !item.innerText.includes(product.title)) return false;
          const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: product.currencyCode });
          const formatted = formatter.format(product.priceMinor / (10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2)));
          if (!item.innerText.includes(formatted)) return false;
          if ((product.inventoryTracked && product.quantityOnHand === 0) !== /sold out/i.test(item.innerText)) return false;
          if (!product.imageUrl || ![...item.querySelectorAll("img")].some(image => {
            const source = new URL(image.currentSrc || image.src, window.location.href);
            return visible(image) && image.complete && image.naturalWidth > 0 && (source.href === product.imageUrl || source.searchParams.get("url") === product.imageUrl);
          })) return false;
        }
        const contact = [...root.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]')].some(link => visible(link) && link.href === `mailto:${expected.business.contactEmail}`);
        return contact && ![...document.querySelectorAll("button,a")].some(element => /^(?:checkout|add to cart|pay now)$/i.test((element.textContent ?? "").trim()));
      }, { expected });
      return passed && errors.length === 0;
    } finally { await browser.close(); }
  }
}

/** Independent anonymous network comparison plus rendered mobile smoke check. Never accepts provider prose. */
export class AnonymousStorefrontVerifier implements StorefrontVerifier {
  constructor(
    private readonly trustedOrigins: readonly string[],
    private readonly browser: AnonymousBrowserCheck,
    private readonly request: typeof fetch = fetch,
    private readonly now = () => new Date(),
  ) {}

  async verify(value: string, plan: StorefrontPlan, replId: string) {
    const checks: string[] = [];
    const evidence: TaskEvidence[] = [];
    try {
      const storefront = allowedPublicUrl(value, this.trustedOrigins);
      const canonicalUrl = allowedPublicUrl(plan.brief.publicCatalogUrl, this.trustedOrigins);
      const get = (url: string) => this.request(url, { redirect: "manual", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json, text/html, image/*" } });
      const original = parseCanonicalCatalog(JSON.parse((await body(requireUncached(await get(canonicalUrl.href)), 2_000_000)).toString()), plan);
      if (original.business.id !== plan.brief.businessId || original.revision < plan.brief.catalogRevision || original.products.length === 0) throw new Error("Catalog identity or revision mismatch.");
      const proxy = new URL("/api/shopcall/catalog", storefront);
      const proxyCatalog = parseCanonicalCatalog(JSON.parse((await body(requireUncached(await get(proxy.href)), 2_000_000)).toString()), plan);
      if (JSON.stringify(proxyCatalog) !== JSON.stringify(original)) throw new Error("Storefront proxy is stale or differs from canonical catalog.");
      checks.push("same-origin-live-catalog-proxy");
      const htmlResponse = requireUncached(await get(storefront.href));
      const html = (await body(htmlResponse, 3_000_000)).toString();
      if (!html.includes(original.business.id) || !html.includes("data-shopcall-business") || !html.includes("data-shopcall-revision")) throw new Error("Storefront did not server-render expected business.");
      checks.push("anonymous-public-url");
      for (const product of original.products) {
        if (!html.includes(product.id) || !html.includes("data-shopcall-product") || !product.imageUrl) throw new Error("Missing server-rendered product or original image.");
        const image = allowedPublicUrl(product.imageUrl, this.trustedOrigins);
        const response = await get(image.href);
        if (!/^image\/(?:jpeg|png|webp|avif)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Public image type is unsupported.");
        if ((await body(response, 15_000_000)).length === 0) throw new Error("Public image empty.");
      }
      checks.push("usable-original-images");
      if (!await this.browser.inspect(storefront.href, original, this.trustedOrigins)) throw new Error("Rendered storefront check failed.");
      // Avoid accepting an apparent stale site if catalog changed while checks were in flight.
      const after = parseCanonicalCatalog(JSON.parse((await body(requireUncached(await get(canonicalUrl.href)), 2_000_000)).toString()), plan);
      if (JSON.stringify(after) !== JSON.stringify(original)) throw new CatalogChanged("Catalog changed during verification; retry with a fresh snapshot.");
      checks.push("correct-live-business-catalog", "current-product-prices-stock");
      evidence.push({ planId: plan.id, taskId: "deploy", replId, source: "browser-check", observedAt: this.now().toISOString(), outcome: "passed", artifactRef: storefront.href, checks: ["anonymous-public-url", "correct-live-business-catalog"] });
      return { passed: true, checks, evidence, catalogRevision: original.revision, httpStatus: htmlResponse.status };
    } catch (error) {
      return { passed: false, checks, evidence, retryable: error instanceof CatalogChanged };
    }
  }
}
