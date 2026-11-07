import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/server/db";
import {
  SmtpMailTransport,
  clearMailInbox,
  getMailInbox,
  setMailTransport,
  resetMailTransport,
} from "@/server/mail";
import { startLocalSmtpSink, type SmtpSinkHandle } from "@/server/smtp-sink";
import { issueRecoveryCode } from "@/server/auth";
import { sendMail } from "@/server/mail";

let sink: SmtpSinkHandle;

beforeAll(async () => {
  ensureReady();
  sink = await startLocalSmtpSink(2526);
  setMailTransport(
    new SmtpMailTransport(
      {
        host: "127.0.0.1",
        port: sink.port,
        secure: false,
        from: "test@localhost",
      },
      "smtp-sink"
    )
  );
  process.env.SMTP_TLS_REJECT = "0";
});

afterAll(async () => {
  resetMailTransport();
  clearMailInbox();
  await sink.close();
});

describe("local SMTP sink (no humans)", () => {
  it("delivers recovery mail over real SMTP protocol to loopback sink", async () => {
    clearMailInbox();
    const code = issueRecoveryCode("tender@alfastroy.ru");
    await sendMail({
      to: "tender@alfastroy.ru",
      subject: "Восстановление доступа — истройка",
      text: `Код восстановления: ${code}`,
    });
    // Allow smtp-server onData to finish
    await new Promise((r) => setTimeout(r, 200));
    const msgs = sink.messages();
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].to).toMatch(/tender@alfastroy\.ru/i);
    expect(msgs[0].text).toContain(code);
    expect(getMailInbox().length).toBeGreaterThanOrEqual(1);
  });
});
