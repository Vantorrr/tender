/**
 * Mail transport for password recovery.
 * - memory: in-process inbox (unit tests)
 * - file: local sink under DATA_DIR/mail-sink
 * - console: log + memory
 * - smtp: real SMTP via nodemailer (SMTP_HOST required)
 * - smtp-sink: connect to a local smtp-server sink (tests; no humans)
 * Never puts passwords in mail — only opaque recovery codes.
 */

import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
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

/** Writes JSON messages under data/mail-sink — local/test only. */
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
    fs.writeFileSync(
      path.join(this.sinkDir(), "latest.json"),
      JSON.stringify(full, null, 2),
      "utf8"
    );
    return { ok: true, transport: this.id, id };
  }
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

export function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASS?.trim() || undefined,
    from:
      process.env.SMTP_FROM?.trim() ||
      process.env.SMTP_USER?.trim() ||
      "noreply@localhost",
  };
}

/** Real SMTP via nodemailer — used for prod config and local smtp-sink tests. */
export class SmtpMailTransport implements MailTransport {
  readonly id: string;
  private readonly cfg: SmtpConfig;

  constructor(cfg: SmtpConfig, id = "smtp") {
    this.cfg = cfg;
    this.id = id;
  }

  async send(message: Omit<MailMessage, "at" | "id">) {
    const transporter = nodemailer.createTransport({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth:
        this.cfg.user && this.cfg.pass
          ? { user: this.cfg.user, pass: this.cfg.pass }
          : undefined,
      tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT !== "0" },
    });
    const info = await transporter.sendMail({
      from: this.cfg.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    const full: MailMessage = {
      ...message,
      at: new Date().toISOString(),
      id: String(info.messageId || `smtp-${Date.now()}`),
    };
    pushInbox(full);
    // Mirror to file sink for local observability (never replaces SMTP send).
    if (process.env.SMTP_MIRROR_FILE === "1") {
      const dir = path.join(config.dataDir, "mail-sink");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "latest.json"),
        JSON.stringify({ ...full, via: this.id }, null, 2)
      );
    }
    return { ok: true, transport: this.id, id: full.id };
  }
}

function createDefaultTransport(): MailTransport {
  const mode = (process.env.MAIL_TRANSPORT ?? "file").toLowerCase();
  if (mode === "memory") return new MemoryMailTransport();
  if (mode === "console") return new ConsoleMailTransport();
  if (mode === "file") return new FileMailTransport();
  if (mode === "smtp" || mode === "smtp-sink") {
    const cfg = readSmtpConfig();
    if (!cfg) {
      if (mode === "smtp-sink") {
        throw new Error(
          "MAIL_TRANSPORT=smtp-sink требует SMTP_HOST (локальный sink, напр. 127.0.0.1)"
        );
      }
      return new FileMailTransport();
    }
    return new SmtpMailTransport(
      cfg,
      mode === "smtp-sink" ? "smtp-sink" : "smtp"
    );
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
