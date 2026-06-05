import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotserviceModule } from './botservice/botservice.module';
import { PitcherModule } from './bots/BotPitcher/pitcher.module';
import { CatcherModule } from './bots/BotCatcher/catcher.module';
import { CreatorModule } from './bots/BotCreator/creator.module';

@Module({
  imports: [
    BotserviceModule,
    PitcherModule,
    CatcherModule,
    CreatorModule,
    ConfigModule.forRoot({
      isGlobal:true,
    })
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
