import { getJobs, runProcurementSync, runReanalyzePipeline } from "@/server/jobs";
import { getBootstrap } from "@/server/repo";
import { json, requireUser } from "@/server/http";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return json({ jobs: getJobs() });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const body = (await req.json()) as {
    type: "procurement_sync" | "document_reanalyze";
    documentId?: string;
  };
  if (body.type === "procurement_sync") {
    const result = runProcurementSync(auth.user.id);
    return json({ ...getBootstrap(auth.user), jobs: result.jobs, jobId: result.jobId });
  }
  if (body.type === "document_reanalyze" && body.documentId) {
    const result = runReanalyzePipeline(auth.user.id, body.documentId);
    return json({ ...getBootstrap(auth.user), jobs: result.jobs, jobId: result.jobId });
  }
  return json({ error: "Неизвестный тип задания" }, 400);
}
