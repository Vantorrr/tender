import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  calculationTotals,
  positionLineSum,
} from "@/lib/calc-math";
import { readAppData } from "@/server/db";
import { estimateKey, parseGrandBuffer } from "@/server/grand-smeta";

export async function buildCalculationXlsx(calcId: string): Promise<Buffer> {
  const data = readAppData();
  const calc = data.calculations.find((c) => c.id === calcId);
  if (!calc) throw new Error("Расчёт не найден");

  const wb = new ExcelJS.Workbook();
  wb.creator = "истройка";
  const ws = wb.addWorksheet("Расчёт");
  ws.columns = [
    { header: "Код", key: "code", width: 22 },
    { header: "Наименование", key: "name", width: 42 },
    { header: "Ед.", key: "unit", width: 10 },
    { header: "Кол-во", key: "qty", width: 12 },
    { header: "Расценка", key: "rate", width: 14 },
    { header: "Сумма", key: "sum", width: 16 },
  ];
  ws.getRow(1).font = { bold: true };

  const factor = calc.scenarioFactor || 1;
  for (const p of calc.positions) {
    const sum = positionLineSum(p, factor);
    ws.addRow({
      code: p.code,
      name: p.name,
      unit: p.unit,
      qty: p.quantity,
      rate: p.rate,
      sum,
    });
  }
  const totals = calculationTotals(calc);
  const dir = data.directories.find((d) => d.id === calc.directoryVersionId);
  ws.addRow({});
  ws.addRow({ code: "Итого", sum: totals.total });
  ws.addRow({
    code: "Сценарий",
    name:
      calc.scenario === "optimisticheskiy"
        ? "Оптимистичный"
        : calc.scenario === "pessimisticheskiy"
          ? "Пессимистичный"
          : "Базовый",
    rate: calc.scenarioFactor,
  });
  ws.addRow({
    code: "Справочник",
    name: dir ? `${dir.name} v${dir.version}` : calc.directoryVersionId,
  });
  ws.addRow({ code: "Версия расчёта", name: String(calc.version ?? 1) });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function buildCalculationPdf(calcId: string): Promise<Buffer> {
  const data = readAppData();
  const calc = data.calculations.find((c) => c.id === calcId);
  if (!calc) throw new Error("Расчёт не найден");

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const draw = (text: string, size = 11, b = false) => {
    page.drawText(text, {
      x: 40,
      y,
      size,
      font: b ? bold : font,
      color: rgb(0.08, 0.14, 0.18),
    });
    y -= size + 8;
  };

  draw(`TenderKontur / Raschet ${calc.id}`, 14, true);
  draw(calc.title.replace(/[^\x00-\x7F]/g, "?"), 12, true);
  draw(`Scenario: ${calc.scenario} x${calc.scenarioFactor}`);
  draw(`Dir: ${(calc.directoryVersionId || "-").slice(0, 40)} v${calc.version ?? 1}`);
  y -= 6;
  const factor = calc.scenarioFactor || 1;
  for (const p of calc.positions) {
    const sum = positionLineSum(p, factor);
    const line = `${p.code} | ${p.quantity} x ${p.rate} = ${Math.round(sum)}`;
    draw(line.replace(/[^\x00-\x7F]/g, "?"), 9);
    if (y < 60) break;
  }
  const totals = calculationTotals(calc);
  draw(`TOTAL: ${Math.round(totals.total)} RUB`, 12, true);
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export async function buildMoneyXlsx(planId: string): Promise<Buffer> {
  const data = readAppData();
  const plan = data.moneyPlans.find((m) => m.id === planId);
  if (!plan) throw new Error("План не найден");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Деньги");
  ws.addRow(["Тип", "Название", "Сумма", "Дата", "Неделя", "Месяц", "Комментарий"]);
  ws.getRow(1).font = { bold: true };
  for (const p of plan.payments) {
    ws.addRow([p.type, p.title, p.amount, p.date, p.week, p.month, p.note ?? ""]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildGprXlsx(gprId: string): Promise<Buffer> {
  const data = readAppData();
  const g = data.schedules.find((s) => s.id === gprId);
  if (!g) throw new Error("ГПР не найден");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ГПР");
  ws.addRow([
    "Этап",
    "Начало",
    "Окончание",
    "Порядок",
    "Зависит от",
    "Тип связи",
    "Лаг дн.",
    "Чел.",
    "Ч/смена",
    "Смен/сут",
    "Ресурсы",
  ]);
  ws.getRow(1).font = { bold: true };
  for (const s of g.stages) {
    const res = (s.resources ?? [])
      .map((r) => `${r.kind}:${r.name}×${r.quantity}${r.unit ? r.unit : ""}`)
      .join("; ");
    ws.addRow([
      s.name,
      s.start,
      s.end,
      s.sequence,
      s.dependsOn ?? "",
      s.dependencyType ?? "",
      s.lagDays ?? 0,
      s.crewSize ?? "",
      s.hoursPerShift ?? g.calendar?.hoursPerShift ?? "",
      s.shiftsPerDay ?? g.calendar?.shiftsPerDay ?? "",
      res,
    ]);
  }
  const resSheet = wb.addWorksheet("Ресурсы");
  resSheet.addRow(["Этап", "Вид", "Название", "Кол-во", "Ед."]);
  resSheet.getRow(1).font = { bold: true };
  for (const s of g.stages) {
    for (const r of s.resources ?? []) {
      resSheet.addRow([s.name, r.kind, r.name, r.quantity, r.unit ?? ""]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildRisksXlsx(riskId: string): Promise<Buffer> {
  const data = readAppData();
  const r = data.risks.find((x) => x.id === riskId);
  if (!r) throw new Error("Реестр не найден");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Риски");
  ws.addRow(["Замечание", "Фрагмент", "Статус", "Критичность", "Решение"]);
  ws.getRow(1).font = { bold: true };
  for (const rem of r.remarks) {
    const statusRu = {
      otkryto: "Открыто",
      v_rabote: "В работе",
      zakryto: "Закрыто",
      prinyato: "Принято",
    }[rem.status];
    const severityRu = {
      low: "Низкая",
      medium: "Средняя",
      high: "Высокая",
    }[rem.severity];
    ws.addRow([
      rem.text,
      rem.sourceExcerpt,
      statusRu,
      severityRu,
      rem.decision ?? "",
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildPlanFactXlsx(id: string): Promise<Buffer> {
  const data = readAppData();
  const pf = data.planFacts.find((x) => x.id === id);
  if (!pf) throw new Error("План/факт не найден");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ПланФакт");
  ws.addRow(["Работа", "Ед.", "План", "Факт", "Отклонение", "Остаток договора"]);
  ws.getRow(1).font = { bold: true };
  for (const e of pf.entries) {
    ws.addRow([
      e.workName,
      e.unit,
      e.plan,
      e.fact,
      e.fact - e.plan,
      e.contractRemaining ?? "",
    ]);
  }
  if (pf.baselineEntries?.length) {
    const base = wb.addWorksheet("Baseline");
    base.addRow(["Работа", "Ед.", "План", "Факт", "Зафиксировано"]);
    base.getRow(1).font = { bold: true };
    for (const e of pf.baselineEntries) {
      base.addRow([e.workName, e.unit, e.plan, e.fact, pf.baselineAt ?? ""]);
    }
  }
  const daily = wb.addWorksheet("ЕжедневныйФакт");
  daily.addRow([
    "Дата",
    "Работа",
    "Ед.",
    "Кол-во",
    "Фото",
    "Автор",
    "Комментарий",
  ]);
  daily.getRow(1).font = { bold: true };
  for (const d of pf.dailyFacts ?? []) {
    daily.addRow([
      d.date,
      d.workName,
      d.unit,
      d.quantity,
      d.photos.map((p) => p.fileName).join("; "),
      d.authorId,
      d.comment ?? "",
    ]);
  }
  const pnl = wb.addWorksheet("PnL");
  pnl.addRow(["Показатель", "Значение", "Примечание"]);
  pnl.getRow(1).font = { bold: true };
  pnl.addRow(["earnedValue", pf.pnl?.earnedValue ?? 0, "физический факт ≠ платёж"]);
  pnl.addRow(["incurredCosts", pf.pnl?.incurredCosts ?? 0, ""]);
  pnl.addRow(["cashIn", pf.pnl?.cashIn ?? 0, "не из факта работ"]);
  pnl.addRow(["cashOut", pf.pnl?.cashOut ?? 0, "не из факта работ"]);
  pnl.addRow([
    "recognizedRevenue",
    pf.pnl?.recognizedRevenue ?? "нет данных",
    "",
  ]);
  for (const n of pf.pnl?.notes ?? []) {
    pnl.addRow(["note", n, ""]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildSmetaExportXlsx(calcId?: string): Promise<Buffer> {
  const data = readAppData();
  const calc = data.calculations.find((c) => c.id === (calcId ?? "c-1")) ?? data.calculations[0];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Works");
  ws.addRow(["code", "name", "unit", "quantity"]);
  ws.getRow(1).font = { bold: true };
  if (calc) {
    for (const p of calc.positions) {
      ws.addRow([p.code, p.name, p.unit, p.quantity]);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildDirectoryTemplate(
  type: "normy" | "rascenki" | "ceny" | "profil" | "park"
): Promise<Buffer> {
  const headers =
    type === "normy"
      ? ["code", "name", "unit", "labor"]
      : type === "rascenki"
        ? ["code", "category", "work", "department", "unit", "rate"]
        : type === "ceny"
          ? [
              "code",
              "category",
              "name",
              "unit",
              "rate_1s_kpi085",
              "rate_2s_kpi085",
              "rate_1s_kpi10",
              "rate_2s_kpi10",
              "price",
            ]
          : type === "park"
            ? ["code", "category", "name", "qty", "unit"]
            : ["region", "okpd", "maxNmck"];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Template");
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseDirectoryXlsx(
  buf: Buffer
): Promise<Record<string, string | number>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, col) => {
    headers[col] = String(cell.value ?? `col${col}`).trim();
  });
  const rows: Record<string, string | number>[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string | number> = {};
    let empty = true;
    headers.forEach((h, col) => {
      if (!h) return;
      const raw = row.getCell(col).value;
      if (raw === null || raw === undefined || raw === "") return;
      empty = false;
      const num = Number(raw);
      obj[h] = Number.isFinite(num) && String(raw).trim() !== "" ? num : String(raw);
    });
    if (!empty) rows.push(obj);
  });
  return rows;
}

export async function parseSmetaXlsx(buf: Buffer): Promise<{ code: string; quantity: number; name?: string }[]> {
  try {
    const parsed = await parseGrandBuffer(buf);
    if (parsed) {
      const key = estimateKey(parsed.estimateNumber);
      return parsed.positions.map((position) => ({
        code: `${key} · ${position.code}`,
        quantity: position.quantity,
        name: position.name,
      }));
    }
  } catch {
    // не форма ГРАНД-Сметы — ниже простой разбор колонок
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: { code: string; quantity: number; name?: string }[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const code = String(row.getCell(1).value ?? "").trim();
    const name = String(row.getCell(2).value ?? "").trim();
    const qtyRaw = row.getCell(4).value ?? row.getCell(3).value;
    const quantity = Number(qtyRaw);
    if (code && Number.isFinite(quantity)) {
      rows.push({ code, quantity, name });
    }
  });
  return rows;
}
