/**
 * Общая очистка описаний, приходит из GigaChat, Telegram, VK
 * Сохраняет <br>, заменяет </p> на переносы, чистит HTML
 */
export function cleanDescription(text: string = ''): string {
  return text
    .replace(/<p[^>]*>/gi, '')          // убираем <p>
    .replace(/<\/p>/gi, '\n')          // заменяем </p> на перенос
    .replace(/<br\s*\/?>/gi, '\n')     // <br> → перенос
    .replace(/<[^>]+>/g, '')           // удаляем все остальные теги
    .replace(/\n\s*\n/g, '\n\n')       // ограничиваем подряд идущие пустые строки
    .trim();
}

/**
 * Дополнительная чистка для VK — убираем жирный текст и тройные переносы
 * Принимает уже очищенный текст или сырое сообщение
 */
export function cleanForVK(text: string = ''): string {
  return text
    .replace(/<b>/gi, '')              // убираем <b>
    .replace(/<\/b>/gi, '')            // убираем </b>
    .replace(/\n{3,}/g, '\n\n')        // 3+ переносов → 2
    .trim();
}

/**
 * Удаляет HTML полностью (если нужен самый грубый вариант)
 */
export function removeHtml(text: string = ''): string {
  return text.replace(/<[^>]+>/g, '').trim();
}

/**
 * Универсальная нормализация: замена множественных пробелов, табов и т.п.
 */
export function normalizeSpaces(text: string = ''): string {
  return text.replace(/\s+/g, ' ').trim();
}
