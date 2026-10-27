import { getBootstrap } from "@/server/repo";
import { getJobs } from "@/server/jobs";
import { withUser, json } from "@/server/http";

export async function GET(req: Request) {
  return withUser(req, (user) => {
    const payload = getBootstrap(user);
    return json({ ...payload, jobs: getJobs() });
  });
}
