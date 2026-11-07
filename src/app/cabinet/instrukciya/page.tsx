"use client";

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ROLE_LABELS } from "@/lib/roles";

/**
 * Критерии приёмки 1–11 из Приложения №1 к Договору TMA361 (конец ТЗ).
 * Это сценарии приёмки, не список модулей §§1–12.
 */
const acceptanceScenarios = [
  {
    n: 1,
    title: "Суперадмин создаёт пользователя, выдаёт роль; пользователь входит в ЛК",
    route: "/cabinet/polzovateli",
    steps:
      "Суперадмин (или администратор) создаёт учётную запись в «Пользователи», назначает роль и права на разделы. Новый пользователь входит через /login паролем (или секретным ключом для суперадмина/администратора).",
  },
  {
    n: 2,
    title: "Открывается лента закупок и карточка тендера (из согласованного источника)",
    route: "/cabinet/zakupki",
    steps:
      "Откройте ленту закупок, фильтры и карточку тендера со вложениями. Источник на kickoff ещё не согласован — сейчас честный stub (not_configured); синхронизация не изобретает AUTO-закупки. После подключения вендора лента берётся из согласованного источника.",
  },
  {
    n: 3,
    title: "Документы загружаются; формируется аналитическая записка",
    route: "/cabinet/dokumenty",
    steps:
      "Загрузите PDF/DOCX/XLSX. Система формирует аналитическую записку с цитатами (PDF page / DOCX абзац / XLSX sheet+cell + version), подсветками и версиями. Повторный разбор и экспорт записки — в карточке документа.",
  },
  {
    n: 4,
    title: "Черновой расчёт рассчитывается и сохраняется по справочникам Заказчика",
    route: "/cabinet/raschety",
    steps:
      "Расчёт берёт ставки из текущей версии справочников, считает итоги/НР/СП/сценарии в коде, сохраняет версию и directoryVersionId. Выгрузка Excel/PDF и решение об участии — в карточке расчёта.",
  },
  {
    n: 5,
    title:
      "Выполняется обмен со сметным ПО в согласованном на kickoff формате (выгрузка и/или загрузка)",
    route: "/cabinet/obmen",
    steps:
      "Раздел «Обмен»: выгрузка работ/объёмов в XLSX и загрузка результатов сметы, сопоставление позиций, версии, контроль расхождений, подтверждение пользователем. Ориентир — XLSX (фикстуры ГРАНД-Смета). Итоговое ПО/формат фиксируются на kickoff.",
  },
  {
    n: 6,
    title: "Создаётся и редактируется упрощённый ГПР",
    route: "/cabinet/gpr",
    steps:
      "Создайте/откройте график: этапы, сроки, последовательность, ручные правки, календарный вид, версия, выгрузка.",
  },
  {
    n: 7,
    title: "Заполняется и отображается простой денежный план",
    route: "/cabinet/dengi",
    steps:
      "Авансы, поступления, ключевые выплаты; фильтр неделя/месяц; сводка; ручные правки названий; Excel-выгрузка.",
  },
  {
    n: 8,
    title: "Формируется реестр договорных рисков-помощника",
    route: "/cabinet/riski",
    steps:
      "Загрузите/разберите текст договора. Помощник строит реестр замечаний с опорой на цитаты (не юрэкспертиза). Статусы обработки и решение сотрудника — в карточке; выгрузка реестра доступна.",
  },
  {
    n: 9,
    title: "Ведется план/факт; отображается сводка руководителю",
    route: "/cabinet/proizvodstvo",
    steps:
      "Проекты/объекты, план, ввод факта, отклонения и сводки. Руководитель видит сводку в разделе производства (и на главной кабинета).",
  },
  {
    n: 10,
    title: "Данные организаций разделены",
    route: "/cabinet/admin",
    steps:
      "Каждая организация видит только свои закупки/документы/расчёты. Проверка: пользователь org-beta не видит данные org-alfa. Журнал действий и цепочка — в админке.",
  },
  {
    n: 11,
    title: "Передана краткая инструкция по основным сценариям",
    route: "/cabinet/instrukciya",
    steps:
      "Эта страница и есть краткая инструкция по критериям приёмки 1–11. Демо-учётки ниже — для проверки сценариев на синтетических данных.",
  },
];

