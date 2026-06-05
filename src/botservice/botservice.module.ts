import { Module } from '@nestjs/common';
import { BotserviceService } from './botservice.service';
import { BotserviceController } from './botservice.controller';

@Module({
  controllers: [BotserviceController],
  providers: [BotserviceService],
})
export class BotserviceModule {}
