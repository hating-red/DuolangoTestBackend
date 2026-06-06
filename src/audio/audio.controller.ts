import { Controller, Post, Body } from '@nestjs/common';
import { AudioService } from './audio.service';

@Controller('audio')
export class AudioController {
  constructor(private readonly audioService: AudioService) {}
  @Post('send')
  send(@Body() body) {
    return this.audioService.sendOrderToChats(body);
  }
}
