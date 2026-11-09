import fs from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import ExcelJS from "exceljs";
import { PDFDocument, rgb } from "pdf-lib";
import {
  calculationTotals,
  positionLineSum,
} from "@/lib/calc-math";
import { resolveResourceDimensions } from "@/lib/resource-dimensions";
import { EXCEL_RESOURCE_SCHEDULE_DEFAULTS } from "@/lib/resource-schedule-model";
import { readAppData } from "@/server/db";
import { estimateKey, parseGrandBuffer } from "@/server/grand-smeta";

function columnLetter(column: number): string {
  let n = column;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/** Make exports readable as working spreadsheets: frozen header, filters, formats and row rhythm. */
function formatWorksheet(
  worksheet: ExcelJS.Worksheet,
  options: { currencyColumns?: number[]; dateColumns?: number[]; numberColumns?: number[] } = {}
) {
  const lastColumn = Math.max(worksheet.columnCount, 1);
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  if (worksheet.rowCount > 1) {
    worksheet.autoFilter = {
      from: "A1",
      to: `${columnLetter(lastColumn)}1`,
    };
  }

  const header = worksheet.getRow(1);
  header.height = 28;
  header.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183A57" } };
  header.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  header.border = { bottom: { style: "medium", color: { argb: "FFB86B2B" } } };

  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    row.height = 21;
    row.alignment = { vertical: "middle", wrapText: true };
    if (rowIndex % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F7F9" } };
    }
    row.border = { bottom: { style: "hair", color: { argb: "FFD9E1E7" } } };
  }

  for (const column of options.currencyColumns ?? []) {
    worksheet.getColumn(column).numFmt = '#,##0.00;[Red]-#,##0.00;–';
  }
  for (const column of options.dateColumns ?? []) {
    worksheet.getColumn(column).numFmt = "dd.mm.yyyy";
  }
  for (const column of options.numberColumns ?? []) {
    worksheet.getColumn(column).numFmt = "#,##0.###;[Red]-#,##0.###;–";
  }
}

