import { Module } from '@nestjs/common';
import { CreatorService } from './creator.service';

@Module({
  providers: [CreatorService],
  exports: [CreatorService],
})
export class CreatorModule {}
