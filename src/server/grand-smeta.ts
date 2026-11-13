import ExcelJS from "exceljs";
import { GRAND_PROFILE } from "@/lib/grand-profile";
import { refineNote } from "@/server/model-note";
import { extractDocumentText, ocrConfigured } from "@/server/ocr";
import type {
  CardStatus,
  Citation,
  DocumentAnalysis,
  Highlight,
} from "@/lib/types";

export type GrandPosition = {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  rate: number;
};

export type FieldLocator = {
  sheet: string;
  /** A1 cell, e.g. G10 */
  cell: string;
  row: number;
  col: number;
};

export type GrandParse = {
  product: string;
  normatives: string;
  orders: string;
  indexes: string;
  wages: string;
  region: string;
  zone: string;
  construction: string;
  objectName: string;
  estimateNumber: string;
  workName: string;
  basis: string;
  method: string;
  priceYear: string;
  costCurrentThousand: number | null;
  costBaseThousand: number | null;
  totalCurrent: number | null;
  totalBase: number | null;
  sections: string[];
  positions: GrandPosition[];
  negativePositions: number;
  coefficientNotes: string[];
  totalLocked: boolean;
  sheetName: string;
  locators: Partial<Record<string, FieldLocator>>;
  sourceVersion: string;
};

function colLetter(col: number): string {
  let n = col;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

function a1(row: number, col: number): string {
  return `${colLetter(col)}${row}`;
}

export type UploadAnalysis = {
  title: string;
  analyticalNote: string;
  citations: Citation[];
  highlights: Highlight[];
  status: CardStatus;
  analysis: DocumentAnalysis;
  positions: GrandPosition[];
  noteByModel?: boolean;
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    }
    if ("text" in value && value.text) return String(value.text).replace(/\s+/g, " ").trim();
    if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
  }
  return "";
}

function asNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cellText(value).replace(/\s/g, "").replace(",", ".");
  if (!text) return null;
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function rowCells(row: ExcelJS.Row, max = 20): { col: number; text: string; value: ExcelJS.CellValue }[] {
  const cells: { col: number; text: string; value: ExcelJS.CellValue }[] = [];
  for (let col = 1; col <= max; col++) {
    const value = row.getCell(col).value;
    const text = cellText(value);
    if (text) cells.push({ col, text, value });
  }
  return cells;
}

function firstOther(cells: { col: number; text: string }[], label: string) {
  return (
    cells.find((cell) => cell.col > 1 && cell.text !== label && !cell.text.startsWith("("))
      ?.text ?? ""
  );
}

