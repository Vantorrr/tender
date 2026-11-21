export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Не указано";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: digits,
  }).format(value);
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
  const key = code.trim().toLocaleUpperCase("ru-RU");
  if (PLAIN_POSITION_CODES[key]) return PLAIN_POSITION_CODES[key];
  if (/^(?:res|cp|urp|draft|source|gs|pay)-/iu.test(code) || (code.length > 24 && !/[а-яё]/iu.test(code))) return "";
  return code;
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
