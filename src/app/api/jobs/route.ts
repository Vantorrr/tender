import {
  getJobs,
  runProcurementSync,
  runReanalyzePipeline,
} from "@/server/jobs";
import { getBootstrap } from "@/server/repo";
import { withUser, json } from "@/server/http";

export async function GET(req: Request) {
  return withUser(req, () => json({ jobs: getJobs() }));
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      type?: "procurement_sync" | "document_reanalyze";
      documentId?: string;
    };
    if (body.type === "procurement_sync") {
      const result = runProcurementSync(user.id);
      return json({
        ...getBootstrap(user),
        jobs: result.jobs,
        jobId: result.jobId,
      });
    }
    if (body.type === "document_reanalyze" && body.documentId) {
      const result = runReanalyzePipeline(user.id, body.documentId);
      return json({
        ...getBootstrap(user),
        jobs: result.jobs,
        jobId: result.jobId,
      });
    }
    return json({ error: "Неизвестный тип задания" }, 400);
  });
}
