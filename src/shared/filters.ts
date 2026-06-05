export function isPotentialOrder(msg: string) {
    const text = msg.toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    const strong = ['требуется', 'требуются', 'нужен', 'нужны', 'ищем', 'ищется', 'вакансия', 'вакансии'];
    for (const w of strong) if (text.includes(w)) { score += 3; reasons.push(`+kw:${w}`); }

    const pay = ['плачу', 'оплата', 'руб', '₽', 'з/п', 'зарплата'];
    for (const w of pay) if (text.includes(w)) { score += 3; reasons.push(`+pay:${w}`); }

    const timeWords = ['час', 'часа', 'день', 'дней', 'смена', 'смены', 'вечером', 'утром', 'завтра', 'послезавтра', 'сегодня'];
    for (const w of timeWords) if (text.includes(w)) { score += 2; reasons.push(`+time:${w}`); }

    const moneyRegex = /(\d[\d\s.,]*\s?(руб|р\b|₽)|\b\d{3,}\b)/i;
    if (moneyRegex.test(text)) { score += 3; reasons.push('+money'); }

    const pplRegex = /\b(\d+)\s*(человека|чел|человек|людей)\b/i;
    if (pplRegex.test(text)) { score += 2; reasons.push('+people'); }

    const timeRange = /с\s*\d{1,2}[:.]?\d{0,2}\s*(до|-)\s*\d{1,2}[:.]?\d{0,2}/i;
    if (timeRange.test(text)) { score += 2; reasons.push('+timerange'); }

    const jokewords = ['прикол', 'шутк', 'мем', 'лол', 'хаха', 'хах', 'пранк', 'смешн', 'хуй', 'хуе', 'бля', 'лох', 'лош', 'чурк', 'член', 'еблан', 'писюн', 'машонк', 'мошонк', 'гей', 'геи', 'срак', 'героин', 'гера', 'герыч', 'мефедрон', 'соль', 'прон', 'порн', 'сэкс', 'меф', 'чурок'];
    for (const w of jokewords) if (text.includes(w)) { score -= 6; reasons.push(`-joke:${w}`); }

    if (text.trim().split(/\s+/).length < 3) { score -= 2; reasons.push('-too-short'); }

    const trivial = ['привет', 'как дела', 'здорово', 'ура', 'спасибо'];
    for (const w of trivial) if (text.includes(w)) { score -= 4; reasons.push(`-trivial:${w}`); }

    if (text.length > 40) { score += 1; reasons.push('+long'); }

    const threshold = 4;
    return { ok: score >= threshold, score, reasons };
  }