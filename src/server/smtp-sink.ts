/**
 * Local SMTP sink for integration tests — accepts mail on loopback, never relays
 * to real humans. Pair with SmtpMailTransport(host=127.0.0.1, port=…).
 */

import fs from "node:fs";
import path from "node:path";
import { SMTPServer } from "smtp-server";
import { config } from "@/server/config";
import type { MailMessage } from "@/server/mail";

export type SmtpSinkHandle = {
  port: number;
  host: string;
  close: () => Promise<void>;
  messages: () => MailMessage[];
};

const captured: MailMessage[] = [];

function header(raw: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = raw.match(re);
  return m?.[1]?.trim() ?? "";
}

function decodeBody(raw: string): string {
  const parts = raw.split(/\r?\n\r?\n/);
  const head = parts[0] ?? "";
  let body = parts.slice(1).join("\n\n");
  const encoding = header(head, "Content-Transfer-Encoding").toLowerCase();
  if (encoding.includes("base64")) {
    try {
      body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      /* keep raw */
    }
  } else if (encoding.includes("quoted-printable")) {
    body = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      );
  }
  return body || raw;
}

function persist(msg: MailMessage) {
  captured.unshift(msg);
  const dir = path.join(config.dataDir, "mail-sink");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "latest.json"),
    JSON.stringify({ ...msg, via: "smtp-sink" }, null, 2),
    "utf8"
  );
}

export async function startLocalSmtpSink(
  port = Number(process.env.SMTP_SINK_PORT ?? 2525)
): Promise<SmtpSinkHandle> {
  captured.length = 0;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c)));
      stream.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const head = raw.split(/\r?\n\r?\n/)[0] ?? "";
          persist({
            to: header(head, "To"),
            subject: header(head, "Subject"),
            text: decodeBody(raw),
            at: new Date().toISOString(),
            id: `sink-${Date.now()}`,
          });
          callback();
        } catch (e) {
          callback(e as Error);
        }
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", (err?: Error) =>
      err ? reject(err) : resolve()
    );
  });

  return {
    port,
    host: "127.0.0.1",
    messages: () => [...captured],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
