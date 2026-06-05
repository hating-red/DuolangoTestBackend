import { Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { VK } from 'vk-io';
import { cleanDescription } from '../shared/cleaning';
import { calculateEndTime } from '../shared/time';
import { formatDate } from '../shared/date';
import { JobForm } from './interfaces/botservice.interface';

const jobFormLabels: Record<keyof JobForm, string> = {
  people: 'Кто нужен',
  work: 'Что делать',
  duration: 'На сколько',
  address: 'Адрес',
  contact: 'Контакт',
  contact_type: 'Тип контакта',
};

@Injectable()
export class BotserviceService {
  private readonly logger = new Logger(BotserviceService.name);

  private tgBot: Telegraf | null = null;
  private vk: VK | null = null;
  private andreId: string | null = null;

  private telegramChatIds: number[] = [];
  private vkChatIds: number[] = [];

  constructor() {
    const tgToken = process.env.TELEGRAM_PITCHER_TOKEN;
    const vkToken = process.env.VK_BOT_TOKEN;

    if (tgToken) this.tgBot = new Telegraf(tgToken);
    if (vkToken) this.vk = new VK({ token: vkToken });

    if (process.env.TELEGRAM_CHAT_IDS) {
      this.telegramChatIds = process.env.TELEGRAM_CHAT_IDS.split(',').map(Number);
    }

    if (process.env.VK_CHAT_IDS) {
      this.vkChatIds = process.env.VK_CHAT_IDS.split(',').map(Number);
    }

    if (process.env.ANDRE_ID) {
      this.andreId = process.env.ANDRE_ID.trim();
    }
  }

  private formatForVK(message: string): string {
    return message
      .replace(/<b>(.*?)<\/b>/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace('🆕 Новый заказ!', '🆕 НОВЫЙ ЗАКАЗ!');
  }

  async sendOrderToChats(order: any) {
    if (order?.source && ['group', 'vk', 'telegram'].includes(order.source)) {
      this.logger.log(`⏭️ Skip broadcast for group source: ${order.source}`);
      return { success: true, skipped: true };
    }

    this.logger.log(order.employer_name || order.employerName);
    const timeInfo =
      order.startTime && order.hours
        ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)} (${order.hours} ч.)`
        : order.startTime || 'не указано';

    const orderId = order.orderId || order._id;
    const orderLink = orderId ? `https://nirby.ru/order/${orderId}` : null;
    const employerLink = orderLink;

    let message = `
<b>🆕 Новый заказ</b>
<b>${order.title}</b>

📝 <b>Описание:</b> ${cleanDescription(order.description)}


⏰ <b>Когда ждут:</b> ${timeInfo}
📅 <b>Дата:</b> ${formatDate(order.date) || 'не указано'}
📍 <b>Адрес:</b> ${order.address || 'не указано'}

💰 <b>Оплата:</b> ${this.formatPayment(order)}
🕒 <b>Часы:</b> ${order.hours ? `${order.hours} ч.` : 'не указано'}

🔗 <b>Ссылка на заказ:</b> ${orderLink || 'не указано'}
`;

    const mapLink = order.address
      ? `https://yandex.ru/maps/?text=${encodeURIComponent(order.address)}`
      : null;

    if (this.vk && this.vkChatIds.length > 0) {
      let vkMessage = this.formatForVK(message);
      if (mapLink) vkMessage += `\n📍 Посмотреть на карте: ${mapLink}`;
      // vkMessage += `\n🔗 Перейти к заказу: ${orderLink}`;
      if (employerLink) vkMessage += `\n➡️ Связаться с заказчиком: ${employerLink}`;

      for (const chat of this.vkChatIds) {
        try {
          await this.vk.api.messages.send({
            peer_id: chat,
            message: vkMessage,
            random_id: Date.now(),
          });
          this.logger.log(`📨 Order sent to VK chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to VK chat ${chat}`, err);
        }
      }
    }
    if (this.tgBot && this.telegramChatIds.length > 0) {
      const buttons: any[] = [];
      // buttons.push([{ text: '➡️ Перейти к заказу', url: orderLink }]);
      if (mapLink) buttons.push([{ text: '📍 Посмотреть на карте', url: mapLink }]);
      if (employerLink) buttons.push([{ text: '➡️ Связаться с заказчиком', url: employerLink }]);

      for (const chat of this.telegramChatIds) {
        try {
          await this.tgBot.telegram.sendMessage(chat, message, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: buttons,
            },
          });
          this.logger.log(`📨 Order sent to Telegram chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to Telegram chat ${chat}`, err);
        }
      }
    }

    return { success: true };
  }

  async sendJobFormToAndre(form: JobForm) {
    if (!this.vk) {
      this.logger.error('VK bot is not configured');
      return { success: false, error: 'VK bot is not configured' };
    }

    if (!this.andreId) {
      this.logger.error('ANDRE_ID is not configured');
      return { success: false, error: 'ANDRE_ID is not configured' };
    }

    const message = this.formatJobFormForVK(form);

    try {
      const peerId = await this.resolveVkPeerId(this.andreId);

      await this.vk.api.messages.send({
        peer_id: peerId,
        message,
        random_id: Date.now(),
      });

      this.logger.log(`📨 Job form sent to VK user ${this.andreId}`);
      return { success: true };
    } catch (err) {
      this.logger.error(`❌ Failed to send job form to VK user ${this.andreId}`, err);
      return { success: false, error: 'Failed to send message to VK' };
    }
  }

  private async resolveVkPeerId(target: string): Promise<number> {
    const normalizedTarget = target.trim().replace(/^@/, '');
    const numericTarget = Number(normalizedTarget);

    if (!Number.isNaN(numericTarget)) {
      return numericTarget;
    }

    if (!this.vk) {
      throw new Error('VK bot is not configured');
    }

    const users = await this.vk.api.users.get({
      user_ids: [normalizedTarget],
    });

    const userId = users[0]?.id;
    if (!userId) {
      throw new Error(`VK user not found: ${target}`);
    }

    return userId;
  }

  private formatJobFormForVK(form: JobForm): string {
    const lines = (Object.keys(jobFormLabels) as Array<keyof JobForm>)
      .map((key) => `• ${jobFormLabels[key]}: ${form[key] || 'не указано'}`);

    return ['🆕 Новая заявка с формы', '', ...lines].join('\n');
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
