/** Демо-пароли для UI/recovery (в БД хранятся scrypt-хеши). */
export const DEMO_ACCOUNTS = [
  {
    email: "super@tenderkontur.ru",
    password: "Super123!",
    role: "Суперадмин",
  },
  {
    email: "ruk@alfastroy.ru",
    password: "Ruk123!",
    role: "Руководитель",
  },
  {
    email: "tender@alfastroy.ru",
    password: "Tender123!",
    role: "Тендерный специалист",
  },
  {
    email: "smeta@alfastroy.ru",
    password: "Smeta123!",
    role: "Сметчик / экономист",
  },
  {
    email: "object@alfastroy.ru",
    password: "Object123!",
    role: "Ответственный за объект",
  },
  {
    email: "admin@alfastroy.ru",
    password: "Admin123!",
    role: "Администратор",
  },
  {
    email: "tender@betain.ru",
    password: "Beta123!",
    role: "Тендер (БетаИнжиниринг)",
  },
] as const;

export function demoPasswordFor(email: string): string | undefined {
  return DEMO_ACCOUNTS.find(
    (a) => a.email.toLowerCase() === email.trim().toLowerCase()
  )?.password;
}
