"use client";

import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ROLE_LABELS } from "@/lib/roles";

const scenarios = [
  {
    n: 1,
    title: "Авторизация и роли",
    route: "/login",
    steps:
      "Войдите под демо-учёткой. Суперадмин управляет пользователями, правами разделов и историей ролей в «Пользователи».",
  },
  {
    n: 2,
    title: "Навигация по разделам",
    route: "/cabinet",
    steps:
      "В боковом меню доступны: Закупки, Документы, Расчёты, ГПР, Деньги, Риски, Производство, Справочники, Пользователи, Админ — в зависимости от роли.",
  },
  {
    n: 3,
    title: "Карточки и уведомления",
    route: "/cabinet",
    steps:
      "Карточки закупок/документов/расчётов/объектов показывают статусы. Колокольчик в шапке — внутриприложенческие уведомления.",
  },
  {
    n: 4,
    title: "Справочники",
    route: "/cabinet/spravochniki",
    steps:
      "Нормы, расценки, цены, профиль закупок. Скачайте шаблон, выполните импорт Excel, переключите текущую версию — расчёты ссылаются на неё.",
  },
  {
    n: 5,
    title: "Закупки",
    route: "/cabinet/zakupki",
    steps:
      "Лента, фильтры, карточка со вложениями, дедупликация (p-3), статусы рассмотрения, баннер синхронизации источника.",
  },
  {
    n: 6,
    title: "Документы",
    route: "/cabinet/dokumenty/d-1",
    steps:
      "Загрузка PDF/DOCX/XLSX, аналитическая записка с цитатами, подсветки для ручной проверки, версии, повторный разбор, экспорт записки.",
  },
  {
    n: 7,
    title: "Черновой расчёт",
    route: "/cabinet/raschety/c-1",
    steps:
      "Позиции из справочников, итоги, допущения, сценарии и пересчёт, решение об участии, экспорт Excel/PDF.",
  },
  {
    n: 8,
    title: "ГПР",
    route: "/cabinet/gpr/g-1",
    steps:
      "Этапы, даты, последовательность, календарное представление, редактирование, версия, экспорт.",
  },
  {
    n: 9,
    title: "Деньги",
    route: "/cabinet/dengi",
    steps:
      "Авансы, поступления, ключевые платежи; сводка; фильтр неделя/месяц; правки названий; Excel-экспорт.",
  },
  {
    n: 10,
    title: "Риски",
    route: "/cabinet/riski",
    steps:
      "Помощник разбора договора, реестр замечаний с привязкой к тексту, статусы, решение, экспорт.",
  },
  {
    n: 11,
    title: "План/факт",
    route: "/cabinet/proizvodstvo",
    steps:
      "Проекты/объекты, план, ввод факта, отклонения, сводки, экспорт.",
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
        description="Краткий проход критериев приёмки 1–11 и демо-учётки. Модуль ПТО / закрывающие вне объёма."
      />

      <section className="mb-8 overflow-x-auto rounded-xl border border-[var(--tk-line)] bg-white/80">
        <div className="border-b border-[var(--tk-line)] px-4 py-3 font-[family-name:var(--font-display)]">
          Демо-учётки
        </div>
        <table className="w-full text-sm">
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
                <td className="px-4 py-2">
                  {ROLE_LABELS[a.role]}
                  {"note" in a && a.note ? (
                    <span className="block text-xs text-[var(--tk-muted)]">
                      {a.note}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{a.email}</td>
                <td className="px-4 py-2 font-mono text-xs">{a.password}</td>
                <td className="px-4 py-2 font-mono text-xs">{a.key || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ol className="space-y-3">
        {scenarios.map((s) => (
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
          Дополнительно
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--tk-ink-soft)]">
          <li>
            Админ-фундамент и цепочка:{" "}
            <Link className="underline" href="/cabinet/admin">
              /cabinet/admin
            </Link>
          </li>
          <li>
            Обмен со сметным ПО:{" "}
            <Link className="underline" href="/cabinet/obmen">
              /cabinet/obmen
            </Link>
          </li>
          <li>
            Данные и сессии хранятся в SQLite на сервере (`data/tenderkontur.sqlite`).
          </li>
          <li>
            Реальный API источника тендеров не подключён — используется мок
            «согласованный источник» с job-синхронизацией и статусом.
          </li>
          <li>
            Разбор документов настроен на ГРАНД-Смета 2022.3: локальная смета
            (приказ № 421), регион Красноярский край, зона 5, шифр ТП-КП-М-Д.
            Чертёж КМ.Л2 приложен как графический лист, без текстового слоя.
          </li>
        </ul>
      </section>
    </div>
  );
}
