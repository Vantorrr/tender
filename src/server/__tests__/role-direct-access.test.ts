import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, ensureReady, readAppData, resetAppData } from "@/server/db";
import { dbPath } from "@/server/config";
import { userHasSection } from "@/lib/acl";
import { DEFAULT_SECTIONS } from "@/lib/roles";
import {
  setUserSections,
  updateUser,
  getBootstrap,
} from "@/server/repo";
import { createSession, getUserIdByToken } from "@/server/auth";
import type { User } from "@/lib/types";
import { GET as getDengi } from "@/app/api/dengi/route";
import { GET as getZakupki } from "@/app/api/zakupki/route";
import { GET as getRaschety } from "@/app/api/raschety/route";

beforeAll(() => {
  ensureReady();
  resetAppData();
});

afterAll(() => {
  closeDb();
  const p = dbPath();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = `${p}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function byEmail(email: string): User {
  const u = readAppData().users.find((x) => x.email === email);
  if (!u) throw new Error(email);
  return u;
}

function authReq(token: string, url: string) {
  return new Request(url, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("6-role matrix — direct API after revoke/block", () => {
  it("after revoke dengi, direct /api/dengi is 403 even with valid session", async () => {
    const admin = byEmail("admin@alfastroy.ru");
    const tender = byEmail("tender@alfastroy.ru");
    setUserSections(admin.id, tender.id, [
      ...DEFAULT_SECTIONS.tender,
      "dengi",
    ]);
    const token = createSession(tender.id);
    expect(getUserIdByToken(token)).toBe(tender.id);
    const ok = await getDengi(authReq(token, "http://127.0.0.1/api/dengi"));
    expect(ok.status).toBe(200);

    setUserSections(admin.id, tender.id, [...DEFAULT_SECTIONS.tender]);
    // Session still valid, section revoked
    expect(getUserIdByToken(token)).toBe(tender.id);
    const fresh = byEmail("tender@alfastroy.ru");
    expect(userHasSection(fresh, "dengi")).toBe(false);
    const denied = await getDengi(authReq(token, "http://127.0.0.1/api/dengi"));
    expect(denied.status).toBe(403);
  });

  it("blocked user: session token present but API dengi/zakupki see 401 via requireUser", async () => {
    const admin = byEmail("admin@alfastroy.ru");
    const ruk = byEmail("ruk@alfastroy.ru");
    const token = createSession(ruk.id);
    expect(getUserIdByToken(token)).toBe(ruk.id);
    updateUser(admin.id, ruk.id, { blocked: true });
    // userById in auth filters blocked → requireUser → 401
    const res = await getZakupki(authReq(token, "http://127.0.0.1/api/zakupki"));
    expect(res.status).toBe(401);
    updateUser(admin.id, ruk.id, { blocked: false });
    const ok = await getZakupki(authReq(token, "http://127.0.0.1/api/zakupki"));
    expect(ok.status).toBe(200);
  });

  it("smetchik direct zakupki API is 403; raschety allowed", async () => {
    const smet = byEmail("smeta@alfastroy.ru");
    const token = createSession(smet.id);
    const z = await getZakupki(authReq(token, "http://127.0.0.1/api/zakupki"));
    expect(z.status).toBe(403);
    const r = await getRaschety(
      authReq(token, "http://127.0.0.1/api/raschety")
    );
    expect(r.status).toBe(200);
  });

  it("section matrix matches UI gate helper for all 6 roles", () => {
    const checks: Array<[string, string, boolean]> = [
      ["super@tenderkontur.ru", "admin", true],
      ["ruk@alfastroy.ru", "dengi", true],
      ["tender@alfastroy.ru", "dengi", false],
      ["smeta@alfastroy.ru", "zakupki", false],
      ["object@alfastroy.ru", "raschety", false],
      ["admin@alfastroy.ru", "gpr", false],
    ];
    for (const [email, section, allowed] of checks) {
      expect(userHasSection(byEmail(email), section as never)).toBe(allowed);
    }
  });
});
