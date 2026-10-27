# ТендерКонтур (TMA361) — под ключ

Платформа отбора строительных тендеров. Договор № TMA361 (26.10.2026).

**Стек:** Next.js App Router · TypeScript · Tailwind · shadcn/ui · SQLite (`node:sqlite`) · exceljs / pdf-lib.

## Быстрый старт

```bash
npm install
npm run setup
npm run dev
```

Откройте [http://127.0.0.1:43141](http://127.0.0.1:43141).

Проверка:

```bash
npm run doctor          # GET /api/health
```

Docker:

```bash
docker compose up --build
```

Данные живут в `data/tenderkontur.sqlite` (volume `tk_data` в Docker). Пароли в БД — scrypt-хеши. Автосинхронизация закупок — каждые 5 мин (`SYNC_INTERVAL_MS`).

## Демо-учётки

| Роль | Email | Пароль |
|------|-------|--------|
| Суперадмин | `super@tenderkontur.ru` | `Super123!` |
| Руководитель | `ruk@alfastroy.ru` | `Ruk123!` |
| Тендерный специалист | `tender@alfastroy.ru` | `Tender123!` |
| Сметчик | `smeta@alfastroy.ru` | `Smeta123!` |
| Ответственный | `object@alfastroy.ru` | `Object123!` |
| Администратор | `admin@alfastroy.ru` | `Admin123!` |
| Тендер (Бета) | `tender@betain.ru` | `Beta123!` |

## Что внутри

- Cookie-сессии, CRUD API по всем модулям ЛК
- Jobs: sync закупок, re-analyze документов, recalc
- Excel/PDF export, обмен со сметным ПО (XLSX + расхождения)
- Изоляция данных организаций
- `/api/health` для мониторинга

Конфиг: скопируйте `.env.example` → `.env` при необходимости.

Инструкция в продукте: `/cabinet/instrukciya`.

## Вне объёма / kickoff

- Реальный API источника тендеров  
- SSO / IdP  
- Именованный вендор сметного ПО  
- Модуль ПТО / закрывающие