const accounts = [
  { role: "superadmin" as const, email: "super@tenderkontur.ru", password: "Super123!", key: "TK-SUPER-361-IRINA" },
  { role: "rukovoditel" as const, email: "ruk@alfastroy.ru", password: "Ruk123!", key: "" },
  { role: "tender" as const, email: "tender@alfastroy.ru", password: "Tender123!", key: "" },
  { role: "smetchik" as const, email: "smeta@alfastroy.ru", password: "Smeta123!", key: "" },
  { role: "otvetstvennyy" as const, email: "object@alfastroy.ru", password: "Object123!", key: "" },
  { role: "admin" as const, email: "admin@alfastroy.ru", password: "Admin123!", key: "TK-ADMIN-361-ALFA" },
  { role: "tender" as const, email: "tender@betain.ru", password: "Beta123!", key: "", note: "орг. Бета — изоляция" },
];

export default function InstrukciyaPage() {
  return (
    <div>
      <PageHeader
        title="Инструкция по основным сценариям"
        description="Критерии приёмки 1–11 из ТЗ (Приложение №1 к Договору TMA361). Приёмка — на согласованных данных Заказчика; ниже — путь проверки в кабинете."
      />

      <section className="mb-8 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
        <div className="border-b border-[var(--tk-line)] px-4 py-3 font-[family-name:var(--font-display)]">
          Учётные записи (демо)
        </div>
        <table className="tk-mobile-rows w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--tk-line)] text-left text-[var(--tk-muted)]">
              <th className="px-4 py-2 font-medium">Роль</th>
              <th className="px-4 py-2 font-medium">Логин</th>
              <th className="px-4 py-2 font-medium">Пароль</th>
              <th className="px-4 py-2 font-medium">Секретный ключ</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.email} className="border-b border-[var(--tk-line)] last:border-0">
                <td className="px-4 py-2" data-label="Роль">
                  {ROLE_LABELS[a.role]}
                  {"note" in a && a.note ? (
                    <span className="block text-xs text-[var(--tk-muted)]">
                      {a.note}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs break-all" data-label="Логин">{a.email}</td>
                <td className="px-4 py-2 font-mono text-xs" data-label="Пароль">{a.password}</td>
                <td className="px-4 py-2 font-mono text-xs break-all" data-label="Секретный ключ">{a.key || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ol className="space-y-3">
        {acceptanceScenarios.map((s) => (
          <li
            key={s.n}
            className="rounded-xl border border-[var(--tk-line)] bg-white/80 p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-[family-name:var(--font-display)] text-base">
                {s.n}. {s.title}
              </h2>
              <Link
                href={s.route}
                className="text-sm text-[var(--tk-copper-deep)] underline"
              >
                {s.route}
              </Link>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-[var(--tk-ink-soft)]">
              {s.steps}
            </p>
          </li>
        ))}
      </ol>

      <section className="mt-8 rounded-xl border border-[var(--tk-line)] bg-[linear-gradient(120deg,rgba(27,58,75,0.06),rgba(184,107,43,0.08))] p-5 text-sm">
        <h2 className="font-[family-name:var(--font-display)] text-base">
          Модули кабинета (справочно)
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--tk-ink-soft)]">
          <li>
            Администрирование, журнал, цепочка артефактов:{" "}
            <Link className="underline" href="/cabinet/admin">
              /cabinet/admin
            </Link>
          </li>
          <li>
            Справочники (нормы/расценки/цены/профиль):{" "}
            <Link className="underline" href="/cabinet/spravochniki">
              /cabinet/spravochniki
            </Link>
          </li>
          <li>
            Обмен со сметным ПО:{" "}
            <Link className="underline" href="/cabinet/obmen">
              /cabinet/obmen
            </Link>
          </li>
          <li>
            Разбор документов ориентирован на ГРАНД-Смета 2022.3 (локальная смета,
            приказ № 421). Цифры — из ячеек/абзацев/OCR; записка только по ним.
            Итоговое сметное ПО фиксируется на kickoff.
          </li>
          <li>
            Мелкие замечания по интерфейсу, не блокирующие сценарии 1–11, не
            являются основанием для отказа в приёмке (по ТЗ).
          </li>
        </ul>
      </section>
    </div>
  );
}
