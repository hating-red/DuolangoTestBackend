import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AudioService } from './audio/audio.service';
import type { Server } from 'node:http';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const audioService = app.get(AudioService);

  app.enableCors({
    origin: [process.env.MAIN_BACKEND_URL],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  audioService.bindWebSocketServer(app.getHttpServer() as Server);

  const port = process.env.PORT ?? 2006;
  const host = process.env.HOST ?? '127.0.0.1';

  await app.listen(port, host);
  console.log(`🚀 Сервер слушает ${host}:${port}`);
}

void bootstrap();
