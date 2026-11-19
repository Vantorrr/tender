/** Strip supplier names, API wording and masked-field diagnostics from toasts. */
export function plainUserMessage(message: string, fallback = "Не удалось выполнить действие. Повторите позже."): string {
  const text = message.trim();
  if (!text) return fallback;
  if (/контур|api[-\s]?ключ|замаскир|\bapi\b|purchase|openrouter/iu.test(text)) return fallback;
  return text;
}
