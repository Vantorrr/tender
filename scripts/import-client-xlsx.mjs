#!/usr/bin/env node
/**
 * Импорт клиентских XLSX в живой стенд через API.
 * Файлы: data/client-imports/{tarify-ats-dsm-2026,sebestoimost-normochas,park-tehniki}.xlsx
 */
const port = process.env.PORT ?? "43141";
const host = process.env.HOST ?? "127.0.0.1";
const base = `http://${host}:${port}`;

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "super@tenderkontur.ru",
    password: "Super123!",
  }),
});
if (!login.ok) {
  console.error("login failed", await login.text());
  process.exit(1);
}
const { token } = await login.json();
const res = await fetch(`${base}/api/admin`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ action: "importClientXlsx" }),
});
const body = await res.json();
if (!res.ok) {
  console.error(body);
  process.exit(1);
}
console.log("OK import", body.importResult);
const dirs = body.data?.directories?.filter((d) => d.current) ?? [];
for (const d of dirs) {
  console.log(`  ${d.type} · ${d.name} · rows=${d.rows?.length ?? 0}`);
}
