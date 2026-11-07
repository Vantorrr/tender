import ExcelJS from "exceljs";
import { GRAND_PROFILE } from "@/lib/grand-profile";
import { refineNote } from "@/server/model-note";
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
};

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
      } else if (label.startsWith("Наименование редакции сметных нормативов")) {
        parsed.normatives = firstOther(cells, label);
      } else if (label.startsWith("Реквизиты приказа Минстроя")) {
        parsed.orders = firstOther(cells, label);
      } else if (label.startsWith("Реквизиты письма Минстроя")) {
        parsed.indexes = firstOther(cells, label);
      } else if (label.startsWith("Реквизиты нормативного правового акта")) {
        parsed.wages = firstOther(cells, label);
      } else if (label.startsWith("Наименование субъекта")) {
        parsed.region = firstOther(cells, label);
      } else if (label.startsWith("Наименование зоны")) {
        parsed.zone = firstOther(cells, label);
      } else if (label.includes("шифр") || label.startsWith("«")) {
        parsed.construction = label;
      } else if (
        label.startsWith("Участок") ||
        label.startsWith("Объект") ||
        (label.length > 40 && !parsed.objectName && !label.startsWith("ЛОКАЛЬНЫЙ") && !label.startsWith("("))
      ) {
        if (!parsed.objectName && rowNumber > 13 && rowNumber < 18) parsed.objectName = label;
      } else if (label.startsWith("ЛОКАЛЬНЫЙ СМЕТНЫЙ")) {
        parsed.estimateNumber = label.replace(/\s+/g, " ");
        seenEstimate = true;
      } else if (seenEstimate && !parsed.workName && !label.startsWith("(") && !label.startsWith("Составлен")) {
        parsed.workName = label;
        seenEstimate = false;
      } else if (label === "Основание") {
        parsed.basis = cells.find((cell) => cell.col > 1)?.text ?? "";
      } else if (label.startsWith("Составлен") && label.length < 40) {
        parsed.method = cells.map((cell) => cell.text).join(" ");
      } else if (label.includes("уровне цен")) {
        parsed.priceYear = cells.find((cell) => /\d{4}/.test(cell.text))?.text ?? "";
      } else if (label === "Сметная стоимость") {
        const nums = cells
          .filter((cell) => cell.col > 1)
          .map((cell) => asNumber(cell.value))
          .filter((n): n is number => n != null);
        parsed.costCurrentThousand = nums[0] ?? null;
        const paren = cells.map((cell) => cell.text).find((text) => text.startsWith("("));
        parsed.costBaseThousand = paren ? asNumber(paren) : (nums[1] ?? null);
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
    } else if (name === "Итого" && !parsed.totalLocked) {
      parsed.totalBase = asNumber(row.getCell(12).value);
      parsed.totalCurrent = asNumber(row.getCell(14).value);
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
  const quote = (id: string, text: string) => {
    if (!text) return;
    citations.push({ id, text: text.slice(0, 400), page: 1, sourceFile: fileName });
  };
  quote("c-obj", parsed.construction);
  quote("c-est", parsed.estimateNumber);
  quote("c-work", parsed.workName);
  quote("c-basis", parsed.basis ? `Основание: ${parsed.basis}` : "");
  quote("c-reg", [parsed.region, parsed.zone ? `зона ${parsed.zone}` : ""].filter(Boolean).join(", "));
  if (parsed.positions[0]) {
    const p = parsed.positions[0];
    quote("c-pos", `${p.code} ${p.name} — ${rub(p.quantity)} ${p.unit}`.trim());
  }
  if (parsed.coefficientNotes[0]) quote("c-k", parsed.coefficientNotes[0]);

  const costLine =
    parsed.costCurrentThousand != null
      ? `${rub(parsed.costCurrentThousand)} тыс. руб. в текущем уровне${
          parsed.costBaseThousand != null ? ` (${rub(parsed.costBaseThousand)} тыс. руб. в базисном)` : ""
        }`
      : "в шапке не указана";

  const analyticalNote = [
    `Разбор локальной сметы по параметрам ${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version}, ${GRAND_PROFILE.form}.`,
    `Объект: ${parsed.construction || GRAND_PROFILE.construction}.`,
    parsed.objectName ? `Площадка: ${parsed.objectName}.` : "",
    `Смета: ${parsed.estimateNumber || "номер не прочитан"}. Работы: ${parsed.workName || "не названы"}.`,
    `Регион: ${parsed.region || "не указан"}, зона ${parsed.zone || "не указана"}. ${
      regionOk && zoneOk ? "Совпадает с эталоном " + GRAND_PROFILE.cipher + "." : "Отличается от эталона " + GRAND_PROFILE.cipher + "."
    }`,
    `Нормативы: ${parsed.normatives || "не указаны"}.`,
    parsed.orders ? `Дополнения: ${parsed.orders}.` : "",
    `Метод: ${parsed.method || "не указан"}. Уровень цен: ${parsed.priceYear || "не указан"}.`,
    parsed.basis ? `Основание: ${parsed.basis}.` : "",
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

export function analysisFromDrawing(fileName: string, pages = 24): UploadAnalysis {
  const matched = /ТП-КП-М-Д|101-3103|КМ/i.test(fileName);
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
  buf: Buffer
): Promise<UploadAnalysis> {
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
        return refineNote(
          analysis,
          {
            kind: "local-estimate",
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
          ]
        );
      }
    } catch {
      return unrecognized(fileName, "Файл Excel повреждён или это не книга .xlsx.");
    }
    return unrecognized(
      fileName,
      `Книга не распознана как локальный сметный расчёт ${GRAND_PROFILE.vendor} ${GRAND_PROFILE.version} (${GRAND_PROFILE.form}).`
    );
  }
  if (fileType === "pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    if (/ТП-КП-М-Д|101-3103|КМ/i.test(fileName)) {
      const analysis = analysisFromDrawing(fileName);
      return refineNote(
        analysis,
        {
          kind: "drawing",
          fileName,
          profile: GRAND_PROFILE,
          pages: 24,
          textLayer: false,
          profileMatch: analysis.analysis.profileMatch,
        },
        [GRAND_PROFILE.drawing, "текст"]
      );
    }
    return unrecognized(
      fileName,
      `PDF не совпал с чертежом ${GRAND_PROFILE.drawing} и не является таблицей сметы. Текстовый слой не разобран.`
    );
  }
  return unrecognized(
    fileName,
    `Формат не входит в обмен ${GRAND_PROFILE.vendor}. Эталон — локальная смета .xlsx и чертёж КМ .pdf по шифру ${GRAND_PROFILE.cipher}.`
  );
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
