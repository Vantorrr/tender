import {
  addDailyProductionFact,
  getBootstrap,
  transferProcurementToProduction,
  updatePlanFact,
} from "@/server/repo";
import { withAnySection, json } from "@/server/http";
import type { DailyResourceLine, PlanFact } from "@/lib/types";
import { saveUpload } from "@/server/uploads";

const SECTIONS = ["proizvodstvo", "zakupki"] as const;

function parseResourceLines(raw: unknown): DailyResourceLine[] | undefined {
  if (raw == null || raw === "") return undefined;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const kind = String(r.kind ?? "other") as DailyResourceLine["kind"];
      return {
        kind:
          kind === "labor" ||
          kind === "material" ||
          kind === "equipment" ||
          kind === "bus" ||
          kind === "other"
            ? kind
            : "other",
        name: String(r.name ?? ""),
        unit: String(r.unit ?? ""),
        planQty: Number(r.planQty) || 0,
        factQty:
          r.factQty == null || r.factQty === ""
            ? null
            : Number(r.factQty) || 0,
      } satisfies DailyResourceLine;
    })
    .filter((x): x is DailyResourceLine => Boolean(x && x.name));
}

export async function GET(req: Request) {
  return withAnySection(req, [...SECTIONS], (user) =>
    json({ items: getBootstrap(user).data.planFacts })
  );
}

export async function PATCH(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const body = (await req.json()) as {
      id?: string;
      patch?: Partial<PlanFact>;
    };
    if (!body.id || !body.patch) {
      return json({ error: "Нужны id и patch" }, 400);
    }
    updatePlanFact(user.id, body.id, body.patch);
    return json(getBootstrap(user));
  });
}

export async function POST(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const planFactId = String(form.get("planFactId") ?? "");
      const date = String(form.get("date") ?? "");
      const workName = String(form.get("workName") ?? "");
      const unit = String(form.get("unit") ?? "ед");
      const quantity = Number(form.get("quantity") ?? 0);
      const factId = String(form.get("factId") ?? "") || undefined;
      if (!planFactId || !date || !workName) {
        return json({ error: "Нужны planFactId, date, workName" }, 400);
      }
      const photos: Array<{
        id: string;
        fileName: string;
        storedPath?: string;
        at: string;
        caption?: string;
      }> = [];
      const file = form.get("photo");
      if (file instanceof File && file.size > 0) {
        const buf = Buffer.from(await file.arrayBuffer());
        const id = `ph-${Date.now()}`;
        const stored = await saveUpload(id, file.name, buf);
        photos.push({
          id,
          fileName: file.name,
          storedPath: stored.storedPath,
          at: new Date().toISOString(),
          caption: String(form.get("caption") ?? "") || undefined,
        });
      }
      addDailyProductionFact(user.id, planFactId, {
        date,
        workName,
        unit,
        quantity,
        factId,
        people: form.get("people") ? Number(form.get("people")) : undefined,
        equipment: String(form.get("equipment") ?? "") || undefined,
        materialsNote: String(form.get("materialsNote") ?? "") || undefined,
        resourceLines: parseResourceLines(form.get("resourceLines")),
        comment:
          String(form.get("comment") ?? form.get("caption") ?? "") ||
          undefined,
        photos,
      });
      return json(getBootstrap(user));
    }

    const body = (await req.json()) as {
      action?: "transferToProduction" | "dailyFact";
      procurementId?: string;
      planFactId?: string;
      fact?: {
        date: string;
        workName: string;
        unit: string;
        quantity: number;
        people?: number;
        equipment?: string;
        materialsNote?: string;
        resourceLines?: DailyResourceLine[];
        comment?: string;
        factId?: string;
      };
    };
    if (body.action === "transferToProduction" && body.procurementId) {
      transferProcurementToProduction(user.id, body.procurementId);
      return json(getBootstrap(user));
    }
    if (body.action === "dailyFact" && body.planFactId && body.fact) {
      addDailyProductionFact(user.id, body.planFactId, body.fact);
      return json(getBootstrap(user));
    }
    return json({ error: "Некорректный запрос" }, 400);
  });
}
