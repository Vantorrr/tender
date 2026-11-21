import type { KonturSearchFilters } from "@/server/procurement-source";

/** Names shown in the form. Numeric codes stay on the server payload. */
export const SEARCH_REGIONS: Array<{ id: string; label: string }> = [
  { id: "24", label: "Красноярский край" },
  { id: "89", label: "Ямало-Ненецкий автономный округ" },
  { id: "86", label: "Ханты-Мансийский автономный округ" },
  { id: "77", label: "Москва" },
  { id: "78", label: "Санкт-Петербург" },
  { id: "50", label: "Московская область" },
  { id: "66", label: "Свердловская область" },
  { id: "54", label: "Новосибирская область" },
];

export const SEARCH_INDUSTRIES: Array<{ id: number; label: string }> = [
  { id: 20, label: "Строительные работы" },
  { id: 21, label: "Проектирование" },
  { id: 22, label: "Оборудование и материалы" },
  { id: 68, label: "Строительство" },
  { id: 17, label: "Ремонт и техобслуживание" },
  { id: 40, label: "Обслуживание и ремонт" },
];

export function withIndustries(filters: KonturSearchFilters, industries: number[]): KonturSearchFilters {
  return industries.length ? { ...filters, CategoryIds: industries } : filters;
}
