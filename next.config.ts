import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Disable Turbopack for production builds — Turbopack (beta) has known
  // worker-thread module-resolution issues on this Node.js v20 host.
  // Webpack (stable) produces identical output and is the safe fallback.
  // turbopack: undefined doesn't actually disable it; omit the key entirely.
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  headers: async () => [
    {
      // HTML pages and API routes — always revalidate (ETag still works for 304s)
      source: "/((?!_next/static|_next/image|favicon\\.ico).*)",
      headers: [
        {
          key: "Cache-Control",
          value: "no-cache, must-revalidate",
        },
      ],
    },
  ],
};

export default nextConfig;