function fontBytes(bold = false): Uint8Array {
  const configured = process.env.PDF_FONT_PATH?.trim();
  const candidates = [
    ...(configured ? [configured] : []),
    bold
      ? "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
      : "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error(
      "Для PDF не найден шрифт с кириллицей. Установите fonts-noto-core или задайте PDF_FONT_PATH."
    );
  }
  return new Uint8Array(fs.readFileSync(path.resolve(file)));
}

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

  formatWorksheet(ws, { currencyColumns: [5, 6], numberColumns: [4] });

  const linkedSchedules = data.schedules.filter((schedule) => schedule.calculationId === calc.id);
  const resources = wb.addWorksheet("Ресурсный состав");
  resources.columns = [
    { header: "Этап", key: "stage", width: 34 },
    { header: "Вид ресурса", key: "kind", width: 16 },
    { header: "Ресурс", key: "name", width: 40 },
    { header: "Количество", key: "quantity", width: 14 },
    { header: "Ед.", key: "unit", width: 10 },
    { header: "Часов в смене", key: "hoursPerShift", width: 16 },
    { header: "Смен в день", key: "shiftsPerDay", width: 14 },
    { header: "Дней", key: "days", width: 12 },
    { header: "Часы", key: "hours", width: 14 },
    { header: "Ставка, ₽", key: "rate", width: 16 },
    { header: "Сумма, ₽", key: "amount", width: 18 },
    { header: "Статус", key: "status", width: 28 },
  ];
  let knownResourceAmount = 0;
  let hasPartialResource = false;
  for (const schedule of linkedSchedules) {
    const params = calc.resourceScheduleParams ?? EXCEL_RESOURCE_SCHEDULE_DEFAULTS;
    for (const stage of schedule.stages) {
      for (const resource of stage.resources ?? []) {
        const dimensions = resolveResourceDimensions(resource, stage, params);
        if (dimensions.amount != null) knownResourceAmount += dimensions.amount;
        if (dimensions.incomplete.length) hasPartialResource = true;
        resources.addRow({
          stage: stage.name,
          kind: resource.kind,
          name: resource.name,
          quantity: dimensions.sourceQty,
          unit: resource.unit ?? "",
          hoursPerShift: dimensions.hoursPerShift,
          shiftsPerDay: dimensions.shiftsPerDay,
          days: dimensions.days,
          hours: dimensions.hours,
          rate: dimensions.rate,
          amount: dimensions.amount,
          status: dimensions.incomplete.length ? "Неполно" : "Подтверждено",
        });
      }
    }
  }
  if (linkedSchedules.length === 0) {
    resources.addRow({ stage: "К этому расчёту пока не привязан ГПР" });
  } else {
    resources.addRow({
      stage: `Подтверждённые суммы${hasPartialResource ? " · неполно" : ""}`,
      amount: knownResourceAmount,
      status: hasPartialResource ? "Часть ставок не заполнена" : "Подтверждено",
    });
  }
  formatWorksheet(resources, { currencyColumns: [10, 11], numberColumns: [4, 6, 7, 8, 9] });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export async function buildCalculationPdf(calcId: string): Promise<Buffer> {
  const data = readAppData();
  const calc = data.calculations.find((c) => c.id === calcId);
  if (!calc) throw new Error("Расчёт не найден");

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes(), { subset: true });
  const bold = await pdf.embedFont(fontBytes(true), { subset: true });
  pdf.setTitle(`Расчёт: ${calc.title}`);
  pdf.setAuthor("истройка");
  pdf.setCreator("истройка · TMA361");
  const pageSize: [number, number] = [595, 842];
  const margin = 42;
  const ink = rgb(0.07, 0.15, 0.22);
  const muted = rgb(0.35, 0.42, 0.48);
  const accent = rgb(0.72, 0.42, 0.17);
  const money = (value: number) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} руб.`;
  const scenarioLabel = calc.scenario === "optimisticheskiy"
    ? "Оптимистичный"
    : calc.scenario === "pessimisticheskiy"
      ? "Пессимистичный"
      : "Базовый";
  let page = pdf.addPage(pageSize);
  let y = 0;

  const addPage = () => {
    page = pdf.addPage(pageSize);
    page.drawRectangle({ x: 0, y: 811, width: pageSize[0], height: 31, color: ink });
    page.drawText("Истройка · Расчёт проекта", {
      x: margin,
      y: 821,
      size: 10,
      font: bold,
      color: rgb(1, 1, 1),
    });
    y = 787;
  };

  const drawWrapped = (text: string, size = 10, isBold = false, color = ink) => {
    const selectedFont = isBold ? bold : font;
    const maxWidth = pageSize[0] - margin * 2;
    const words = text.split(/\s+/);
    let line = "";
    const lines: string[] = [];
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && selectedFont.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    for (const wrapped of lines) {
      if (y < 55) addPage();
      page.drawText(wrapped, { x: margin, y, size, font: selectedFont, color });
      y -= size + 6;
    }
  };

  page.drawRectangle({ x: 0, y: 786, width: pageSize[0], height: 56, color: ink });
  page.drawText("Истройка · Расчёт проекта", {
    x: margin,
    y: 815,
    size: 15,
    font: bold,
    color: rgb(1, 1, 1),
  });
  y = 758;
  drawWrapped(calc.title, 13, true);
  drawWrapped(
    `${calc.kind === "customer_original" || calc.immutable ? "Исходная смета заказчика" : "Ресурсный черновик"} · Сценарий: ${scenarioLabel} · Коэффициент ${calc.scenarioFactor} · Версия ${calc.version ?? 1}`,
    9,
    false,
    muted
  );
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: pageSize[0] - margin, y }, thickness: 1, color: accent });
  y -= 18;
  drawWrapped("Позиции сметы", 11, true);
  const factor = calc.scenarioFactor || 1;
  for (const p of calc.positions) {
    if (p.rateMissing) {
      drawWrapped(
        `${p.code} · ${p.name} · ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(p.quantity)} ${p.unit} · ставка не заполнена · сумма не подтверждена`,
        9,
        false,
        accent
      );
    } else {
      const sum = positionLineSum(p, factor);
      drawWrapped(
        `${p.code} · ${p.name} · ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(p.quantity)} ${p.unit} × ${money(p.rate)} = ${money(sum)}`,
        9
      );
    }
  }
  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: pageSize[0] - margin, y }, thickness: 0.6, color: muted });
  y -= 18;
  drawWrapped("Итоги", 11, true);
  const slices = calc.costSummary?.resourceSlices;
  const partial =
    Boolean(calc.costSummary?.totalsIncomplete) || Boolean(slices?.partial);
  if (isResourceDraftExport(calc) && slices) {
    const tag = partial ? " · неполный расчёт" : "";
    drawWrapped(`Прямые затраты V: ${money(slices.direct)}${tag}`, 10, true);
    drawWrapped(`Накладные W: ${money(slices.overhead)}${tag}`, 10);
    drawWrapped(`Себестоимость с накладными X: ${money(slices.costWithOh)}${tag}`, 10);
    drawWrapped(`Прибыль Y: ${money(slices.profit)}${tag}`, 10);
    drawWrapped(`Итого ресурсного черновика Z: ${money(slices.total)}${tag}`, 12, true);
    drawWrapped(`Материалы S: ${money(slices.materials)} · Люди T: ${money(slices.labor)} · Техника U: ${money(slices.equipment)}`, 9, false, muted);
    if (calc.officeOverhead != null) drawWrapped(`Офисные расходы отдельно: ${money(calc.officeOverhead)}`, 9, false, muted);
    if (calc.costSummary?.reserve != null) drawWrapped(`Непредвиденные расходы: ${money(calc.costSummary.reserve)}`, 9, false, muted);
  } else {
    const totals = calculationTotals(calc);
    const label =
      calc.kind === "customer_original" || calc.immutable
        ? "Итого исходной сметы (НР15/СП8)"
        : "Итого расчёта";
    drawWrapped(`${label}: ${money(totals.total)}${partial ? " · неполный расчёт" : ""}`, 12, true);
  }
  if (partial || calc.positions.some((position) => position.rateMissing)) {
    y -= 8;
    drawWrapped("Есть незаполненные ставки или исходные данные. Неполные суммы нельзя считать подтверждённой стоимостью.", 9, true, accent);
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
  formatWorksheet(ws, { currencyColumns: [3], dateColumns: [4] });
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
  formatWorksheet(ws, { dateColumns: [2, 3], numberColumns: [4, 7, 8, 9, 10, 11] });
  formatWorksheet(resSheet, { currencyColumns: [11, 12], numberColumns: [4, 7, 8, 9, 10] });
  formatWorksheet(sumSheet, { currencyColumns: [2] });
  formatWorksheet(rsSheet, { currencyColumns: [2] });
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
  formatWorksheet(ws);
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
    formatWorksheet(base, { numberColumns: [3, 4] });
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
  formatWorksheet(ws, { numberColumns: [3, 4, 5, 6] });
  formatWorksheet(daily, { dateColumns: [1], numberColumns: [4] });
  formatWorksheet(pnl, { currencyColumns: [2] });
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
  formatWorksheet(ws, { numberColumns: [4] });
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
