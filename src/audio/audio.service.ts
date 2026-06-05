import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor() {

  }

  private formatForVK(message: string): string {

  }

  async sendOrderToChats(order: any) {
    return { success: true };
  }
}