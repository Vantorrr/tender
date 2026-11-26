/** Grouped rubles with kopecks: `7 677 127,06 ₽`. Display only. */
export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Не указано";
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value).replace(/[\u00a0\u202f]/g, " ");
  return `${formatted} ₽`;
}

/** Drop binary float noise, then keep a fixed number of decimal places. */
export function roundQuantity(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const normalized = Number(value.toPrecision(12));
  const factor = 10 ** digits;
  return Math.round(normalized * factor) / factor;
}

export function formatNumber(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? roundQuantity(value, digits) : value;
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: digits,
  }).format(safe);
}

/** Quantity plus unit, Russian decimal comma, no raw binary tail. */
export function formatQuantity(value: number, unit?: string, digits = 2): string {
  const text = formatNumber(value, digits);
  const clean = unit?.trim();
  return clean ? `${text} ${clean}` : text;
}

/** A real calendar day, or null when the supply has no usable date. */
export function parsedNeedBy(iso: string | null | undefined): string | null {
  if (!iso || !String(iso).trim()) return null;
  return formatDate(iso) === "не указан" ? null : iso.trim();
}

/** «к 01.12.2026», or a complete phrase when the date is empty. Never «к не указан». */
export function needByPhrase(iso: string | null | undefined): string {
  const raw = parsedNeedBy(iso);
  if (!raw) return "срок не указан";
  return `к ${formatDate(raw)}`;
}

/** True when the typed quantity is the same rounded value already on screen. */
export function sameRoundedQuantity(stored: number, draft: string, digits = 4): boolean {
  const parsed = Number(String(draft).trim().replace(",", "."));
  if (!Number.isFinite(parsed) || !Number.isFinite(stored)) return false;
  return roundQuantity(parsed, digits) === roundQuantity(stored, digits);
}

/** A supply with no date is not late. Comparison uses the stored calendar day. */
export function supplyIsOverdue(needBy: string | null | undefined, asOf: string, remaining: number): boolean {
  const raw = parsedNeedBy(needBy);
  if (!raw || !(remaining > 0)) return false;
  return raw < asOf;
}

/** A return or exclusion keeps its sign only as a difference. The quantity itself stays positive. */
export function splitSignedQuantity(quantity: number): { quantity: number; difference: number | null } {
  if (!Number.isFinite(quantity)) return { quantity: 0, difference: null };
  if (quantity < 0) return { quantity: Math.abs(quantity), difference: quantity };
  return { quantity, difference: null };
}

const PLAIN_POSITION_CODES: Record<string, string> = {
  ВОР: "Ведомость объёмов",
  ЗТ: "Затраты труда",
  ЗТМ: "Затраты труда машинистов",
  НР: "Накладные расходы",
  СП: "Сметная прибыль",
  РК: "Районный коэффициент",
  СН: "Северная надбавка",
};

/** Codes that are internal labels, not a line from the customer's estimate. */
export function visiblePositionCode(code: string): string {
  const key = code.trim().toLocaleUpperCase("ru-RU").replace(/\s+/g, "");
  if (PLAIN_POSITION_CODES[key]) return PLAIN_POSITION_CODES[key];
  if (/^(?:res|cp|urp|draft|source|gs|pay)-/iu.test(code) || (code.length > 24 && !/[а-яё]/iu.test(code))) return "";
  return code;
}

/** Labour rows stored as «ЗТ» / «ЗТм» are shown in words. Other names stay as written. */
export function plainPositionName(name: string): string {
  const key = name.trim().toLocaleUpperCase("ru-RU").replace(/\s+/g, "");
  return PLAIN_POSITION_CODES[key] ?? name;
}

/** Code and name the way the calculation table and Excel already show them. */
export function positionHeading(code: string, name: string): string {
  const shownCode = visiblePositionCode(code);
  const shownName = plainPositionName(name);
  if (!shownCode || shownCode === shownName) return shownName || shownCode;
  return `${shownCode} · ${shownName}`;
}

/** Piece counts from a norm are fractional. Show two decimals and explain the source. */
export function quantityPresentation(quantity: number, unit: string): { text: string; title?: string } {
  const piece = /^шт\.?$/iu.test(unit.trim());
  const text = formatNumber(quantity, 2);
  if (!piece || Math.abs(quantity - Math.round(quantity)) < 1e-6) return { text };
  return {
    text,
    title: `По норме сметы ${formatNumber(quantity, 4)} ${unit}. Дробь получается из нормы на единицу объёма, на экране — до 2 знаков.`,
  };
}

/** Today's calendar date in the project's operating timezone, not UTC. */
export function todayIsoInTimeZone(timeZone = "Europe/Moscow", now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Calendar day as DD.MM.YYYY (client requirement). Uses UTC noon to avoid TZ shift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso || !String(iso).trim()) return "не указан";
  const raw = iso.includes("T") ? iso.slice(0, 10) : iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return "не указан";
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "не указан";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/** Compact bar label DD.MM→DD.MM (same year omitted on end when equal). */
export function formatDateRangeShort(startIso: string, endIso: string): string {
  const a = formatDate(startIso);
  const b = formatDate(endIso);
  if (a.slice(6) === b.slice(6)) {
    return `${a.slice(0, 5)}–${b.slice(0, 5)}.${a.slice(6)}`;
  }
  return `${a}–${b}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso || !String(iso).trim()) return "не указан";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "не указан";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Parse user DD.MM.YYYY (also accepts YYYY-MM-DD) → ISO date YYYY-MM-DD or null. */
export function parseDateRu(text: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : t;
  }
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const d = new Date(`${iso}T12:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCDate() !== dd ||
    d.getUTCMonth() + 1 !== mm
  ) {
    return null;
  }
  return iso;
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function toCsv(rows: (string | number)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return s.includes(";") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(";")
    )
    .join("\n");
}
