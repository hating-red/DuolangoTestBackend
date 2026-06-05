import { Injectable, Logger } from '@nestjs/common';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { parseOrderWithGigaChat } from '../../shared/parser';
import { calculateEndTime } from '../../shared/time';
import { cleanDescription } from '../../shared/cleaning';
import { generateOrderId } from '../../shared/order-id';
import { formatDate } from '../../shared/date';

@Injectable()
export class CatcherService {
  private readonly logger = new Logger(CatcherService.name);

  private tgBot: Telegraf | null = null;

  private readonly modChatId = process.env.TELEGRAM_MOD_CHANNEL_ID;

  private pendingEdits: Record<string, {
    order: any;
    timer?: NodeJS.Timeout;
    messageId?: number;
    messageText?: string;
  }> = {};

  private readonly moderationTimeoutMs = 10 * 60 * 1000;

  constructor() {
    const tgToken = process.env.TELEGRAM_CATCHER_TOKEN;

    if (tgToken) {
      this.tgBot = new Telegraf(tgToken);
      this.logger.log('🤖 Catcher Telegram bot started');
    }

    void this.listenToModChat();
  }

  private async listenToModChat() {
    if (!this.tgBot || !this.modChatId) {
      this.logger.warn('⚠️ Catcher Telegram not configured');
      return;
    }

    this.tgBot.on('channel_post', async (ctx) => {
      const post = ctx.channelPost;
      const text = (post as any)?.text;
      if (!text) return;

      const senderMatch = text.match(/👤 Отправитель:\s*(.+)/);
      let sender = senderMatch ? senderMatch[1].trim() : 'не указано';
      
      const sourceMatch = text.match(/📦 Источник:\s*(.+)/);
      const source = (sourceMatch?.[1] || 'group').trim();

      if (source === 'vk') {
        sender = sender.startsWith('http')
          ? sender
          : `https://vk.com/${sender}`;
      } else {
        sender = sender.startsWith('http')
          ? sender
          : `https://t.me/${sender}`;
      }

      this.logger.log(sender);

      let isEditedJSON = false;
      let order: any;

      try {
        order = JSON.parse(text);
        if (order?.orderId) {
          isEditedJSON = true;
          this.logger.log(`[CatcherService] channel_post: received edited JSON for orderId=${order.orderId}`);
        }
      } catch {
      }

      if (isEditedJSON) {
        this.pendingEdits[order.orderId] = { order };
        await this.sendToModeratorWithButtons(order.orderId, order);
        this.logger.log(`[CatcherService] channel_post: resent edited orderId=${order.orderId} with buttons`);
        return;
      }

      const orderId = generateOrderId();
      this.logger.log(`channel_post: new post, generated orderId=${orderId}. Starting parser...`);

      try {
        const gigaKey = process.env.GIGACHAT_API_KEY;

        let cleanText = text;

        const match = text.match(/📨 <b>Новое объявление \(оригинал\)<\/b>\n([\s\S]*?📦 Источник:.*)/);
        if (match && match[1]) {
          cleanText = match[1].trim();
          this.logger.log(`[CatcherService] channel_post: extracted clean text for parsing`);
        } else {
          this.logger.warn(`[CatcherService] channel_post: unable to extract clean text, using full post`);
        }

        let parsedOrder = await parseOrderWithGigaChat(cleanText, gigaKey!);
        parsedOrder.employer_name = sender;
        parsedOrder.isEditing = false;
        parsedOrder.source = source;
        this.pendingEdits[orderId] = { order: parsedOrder };

        await this.sendToModeratorWithButtons(orderId, parsedOrder);
        this.logger.log(`channel_post: sent parsed orderId=${orderId} to moderator with buttons`);
      } catch (err) {
        this.logger.error('❌ Ошибка парсинга заказа в channel_post', err as Error);
      }
    });

    this.tgBot.on('callback_query', async (ctx) => {
      const callback = ctx.callbackQuery as any;
      const data = callback?.data as string;
      const msg = callback?.message as any;
      if (!data || !msg) return;

      try {
        // --- ОДОБРЕНИЕ ---
        if (data.startsWith('approve_')) {
          const parts = data.split('_');
          const orderId = parts[1];
          const backendUrl = process.env.MAIN_BACKEND_URL;

          const entry = this.pendingEdits?.[orderId];
          const order = entry?.order;
          if (!order) {
            this.logger.warn(`⚠️ Не найден заказ для orderId=${orderId}`);
            await ctx.answerCbQuery('⚠️ Данные заказа не найдены');
            return;
          }

          const requiredFields = ['title', 'paymentType', 'budget', 'date', 'startTime'];
          for (const field of requiredFields) {
            if (!order[field]) {
              this.logger.error(`❌ Order ${orderId} missing required field: ${field}`);
              await ctx.answerCbQuery(`⚠️ Order неполный. Поле ${field} обязательно`);
              return;
            }
          }

          try {
            this.logger.log(`📡 Попытка отправки запроса на ${backendUrl}/order/create-from-bot-without-sending`);
            const response = await axios.post(`${backendUrl}/order/create-from-bot-without-sending`, {
              order: this.appendEmployerLinkToDescription(order),
            });

            if (response.data?.success) {
              this.logger.log(`✅ Order ${orderId} успешно добавлен в базу`);
              await ctx.editMessageText(`${msg.text}\n\n✅ Страйк! Мяч пойман!`, { parse_mode: 'HTML' });
              await ctx.answerCbQuery('✅ Страйк!');
            } else {
              const backendError = response.data?.error || 'Неизвестная ошибка при добавлении заказа';
              this.logger.error(`⚠️ Бэкенд вернул ошибку: ${backendError}`);
              throw new Error(backendError);
            }
          } catch (err) {
            this.logger.error(`❌ Ошибка при добавлении Order ${orderId} в базу`, err);
            await ctx.answerCbQuery('❌ Промах! Мяч улетел мимо!');
          }

          this.clearModerationTimer(orderId);
          delete this.pendingEdits?.[orderId];
        }

        // --- ОТКЛОНЕНИЕ ---
        if (data.startsWith('reject_')) {
          const orderId = data.split('_')[1];
          this.clearModerationTimer(orderId);
          delete this.pendingEdits?.[orderId];
          await ctx.editMessageText(`${msg.text}\n\n❌ Мяч не засчитан судьями! Заказ отклонён`, { parse_mode: 'HTML' });
          await ctx.answerCbQuery('❌ Не засчитан!');
        }

        // --- РЕДАКТИРОВАНИЕ ---
        if (data.startsWith('edit_')) {
          const orderId = data.split('_')[1];
          const entry = this.pendingEdits?.[orderId];

          if (!entry) {
            this.logger.warn(`callback_query: edit requested but pendingEdits[${orderId}] not found`);
            await ctx.answerCbQuery('⚠️ Данные заказа не найдены');
            return;
          }

          const editableJSON = {
            ...entry.order,
            orderId,
          };

          await ctx.reply(
            '✏️ Кикер меняет траекторию мяча.\nСкопируйте JSON ниже, внесите правки и отправьте обратно в канал:',
            { parse_mode: 'Markdown' }
          );
          await ctx.reply('```json\n' + JSON.stringify(editableJSON, null, 2) + '\n```', { parse_mode: 'Markdown' });

          this.scheduleAutoApprove(orderId);
          this.logger.log(`callback_query: orderId=${orderId} sent as editable JSON to moderator`);
        }



      } catch (err) {
        this.logger.error('❌ Ошибка при обработке callback_query', err as Error);
        await ctx.answerCbQuery('Ошибка обработки кнопки');
      }
    });

    try {
      await this.tgBot.launch();
      this.logger.log('🎯 Catcher listening to moderator chat');
    } catch (err) {
      this.logTelegramLaunchError(err, 'Catcher');
    }
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

  private async sendToModeratorWithButtons(orderId: string, order: any) {
    if (!this.tgBot || !this.modChatId) return;

    const msg = `
🧤🧤🧤🧤🧤🧤🧤🧤🧤🧤

<b>✨ Новое объявление!</b>
<b>${order.title}</b>

📝 Информация заказа: ${cleanDescription(order.description)}
📅 Дата: ${formatDate(order.date) || 'не указано'}
⏰ Время (когда ждут человека): ${order.startTime && order.hours
        ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)} (${order.hours} ч.)`
        : order.startTime || 'не указано'}
📍 Адрес: ${order.address || 'не указано'}
💰 Цена: ${this.formatPayment(order)}
🕒 Количество часов: ${order.hours ? `${order.hours} ч.` : 'не указано'}

👤 Отправитель: ${order.employer_name}
🔗 Ссылка на заказчика: ${order.employer_name || 'не указано'}
📦 Источник: ${order.source || 'group'}

🧤🧤🧤🧤🧤🧤🧤🧤🧤🧤
`;

    const sent = await this.tgBot.telegram.sendMessage(this.modChatId, msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          Markup.button.callback(`✅ Готово`, `approve_${orderId}`),
          Markup.button.callback(`❌ Отмена`, `reject_${orderId}`),
          Markup.button.callback(`✏️ Редактировать`, `edit_${orderId}`)
        ]]
      }
    });

    const entry = this.pendingEdits[orderId];
    if (entry) {
      entry.messageId = (sent as any)?.message_id;
      entry.messageText = msg;
      this.scheduleAutoApprove(orderId);
    }
  }

  private scheduleAutoApprove(orderId: string) {
    const entry = this.pendingEdits[orderId];
    if (!entry) return;
    this.clearModerationTimer(orderId);
    entry.timer = setTimeout(() => {
      void this.autoApprove(orderId);
    }, this.moderationTimeoutMs);
  }

  private clearModerationTimer(orderId: string) {
    const entry = this.pendingEdits[orderId];
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private async autoApprove(orderId: string) {
    const entry = this.pendingEdits[orderId];
    if (!entry) return;

    const backendUrl = process.env.MAIN_BACKEND_URL;
    const order = entry.order;

    try {
      this.logger.log(`⏱️ Автопубликация orderId=${orderId}`);
      const response = await axios.post(`${backendUrl}/order/create-from-bot-without-sending`, {
        order: this.appendEmployerLinkToDescription(order),
      });
      if (!response.data?.success) {
        throw new Error(response.data?.error || 'Неизвестная ошибка при автопубликации');
      }

      if (this.tgBot && this.modChatId && entry.messageId && entry.messageText) {
        await this.tgBot.telegram.editMessageText(
          this.modChatId,
          entry.messageId,
          undefined,
          `${entry.messageText}\n\n⏱️ Автопубликация через 10 минут без правок`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      this.logger.error(`❌ Ошибка при автопубликации orderId=${orderId}`, err as Error);
    } finally {
      this.clearModerationTimer(orderId);
      delete this.pendingEdits[orderId];
    }
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

  private appendEmployerLinkToDescription(order: any): any {
    const link = order?.employer_name;
    if (!link) return order;

    const tail = `\n\nСсылка на заказчика: ${link}`;
    const description = order.description || '';

    if (description.includes(link) || description.includes('Ссылка на заказчика')) {
      return order;
    }

    return {
      ...order,
      description: `${description}${tail}`,
    };
  }
}