function rub(n: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

function isRateCode(text: string) {
  return /^(ФЕР|ТЕР|ГЭСН|ФССЦ|ТССЦ|ФСБЦ|ФСЭМ|ТСЭМ|ТЦ|ФЕРм|ТЕРм)/i.test(text);
}

export function estimateKey(estimateNumber: string) {
  const matched = estimateNumber.match(/№\s*(.+)$/);
  return (matched?.[1] ?? estimateNumber).replace(/\s+/g, "");
}

export async function parseGrandBuffer(buf: Buffer): Promise<GrandParse | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) return null;

  const sheetName = ws.name || "Sheet1";
  const parsed: GrandParse = {
    product: "",
    normatives: "",
    orders: "",
    indexes: "",
    wages: "",
    region: "",
    zone: "",
    construction: "",
    objectName: "",
    estimateNumber: "",
    workName: "",
    basis: "",
    method: "",
    priceYear: "",
    costCurrentThousand: null,
    costBaseThousand: null,
    totalCurrent: null,
    totalBase: null,
    sections: [],
    positions: [],
    negativePositions: 0,
    coefficientNotes: [],
    totalLocked: false,
    sheetName,
    locators: {},
    sourceVersion: `${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}`,
  };
  const mark = (key: string, row: number, col: number) => {
    parsed.locators[key] = {
      sheet: sheetName,
      cell: a1(row, col),
      row,
      col,
    };
  };

  let lastPosition: GrandPosition | null = null;

  let headerRow = 0;
  let seenEstimate = false;
  ws.eachRow((row, rowNumber) => {
    const cells = rowCells(row, 16);
    if (!cells.length) return;
    const label = cells[0]?.text ?? "";

    if (rowNumber <= 40) {
      if (label.startsWith("Наименование программного продукта")) {
        parsed.product = firstOther(cells, label);
        const hit = cells.find((c) => c.col > 1 && c.text === parsed.product);
        mark("product", rowNumber, hit?.col ?? 7);
      } else if (label.startsWith("Наименование редакции сметных нормативов")) {
        parsed.normatives = firstOther(cells, label);
        mark("normatives", rowNumber, cells.find((c) => c.col > 1)?.col ?? 7);
      } else if (label.startsWith("Реквизиты приказа Минстроя")) {
        parsed.orders = firstOther(cells, label);
        mark("orders", rowNumber, cells.find((c) => c.col > 1)?.col ?? 7);
      } else if (label.startsWith("Реквизиты письма Минстроя")) {
        parsed.indexes = firstOther(cells, label);
        if (parsed.indexes) mark("indexes", rowNumber, cells.find((c) => c.col > 1)?.col ?? 7);
      } else if (label.startsWith("Реквизиты нормативного правового акта")) {
        parsed.wages = firstOther(cells, label);
        if (parsed.wages) mark("wages", rowNumber, cells.find((c) => c.col > 1)?.col ?? 7);
      } else if (label.startsWith("Наименование субъекта")) {
        parsed.region = firstOther(cells, label);
        mark("region", rowNumber, cells.find((c) => c.col > 1 && c.text === parsed.region)?.col ?? 7);
      } else if (label.startsWith("Наименование зоны")) {
        parsed.zone = firstOther(cells, label);
        mark("zone", rowNumber, cells.find((c) => c.col > 1 && c.text === parsed.zone)?.col ?? 7);
      } else if (label.includes("шифр") || label.startsWith("«")) {
        parsed.construction = label;
        mark("construction", rowNumber, 1);
      } else if (
        label.startsWith("Участок") ||
        label.startsWith("Объект") ||
        (label.length > 40 && !parsed.objectName && !label.startsWith("ЛОКАЛЬНЫЙ") && !label.startsWith("("))
      ) {
        if (!parsed.objectName && rowNumber > 13 && rowNumber < 18) {
          parsed.objectName = label;
          mark("objectName", rowNumber, 1);
        }
      } else if (label.startsWith("ЛОКАЛЬНЫЙ СМЕТНЫЙ")) {
        parsed.estimateNumber = label.replace(/\s+/g, " ");
        seenEstimate = true;
        mark("estimateNumber", rowNumber, 1);
      } else if (seenEstimate && !parsed.workName && !label.startsWith("(") && !label.startsWith("Составлен")) {
        parsed.workName = label;
        seenEstimate = false;
        mark("workName", rowNumber, 1);
      } else if (label === "Основание") {
        const basisCell = cells.find((cell) => cell.col > 1);
        parsed.basis = basisCell?.text ?? "";
        if (basisCell) mark("basis", rowNumber, basisCell.col);
      } else if (label.startsWith("Составлен") && label.length < 40) {
        parsed.method = cells.map((cell) => cell.text).join(" ");
        mark("method", rowNumber, 1);
      } else if (label.includes("уровне цен")) {
        const yearCell = cells.find((cell) => /\d{4}/.test(cell.text));
        parsed.priceYear = yearCell?.text ?? "";
        if (yearCell) mark("priceYear", rowNumber, yearCell.col);
      } else if (label === "Сметная стоимость") {
        const nums = cells
          .filter((cell) => cell.col > 1)
          .map((cell) => ({ cell, n: asNumber(cell.value) }))
          .filter((x): x is { cell: (typeof cells)[0]; n: number } => x.n != null);
        parsed.costCurrentThousand = nums[0]?.n ?? null;
        if (nums[0]) mark("costCurrentThousand", rowNumber, nums[0].cell.col);
        const paren = cells.map((cell) => cell.text).find((text) => text.startsWith("("));
        parsed.costBaseThousand = paren ? asNumber(paren) : (nums[1]?.n ?? null);
        if (parsed.costBaseThousand != null) {
          const parenCell = cells.find((c) => c.text.startsWith("("));
          mark("costBaseThousand", rowNumber, parenCell?.col ?? nums[0]?.cell.col ?? 3);
        }
      }
    }

    if (label === "№ п/п" && cells.some((cell) => cell.text === "Обоснование")) {
      headerRow = rowNumber;
    }
    if (!headerRow || rowNumber <= headerRow + 2) return;

    if (label.startsWith("Раздел ") && parsed.sections.length < 12) {
      parsed.sections.push(label);
    }
    const name = cells.find((cell) => cell.col === 3)?.text ?? "";
    if (name === "Итого по расценке" && lastPosition && lastPosition.quantity) {
      const current = asNumber(row.getCell(14).value);
      if (current != null && lastPosition.rate === 0) {
        lastPosition.rate = Math.round((current / lastPosition.quantity) * 100) / 100;
      }
    }
    if (name === "Всего по позиции") {
      const total = asNumber(row.getCell(12).value);
      if (total != null && total < 0) parsed.negativePositions += 1;
    }
    if (name === "ВСЕГО по смете" || name === "Итого по смете") {
      parsed.totalBase = asNumber(row.getCell(12).value);
      parsed.totalCurrent = asNumber(row.getCell(14).value);
      parsed.totalLocked = true;
      mark("totalCurrent", rowNumber, 14);
      mark("totalBase", rowNumber, 12);
    } else if (name === "Итого" && !parsed.totalLocked) {
      parsed.totalBase = asNumber(row.getCell(12).value);
      parsed.totalCurrent = asNumber(row.getCell(14).value);
      mark("totalCurrent", rowNumber, 14);
      mark("totalBase", rowNumber, 12);
    }

    const code = cells.find((cell) => cell.col === 2)?.text ?? "";
    if (/приказ/i.test(code) && parsed.coefficientNotes.length < 4) {
      parsed.coefficientNotes.push(`${code}. ${name}`.slice(0, 280));
    }
    if (!/^\d+$/.test(label) || !isRateCode(code)) return;
    const unit = cells.find((cell) => cell.col === 6)?.text ?? "";
    const quantity = asNumber(row.getCell(9).value) ?? asNumber(row.getCell(7).value);
    if (!name || quantity == null || quantity === 0) return;
    lastPosition = {
      code,
      name: name.slice(0, 240),
      unit,
      quantity,
      rate: asNumber(row.getCell(10).value) ?? 0,
    };
    if (!parsed.locators.firstPosition) {
      mark("firstPosition", rowNumber, 2);
      mark("firstPositionQty", rowNumber, quantity === asNumber(row.getCell(9).value) ? 9 : 7);
    }
    parsed.positions.push(lastPosition);
  });

  if (!parsed.product.includes("ГРАНД-Смета") && !parsed.estimateNumber) return null;
  return parsed;
}

