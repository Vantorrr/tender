/**
 * Mail transport boundary for password recovery and system notices.
 * Default: memory (captures messages for tests / isolated demos).
 * Set MAIL_TRANSPORT=console|smtp|memory. SMTP without host falls back to memory.
 * Never logs raw passwords — only opaque recovery codes.
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  at: string;
};

export interface MailTransport {
  readonly id: string;
  send(message: Omit<MailMessage, "at">): Promise<{ ok: boolean; transport: string }>;
}

const inbox: MailMessage[] = [];

export class MemoryMailTransport implements MailTransport {
  readonly id = "memory";

  async send(message: Omit<MailMessage, "at">) {
    inbox.push({ ...message, at: new Date().toISOString() });
    return { ok: true, transport: this.id };
  }
}

export class ConsoleMailTransport implements MailTransport {
  readonly id = "console";

  async send(message: Omit<MailMessage, "at">) {
    inbox.push({ ...message, at: new Date().toISOString() });
    console.info(
      `[mail:${this.id}] to=${message.to} subject=${JSON.stringify(message.subject)}`
    );
    return { ok: true, transport: this.id };
  }
}

/**
 * SMTP placeholder: requires SMTP_HOST. Without it, refuses and callers
 * should fall back — we never invent credentials or hit a real relay in CI.
 */
export class SmtpMailTransport implements MailTransport {
  readonly id = "smtp";

  async send(message: Omit<MailMessage, "at">) {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) {
      throw new Error("SMTP не сконфигурирован (нет SMTP_HOST)");
    }
    // Real nodemailer/SMTP relay is kickoff-blocked; record intent only.
    inbox.push({
      ...message,
      text: `[smtp-queued via ${host}] ${message.text}`,
      at: new Date().toISOString(),
    });
    return { ok: true, transport: this.id };
  }
}

function createDefaultTransport(): MailTransport {
  const mode = (process.env.MAIL_TRANSPORT ?? "memory").toLowerCase();
  if (mode === "console") return new ConsoleMailTransport();
  if (mode === "smtp") {
    if (process.env.SMTP_HOST?.trim()) return new SmtpMailTransport();
    return new MemoryMailTransport();
  }
  return new MemoryMailTransport();
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

export async function sendMail(message: Omit<MailMessage, "at">) {
  return getMailTransport().send(message);
}
