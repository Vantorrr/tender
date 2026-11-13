import type { Role, SectionKey } from "./types";

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "Суперадмин",
  rukovoditel: "Руководитель",
  tender: "Тендерный специалист",
  smetchik: "Сметчик / экономист",
  otvetstvennyy: "Ответственный за объект",
  admin: "Администратор",
};

export const SECTION_LABELS: Record<SectionKey, string> = {
  zakupki: "Закупки",
  dokumenty: "Документы",
  raschety: "Расчёты",
  gpr: "ГПР",
  dengi: "Деньги",
  riski: "Риски",
  proizvodstvo: "Производство",
  spravochniki: "Справочники",
  polzovateli: "Пользователи и настройки",
  admin: "Администрирование",
  instrukciya: "Инструкция",
  obmen: "Обмен со сметным ПО",
};

export const ALL_SECTIONS: SectionKey[] = [
  "zakupki",
  "dokumenty",
  "raschety",
  "gpr",
  "dengi",
  "riski",
  "proizvodstvo",
  "spravochniki",
  "polzovateli",
  "admin",
  "instrukciya",
  "obmen",
];

export const DEFAULT_SECTIONS: Record<Role, SectionKey[]> = {
  superadmin: [...ALL_SECTIONS],
  rukovoditel: [
    "zakupki",
    "dokumenty",
    "raschety",
    "gpr",
    "dengi",
    "riski",
    "proizvodstvo",
    "spravochniki",
    "instrukciya",
    "obmen",
  ],
  tender: [
    "zakupki",
    "dokumenty",
    "raschety",
    "riski",
    "spravochniki",
    "instrukciya",
  ],
  smetchik: [
    "dokumenty",
    "raschety",
    "gpr",
    "dengi",
    "spravochniki",
    "instrukciya",
    "obmen",
  ],
  otvetstvennyy: [
    "zakupki",
    "dokumenty",
    "gpr",
    "proizvodstvo",
    "riski",
    "instrukciya",
  ],
  admin: [
    "zakupki",
    "dokumenty",
    "spravochniki",
    "polzovateli",
    "admin",
    "instrukciya",
  ],
};

export const STATUS_LABELS = {
  zagruzheno: "Загружено",
  // Plain space for titles/ARIA; StatusBadge renders «В»+gap+«работе» for chips.
  v_rabote: "В работе",
  gotovo: "Готово",
  trebuet_proverki: "Требует проверки",
  oshibka: "Ошибка",
} as const;

export const REVIEW_LABELS = {
  novaya: "Новая",
  na_rassmotrenii: "На рассмотрении / в работе",
  odobrena: "Участвуем",
  otklonena: "Не участвуем",
  dublirovana: "Дубликат",
} as const;

export const PARTICIPATE_RECOMMENDATION_LABELS = {
  participate: "Участвовать (условно)",
  do_not_participate: "Не участвовать (условно)",
  insufficient_data: "Недостаточно данных",
} as const;

export const REMARK_STATUS_LABELS = {
  otkryto: "Открыто",
  v_rabote: "В работе",
  zakryto: "Закрыто",
  prinyato: "Принято",
} as const;

export const SEVERITY_LABELS = {
  low: "Низкая",
  medium: "Средняя",
  high: "Высокая",
  info: "Информация",
  warning: "Внимание",
  critical: "Критично",
} as const;

export const SYNC_STATUS_LABELS = {
  aktualno: "Актуально",
  ustarelo: "Данные устарели",
  oshibka_sinhronizacii: "Ошибка синхронизации",
} as const;

export const SCENARIO_LABELS = {
  bazovyy: "Базовый",
  optimisticheskiy: "Оптимистичный",
  pessimisticheskiy: "Пессимистичный",
} as const;

export const PERIOD_LABELS = {
  all: "Весь период",
  week: "По неделям",
  month: "По месяцам",
} as const;

export const JOB_STATUS_LABELS: Record<string, string> = {
  running: "Выполняется",
  done: "Готово",
  error: "Ошибка",
  failed: "Ошибка",
  pending: "В очереди",
};

export const JOB_TYPE_LABELS: Record<string, string> = {
  procurement_sync: "Синхронизация закупок",
  document_reanalyze: "Повторный разбор документа",
};

export const ACTION_LABELS: Record<string, string> = {
  create: "Создание",
  update: "Изменение",
  role_change: "Смена роли",
  review: "Рассмотрение",
  reanalyze: "Повторный разбор",
  upload: "Загрузка",
  directory: "Справочник",
  import: "Импорт",
  confirm: "Подтверждение",
  parse: "Разбор",
  reset: "Сброс",
  activate: "Включение",
  deactivate: "Отключение",
  issue_secret_key: "Выдача ключа",
};

export const ENTITY_LABELS: Record<string, string> = {
  user: "Пользователь",
  organization: "Организация",
  procurement: "Закупка",
  calculation: "Расчёт",
  document: "Документ",
  gpr: "ГПР",
  money: "Деньги",
  risk: "Риски",
  planfact: "План/факт",
  directory: "Справочник",
  smeta: "Обмен",
  system: "Система",
};

const CODE_LABELS: Record<string, string> = {
  ...STATUS_LABELS,
  ...REVIEW_LABELS,
  ...REMARK_STATUS_LABELS,
  ...SEVERITY_LABELS,
  ...SYNC_STATUS_LABELS,
  ...SCENARIO_LABELS,
  ...ACTION_LABELS,
  ...ENTITY_LABELS,
  ...JOB_STATUS_LABELS,
  ...JOB_TYPE_LABELS,
};

export function labelOf(code: string | null | undefined, fallback = ""): string {
  if (!code) return fallback;
  return CODE_LABELS[code] ?? fallback;
}

export function humanizeCodes(text: string): string {
  return text.replace(/\b[a-z][a-z0-9_]*\b/g, (token) => CODE_LABELS[token] ?? token);
}
