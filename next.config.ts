import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
    // Phone photos are often larger than the 10MB proxy buffer. The route
    // still rejects anything above MAX_UPLOAD_BYTES (25MB) with a clear error.
    proxyClientMaxBodySize: "32mb",
    serverActions: {
      bodySizeLimit: "32mb",
    },
  },
  // API + SQLite session routes need request-time rendering
  cacheComponents: false,
  serverExternalPackages: ["exceljs", "node-unrar-js", "xlsx"],
  // Cursor preview / proxies hit the app via alternate Host headers
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.cursor.sh",
    "*.cursor.com",
    "*.trycloudflare.com",
  ],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
