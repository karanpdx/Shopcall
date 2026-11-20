import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  async rewrites() {
    const configured = process.env.SHOPCALL_API_PROXY_ORIGIN;
    if (!configured) return [];
    const backend = new URL(configured);
    if (backend.protocol !== "https:" || backend.username || backend.password || backend.search || backend.hash || backend.pathname !== "/") throw new Error("SHOPCALL_API_PROXY_ORIGIN must be a fixed HTTPS origin.");
    return { beforeFiles: [{ source: "/api/:path*", destination: `${backend.origin}/api/:path*` }], afterFiles: [], fallback: [] };
  },
};

export default config;
