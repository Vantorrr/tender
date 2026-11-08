import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  calculationTotals,
  positionLineSum,
} from "@/lib/calc-math";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { readAppData } from "@/server/db";
import { estimateKey, parseGrandBuffer } from "@/server/grand-smeta";

function partialTag(incomplete: boolean): string {
  return incomplete ? " PARTIAL" : "";
}

function isResourceDraftExport(calc: {
  kind?: string;
  immutable?: boolean;
  costSummary?: { resourceSlices?: unknown; method?: string } | null;
}): boolean {
  if (calc.immutable || calc.kind === "customer_original") return false;
  return Boolean(
    calc.costSummary?.resourceSlices ||
      (calc.kind === "resource_draft" &&
        calc.costSummary?.method?.includes("resource-schedule"))
  );
}

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
    const sum = p.rateMissing ? null : positionLineSum(p, factor);
    ws.addRow({
      code: p.code,
      name: p.name,
      unit: p.unit,
      qty: p.quantity,
      rate: p.rateMissing ? null : p.rate,
      sum,
    });
  }
  const dir = data.directories.find((d) => d.id === calc.directoryVersionId);
  ws.addRow({});

  const slices = calc.costSummary?.resourceSlices;
  const partial =
    Boolean(calc.costSummary?.totalsIncomplete) || Boolean(slices?.partial);
  if (isResourceDraftExport(calc) && slices) {
    // Resource draft: Excel V/W/X/Y/Z (OH43% / markup40%) — not НР15/СП8.
    ws.addRow({
      code: "V_direct",
      name: partial ? "V прямые (PARTIAL)" : "V прямые",
      sum: slices.direct,
    });
    ws.addRow({
      code: "W_oh43",
      name: partial ? "W НР 43% (PARTIAL)" : "W НР 43%",
      sum: slices.overhead,
    });
    ws.addRow({
      code: "X_cost_oh",
      name: partial ? "X с/с с НР (PARTIAL)" : "X с/с с НР",
      sum: slices.costWithOh,
    });
    ws.addRow({
      code: "Y_markup40",
      name: partial ? "Y наценка 40% (PARTIAL)" : "Y наценка 40%",
      sum: slices.profit,
    });
    ws.addRow({
      code: "Z_total",
      name: partial ? "Z итого (PARTIAL)" : "Z итого",
      sum: slices.total,
    });
    ws.addRow({
      code: "Q_hours",
      name: "Q часы (без материалов)",
      sum: slices.hours,
    });
  } else {
    // Immutable original / legacy: позиции × коэф. + НР15/СП8
    const totals = calculationTotals(calc);
    ws.addRow({
      code: "Итого",
      name:
        calc.kind === "customer_original" || calc.immutable
          ? "Оригинал (НР15/СП8)"
          : "Итого",
      sum: totals.total,
    });
  }
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
    if (p.rateMissing) {
      draw(`${p.code} | ${p.quantity} x (no rate) = PARTIAL`, 9);
    } else {
      const sum = positionLineSum(p, factor);
      draw(
        `${p.code} | ${p.quantity} x ${p.rate} = ${Math.round(sum)}`.replace(
          /[^\x00-\x7F]/g,
          "?"
        ),
        9
      );
    }
    if (y < 100) break;
  }
  const slices = calc.costSummary?.resourceSlices;
  const partial =
    Boolean(calc.costSummary?.totalsIncomplete) || Boolean(slices?.partial);
  if (isResourceDraftExport(calc) && slices) {
    const tag = partial ? " PARTIAL" : "";
    draw(`V direct: ${Math.round(slices.direct)}${tag}`, 11, true);
    draw(`W OH43%: ${Math.round(slices.overhead)}${tag}`, 11, true);
    draw(`X cost+OH: ${Math.round(slices.costWithOh)}${tag}`, 11, true);
    draw(`Y markup40%: ${Math.round(slices.profit)}${tag}`, 11, true);
    draw(`Z TOTAL: ${Math.round(slices.total)}${tag}`, 12, true);
  } else {
    const totals = calculationTotals(calc);
    const label =
      calc.kind === "customer_original" || calc.immutable
        ? "ORIGINAL TOTAL (NR15/SP8)"
        : "TOTAL";
    draw(`${label}: ${Math.round(totals.total)} RUB`, 12, true);
  }
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
    "Объём плана",
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
      s.planVolume ?? "",
      res,
    ]);
  }
  const calc = data.calculations.find((c) => c.id === g.calculationId);
  const rsParams = calc?.resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
  const cs = calc?.costSummary;
  const totalsPartial = Boolean(
    cs?.totalsIncomplete || cs?.resourceSlices?.partial
  );

  const resSheet = wb.addWorksheet("Ресурсы");
  resSheet.addRow([
    "Этап",
    "Вид",
    "Название",
    "L кол-во",
    "Ед.",
    "Basis",
    "N ч/смена",
    "O смен",
    "P дни",
    "Q часы",
    "Ставка",
    "R сумма",
    "Статус",
  ]);
  resSheet.getRow(1).font = { bold: true };
  let knownSum = 0;
  let anyIncomplete = false;
  for (const s of g.stages) {
    for (const r of s.resources ?? []) {
      const dim = resolveResourceDimensions(r, s, rsParams);
      if (dim.incomplete.length) anyIncomplete = true;
      if (dim.amount != null) knownSum += dim.amount;
      resSheet.addRow([
        s.name,
        r.kind,
        r.name,
        dim.sourceQty,
        r.unit ?? "",
        dim.basis,
        dim.hoursPerShift,
        dim.shiftsPerDay,
        dim.days,
        dim.hours,
        dim.rate,
        dim.amount,
        dim.incomplete.length ? "PARTIAL" : "ok",
      ]);
    }
  }
  const resPartial = totalsPartial || anyIncomplete;
  resSheet.addRow([
    `Итого подтверждённых${partialTag(resPartial)}`,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    knownSum,
    resPartial ? "PARTIAL" : "ok",
  ]);

  const sumSheet = wb.addWorksheet("Сводка");
  sumSheet.addRow(["Показатель", "Значение", "Примечание"]);
  sumSheet.getRow(1).font = { bold: true };
  if (cs) {
    const ptag = partialTag(totalsPartial);
    sumSheet.addRow([
      `C0${ptag}`,
      cs.C0,
      totalsPartial ? "PARTIAL" : "",
    ]);
    sumSheet.addRow([`C${ptag}`, cs.C, totalsPartial ? "PARTIAL" : ""]);
    sumSheet.addRow([
      `Резерв${ptag}`,
      cs.reserve,
      "не путать с резервом отпуска; общий непредвиденный — только если подтверждён",
    ]);
    sumSheet.addRow([
      `Прибыль${ptag}`,
      cs.profit,
      totalsPartial
        ? "PARTIAL · наценка на с/с с НР"
        : "наценка на с/с с НР (не маржа выручки)",
    ]);
    sumSheet.addRow([
      `Цена без НДС${ptag}`,
      cs.priceExVat,
      totalsPartial ? "PARTIAL" : "",
    ]);
    sumSheet.addRow([
      `НДС${ptag}`,
      cs.vatAmount == null ? "нет данных" : cs.vatAmount,
      totalsPartial ? "PARTIAL" : "",
    ]);
    sumSheet.addRow([
      "Неполнота",
      (cs.incomplete ?? []).join("; ") || "—",
      totalsPartial ? "итоги не подтверждены · PARTIAL" : "",
    ]);
  } else {
    sumSheet.addRow(["Сводка", "нет данных", "пересчитайте cost-engine"]);
  }
  const rsSheet = wb.addWorksheet("Ресурсный_параметры");
  rsSheet.addRow(["Параметр", "Значение", "Локатор/смысл"]);
  rsSheet.getRow(1).font = { bold: true };
  const p = rsParams;
  rsSheet.addRow(["Стоимость 1 чел.-часа", p.personHourRate, "B4"]);
  rsSheet.addRow(["Смен персонала/сутки", p.personnelShiftsPerDay, "B5"]);
  rsSheet.addRow(["Часов в смене", p.hoursPerShift, "B6"]);
  rsSheet.addRow(["Смен техники/сутки", p.equipmentShiftsPerDay, "B7"]);
  rsSheet.addRow(["НР (доля от прямых)", p.overheadRate, "B8"]);
  rsSheet.addRow([
    "Прибыль (наценка на с/с с НР)",
    p.profitMarkupOnCostWithOh,
    "B9",
  ]);
  rsSheet.addRow([
    "Часы ресурса",
    "Q=L*N*O*P",
    "кол-во×ч/смена×смен/сут×дни",
  ]);
  rsSheet.addRow(["Сумма ресурса", "R=Q*M", "ставка без двойного ГСМ/водителя"]);
  const slices = cs?.resourceSlices;
  const ptag = partialTag(totalsPartial);
  rsSheet.addRow([
    `Прямые V${ptag}`,
    slices ? slices.direct : "V=S+T+U",
    totalsPartial ? "PARTIAL" : "материалы+люди+техника",
  ]);
  rsSheet.addRow([
    `НР W${ptag}`,
    slices ? slices.overhead : "W=V*B8",
    totalsPartial ? "PARTIAL" : "",
  ]);
  rsSheet.addRow([
    `С/с с НР X${ptag}`,
    slices ? slices.costWithOh : "X=V+W",
    totalsPartial ? "PARTIAL" : "",
  ]);
  rsSheet.addRow([
    `Прибыль Y${ptag}`,
    slices ? slices.profit : "Y=X*B9",
    totalsPartial ? "PARTIAL" : "",
  ]);
  rsSheet.addRow([
    `Итого Z${ptag}`,
    slices ? slices.total : "Z=X+Y",
    totalsPartial
      ? "PARTIAL"
      : slices?.skipped?.length
        ? `пропуск: ${slices.skipped.join(",")}`
        : "",
  ]);
  if (slices) {
    rsSheet.addRow([`S материалы${ptag}`, slices.materials, totalsPartial ? "PARTIAL" : ""]);
    rsSheet.addRow([`T люди${ptag}`, slices.labor, totalsPartial ? "PARTIAL" : ""]);
    rsSheet.addRow([`U техника${ptag}`, slices.equipment, totalsPartial ? "PARTIAL" : ""]);
    rsSheet.addRow([`Q часы${ptag}`, slices.hours, totalsPartial ? "PARTIAL" : ""]);
    rsSheet.addRow([`R известное${ptag}`, slices.knownAmount, totalsPartial ? "PARTIAL" : ""]);
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
  let rowIdx = 2;
  for (const e of pf.entries) {
    ws.addRow([
      e.workName,
      e.unit,
      e.plan,
      e.fact,
      null,
      e.contractRemaining ?? Math.max(0, e.plan - e.fact),
    ]);
    // Excel formulas: deviation = fact - plan; remain = plan - fact
    ws.getCell(`E${rowIdx}`).value = { formula: `D${rowIdx}-C${rowIdx}` };
    ws.getCell(`F${rowIdx}`).value = { formula: `MAX(0,C${rowIdx}-D${rowIdx})` };
    rowIdx += 1;
  }
  if (pf.entries.length) {
    const last = rowIdx - 1;
    const totalRow = last + 1;
    ws.addRow(["Итого", "", null, null, null, null]);
    ws.getCell(`C${totalRow}`).value = { formula: `SUM(C2:C${last})` };
    ws.getCell(`D${totalRow}`).value = { formula: `SUM(D2:D${last})` };
    ws.getCell(`E${totalRow}`).value = {
      formula: `D${totalRow}-C${totalRow}`,
    };
    ws.getCell(`F${totalRow}`).value = {
      formula: `MAX(0,C${totalRow}-D${totalRow})`,
    };
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
  pnl.addRow([
    "earnedValue",
    pf.pnl?.earnedValue ?? 0,
    "физический индекс ≠ платёж",
  ]);
  pnl.addRow([
    "economicsAuto",
    pf.pnl?.economicsAuto ?? "нет данных",
    "объём×подтверждённые расценки",
  ]);
  pnl.addRow([
    "incurredCosts",
    pf.pnl?.incurredCosts ?? 0,
    pf.pnl?.incurredManual ? "ручная корректировка" : "из auto или 0",
  ]);
  pnl.addRow(["cashIn", pf.pnl?.cashIn ?? 0, "касса отдельно"]);
  pnl.addRow(["cashOut", pf.pnl?.cashOut ?? 0, "касса отдельно"]);
  pnl.addRow([
    "recognizedRevenue",
    pf.pnl?.recognizedRevenue ?? "нет данных",
    "выручка отдельно",
  ]);
  pnl.addRow([
    "incomplete",
    (pf.pnl?.incomplete ?? []).join("; ") || "—",
    (pf.pnl?.incomplete?.length ?? 0) > 0
      ? "экономика неполная"
      : "",
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
