import { Logger } from '@nestjs/common';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { parseOrderWithGigaChat } from '../../shared/parser';
import { BotserviceService } from '../../botservice/botservice.service';
import { calculateEndTime } from '../../shared/time';
import { cleanDescription } from '../../shared/cleaning';
import { formatDate } from '../../shared/date';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
const db = mongo.db('freelance');
const PROVIDER_TOKEN = process.env.TG_PROVIDER_TOKEN!;
const balances = db.collection('balances');
const payments = db.collection('payments');
const TARIFFS = {
    "1": { boosts: 1, price: 100 },
    "10": { boosts: 10, price: 900 },
    "25": { boosts: 25, price: 2000 },
    "50": { boosts: 50, price: 3500 },
} as const;

async function getBoosts(userId: number): Promise<number> {
    const doc = await balances.findOne({ user_id: userId });
    if (!doc) {
        await balances.insertOne({ user_id: userId, boosts: 0 });
        return 0;
    }
    return doc.boosts ?? 0;
}

async function addBoosts(userId: number, amount: number) {
    await balances.updateOne(
        { user_id: userId },
        { $inc: { boosts: amount } },
        { upsert: true },
    );
}

async function spendBoost(userId: number): Promise<boolean> {
    const doc = await balances.findOne({ user_id: userId });
    if (!doc || !doc.boosts || doc.boosts <= 0) return false;

    await balances.updateOne(
        { user_id: userId },
        { $inc: { boosts: -1 } },
    );
    return true;
}

type ServiceType = 'site' | 'site+broadcast';

interface UserDraft {
    step: 'idle' | 'awaiting_text' | 'confirm';
    serviceType?: ServiceType;
    rawText?: string;
    order?: any;
}

export class CreatorService {
    private readonly logger = new Logger(CreatorService.name);
    private bot: Telegraf;
    private drafts = new Map<number, UserDraft>();

