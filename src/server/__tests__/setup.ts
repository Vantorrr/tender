import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const dbFile = `test-tma361-${process.pid}.sqlite`;

process.env.DATA_DIR = "data";
process.env.DB_FILE = dbFile;
process.env.SYNC_INTERVAL_MS = "0";
process.env.MAIL_TRANSPORT = "memory";
process.env.OPENROUTER_API_KEY = "";
process.env.OCR_PROVIDER = "";

fs.mkdirSync(dataDir, { recursive: true });
for (const name of fs.readdirSync(dataDir)) {
  if (name.startsWith("test-tma361-") || name.startsWith("test-backup-")) {
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
}
