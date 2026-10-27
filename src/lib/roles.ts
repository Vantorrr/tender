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
  v_rabote: "В работе",
  gotovo: "Готово",
  trebuet_proverki: "Требует проверки",
  oshibka: "Ошибка",
} as const;

export const REVIEW_LABELS = {
  novaya: "Новая",
  na_rassmotrenii: "На рассмотрении",
  odobrena: "Одобрена",
  otklonena: "Отклонена",
  dublirovana: "Дубликат",
} as const;