    private startKeyboard() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('➕ Создать новый заказ', 'start_create')],
            [Markup.button.callback('📦 Баланс бустов', 'check_balance')],
            [Markup.button.callback('💳 Купить бусты', 'buy_boosts')],
        ]);
    }


    constructor(
        private readonly botservice: BotserviceService,
    ) {
        const token = process.env.TELEGRAM_CREATOR_TOKEN;
        if (!token) throw new Error('TELEGRAM_CREATOR_TOKEN not set');
        mongo.connect();
        this.bot = new Telegraf(token);
        this.init();
        this.bot.launch().catch((err) => {
            this.logTelegramLaunchError(err, 'Creator');
        });
        this.logger.log('🤖 OrderCreatorBot started');
    }

    private logTelegramLaunchError(err: unknown, botName: string) {
        const description =
            typeof err === 'object' && err !== null && 'response' in err
                ? (err as { response?: { description?: string } }).response?.description
                : undefined;

        if (description?.includes('terminated by other getUpdates request')) {
            this.logger.warn(`⚠️ ${botName} Telegram bot is already running in another process`);
            return;
        }

        this.logger.error(`❌ Failed to launch ${botName} Telegram bot`, err as Error);
    }

    private init() {
        this.bot.start(async (ctx) => {
            if (ctx.chat.type !== 'private') return;

            this.drafts.set(ctx.from.id, { step: 'idle' });

            await ctx.reply(
                '👋 Добро пожаловать!\n\nНажмите кнопку ниже, чтобы создать заказ:',
                this.startKeyboard(),
            );
        });

        this.bot.action('start_create', async (ctx) => {
            if (ctx.chat?.type !== 'private') return;

            this.drafts.set(ctx.from.id, { step: 'idle' });

            await ctx.editMessageText(
                '📝 Создание заказа\n\nВыберите вариант размещения:',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('📢 Бесплатно — только сайт', 'service_site')],
                            [Markup.button.callback('🚀 Платно — сайт + рассылка', 'service_broadcast')],
                        ],
                    },
                },
            );
        });

        this.bot.action('buy_boosts', async (ctx) => {
            const kb = Object.entries(TARIFFS).map(([id, t]) => ([
                Markup.button.callback(
                    `${t.boosts} бустов — ${t.price} ₽`,
                    `tariff_${id}`
                )
            ]));
            await ctx.editMessageText(
                'Выберите пакет бустов:',
                { reply_markup: { inline_keyboard: kb } }
            );
        });

        this.bot.action('check_balance', async (ctx) => {
            const boosts = await getBoosts(ctx.from.id);
            await ctx.answerCbQuery();
            await ctx.editMessageText(
                `📦 Ваш баланс: <b>${boosts}</b> буст(ов)`,
                { parse_mode: 'HTML', reply_markup: this.startKeyboard().reply_markup }
            );
        });

        this.bot.action(/^tariff_(.+)$/, async (ctx) => {
            const id = ctx.match[1];
            const t = TARIFFS[id as keyof typeof TARIFFS];
            if (!t) return;

            await ctx.answerCbQuery();

            await ctx.replyWithInvoice({
                provider_token: PROVIDER_TOKEN,
                title: `Покупка ${t.boosts} бустов`,
                description: `Пополнение баланса на ${t.boosts} бустов`,
                currency: 'RUB',
                prices: [
                    { label: `${t.boosts} бустов`, amount: t.price * 100 },
                ],
                payload: JSON.stringify({
                    userId: ctx.from.id,
                    boosts: t.boosts,
                }),
            });
        });

        this.bot.on('pre_checkout_query', async (ctx) => {
            await ctx.answerPreCheckoutQuery(true);
        });

        this.bot.on('successful_payment', async (ctx) => {
            const data = JSON.parse(ctx.message.successful_payment.invoice_payload);
            await addBoosts(data.userId, data.boosts);

            const boosts = await getBoosts(ctx.from.id);

            await ctx.reply(
                `🎯 Оплата принята!\n📦 Новый баланс: ${boosts} буст(ов)`,
                { reply_markup: this.startKeyboard().reply_markup }
            );
        });

        this.bot.action(['service_site', 'service_broadcast'], async (ctx) => {
            const callback = ctx.callbackQuery as any;
            const data = callback?.data as string;
            const serviceType: ServiceType =
                data === 'service_site'
                    ? 'site'
                    : 'site+broadcast';

            this.drafts.set(ctx.from.id, {
                step: 'awaiting_text',
                serviceType,
            });

            await ctx.editMessageText(
                '✏️ Напишите заказ одним сообщением.\n\nПример:\n\n' +
                'Нужны 2 грузчика\n' +
                'Адрес: Пермский 86\n' +
                'Завтра с 10:00 до 16:00\n' +
                'Оплата 2500 за смену',
            );
        });

        /** TEXT INPUT */
        this.bot.on('text', async (ctx) => {
            if (ctx.chat.type !== 'private') return;

            const draft = this.drafts.get(ctx.from.id);
            if (!draft || draft.step !== 'awaiting_text') return;

            draft.rawText = ctx.message.text;

            try {
                const gigaKey = process.env.GIGACHAT_API_KEY!;
                const order = await parseOrderWithGigaChat(draft.rawText, gigaKey);

                order.employer_name = this.buildTelegramProfileLink(ctx.from);
                draft.order = order;
                draft.step = 'confirm';

                await ctx.reply(
                    this.buildPreviewMessage(order),
                    {
                        parse_mode: 'HTML',
                        reply_markup:
                        {
                            inline_keyboard: ([
                                [Markup.button.callback('✅ Подтвердить', 'confirm')],
                                [Markup.button.callback('✏️ Отредактировать текст', 'edit')],
                                [Markup.button.callback('❌ Отменить', 'cancel')],
                            ]),
                        }
                    },
                );
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('❌ Не удалось разобрать заказ. Попробуйте переформулировать.');
            }
        });

        this.bot.action('confirm', async (ctx) => {
            const draft = this.drafts.get(ctx.from.id);
            if (!draft || draft.step !== 'confirm') return;

            const backendUrl = process.env.MAIN_BACKEND_URL!;
            const order = draft.order;

            try {
                if (draft.serviceType === 'site+broadcast') {

                    const ok = await spendBoost(ctx.from.id);

                    if (!ok) {
                        await ctx.reply(
                            '⚠️ На вашем балансе нет бустов.\n\n' +
                            '🚀 Чтобы разослать заказ — пополните баланс бустов',
                            {
                                reply_markup: {
                                    inline_keyboard: [[
                                        Markup.button.callback('💳 Купить бусты', 'buy_boosts'),
                                    ]]
                                }
                            }
                        );
                        return;
                    }
                    let res = await axios.post(`${backendUrl}/order/create-from-bot`, { order });
                    if (!res.data?.success) throw new Error('Backend error');
                }
                else {
                    let res = await axios.post(`${backendUrl}/order/create-from-bot-without-sending`, { order });
                    if (!res.data?.success) throw new Error('Backend error');
                }
                await ctx.editMessageText(
                    draft.serviceType === 'site'
                        ? '✅ Заказ опубликован на сайте nirby.ru'
                        : '🚀 Заказ опубликован и разослан по чатам',
                    {
                        reply_markup: this.startKeyboard().reply_markup,
                    }
                );

                this.drafts.delete(ctx.from.id);
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('❌ Ошибка при публикации заказа');
            }
        });

        this.bot.action('edit', async (ctx) => {
            const draft = this.drafts.get(ctx.from.id);
            if (!draft) return;
            draft.step = 'awaiting_text';
            await ctx.editMessageText('✏️ Отправьте исправленный текст заказа одним сообщением',);
        });

        this.bot.action('cancel', async (ctx) => {
            this.drafts.delete(ctx.from.id);
            await ctx.editMessageText(
                '❌ Создание заказа отменено',
                {
                    reply_markup: this.startKeyboard().reply_markup,
                });
        });
    }

    private buildTelegramProfileLink(user: any): string {
        if (user.username) {
            return `https://t.me/${user.username}`;
        }
        return `tg://user?id=${user.id}`;
    }

    private buildPreviewMessage(order: any): string {
        const time =
            order.startTime && order.hours
                ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)}`
                : order.startTime || 'не указано';

        return cleanDescription(`
<b>🧾 Проверьте заказ</b>

<b>${order.title}</b>

📝 Информация заказа: ${order.description}
📅 Дата: ${formatDate(order.date) || 'не указано'}
⏰ Время (когда ждут человека): ${time}
📍 Адрес: ${order.address || 'не указано'}
💰 Цена: ${this.formatPayment(order)}
🕒 Количество часов: ${order.hours ? `${order.hours} ч.` : 'не указано'}
🔗 Ссылка на заказчика: ${order.employer_name || 'не указано'}
`);
    }

    private formatPayment(order: any): string {
        const budget = typeof order.budget === 'number' ? order.budget : Number(order.budget);
        const hours = typeof order.hours === 'number' ? order.hours : Number(order.hours);

        if (order.paymentType === 'hourly') {
            if (budget && hours) {
                const rate = Math.round(budget / hours);
                return `Почасовая (${rate}р/час, ${hours} ч = ${budget}р)`;
            }
            if (budget) return `Почасовая (${budget}р/час)`;
            return 'Почасовая (не указано)';
        }

        if (budget) return `Сдельная (${budget}р)`;
        return 'Сдельная (не указано)';
    }
}
