import { publicApiBase } from "@/server/config";
import { errorResponse, ok } from "@/server/http";
import { repository } from "@/server/repository";

// Anonymous, read-only, no cookies read. `*` is safe: no credentials are honored and the payload is an explicit public allowlist.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    publicApiBase(); // image URLs must be absolute for a separately deployed storefront
    // no-store so price/stock changes are visible on the next storefront fetch, without rebuilding.
    return ok(repository().getPublicCatalog((await params).slug), { headers: { ...CORS, "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err, CORS);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
