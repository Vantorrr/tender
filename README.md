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

| Роль | Email | Пароль | Секретный ключ |
|------|-------|--------|----------------|
| Суперадмин | `super@tenderkontur.ru` | `Super123!` | `TK-SUPER-361-IRINA` |
| Руководитель | `ruk@alfastroy.ru` | `Ruk123!` | — |
| Тендерный специалист | `tender@alfastroy.ru` | `Tender123!` | — |
| Сметчик | `smeta@alfastroy.ru` | `Smeta123!` | — |
| Ответственный | `object@alfastroy.ru` | `Object123!` | — |
| Администратор | `admin@alfastroy.ru` | `Admin123!` | `TK-ADMIN-361-ALFA` |
| Тендер (Бета) | `tender@betain.ru` | `Beta123!` | — |

Суперадмин и администратор входят и по паролю, и по секретному ключу (`POST /api/auth/login` с полем `secretKey`). Ключ хранится как scrypt-хеш. Новый ключ выдаётся в «Пользователи» и показывается один раз; смена роли с административной ключ снимает.

## Что внутри

- Cookie-сессии, CRUD API по всем модулям ЛК
- Jobs: sync закупок, re-analyze документов, recalc
- Excel/PDF export, обмен со сметным ПО (XLSX + расхождения)
- Изоляция данных организаций
- `/api/health` для мониторинга
- Клиентские справочники из XLSX (тарифы АТС/ДСМ, нормо-час, парк техники)

## Клиентские XLSX

Файлы в `fixtures/client-imports/` (и зеркало `src/lib/client-directories.json` для seed без Excel):

| Файл | Справочник | Строк |
|------|------------|------:|
| `tarify-ats-dsm-2026.xlsx` | Тарифы АТС/ДСМ (`ceny`) | 69 |
| `sebestoimost-normochas.xlsx` | Нормо-час (`rascenki`) | 57 |
| `park-tehniki.xlsx` | Парк техники (`park`) | 77 |

Профиль закупок (`profil`) не затирается парком. Расчёт «школа №12» сразу на клиентских ставках; в карточке расчёта — **Обновить из справочников** и добавление позиций из текущих версий (с выбором колонки КПИ для АТС).

```bash
npm run build:client-dirs   # пересобрать JSON из XLSX
npm run import:client       # повторный импорт в живой стенд
```

Также кнопка в `/cabinet/admin`. После сброса демо клиентские справочники поднимаются снова.

Конфиг: скопируйте `.env.example` → `.env` при необходимости.

Инструкция в продукте: `/cabinet/instrukciya`.

## Вне объёма / kickoff

- Реальный API источника тендеров  
- SSO / IdP  
- Именованный вендор сметного ПО  
- Модуль ПТО / закрывающие
