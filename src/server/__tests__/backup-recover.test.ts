import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, resetAppData } from "@/server/db";
import { config, dbPath } from "@/server/config";
import {
  clearMailInbox,
  getMailInbox,
  resetMailTransport,
} from "@/server/mail";
import { recoveryToken } from "@/server/auth";
import { POST as recoverPost } from "@/app/api/auth/recover/route";

beforeAll(() => {
  ensureReady();
  resetAppData();
  resetMailTransport();
  clearMailInbox();
});

afterAll(() => {
  closeDb();
});

describe("password recovery + test mail", () => {
  it("sends mail with recovery code and does not echo password in body", async () => {
    clearMailInbox();
    const res = await recoverPost(
      new Request("http://127.0.0.1/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "tender@alfastroy.ru" }),
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      message: string;
      code?: string;
      demoPassword?: string;
      password?: string;
    };
    expect(json.message).toMatch(/отправлен/i);
    expect(json.demoPassword).toBeUndefined();
    expect(json.password).toBeUndefined();
    const inbox = getMailInbox();
    expect(inbox.length).toBe(1);
    const expected = recoveryToken("tender@alfastroy.ru");
    expect(inbox[0].text).toContain(expected);
    expect(inbox[0].text.toLowerCase()).not.toContain("super123");
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
