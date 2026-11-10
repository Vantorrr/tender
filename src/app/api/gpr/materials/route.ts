import { parseClientMaterialsXlsx } from "@/server/export";
import { getBootstrap, updateSchedule } from "@/server/repo";
import { withAnySection, json } from "@/server/http";
import { config } from "@/server/config";

const SECTIONS = ["gpr", "raschety"] as const;
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");

export async function POST(req: Request) {
  return withAnySection(req, [...SECTIONS], async (user) => {
    const form = await req.formData();
    const file = form.get("file");
    const scheduleId = String(form.get("scheduleId") ?? "");
    if (!(file instanceof File) || !scheduleId) {
      return json({ error: "Передайте XLSX и ГПР" }, 400);
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return json({ error: "Нужен файл XLSX из клиентского шаблона" }, 415);
    }
    if (file.size > config.maxUploadBytes) {
      return json({ error: `Файл слишком большой (лимит ${Math.round(config.maxUploadBytes / (1024 * 1024))} МБ)` }, 413);
    }
    const schedule = getBootstrap(user).data.schedules.find((item) => item.id === scheduleId);
    if (!schedule) return json({ error: "ГПР не найден" }, 404);

    let rows;
    try {
      rows = await parseClientMaterialsXlsx(Buffer.from(await file.arrayBuffer()));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Не удалось прочитать лист «Материалы»" }, 422);
    }
    const stagesByName = new Map<string, typeof schedule.stages>();
    for (const stage of schedule.stages) {
      for (const name of [stage.workName, stage.name].filter((x): x is string => Boolean(x))) {
        const key = normalize(name);
        const matches = stagesByName.get(key) ?? [];
        if (!matches.some((item) => item.id === stage.id)) stagesByName.set(key, [...matches, stage]);
      }
    }
    const unmatched = [...new Set(rows.filter((row) => (stagesByName.get(normalize(row.workName)) ?? []).length !== 1).map((row) => row.workName))];
    if (unmatched.length) {
      return json({
        error: `Не все работы однозначно совпали с ГПР: ${unmatched.slice(0, 5).join("; ")}${unmatched.length > 5 ? ` и ещё ${unmatched.length - 5}` : ""}. Исправьте название или связь работы и повторите импорт.`,
        unmatched,
        imported: 0,
      }, 422);
    }

    const prefix = `client-material:${scheduleId}:`;
    const resourcesByStage = new Map(schedule.stages.map((stage) => [stage.id, (stage.resources ?? []).filter((r) => !r.sourceKey?.startsWith(prefix))]));
    for (const row of rows) {
      const stage = stagesByName.get(normalize(row.workName))![0];
      resourcesByStage.get(stage.id)!.push({
        id: `${prefix}${row.sourceRow}`,
        sourceKey: `${prefix}${row.sourceRow}`,
        kind: "material",
        name: row.materialName,
        quantity: row.quantity,
        unit: row.unit,
        rate: row.rate,
        quantityBasis: "material_qty",
      });
    }
    updateSchedule(user.id, schedule.id, {
      stages: schedule.stages.map((stage) => ({ ...stage, resources: resourcesByStage.get(stage.id) ?? [] })),
    });
    return json({ imported: rows.length, stages: new Set(rows.map((row) => stagesByName.get(normalize(row.workName))![0].id)).size });
  });
}
