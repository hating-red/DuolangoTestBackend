import { Controller, Post, Body } from '@nestjs/common';
import { BotserviceService } from './botservice.service';
import type { JobForm } from './interfaces/botservice.interface';

@Controller('botservice')
export class BotserviceController {
  constructor(private readonly botserviceService: BotserviceService) { }
  @Post('send')
  async send(@Body() body) {
    return this.botserviceService.sendOrderToChats(body);
  }

  @Post('send-to-andre')
  async sendTarget(@Body() body: JobForm) {
    return this.botserviceService.sendJobFormToAndre(body);
  }
}
