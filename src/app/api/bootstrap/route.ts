import { getBootstrap } from "@/server/repo";
import { json, requireUser } from "@/server/http";
import { getJobs } from "@/server/jobs";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const payload = getBootstrap(auth.user);
  return json({ ...payload, jobs: getJobs() });
}
