import {
  getJobs,
  runProcurementSync,
  runReanalyzePipeline,
} from "@/server/jobs";
import { assertSection } from "@/server/acl";
import { getBootstrap } from "@/server/repo";
import { withUser, json } from "@/server/http";
import { getProcurementSource, KonturProcurementSource, validateKonturSearchFilters } from "@/server/procurement-source";

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
      /** Optional full Kontur search filter set; each result page is an API call. */
      filters?: unknown;
    };
    if (body.type === "procurement_sync") {
      assertSection(user, "zakupki");
      let filters;
      if (body.filters != null) {
        if (!(getProcurementSource() instanceof KonturProcurementSource)) {
          return json({ error: "Расширенные фильтры доступны, когда подключён поиск закупок" }, 409);
        }
        try {
          filters = validateKonturSearchFilters(body.filters);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Некорректные фильтры поиска" }, 400);
        }
      }
      const result = await runProcurementSync(user.id, filters);
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