function statusFrom(highlights: Highlight[]): CardStatus {
  if (highlights.some((item) => item.severity === "critical" || item.severity === "warning")) {
    return "trebuet_proverki";
  }
  return "gotovo";
}

export function analysisFromGrand(parsed: GrandParse, fileName: string): UploadAnalysis {
  const highlights: Highlight[] = [];
  const regionOk = parsed.region.includes("Красноярск");
  const zoneOk = parsed.zone === GRAND_PROFILE.zone;
  const vendorOk = parsed.product.includes(GRAND_PROFILE.vendor);
  if (!regionOk) {
    highlights.push({
      id: "h-region",
      text: parsed.region || "Субъект не указан",
      reason: `Эталон объекта ${GRAND_PROFILE.cipher}: ${GRAND_PROFILE.region}`,
      severity: "critical",
      page: 1,
    });
  }
  if (!zoneOk) {
    highlights.push({
      id: "h-zone",
      text: parsed.zone ? `Зона ${parsed.zone}` : "Зона субъекта не указана",
      reason: `Для ${GRAND_PROFILE.cipher} ожидается зона ${GRAND_PROFILE.zone}`,
      severity: "warning",
      page: 1,
    });
  }
  if (!vendorOk) {
    highlights.push({
      id: "h-vendor",
      text: parsed.product || "Программный продукт не указан",
      reason: `Обмен настроен на ${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}`,
      severity: "warning",
      page: 1,
    });
  }
  if (!parsed.indexes) {
    highlights.push({
      id: "h-index",
      text: "Индексы изменения сметной стоимости не заполнены",
      reason: "В шапке пусты реквизиты письма Минстроя об индексах. Сверьте текущий уровень цен.",
      severity: "warning",
      page: 1,
    });
  }
  if (!parsed.wages) {
    highlights.push({
      id: "h-wages",
      text: "Не указан акт об оплате труда",
      reason: "Поле шапки пустое. На итог по зарплате это может влиять.",
      severity: "info",
      page: 1,
    });
  }
  if (parsed.negativePositions > 0) {
    highlights.push({
      id: "h-neg",
      text: `Отрицательных позиций: ${parsed.negativePositions}`,
      reason: "Возврат или исключение ресурсов. Проверьте, что объём не ушёл в минус по ошибке.",
      severity: "warning",
      page: 1,
    });
  }
  if (
    parsed.costCurrentThousand != null &&
    parsed.totalCurrent != null &&
    Math.abs(parsed.costCurrentThousand * 1000 - parsed.totalCurrent) > 10
  ) {
    highlights.push({
      id: "h-sum",
      text: `Шапка ${rub(parsed.costCurrentThousand)} тыс. руб., итог ${rub(parsed.totalCurrent)} руб.`,
      reason: "Сметная стоимость в шапке не сходится с итогом по графе текущего уровня.",
      severity: "critical",
      page: 1,
    });
  }
  if (!parsed.positions.length) {
    highlights.push({
      id: "h-empty",
      text: "Расценки ФЕР/ТЕР/ГЭСН не найдены",
      reason: "Таблица есть, но строки с обоснованием не прочитались.",
      severity: "critical",
      page: 1,
    });
  }

  const citations: Citation[] = [];
  const quote = (
    id: string,
    text: string,
    locatorKey?: string,
    confidence: Citation["confidence"] = "confirmed"
  ) => {
    if (!text) return;
    const loc = locatorKey ? parsed.locators[locatorKey] : undefined;
    citations.push({
      id,
      text: text.slice(0, 400),
      page: 1,
      sourceFile: fileName,
      sheet: loc?.sheet ?? parsed.sheetName,
      cell: loc?.cell,
      sourceVersion: parsed.sourceVersion,
      confidence,
    });
  };
  quote("c-obj", parsed.construction || "нет данных", "construction", parsed.construction ? "confirmed" : "unconfirmed");
  quote("c-est", parsed.estimateNumber || "нет данных", "estimateNumber", parsed.estimateNumber ? "confirmed" : "unconfirmed");
  quote("c-work", parsed.workName || "нет данных", "workName", parsed.workName ? "confirmed" : "unconfirmed");
  if (parsed.basis) quote("c-basis", `Основание: ${parsed.basis}`, "basis");
  else quote("c-basis", "Основание: нет данных", undefined, "unconfirmed");
  quote(
    "c-reg",
    [parsed.region || "нет данных", parsed.zone ? `зона ${parsed.zone}` : "зона: нет данных"].join(", "),
    parsed.region ? "region" : "zone",
    parsed.region && parsed.zone ? "confirmed" : "unconfirmed"
  );
  if (parsed.costCurrentThousand != null) {
    quote(
      "c-cost",
      `Сметная стоимость: ${rub(parsed.costCurrentThousand)} тыс. руб.`,
      "costCurrentThousand"
    );
  } else {
    quote("c-cost", "Сметная стоимость: нет данных", undefined, "unconfirmed");
  }
  if (parsed.positions[0]) {
    const p = parsed.positions[0];
    quote(
      "c-pos",
      `${p.code} ${p.name} — ${rub(p.quantity)} ${p.unit}`.trim(),
      "firstPosition"
    );
  }
  if (parsed.coefficientNotes[0]) quote("c-k", parsed.coefficientNotes[0], undefined, "heuristic");

  const costLine =
    parsed.costCurrentThousand != null
      ? `${rub(parsed.costCurrentThousand)} тыс. руб. в текущем уровне${
          parsed.costBaseThousand != null ? ` (${rub(parsed.costBaseThousand)} тыс. руб. в базисном)` : ""
        }`
      : "нет данных";

  const analyticalNote = [
    `Разбор локальной сметы по параметрам ${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}, ${GRAND_PROFILE.form}.`,
    `Источник: лист «${parsed.sheetName}», версия ${parsed.sourceVersion}.`,
    `Объект: ${parsed.construction || "нет данных"}.`,
    parsed.objectName ? `Площадка: ${parsed.objectName}.` : "Площадка: нет данных.",
    `Смета: ${parsed.estimateNumber || "нет данных"}. Работы: ${parsed.workName || "нет данных"}.`,
    `Регион: ${parsed.region || "нет данных"}, зона ${parsed.zone || "нет данных"}. ${
      regionOk && zoneOk ? "Совпадает с эталоном " + GRAND_PROFILE.cipher + "." : "Отличается от эталона " + GRAND_PROFILE.cipher + "."
    }`,
    `Нормативы: ${parsed.normatives || "нет данных"}.`,
    parsed.orders ? `Дополнения: ${parsed.orders}.` : "",
    `Метод: ${parsed.method || "нет данных"}. Уровень цен: ${parsed.priceYear || "нет данных"}.`,
    parsed.basis ? `Основание: ${parsed.basis}.` : "Основание: нет данных.",
    `Сметная стоимость: ${costLine}.`,
    `Расценок в таблице: ${parsed.positions.length}. Разделов: ${parsed.sections.length}.`,
    parsed.sections.length
      ? `Разделы: ${parsed.sections.slice(0, 6).join("; ")}${parsed.sections.length > 6 ? "…" : ""}.`
      : "",
    parsed.coefficientNotes.length
      ? `Коэффициенты: ${parsed.coefficientNotes.slice(0, 2).join(" | ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    title: parsed.workName
      ? `${parsed.workName} — ${parsed.estimateNumber.replace(/^ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ \(СМЕТА\) №\s*/i, "") || fileName}`
      : fileName,
    analyticalNote,
    citations,
    highlights,
    status: statusFrom(highlights),
    positions: parsed.positions,
    analysis: {
      vendor: parsed.product || `${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}`,
      region: parsed.region,
      zone: parsed.zone,
      estimateNumber: parsed.estimateNumber,
      workName: parsed.workName,
      basis: parsed.basis,
      priceLevel: parsed.priceYear,
      costThousand: parsed.costCurrentThousand,
      positionCount: parsed.positions.length,
      profileMatch: regionOk && zoneOk && vendorOk,
    },
  };
}

/**
 * KM / эталонный чертёж — по шифру профиля, не по любой подстроке «КМ».
 * `/КМ/i` слишком широко и ловил произвольные имена.
 */
export function isKmDrawingFileName(fileName: string): boolean {
  return (
    /ТП-КП-М-Д/i.test(fileName) ||
    /101-3103/i.test(fileName) ||
    /III-Д-101-3103-КМ/i.test(fileName) ||
    new RegExp(GRAND_PROFILE.drawing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
      fileName
    ) ||
    new RegExp(GRAND_PROFILE.cipher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
      fileName
    )
  );
}

export function analysisFromDrawing(fileName: string, pages = 24): UploadAnalysis {
  const matched = isKmDrawingFileName(fileName);
  const highlights: Highlight[] = [
    {
      id: "h-draw",
      text: matched
        ? `${GRAND_PROFILE.drawing}, ${GRAND_PROFILE.drawingStage}`
        : "Чертёж не совпал с шифром эталона",
      reason: matched
        ? "В файле нет текстового слоя. Марки опор и объёмы сверьте с локальными сметами вручную."
        : `Эталон чертежа: ${GRAND_PROFILE.drawing}, шифр ${GRAND_PROFILE.cipher}.`,
      severity: matched ? "warning" : "critical",
      page: 1,
    },
  ];
  return {
    title: matched
      ? `Чертёж ${GRAND_PROFILE.drawing}, ${GRAND_PROFILE.drawingStage}`
      : fileName,
    analyticalNote: [
      `Файл принят как чертёж КМ (${pages} л.) комплекта ${GRAND_PROFILE.cipher}.`,
      `Обозначение: ${GRAND_PROFILE.drawing}. Стадия: ${GRAND_PROFILE.drawingStage}.`,
      `Объект: ${GRAND_PROFILE.construction}. ${GRAND_PROFILE.objectHint}.`,
      "Текстовый слой в PDF не извлечён: это графические листы. Разбор сметных параметров (регион, зона, расценки) к чертежу не применяется.",
      "Сверьте марки опор на листах с разделами локальных смет: бурение, демонтаж, установка.",
    ].join("\n"),
    citations: [
      {
        id: "c-draw",
        text: `${GRAND_PROFILE.drawing} · шифр ${GRAND_PROFILE.cipher} · ${GRAND_PROFILE.drawingStage}`,
        page: 1,
        sourceFile: fileName,
        sourceVersion: `${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}`,
        confidence: matched ? "heuristic" : "unconfirmed",
      },
    ],
    highlights,
    status: "trebuet_proverki",
    positions: [],
    analysis: {
      vendor: GRAND_PROFILE.vendor,
      region: GRAND_PROFILE.region,
      zone: GRAND_PROFILE.zone,
      estimateNumber: GRAND_PROFILE.drawing,
      workName: "Конструкции металлические, лист 2",
      basis: "Чертёж КМ, текстовый слой отсутствует",
      priceLevel: "",
      costThousand: null,
      positionCount: 0,
      profileMatch: matched,
    },
  };
}

/** Ordinary scan / PDF: surface OCR text + citations regardless of filename. */
export function analysisFromScan(
  fileName: string,
  ocr: {
    status: string;
    text: string | null;
    pageCount: number | null;
    provider?: string | null;
    reason?: string;
  }
): UploadAnalysis {
  const pages = ocr.pageCount ?? 1;
  const text = (ocr.text ?? "").trim();
  const hasText = text.length > 0;
  const citations: Citation[] = hasText
    ? [
        {
          id: "c-ocr",
          text: text.slice(0, 240),
          page: 1,
          sourceFile: fileName,
          sourceVersion: "ocr-extract",
          confidence: "ocr",
        },
      ]
    : [];
  const highlights: Highlight[] = [
    {
      id: "h-scan",
      text: hasText
        ? "OCR-текст извлечён"
        : ocr.status === "not_configured" || ocr.status === "unavailable"
          ? "OCR недоступен"
          : "Текст скана не извлечён",
      reason: hasText
        ? `Провайдер ${ocr.provider ?? "ocr"}; проверьте цитаты вручную.`
        : ocr.reason ||
          "Локальный OCR не вернул текст. Загрузка сохранена — разберите вручную.",
      severity: hasText ? "info" : "warning",
      page: 1,
    },
  ];
  const analyticalNote = hasText
    ? [
        `PDF принят как скан/документ (${pages} стр.). Имя файла не обязано совпадать с шифром КМ.`,
        `OCR (${ocr.provider ?? "local"}): ${text.slice(0, 800)}`,
        "Цифры и марки из OCR требуют ручной проверки. Сметный разбор ГРАНД-Сметы к произвольному скану не применяется.",
      ].join("\n")
    : [
        `PDF принят (${pages} стр.), но текстовый слой / OCR не дали содержимого.`,
        ocr.reason || `Статус OCR: ${ocr.status}.`,
        "Файл сохранён. Повторите разбор после настройки tesseract/poppler или проверьте вручную.",
      ].join("\n");
  return {
    title: fileName.replace(/\.[^.]+$/, "") || fileName,
    analyticalNote,
    citations,
    highlights,
    status: "trebuet_proverki",
    positions: [],
    analysis: {
      vendor: "",
      region: "",
      zone: "",
      estimateNumber: "",
      workName: "",
      basis: hasText ? `OCR ${ocr.provider ?? "local"}` : `OCR ${ocr.status}`,
      priceLevel: "",
      costThousand: null,
      positionCount: 0,
      profileMatch: false,
    },
  };
}

export type AnalyzeUploadOptions = {
  /** Paid OpenRouter refine — only when caller explicitly requests it. */
  useLlm?: boolean;
};

async function maybeRefineNote<T extends UploadAnalysis>(
  analysis: T,
  facts: Record<string, unknown>,
  checks: Array<string | null>,
  useLlm: boolean
): Promise<T> {
  if (!useLlm) return analysis;
  return refineNote(analysis, facts, checks);
}

function workToken(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("снег")) return "снег";
  if (lower.includes("демонтаж")) return "демонтаж";
  if (lower.includes("сва")) return "сва";
  if (lower.includes("знак")) return "знак";
  if (lower.includes("бурен")) return "бурен";
  return name.slice(0, 24) || null;
}

export async function analyzeUpload(
  fileName: string,
  fileType: string,
  buf: Buffer,
  options: AnalyzeUploadOptions = {}
): Promise<UploadAnalysis> {
  const useLlm = Boolean(options.useLlm);
  if (fileType === "xlsx" || fileName.toLowerCase().endsWith(".xlsx")) {
    try {
      const parsed = await parseGrandBuffer(buf);
      if (parsed) {
        const analysis = analysisFromGrand(parsed, fileName);
        const largest = [...parsed.positions]
          .map((position) => ({
            code: position.code,
            name: position.name,
            unit: position.unit,
            quantity: position.quantity,
            rate: position.rate,
            amount: Math.round(position.quantity * position.rate * 100) / 100,
          }))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
          .slice(0, 5);
        return maybeRefineNote(
          analysis,
          {
            kind: "local-estimate",
            fileName,
            profile: GRAND_PROFILE,
            product: parsed.product,
            normatives: parsed.normatives,
            orders: parsed.orders,
            indexes: parsed.indexes,
            wages: parsed.wages,
            region: parsed.region,
            zone: parsed.zone,
            construction: parsed.construction,
            objectName: parsed.objectName,
            estimateNumber: parsed.estimateNumber,
            workName: parsed.workName,
            basis: parsed.basis,
            method: parsed.method,
            priceYear: parsed.priceYear,
            costThousand: parsed.costCurrentThousand,
            costBaseThousand: parsed.costBaseThousand,
            totalCurrentRub: parsed.totalCurrent,
            positionCount: parsed.positions.length,
            sections: parsed.sections.slice(0, 8),
            negativePositions: parsed.negativePositions,
            coefficientNotes: parsed.coefficientNotes.slice(0, 3),
            largest,
            profileMatch: analysis.analysis.profileMatch,
          },
          [
            "зона 5",
            parsed.costCurrentThousand == null
              ? null
              : Math.abs(parsed.costCurrentThousand) >= 1
                ? String(Math.trunc(parsed.costCurrentThousand))
                : "0,12",
            String(parsed.positions.length),
            workToken(parsed.workName),
          ],
          useLlm
        );
      }
    } catch {
      try {
        return await analyzeGenericWorkbook(fileName, buf);
      } catch {
        return unrecognized(fileName, "Файл Excel повреждён или это не книга .xlsx.");
      }
    }
    return analyzeGenericWorkbook(fileName, buf);
  }
  if (fileType === "docx" || fileName.toLowerCase().endsWith(".docx")) {
    const { analysisFromDocx, parseDocxBuffer } = await import(
      "@/server/docx-parse"
    );
    const docx = await parseDocxBuffer(buf);
    if (!docx) {
      return unrecognized(
        fileName,
        "DOCX повреждён или не содержит word/document.xml."
      );
    }
    const analysis = analysisFromDocx(fileName, docx);
    return maybeRefineNote(
      analysis,
      {
        kind: "docx",
        fileName,
        paragraphCount: docx.paragraphs.length,
        zone: analysis.analysis.zone,
        costThousand: analysis.analysis.costThousand,
        sourceVersion: docx.sourceVersion,
      },
      [
        analysis.analysis.zone || null,
        analysis.analysis.workName || null,
        analysis.analysis.costThousand != null
          ? String(Math.trunc(analysis.analysis.costThousand))
          : null,
      ],
      useLlm
    );
  }
  if (fileType === "doc" || fileName.toLowerCase().endsWith(".doc")) {
    const { analysisFromDocx, parseLegacyWordBuffer } = await import(
      "@/server/docx-parse"
    );
    const legacyDoc = await parseLegacyWordBuffer(buf);
    if (!legacyDoc) {
      return unrecognized(fileName, "Не удалось прочитать двоичный Word .doc.");
    }
    const analysis = analysisFromDocx(fileName, legacyDoc);
    return maybeRefineNote(
      analysis,
      {
        kind: "doc",
        fileName,
        paragraphCount: legacyDoc.paragraphs.length,
        zone: analysis.analysis.zone,
        costThousand: analysis.analysis.costThousand,
        sourceVersion: legacyDoc.sourceVersion,
      },
      [
        analysis.analysis.zone || null,
        analysis.analysis.workName || null,
        analysis.analysis.costThousand != null
          ? String(Math.trunc(analysis.analysis.costThousand))
          : null,
      ],
      useLlm
    );
  }
  const imageExtension = fileName.toLowerCase().match(/\.(png|jpe?g|webp|tiff?|bmp)$/)?.[1];
  if (imageExtension) {
    const mimeHint = imageExtension === "jpg" ? "image/jpeg" :
      imageExtension.startsWith("jpeg") ? "image/jpeg" :
        imageExtension === "tif" || imageExtension === "tiff" ? "image/tiff" :
          `image/${imageExtension}`;
    const ocr = await extractDocumentText({ fileName, buffer: buf, mimeHint });
    const scan = analysisFromScan(fileName, ocr);
    return maybeRefineNote(
      scan,
      {
        kind: "image-scan",
        fileName,
        mimeHint,
        textLayer: Boolean(ocr.text),
        ocrStatus: ocr.status,
        ocrSnippet: (ocr.text ?? "").slice(0, 400),
      },
      ocr.text ? [ocr.text.slice(0, 24)] : [],
      useLlm
    );
  }
  if (fileType === "pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    const ocr = await extractDocumentText({
      fileName,
      buffer: buf,
      mimeHint: "application/pdf",
    });
    if (isKmDrawingFileName(fileName)) {
      const analysis = analysisFromDrawing(fileName, ocr.pageCount ?? 24);
      if (ocr.status === "not_configured" || !ocrConfigured()) {
        analysis.highlights = [
          ...analysis.highlights,
          {
            id: "h-ocr",
            text: "OCR не сконфигурирован",
            reason: ocr.reason,
            severity: "info",
            page: 1,
          },
        ];
      } else if (ocr.text) {
        analysis.analyticalNote = `${analysis.analyticalNote}\nOCR (${ocr.provider}): ${ocr.text.slice(0, 400)}`;
        analysis.citations = [
          ...analysis.citations,
          {
            id: "c-ocr",
            text: ocr.text.slice(0, 160),
            page: 1,
            sourceFile: fileName,
          },
        ];
      }
      return maybeRefineNote(
        analysis,
        {
          kind: "drawing",
          fileName,
          profile: GRAND_PROFILE,
          pages: ocr.pageCount ?? 24,
          textLayer: Boolean(ocr.text),
          ocrStatus: ocr.status,
          profileMatch: analysis.analysis.profileMatch,
        },
        [GRAND_PROFILE.drawing, "текст"],
        useLlm
      );
    }
    // Ordinary scans: keep OCR text/citations; never pretend KM profile match.
    const scan = analysisFromScan(fileName, ocr);
    return maybeRefineNote(
      scan,
      {
        kind: "scan",
        fileName,
        pages: ocr.pageCount ?? 1,
        textLayer: Boolean(ocr.text),
        ocrStatus: ocr.status,
        ocrSnippet: (ocr.text ?? "").slice(0, 400),
      },
      ocr.text ? [ocr.text.slice(0, 24)] : [],
      useLlm
    );
  }
  return unrecognized(
    fileName,
    `Формат не входит в обмен ${GRAND_PROFILE.vendor}. Эталон — локальная смета .xlsx, договор/ТЗ .docx (цитаты по абзацам) и чертёж КМ .pdf по шифру ${GRAND_PROFILE.cipher}. Произвольные сканы PDF разбираются через локальный OCR.`
  );
}

/** Stamp every citation with a document/source version label (chain coverage). */
export function stampCitationSourceVersion(
  citations: Citation[],
  sourceVersion: string
): Citation[] {
  return citations.map((c) => ({
    ...c,
    sourceVersion: c.sourceVersion ?? sourceVersion,
  }));
}

function unrecognized(fileName: string, reason: string): UploadAnalysis {
  return {
    title: fileName.replace(/\.[^.]+$/, ""),
    analyticalNote: reason,
    citations: [],
    highlights: [
      {
        id: "h-form",
        text: "Форма не совпала с эталоном",
        reason,
        severity: "warning",
        page: 1,
      },
    ],
    status: "trebuet_proverki",
    positions: [],
    analysis: {
      vendor: GRAND_PROFILE.vendor,
      region: "",
      zone: "",
      estimateNumber: "",
      workName: "",
      basis: "",
      priceLevel: "",
      costThousand: null,
      positionCount: 0,
      profileMatch: false,
    },
  };
}

/** Read ordinary XLSX workbooks as source material when they are not GRAND-Smeta exports. */
async function analyzeGenericWorkbook(fileName: string, buf: Buffer): Promise<UploadAnalysis> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const rows: Array<{ sheet: string; row: number; text: string; lastCol: number; priority: number }> = [];
  const positions: GrandPosition[] = [];
  const preferredMaterialPositions: GrandPosition[] = [];

  for (const ws of wb.worksheets) {
    let header: { name?: number; unit?: number; quantity?: number; rate?: number; code?: number; preferredMaterials?: boolean } | null = null;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber > 5000) return;
      const cells: Array<{ col: number; text: string; value: ExcelJS.CellValue }> = [];
      row.eachCell((cell, col) => {
        if (col > 40) return;
        const value = cell.value;
        const text = cellText(value);
        if (text) cells.push({ col, text, value });
      });
      if (!cells.length) return;
      const joined = cells.map(({ col, text }) => `${colLetter(col)}: ${text}`).join(" · ").slice(0, 1200);
      const plain = cells.map((cell) => cell.text).join(" ");
      const priority =
        (/материал/i.test(ws.name) ? 30 : /ресурсный.?график/i.test(ws.name) ? 20 : 0) +
        (/заказчик|срок|оплат|аванс|штраф|пени|неустойк|договор|итого|сметная стоимость/i.test(plain) ? 5 : 0) +
        (/работ|материал|ресурс|график|объем|объём/i.test(plain) ? 2 : 0) +
        (rowNumber <= 10 ? 1 : 0);
      rows.push({ sheet: ws.name, row: rowNumber, text: joined, lastCol: cells.at(-1)!.col, priority });

      if (!header) {
        const normalized = cells.map((cell) => cell.text.toLocaleLowerCase("ru-RU").replace(/ё/g, "е"));
        const find = (pattern: RegExp) => cells.find((cell, index) => pattern.test(normalized[index]))?.col;
        const name = find(/материал\s*\/\s*конструкц/) ?? find(/наименование\s*(работ|материал|ресурс)?/);
        const quantity = find(/кол-во\s*для\s*цены|колич|объем|объём|quantity|qty/);
        const unit = find(/ед\.\s*цены|единиц|^ед\.?$|unit/);
        const rate = find(/цена\s*за\s*ед|ставка|тариф|price|rate/);
        const code = find(/код\s*вор|шифр|^код$|code/);
        const preferredMaterials = ws.name.trim().toLocaleLowerCase("ru-RU") === "материалы" &&
          cells.some((cell) => /материал\s*\/\s*конструкц/i.test(cell.text)) &&
          cells.some((cell) => /кол-во\s*для\s*цены/i.test(cell.text));
        if (name && quantity && unit) header = { name, quantity, unit, rate, code, preferredMaterials };
        return;
      }
      if (positions.length >= 2000) return;
      const name = cellText(row.getCell(header.name!).value);
      const quantity = asNumber(row.getCell(header.quantity!).value);
      const unit = cellText(row.getCell(header.unit!).value);
      if (!name || quantity == null || quantity <= 0 || !unit) return;
      const rate = header.rate ? asNumber(row.getCell(header.rate).value) : null;
      const position = {
        code: header.code ? cellText(row.getCell(header.code).value) : "",
        name,
        unit,
        quantity,
        rate: rate ?? 0,
      };
      if (header.preferredMaterials) preferredMaterialPositions.push(position);
      else positions.push(position);
    });
  }

  // Keep source citations bounded and prioritize terms users need for a bid decision.
  const selected = rows
    .sort((a, b) => b.priority - a.priority || a.row - b.row)
    .slice(0, 80);
  const selectedPositions = preferredMaterialPositions.length
    ? preferredMaterialPositions
    : positions;
  const citations = selected.map((item, index): Citation => ({
    id: `c-xlsx-${index + 1}`,
    text: item.text,
    page: 1,
    sourceFile: fileName,
    sheet: item.sheet,
    cell: `A${item.row}:${colLetter(item.lastCol)}${item.row}`,
    confidence: "heuristic",
  }));
  const title = fileName.replace(/\.[^.]+$/, "");
  const sheets = wb.worksheets.map((sheet) => sheet.name);
  const reason = "Книга прочитана как обычный Excel. Сметная методика ГРАНД-Сметы не подтверждена; суммы и тарифы проверьте по исходному файлу.";
  return {
    title,
    analyticalNote: `${reason}\nЛистов: ${sheets.length}; строк-источников: ${citations.length}; распознанных строк таблиц: ${selectedPositions.length}.`,
    citations,
    highlights: [{ id: "h-xlsx-generic", text: "Нестандартная книга Excel", reason, severity: "warning", page: 1 }],
    status: "trebuet_proverki",
    analysis: {
      vendor: "Microsoft Excel",
      region: "",
      zone: "",
      estimateNumber: "",
      workName: "",
      basis: "",
      priceLevel: "",
      costThousand: null,
      positionCount: selectedPositions.length,
      profileMatch: false,
    },
    positions: selectedPositions,
  };
}
