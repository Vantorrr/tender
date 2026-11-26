/**
 * User-facing wording for calculation and GPR issue codes.
 * Raw codes (missing_tariff:res-…, vat_percent_rate, …) must never be shown.
 */
import { plainPositionName } from "@/lib/format";

const NAMED: Array<[RegExp, (name: string) => string]> = [
  [/^missing_tariff(?::|$)/u, (name) => (name ? `Нет ставки для: ${name}` : "Нет ставки")],
  [/^customer_rate:/u, (name) => (name ? `нет расценки заказчика для: ${name}` : "нет расценки заказчика")],
  [/^materials_positions$/u, () => "Не учтены позиции материалов"],
  [/^quantity:/u, (name) => (name ? `Не указано количество: ${name}` : "Не указано количество")],
  [/^customer_estimate_missing$/u, () => "Исходная смета заказчика не загружена"],
  [/^missing_rate:/u, (name) => (name ? `Нет ставки для: ${name}` : "Нет ставки")],
  [/^rate:/u, (name) => (name ? `Нет ставки для: ${name}` : "Нет ставки")],
  [/^hours_per_shift_unknown(?::|$)/u, (name) => (name ? `Не указаны часы в смене: ${name}` : "Не указаны часы в смене")],
  [/^shifts_per_day_unknown(?::|$)/u, (name) => (name ? `Не указаны смены в сутки: ${name}` : "Не указаны смены в сутки")],
  [/^days_unknown(?::|$)/u, (name) => (name ? `Не указана длительность: ${name}` : "Не указана длительность")],
  [/^unit_basis_uncertain(?::|$)/u, (name) => (name ? `Неясно, как считать количество: ${name}` : "Неясно, как считать количество")],
  [/^hours_inputs(?::|$)/u, (name) => (name ? `Не хватает данных для часов: ${name}` : "Не хватает данных для часов")],
  [/^resource_facts:/u, (name) => (name ? `Нет факта по ресурсам: ${name}` : "Нет факта по ресурсам")],
  [/^north:/u, (name) => (name ? `Не подтверждена северная надбавка: ${name}` : "Не подтверждена северная надбавка")],
  [/^unclassified:/u, (name) => (name ? `Ресурс не разобран: ${name}` : "Ресурс не разобран")],
];

function tailName(code: string, names?: Map<string, string>): string {
  const colon = code.indexOf(":");
  if (colon < 0) return "";
  const rest = code.slice(colon + 1);
  const id = rest.split(":")[0] ?? "";
  const lookedUp = names?.get(rest) ?? names?.get(id);
  if (lookedUp) return lookedUp;
  if (/[а-яё]/iu.test(rest)) return plainPositionName(rest);
  const plain = plainPositionName(rest);
  if (plain !== rest) return plain;
  if (/^(res|cp|gs|urp|draft|source|pay|mat|lab|eq|bus)-/iu.test(id) || /^[0-9a-f-]{8,}$/iu.test(id)) {
    return "";
  }
  if (/^[a-z0-9_:-]+$/iu.test(rest)) return "";
  return rest;
}

export function humanizeIssue(code: string, names?: Map<string, string>): string {
  const raw = code.trim();
  if (!raw) return "Нужно проверить исходные данные";
  if (raw === "vat_percent" || raw === "vat_percent_rate" || raw.startsWith("vat_percent")) {
    return "Не указана ставка НДС";
  }
  if (raw === "margin_rate_must_be_in_[0,1)" || raw.startsWith("margin_rate")) {
    return "Наценка должна быть от 0 до 100%";
  }
  if (raw === "materials_external_or_missing") return "Материалы не учтены в итоге";
  if (raw === "no_commercial_rows") return "Нет коммерческих строк со ставками";
  if (raw === "incomplete" || raw === "rate") return "Нет ставки";
  for (const [pattern, label] of NAMED) {
    if (pattern.test(raw)) return label(tailName(raw, names));
  }
  if (/[а-яё]/iu.test(raw) && !/[_:]/.test(raw)) return raw;
  return "Нужно проверить исходные данные";
}

export function humanizeIssues(codes: string[], names?: Map<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const text = humanizeIssue(code, names);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}
