import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = String(process.env.PORT || 43141);
const host = process.env.HOST || "0.0.0.0";
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

const child = spawn(
  process.execPath,
  [nextBin, "start", "--hostname", host, "--port", port],
  { stdio: "inherit", cwd: root, env: process.env }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
