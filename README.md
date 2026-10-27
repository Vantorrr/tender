# ТендерКонтур (TMA361)

Веб-платформа отбора строительных тендеров по договору № TMA361 (26.10.2026).

Стек: **Next.js (App Router) · TypeScript · Tailwind · shadcn/ui · SQLite (`node:sqlite`)**.

Серверные cookie-сессии, CRUD API по всем модулям, jobs синхронизации/разбора, Excel/PDF export. Данные в `data/tenderkontur.sqlite` (создаётся при первом запуске).

## Запуск

```bash
npm install
npm run dev
```

Откройте [http://127.0.0.1:43141](http://127.0.0.1:43141).

## Демо-учётки

| Роль | Email | Пароль |
|------|-------|--------|
| Суперадмин | `super@tenderkontur.ru` | `Super123!` |
| Руководитель | `ruk@alfastroy.ru` | `Ruk123!` |
| Тендерный специалист | `tender@alfastroy.ru` | `Tender123!` |
| Сметчик / экономист | `smeta@alfastroy.ru` | `Smeta123!` |
| Ответственный за объект | `object@alfastroy.ru` | `Object123!` |
| Администратор | `admin@alfastroy.ru` | `Admin123!` |
| Тендер (орг. Бета) | `tender@betain.ru` | `Beta123!` |

Инструкция: `/cabinet/instrukciya`. Аудит ТЗ: `internal/tma361-tz-audit.md` в Project store.

## API (кратко)

- `POST /api/auth/login|logout|recover`, `GET /api/auth/me`
- `GET /api/bootstrap` — данные с изоляцией по организации
- CRUD: `/api/zakupki`, `/dokumenty`, `/raschety`, `/gpr`, `/dengi`, `/riski`, `/proizvodstvo`, `/spravochniki`, `/users`, `/admin`, `/smeta`
- Jobs: `POST /api/jobs` (`procurement_sync`, `document_reanalyze`)
- Export: `GET /api/export?kind=calc-xlsx|calc-pdf|money-xlsx|gpr-xlsx|risks-xlsx|planfact-xlsx|smeta-xlsx|dir-template`

Вне объёма: ПТО / полный комплект закрывающих; реальный API источника тендеров.
