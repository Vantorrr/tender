import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API + SQLite session routes need request-time rendering
  cacheComponents: false,
  serverExternalPackages: ["exceljs"],
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
