import axios from 'axios';
import * as https from 'https';

export async function parseOrderWithGigaChat(msg: string, gigaKey: string) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const authResp = await axios.post(
        'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
        'scope=GIGACHAT_API_PERS',
        {
            headers: {
                Authorization: `Basic ${gigaKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                RqUID: crypto.randomUUID(),
            },
            httpsAgent,
        },
    );

    const token = authResp.data.access_token;
    const resp = await axios.post(
        'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
        {
            model: 'GigaChat-Max',
            messages: [
                {
                    role: 'system',
                    content: `
Ты — парсер заказов. 
Ответ должен быть строго в формате JSON без лишнего текста, комментариев или объяснений.

ВАЖНЫЕ ПРАВИЛА:
Если данных нет — используй "не указано" для строк и 0 для чисел.
Нельзя придумывать значения. Используй только текст сообщения.
Особая логика почасовой записи:
Если встречается формат "400/2", "400/3", "500/4" и т.п., это значит:
- ставка 400 рублей в час
- минимальный выход 2 часа
Тогда:
paymentType = "hourly"
hours = 2 (или другое число после "/")
budget = ставка * hours (например 400*2=800)

Требуемые поля (все обязательно должны присутствовать):

{
  "title": "string", // кратко название работы (не выдумывай того, чего нету в сообщении)
  "shortDescription": "string", // короткое описание (1 предложение, максимум 10 слов)
  "description": "string", // сама суть задания, вся детальная информация
  "date": "YYYY-MM-DD", // если указано "сегодня/завтра/послезавтра" — вычисли дату относительно ${new Date().toISOString().split('T')[0]}. Если вообще ничего не написано про дату, это значит ${new Date().toISOString().split('T')[0]}.
  "startTime": "string", // время начала (например "10:00") если ничего нет, ставь 00:67, если указано условными обозначениями по типу полдень, то пиши 12:00, если написано вечером но не указано время то пиши 18:00, если указано что работа до конца дня, пиши 21:00
  "hours": number, // длительность в часах, если можно вычислить (например "с 10 до 18" = 8), иначе 0
  "address": "string", // место проведения работ
  "budget": number, // оплата на одного человека (только число) (если указано сколько платит за один час и указано сколько часов, нужно посчитать сколько человек получит суммарно), если ничего не указано, пиши -1
  "paymentType": "hourly" | "shift", // если указано "за час" — hourly, иначе shift
  "dateType": "date" | "by agreement", // если дата указана — date, если сказано "по договорённости" — by agreement. Если не сказано ничего - date
  "employer_name": "string", // ссылка на профиль (https://vk.com/... , https://t.me/... , @username) — вернуть ссылку
  "images": [], // не возвращай ничего всегда
  "type": "string", // если можно определить тип ("грузчики", "уборка", "промоутеры" и т.п.), иначе "другое"
  "applications": [] // не возвращай ничего всегда
}

Пример правильного ответа:
{
  "title": "Грузчики",
  "shortDescription": "Помощь при разгрузке фуры",
  "description": "Нужны 2 грузчика для разгрузки фуры с мебелью по адресу Сибирская 27. Начало в 10:00, примерно 6 часов работы. Оплата 2500 рублей за смену.",
  "date": "2025-10-17",
  "startTime": "10:00",
  "hours": 6,
  "address": "Сибирская 27",
  "budget": 2500,
  "paymentType": "shift",
  "dateType": "date",
  "employer_name": "https://t.me/isupmop",
  "images": [],
  "type": "грузчики",
  "applications": []
}
`
                    ,
                },
                { role: 'user', content: msg },
            ],
        },
        { headers: { Authorization: `Bearer ${token}` }, httpsAgent },
    );

    try {
        return JSON.parse(resp.data.choices[0].message.content);
    } catch {
        return { title: msg, description: msg, date: '', address: '', budget: '', hours: '' };
    }
}
