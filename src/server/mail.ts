/**
 * Mail transport for password recovery.
 * - memory: in-process inbox (unit tests)
 * - file: local sink under DATA_DIR/mail-sink (safe, no real humans)
 * - console: log + memory
 * - smtp: requires SMTP_HOST; never used in isolated CI
 * Never puts passwords in mail — only opaque recovery codes.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "@/server/config";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  at: string;
  id?: string;
};

export interface MailTransport {
  readonly id: string;
  send(message: Omit<MailMessage, "at" | "id">): Promise<{
    ok: boolean;
    transport: string;
    id?: string;
  }>;
}

const inbox: MailMessage[] = [];

function pushInbox(message: MailMessage) {
  inbox.unshift(message);
  if (inbox.length > 200) inbox.length = 200;
}

export class MemoryMailTransport implements MailTransport {
  readonly id = "memory";

  async send(message: Omit<MailMessage, "at" | "id">) {
    const full: MailMessage = {
      ...message,
      at: new Date().toISOString(),
      id: `mem-${Date.now()}`,
    };
    pushInbox(full);
    return { ok: true, transport: this.id, id: full.id };
  }
}

export class ConsoleMailTransport implements MailTransport {
  readonly id = "console";

  async send(message: Omit<MailMessage, "at" | "id">) {
    const full: MailMessage = {
      ...message,
      at: new Date().toISOString(),
      id: `con-${Date.now()}`,
    };
    pushInbox(full);
    console.info(
      `[mail:${this.id}] to=${message.to} subject=${JSON.stringify(message.subject)}`
    );
    return { ok: true, transport: this.id, id: full.id };
  }
}

/** Writes JSON messages under data/mail-sink — local/test only, never SMTP. */
export class FileMailTransport implements MailTransport {
  readonly id = "file";

  private sinkDir() {
    const dir = path.join(config.dataDir, "mail-sink");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async send(message: Omit<MailMessage, "at" | "id">) {
    const id = `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full: MailMessage = { ...message, at: new Date().toISOString(), id };
    pushInbox(full);
    const file = path.join(this.sinkDir(), `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(full, null, 2), "utf8");
    // Latest pointer for easy test reads (no secrets beyond recovery code).
    fs.writeFileSync(
      path.join(this.sinkDir(), "latest.json"),
      JSON.stringify(full, null, 2),
      "utf8"
    );
    return { ok: true, transport: this.id, id };
  }
}

/**
 * SMTP placeholder: requires SMTP_HOST. Without it, falls back to file sink.
 * Does not invent credentials or open paid relays in CI.
 */
export class SmtpMailTransport implements MailTransport {
  readonly id = "smtp";

  async send(message: Omit<MailMessage, "at" | "id">) {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) {
      throw new Error("SMTP не сконфигурирован (нет SMTP_HOST)");
    }
    const full: MailMessage = {
      ...message,
      text: `[smtp-queued via ${host}] ${message.text}`,
      at: new Date().toISOString(),
      id: `smtp-${Date.now()}`,
    };
    pushInbox(full);
    return { ok: true, transport: this.id, id: full.id };
  }
}

function createDefaultTransport(): MailTransport {
  const mode = (process.env.MAIL_TRANSPORT ?? "file").toLowerCase();
  if (mode === "memory") return new MemoryMailTransport();
  if (mode === "console") return new ConsoleMailTransport();
  if (mode === "file") return new FileMailTransport();
  if (mode === "smtp") {
    if (process.env.SMTP_HOST?.trim()) return new SmtpMailTransport();
    return new FileMailTransport();
  }
  return new FileMailTransport();
}

let transport: MailTransport = createDefaultTransport();

export function getMailTransport(): MailTransport {
  return transport;
}

export function setMailTransport(next: MailTransport): void {
  transport = next;
}

export function resetMailTransport(): void {
  transport = createDefaultTransport();
  clearMailInbox();
}

export function getMailInbox(): readonly MailMessage[] {
  return inbox;
}

export function clearMailInbox(): void {
  inbox.length = 0;
}

export function readMailSinkLatest(): MailMessage | null {
  const file = path.join(config.dataDir, "mail-sink", "latest.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as MailMessage;
  } catch {
    return null;
  }
}

export function clearMailSink(): void {
  const dir = path.join(config.dataDir, "mail-sink");
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, name));
  }
}

export async function sendMail(message: Omit<MailMessage, "at" | "id">) {
  return getMailTransport().send(message);
}
