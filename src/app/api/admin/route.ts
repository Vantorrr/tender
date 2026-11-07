import { NextResponse } from "next/server";
import {
  getBootstrap,
  resetDemo,
  setOrganizationActive,
} from "@/server/repo";
import { getJobs } from "@/server/jobs";
import { readAppData } from "@/server/db";
import { importClientDirectories } from "@/server/client-import";
import { clearClientImportFlag, markClientImportDone } from "@/server/db";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth";
import { withSection, json } from "@/server/http";

export async function GET(req: Request) {
  return withSection(req, "admin", (user) => {
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
  return withSection(req, "admin", async (user) => {
    if (user.role !== "superadmin" && user.role !== "admin") {
      return json({ error: "Недостаточно прав" }, 403);
    }
    const body = (await req.json()) as {
      action?: string;
      orgId?: string;
      active?: boolean;
    };

    if (body.action === "setOrgActive" && body.orgId && typeof body.active === "boolean") {
      if (user.role !== "superadmin") {
        return json({ error: "Только суперадмин" }, 403);
      }
      setOrganizationActive(user.id, body.orgId, body.active);
      return json({
        ...getBootstrap(user),
        jobs: getJobs(),
      });
    }

    if (body.action === "importClientXlsx") {
      if (user.role !== "superadmin" && user.role !== "admin") {
        return json({ error: "Недостаточно прав" }, 403);
      }
      const result = await importClientDirectories(user.id);
      markClientImportDone();
      return json({
        ...getBootstrap(user),
        jobs: getJobs(),
        importResult: result,
      });
    }

    if (body.action === "reset") {
      if (user.role !== "superadmin") {
        return json({ error: "Только суперадмин" }, 403);
      }
      const { token, actorId } = resetDemo(user.id);
      clearClientImportFlag();
      let importResult: Awaited<
        ReturnType<typeof importClientDirectories>
      > | null = null;
      try {
        importResult = await importClientDirectories(actorId);
        markClientImportDone();
      } catch (err) {
        console.error("[tk] client xlsx after reset failed", err);
      }
      const fresh =
        readAppData().users.find((u) => u.id === actorId) ??
        readAppData().users.find((u) => u.role === "superadmin");
      if (!fresh) {
        return json(
          { error: "Не удалось восстановить сессию после сброса" },
          500
        );
      }
      const boot = getBootstrap(fresh);
      const res = NextResponse.json({
        ...boot,
        jobs: getJobs(),
        token,
        importResult,
      });
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
