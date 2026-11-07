import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearMailInbox,
  clearMailSink,
  FileMailTransport,
  getMailInbox,
  readMailSinkLatest,
  resetMailTransport,
  setMailTransport,
} from "@/server/mail";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { config, dbPath } from "@/server/config";
import { verifyPassword } from "@/server/passwords";
import { POST as recoverPost } from "@/app/api/auth/recover/route";

beforeAll(() => {
  ensureReady();
  resetAppData();
  resetMailTransport();
  clearMailInbox();
  clearMailSink();
});

afterAll(() => {
  closeDb();
});

describe("password recovery + mail sink", () => {
  it("memory transport: request → code in inbox → reset → login hash changes", async () => {
    clearMailInbox();
    const req = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "tender@alfastroy.ru",
          action: "request",
        }),
      })
    );
    expect(req.status).toBe(200);
    const body = (await req.json()) as { message: string; code?: string };
    expect(body.message).toMatch(/отправлен/i);
    expect(body.code).toBeUndefined(); // not exposed by default
    const inbox = getMailInbox();
    expect(inbox.length).toBe(1);
    const match = inbox[0].text.match(/Код восстановления:\s*([a-f0-9]+)/i);
    expect(match?.[1]).toBeTruthy();
    const code = match![1];
    expect(inbox[0].text.toLowerCase()).not.toMatch(/tender123|password\s*[:=]/);

    const newPassword = "IsolatedRecover9!";
    const reset = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "tender@alfastroy.ru",
          action: "reset",
          code,
          newPassword,
        }),
      })
    );
    expect(reset.status).toBe(200);
    const user = readAppData().users.find(
      (u) => u.email === "tender@alfastroy.ru"
    )!;
    expect(verifyPassword(newPassword, user.password ?? "")).toBe(true);
    expect(verifyPassword("Tender123!", user.password ?? "")).toBe(false);

    // restore demo password for other tests / e2e
    const restoreCodeReq = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "tender@alfastroy.ru",
          action: "request",
        }),
      })
    );
    expect(restoreCodeReq.status).toBe(200);
    const code2 = getMailInbox()[0].text.match(
      /Код восстановления:\s*([a-f0-9]+)/i
    )![1];
    await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "tender@alfastroy.ru",
          action: "reset",
          code: code2,
          newPassword: "Tender123!",
        }),
      })
    );
  });

  it("file mail sink writes latest.json without sending to humans", async () => {
    clearMailSink();
    setMailTransport(new FileMailTransport());
    const res = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "smeta@alfastroy.ru",
          action: "request",
        }),
      })
    );
    expect(res.status).toBe(200);
    const latest = readMailSinkLatest();
    expect(latest?.to).toBe("smeta@alfastroy.ru");
    expect(latest?.text).toMatch(/Код восстановления/);
    const sinkDir = path.join(config.dataDir, "mail-sink");
    expect(fs.existsSync(path.join(sinkDir, "latest.json"))).toBe(true);
    resetMailTransport();
  });

  it("unknown email returns generic ok without mail", async () => {
    clearMailInbox();
    const res = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.test" }),
      })
    );
    expect(res.status).toBe(200);
    expect(getMailInbox()).toHaveLength(0);
  });
});

describe("backup / restore scripts (isolated DB)", () => {
  it("round-trips the test sqlite file", () => {
    const db = dbPath();
    expect(fs.existsSync(db)).toBe(true);
    const out = path.join(config.dataDir, `test-backup-${process.pid}`);
    fs.rmSync(out, { recursive: true, force: true });

    closeDb();
    execFileSync(process.execPath, ["scripts/backup-db.mjs", "--out", out], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: "data",
        DB_FILE: path.basename(db),
      },
      encoding: "utf8",
    });
    expect(fs.existsSync(path.join(out, path.basename(db)))).toBe(true);
    expect(fs.existsSync(path.join(out, "manifest.json"))).toBe(true);

    const before = fs.readFileSync(db);
    fs.writeFileSync(db, Buffer.concat([before, Buffer.from("x")]));
    execFileSync(process.execPath, ["scripts/restore-db.mjs", out], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: "data",
        DB_FILE: path.basename(db),
      },
      encoding: "utf8",
    });
    const after = fs.readFileSync(db);
    expect(after.equals(before)).toBe(true);
    fs.rmSync(out, { recursive: true, force: true });
    ensureReady();
  });
});
