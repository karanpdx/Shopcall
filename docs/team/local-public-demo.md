# Temporary public catalog for local demo

The merchant app can run locally while a generated Replit storefront reads its approved public catalog and images over HTTPS. This does **not** replace Replit storefront generation/publication; it only makes the existing canonical backend's public endpoints reachable during a demo.

## Narrow public boundary

`scripts/public-catalog-proxy.ts` listens on `127.0.0.1:8789` and forwards only:

- `GET` / `HEAD /api/public/<slug>/catalog`
- `GET` / `HEAD /api/assets/<uuid>`

Upstream is fixed to `http://127.0.0.1:3000`. No request can select another target host/port, and query strings, traversal, other methods, app pages, login/session/admin routes, voice endpoints, OAuth callbacks, or management writes receive 404. Incoming cookies, authorization, Origin, forwarding headers and Host are never forwarded. Upstream redirects/errors are not exposed; only safe response headers and JSON or supported image types pass through. Catalog is always `Cache-Control: no-store` and CORS `*` without credentials. Private/draft images remain protected by the existing backend route because the proxy supplies no owner credentials.

## Start demo

1. Start the existing Shopcall app on port 3000 using its normal local setup. Keep owner/login/voice traffic local.
2. Start the read-only proxy:

   ```sh
   node --import tsx scripts/public-catalog-proxy.ts
   ```

3. Install/download official `cloudflared` outside the tracked repository, then start a quick tunnel **to the proxy**, never to the full app:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8789 --no-autoupdate --protocol http2
   ```

4. The process prints a temporary `https://<random>.trycloudflare.com` hostname. The backend owner sets local ignored `PUBLIC_API_BASE` to that HTTPS origin and restarts the backend so new public catalog/image URLs use it. Do not change the owner app origin to the tunnel: management pages are intentionally unavailable through it.
5. Configure the publication verifier's trusted public origins with this exact tunnel origin and actual Replit deployment origin. When publication orchestration runs on this same laptop, its network-check adapter may use the known local canonical backend alias for catalog checks; public generated Replit requests still use the HTTPS tunnel.
6. Check the public catalog and an approved product image, plus confirm `/`, `/api/session`, `/api/auth/login`, and write methods remain 404. The catalog slug comes from the app's public-store information; no owner DB inspection is required.

## Lifetime and limits

This is a temporary testing/development setup. All three processes—Shopcall, read-only proxy, and cloudflared—must stay running on the laptop with network access. The URL stops working when the tunnel exits, and changes when restarted. A generated app using the old hostname must receive an approved design/configuration update if the origin changes; ordinary price/stock edits still read live data at the same storefront URL without rebuilding.

Cloudflare quick tunnels provide no uptime guarantee, support up to 200 in-flight requests, and do not support SSE. The public catalog path uses ordinary HTTP JSON/images, not SSE. Use durable publicly hosted backend/storage and a stable hostname for continued use beyond the demo.

Official references: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). The development binary used here is downloaded into a private temporary directory and is not committed.
