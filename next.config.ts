import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API + SQLite session routes need request-time rendering
  cacheComponents: false,
  serverExternalPackages: ["exceljs"],
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
