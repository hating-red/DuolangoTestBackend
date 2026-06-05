import { Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { VK } from 'vk-io';
import { isPotentialOrder } from '../../shared/filters';

@Injectable()
export class PitcherService {
  private readonly logger = new Logger(PitcherService.name);

  private tgBot: Telegraf | null = null;
  private vk: VK | null = null;

  private readonly draftChannelId = process.env.TELEGRAM_MOD_CHANNEL_ID;

  constructor() {
    const tgToken = process.env.TELEGRAM_PITCHER_TOKEN;
    const vkToken = process.env.VK_BOT_TOKEN;

    if (tgToken) {
      this.tgBot = new Telegraf(tgToken);
      this.logger.log('🤖 Pitcher Telegram bot started');
    }

    if (vkToken) {
      this.vk = new VK({ token: vkToken });
      this.logger.log('🤖 Pitcher VK bot started');
    }

    void this.listen().catch((err) => {
      this.logTelegramLaunchError(err, 'Pitcher');
    });
  }

  private async listen() {
    if (!this.tgBot || !this.draftChannelId) {
      this.logger.warn('⚠️ Pitcher Telegram not configured');
      return;
    }

    // === Telegram listener ===
    this.tgBot.on('text', async (ctx) => {
      if (ctx.chat.id === Number(this.draftChannelId)) return;
      const text = ctx.message.text;
      const tgUser = ctx.from;
      const user = {
        id: tgUser.id,
        username: tgUser.username,
        first_name: tgUser.first_name,
        profile_link: tgUser.username
          ? `https://t.me/${tgUser.username}`
          : `tg://user?id=${tgUser.id}`,
      };
      this.logger.log(text);
      const potential = isPotentialOrder(text);
      if (!potential.ok) return;
      await this.sendToModerator(text, user, 'telegram');
    });

    // === VK listener ===
    if (this.vk) {
      this.vk.updates.on('message_new', async (ctx) => {
        const text = ctx.text || '';
        if (!text) return;
        if (!this.vk) return;
        const [vkUser] = await this.vk.api.users.get({
          user_ids: [ctx.senderId],
          fields: ["screen_name"],
        });
        const user = {
          id: vkUser.id,
          first_name: vkUser.first_name,
          last_name: vkUser.last_name,
          screen_name: vkUser.screen_name,
          username: vkUser.screen_name,
          profile_link: vkUser.screen_name
            ? `https://vk.com/${vkUser.screen_name}`
            : `https://vk.com/id${vkUser.id}`,
        };
        const potential = isPotentialOrder(text);
        if (!potential.ok) return;
        await this.sendToModerator(text, user, 'vk');
      });
      await this.vk.updates.start().catch(err => this.logger.error('🚨 VK updates error', err));
    }

    try {
      await this.tgBot.launch();
      this.logger.log('🎯 Pitcher listening to Telegram & VK');
    } catch (err) {
      this.logTelegramLaunchError(err, 'Pitcher');
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

  private async sendToModerator(text: string, user: any, source: 'telegram' | 'vk') {
    if (!this.draftChannelId || !this.tgBot) return;

    const msg = `

⚾⚾⚾⚾⚾⚾⚾⚾⚾⚾

📨 <b>Новое объявление (оригинал)</b>

${text}

👤 Отправитель: <a href="${user.profile_link}">
${user.username || user.first_name || 'неизвестно'}
</a>
📦 Источник: ${source}

⚾⚾⚾⚾⚾⚾⚾⚾⚾⚾
`;
    await this.tgBot.telegram.sendMessage(this.draftChannelId, msg, { parse_mode: 'HTML' });
    this.logger.log(`📤 Сообщение переслано в модераторский канал (${source})`);
  }
}
