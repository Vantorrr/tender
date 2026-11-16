import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth";
import { closeDb, ensureReady, readAppData } from "@/server/db";
import { analyzeUpload } from "@/server/grand-smeta";
import { buildHierarchicalEstimate } from "@/lib/hierarchical-estimate";
import { createManualProcurement, reanalyzeDocument } from "@/server/repo";
import { detectArchiveFormat } from "@/server/safe-archive";
import "./setup";

describe("manual procurement file upload", () => {
  beforeEach(() => {
    closeDb();
    ensureReady();
  });

  it("keeps a file in the procurement card even when its workbook format cannot be read", async () => {
    const procurement = readAppData().procurements.find((item) => item.orgId === "org-alfa")!;
    const form = new FormData();
    form.set("procurementId", procurement.id);
    form.set("category", "estimate");
    form.set("file", new File(["not an xlsx workbook"], "broken.xlsx"));
    const { POST } = await import("@/app/api/dokumenty/route");
    const response = await POST(new Request("http://local/api/dokumenty", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: form,
    }));

    expect(response.status).toBe(200);
    const uploaded = readAppData().documents.find((document) => document.procurementId === procurement.id && document.fileName === "broken.xlsx");
    expect(uploaded).toMatchObject({
      status: "trebuet_proverki",
    });
    expect(uploaded?.storedPath).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.DATA_DIR!, uploaded!.storedPath!))).toBe(true);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)?.analytics).toBeTruthy();
  });

  it("extracts citations and material rows from a normal client XLSX workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Материалы");
    sheet.getRow(3).values = ["Заказчик", "АО Северная дорога", "Срок подачи", "30.11.2026"];
    sheet.getRow(14).values = [
      "Работа ГПР", "Раздел", "Код ВОР", "Подраздел", "Наименование работы",
      "Материал / конструкция", "Кол-во по ВОР", "Ед. ВОР", "Кол-во для цены",
      "Ед. цены", "Цена за ед., руб.", "Стоимость МТР, руб.", "Новая стоимость материалов",
    ];
    sheet.getRow(15).values = ["Отсыпка грунта", "АД", "АД-02", "Земляное полотно", "Устройство основания", "Щебень С4", 10, "м³", 14, "т", 2400, 33600, 36960];
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(detectArchiveFormat("client-materials.xlsx", bytes)).toBe("none");
    expect(detectArchiveFormat("client-pack.zip", bytes)).toBe("zip");
    const analysis = await analyzeUpload("client-materials.xlsx", "xlsx", bytes);

    expect(analysis.citations.some((citation) => citation.sheet === "Материалы" && citation.cell?.includes("15"))).toBe(true);
    expect(analysis.positions).toContainEqual({ code: "АД-02", name: "Щебень С4", unit: "т", quantity: 14, rate: 2400 });
    expect(analysis.analysis.profileMatch).toBe(false);
    expect(analysis.analyticalNote).toMatch(/Книга прочитана как обычный Excel/);

    const procurement = readAppData().procurements.find((item) => item.orgId === "org-alfa")!;
    const form = new FormData();
    form.set("procurementId", procurement.id);
    form.set("category", "estimate");
    form.set("file", new File([bytes], "client-materials.xlsx"));
    const { POST } = await import("@/app/api/dokumenty/route");
    const response = await POST(new Request("http://local/api/dokumenty", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-super")}` },
      body: form,
    }));
    expect(response.status).toBe(200);
    const uploaded = readAppData().documents.find((document) => document.procurementId === procurement.id && document.fileName === "client-materials.xlsx");
    expect(uploaded?.citations.some((citation) => citation.sheet === "Материалы")).toBe(true);
    expect(uploaded?.estimatePositions).toHaveLength(1);
    expect(readAppData().procurements.find((item) => item.id === procurement.id)?.analytics?.citations.length).toBeGreaterThan(0);
  });

  it("builds sectioned GPR resources from a real Grand Smeta estimate without copying its rates", async () => {
    const procurement = createManualProcurement("u-tender", {
      title: "Приёмочная проверка разбора сметы",
      region: "ЯНАО",
    });
    const fileName = "ls-01-02-01-demontazh.xlsx";
    const bytes = fs.readFileSync(path.join(process.cwd(), "fixtures/grand-smeta", fileName));
    const prepared = await analyzeUpload(fileName, "xlsx", bytes);
    const form = new FormData();
    form.set("procurementId", procurement.id);
    form.set("category", "general");
    form.set("file", new File([bytes], fileName));
    const { POST: upload } = await import("@/app/api/dokumenty/route");
    const uploaded = await upload(new Request("http://local/api/dokumenty", {
      method: "POST",
      headers: { authorization: `Bearer ${createSession("u-tender")}` },
      body: form,
    }));
    expect(uploaded.status).toBe(200);

    const document = readAppData().documents.find((item) => item.procurementId === procurement.id && item.fileName === fileName)!;
    expect(document.estimatePositions?.some((position) => position.sectionName)).toBe(true);
    expect(document.estimatePositions?.some((position) => position.workName)).toBe(true);

    const { POST: zakupkiPost } = await import("@/app/api/zakupki/route");
    const sent = await zakupkiPost(new Request("http://local/api/zakupki", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession("u-tender")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "sendToCalculation", id: procurement.id }),
    }));
    expect(sent.status).toBe(200);

    const after = readAppData();
    const savedProcurement = after.procurements.find((item) => item.id === procurement.id)!;
    const schedule = after.schedules.find((item) => item.id === savedProcurement.gprId)!;
    const draft = after.calculations.find((item) => item.id === savedProcurement.calculationId)!;
    const saw = schedule.stages.flatMap((stage) => stage.resources ?? []).find((resource) => /пил[аы].*карбюраторн/i.test(resource.name));
    expect(schedule.stages.length).toBeGreaterThan(1);
    expect(schedule.stages.some((stage) => /^Раздел \d+/i.test(stage.sectionName ?? ""))).toBe(true);
    expect(schedule.stages.some((stage) => Boolean(stage.workName))).toBe(true);
    expect(schedule.stages.some((stage) => Boolean(stage.planVolume && stage.planUnit))).toBe(true);
    const workPosition = draft.positions.find((position) => position.isWorkItem)!;
    expect(workPosition).toBeTruthy();
    const workStage = schedule.stages.find((stage) => stage.name === workPosition.name)!;
    expect(workStage).toMatchObject({ planVolume: workPosition.quantity, planUnit: workPosition.unit });
    expect(workStage.resources?.some((resource) => resource.sourceKey === workPosition.id)).toBe(false);
    expect(saw).toMatchObject({ kind: "equipment", quantityBasis: "total_hours", rate: null });
    expect(saw?.sourceKey).toBeTruthy();
    expect(schedule.stages.some((stage) => stage.resources?.some((resource) => resource.kind === "labor"))).toBe(true);
    expect(schedule.stages.some((stage) => stage.resources?.some((resource) => resource.kind === "material"))).toBe(true);

    const sawPositions = draft.positions.filter((position) => /пил[аы].*карбюраторн/i.test(position.name));
    expect(sawPositions.some((position) => position.sourceDocumentId === document.id && position.sourceWorkName)).toBe(true);
    expect(sawPositions.every((position) => position.rateMissing)).toBe(true);
    const tree = buildHierarchicalEstimate({ stages: schedule.stages, positions: draft.positions, params: draft.resourceScheduleParams });
    expect(tree.some((node) => node.id === "_unbound")).toBe(false);
    expect(tree.some((node) => node.groups.some((group) => group.leaves.some((leaf) => leaf.name === saw?.name)))).toBe(true);
    const displayedLeaves = tree.flatMap((node) => node.groups.flatMap((group) => group.leaves));
    expect(displayedLeaves.every((leaf) => !/^(?:ЕНИР|ФЕР|ТЕР|ГЭСН)/iu.test(leaf.name))).toBe(true);

    const firstCount = draft.positions.length;
    reanalyzeDocument("u-tender", document.id, prepared);
    const repeatedSend = await zakupkiPost(new Request("http://local/api/zakupki", {
      method: "POST",
      headers: {
        authorization: `Bearer ${createSession("u-tender")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "sendToCalculation", id: procurement.id }),
    }));
    expect(repeatedSend.status).toBe(200);
    const afterReanalysis = readAppData();
    const refreshedDraft = afterReanalysis.calculations.find((item) => item.id === savedProcurement.calculationId)!;
    expect(refreshedDraft.positions).toHaveLength(firstCount);
  });
});
