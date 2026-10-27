import { NextResponse } from "next/server";
import { getBootstrap, resetDemo } from "@/server/repo";
import { getJobs } from "@/server/jobs";
import { readAppData } from "@/server/db";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { withUser, json } from "@/server/http";

export async function GET(req: Request) {
  return withUser(req, (user) => {
    if (user.role !== "superadmin" && user.role !== "admin") {
      return json({ error: "Недостаточно прав" }, 403);
    }
    const boot = getBootstrap(user);
    return json({
      organizations: boot.data.organizations,
      auditLog: boot.data.auditLog,
      jobs: getJobs(),
    });
  });
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    if (user.role !== "superadmin") {
      return json({ error: "Только суперадмин" }, 403);
    }
    const body = (await req.json()) as { action?: string };
    if (body.action === "reset") {
      const { token, actorId } = resetDemo(user.id);
      const fresh =
        readAppData().users.find((u) => u.id === actorId) ??
        readAppData().users.find((u) => u.role === "superadmin");
      if (!fresh) {
        return json({ error: "Не удалось восстановить сессию после сброса" }, 500);
      }
      const boot = getBootstrap(fresh);
      const res = NextResponse.json({ ...boot, jobs: getJobs(), token });
      res.cookies.set(
        SESSION_COOKIE,
        token,
        sessionCookieOptions(60 * 60 * 24 * 7)
      );
      return res;
    }
    return json({ ...getBootstrap(user), jobs: getJobs() });
  });
}
