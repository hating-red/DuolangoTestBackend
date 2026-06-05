import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AudioModule } from './audio/audio.module';

@Module({
  imports: [
    AudioModule,
    ConfigModule.forRoot({
      isGlobal:true,
    })
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
