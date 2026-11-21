/** Strip supplier names, API wording and masked-field diagnostics from toasts. */
export function plainUserMessage(message: string, fallback = "Не удалось выполнить действие. Повторите позже."): string {
  const text = message.trim();
  if (!text) return fallback;
  if (/внешн\p{L}*\s+номер|id закупки|нет подтверждённого id/iu.test(text)) {
    return "Для этой карточки нет внешнего номера закупки";
  }
  if (/контур|api[-\s]?ключ|замаскир|\bapi\b|purchase|openrouter/iu.test(text)) {
    return "Поиск закупок сейчас недоступен";
  }
  return text;
}
