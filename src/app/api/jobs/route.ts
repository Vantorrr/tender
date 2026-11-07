import {
  getJobs,
  runProcurementSync,
  runReanalyzePipeline,
} from "@/server/jobs";
import { assertSection } from "@/server/acl";
import { getBootstrap } from "@/server/repo";
import { withUser, json } from "@/server/http";

export async function GET(req: Request) {
  return withUser(req, (user) => {
    // Jobs list is visible to admin section; others get empty for least privilege.
    try {
      assertSection(user, "admin");
    } catch {
      return json({ jobs: [] });
    }
    return json({ jobs: getJobs() });
  });
}

export async function POST(req: Request) {
  return withUser(req, async (user) => {
    const body = (await req.json()) as {
      type?: "procurement_sync" | "document_reanalyze";
      documentId?: string;
      /** Explicit paid model refine — off unless client opts in. */
      useLlm?: boolean;
    };
    if (body.type === "procurement_sync") {
      assertSection(user, "zakupki");
      const result = await runProcurementSync(user.id);
      return json({
        ...getBootstrap(user),
        jobs: result.jobs,
        jobId: result.jobId,
        feed: result.feed
          ? {
              status: result.feed.status,
              stub: result.feed.stub,
              detail: result.feed.detail,
              insertedHint: result.feed.notices.length,
            }
          : undefined,
      });
    }
    if (body.type === "document_reanalyze" && body.documentId) {
      assertSection(user, "dokumenty");
      const result = await runReanalyzePipeline(user.id, body.documentId, {
        useLlm: Boolean(body.useLlm),
      });
      return json({
        ...getBootstrap(user),
        jobs: result.jobs,
        jobId: result.jobId,
      });
    }
    return json({ error: "Неизвестный тип задания" }, 400);
  });
}
