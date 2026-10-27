import { getBootstrap, resetDemo } from "@/server/repo";
import { getJobs } from "@/server/jobs";
import { json, requireUser } from "@/server/http";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "superadmin" && auth.user.role !== "admin") {
    return json({ error: "Недостаточно прав" }, 403);
  }
  const boot = getBootstrap(auth.user);
  return json({
    organizations: boot.data.organizations,
    auditLog: boot.data.auditLog,
    jobs: getJobs(),
  });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "superadmin") {
    return json({ error: "Только суперадмин" }, 403);
  }
  const body = (await req.json()) as { action?: string };
  if (body.action === "reset") {
    resetDemo(auth.user.id);
  }
  return json({ ...getBootstrap(auth.user), jobs: getJobs() });
}
