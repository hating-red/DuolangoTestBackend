import { Module } from '@nestjs/common';
import { CatcherService } from './catcher.service';

@Module({
  providers: [CatcherService],
  exports: [CatcherService],
})
export class CatcherModule {}
