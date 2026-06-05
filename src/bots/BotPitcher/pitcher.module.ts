import { Module } from '@nestjs/common';
import { PitcherService } from './pitcher.service';

@Module({
  providers: [PitcherService],
  exports: [PitcherService],
})
export class PitcherModule {}
