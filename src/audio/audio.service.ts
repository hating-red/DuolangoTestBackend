import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

type SpeechKitEvent = 'partial' | 'final' | 'final_refinement' | 'status_code';

interface SpeechKitAlternative {
  text?: string;
}

interface SpeechKitResponse {
  partial?: { alternatives?: SpeechKitAlternative[] };
  final?: { alternatives?: SpeechKitAlternative[] };
  final_refinement?: {
    normalized_text?: { alternatives?: SpeechKitAlternative[] };
  };
  status_code?: {
    code_type?: string | number;
    message?: string;
  };
}

type SpeechKitStream = grpc.ClientDuplexStream<unknown, SpeechKitResponse>;

interface RecognizerClient extends grpc.Client {
  RecognizeStreaming(metadata: grpc.Metadata): SpeechKitStream;
}

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);
  private wsServer?: WebSocketServer;
  private recognizer?: RecognizerClient;

  constructor(private readonly configService: ConfigService) {}

  bindWebSocketServer(server: Server): void {
    if (this.wsServer) {
      return;
    }

    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
    });

    server.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/audio/stream')) {
        return;
      }

      this.wsServer?.handleUpgrade(request, socket, head, (client) => {
        this.wsServer?.emit('connection', client, request);
      });
    });

    this.wsServer.on('connection', (client, request) => {
      this.handleSpeechSocket(client, request);
    });

    this.logger.log('Audio WebSocket is available at /audio/stream');
  }

  private formatForVK(message: string): string {
    return message;
  }

  sendOrderToChats(order: unknown) {
    return { success: true, order };
  }

  private handleSpeechSocket(
    client: WebSocket,
    request: IncomingMessage,
  ): void {
    let stream: SpeechKitStream;

    try {
      stream = this.createSpeechKitStream(request);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'SpeechKit stream failed';
      this.logger.error(message);
      this.sendJson(client, { type: 'error', message });
      client.close(1011, 'SpeechKit stream failed');
      return;
    }

    stream.on('data', (rawResponse: unknown) => {
      const response = rawResponse as SpeechKitResponse;
      const result = this.extractSpeechKitResult(response);

      if (result) {
        this.sendJson(client, result);
      }
    });

    stream.on('error', (error) => {
      this.logger.error(error.message, error.stack);
      this.sendJson(client, {
        type: 'error',
        message: error.message || 'SpeechKit stream failed',
      });
      client.close(1011, 'SpeechKit stream failed');
    });

    stream.on('end', () => {
      this.sendJson(client, { type: 'done' });
      client.close(1000, 'SpeechKit stream finished');
    });

    client.on('message', (message, isBinary) => {
      if (!isBinary) {
        this.handleSocketCommand(
          client,
          stream,
          this.toAudioBuffer(message).toString('utf8'),
        );
        return;
      }

      stream.write({
        chunk: {
          data: this.toAudioBuffer(message),
        },
      });
    });

    client.on('close', () => {
      stream.end();
    });

    client.on('error', (error) => {
      this.logger.warn(`WebSocket client error: ${error.message}`);
      stream.end();
    });
  }

  private toAudioBuffer(message: RawData): Buffer {
    if (Buffer.isBuffer(message)) {
      return message;
    }

    if (Array.isArray(message)) {
      return Buffer.concat(message);
    }

    return Buffer.from(message);
  }

  private createSpeechKitStream(request: IncomingMessage): SpeechKitStream {
    const metadata = new grpc.Metadata();
    metadata.add('authorization', this.getAuthorizationHeader());

    const folderId =
      this.configService.get<string>('YANDEX_FOLDER_ID') ||
      this.configService.get<string>('FOLDER_ID');
    if (folderId) {
      metadata.add('x-folder-id', folderId);
    }

    const stream = this.getRecognizer().RecognizeStreaming(metadata);
    const { language, sampleRate } = this.getRecognitionParams(request);

    stream.write({
      session_options: {
        recognition_model: {
          model:
            this.configService.get<string>('YANDEX_SPEECHKIT_MODEL') ||
            'general',
          audio_format: {
            raw_audio: {
              audio_encoding: 1,
              sample_rate_hertz: sampleRate,
              audio_channel_count: 1,
            },
          },
          text_normalization: {
            text_normalization: 1,
            profanity_filter: false,
            literature_text: false,
          },
          language_restriction: {
            restriction_type: 1,
            language_code: [language],
          },
          audio_processing_type: 1,
        },
      },
    });

    return stream;
  }

  private getRecognitionParams(request: IncomingMessage): {
    language: string;
    sampleRate: number;
  } {
    const url = new URL(request.url || '/audio/stream', 'http://localhost');
    const language =
      url.searchParams.get('language') ||
      this.configService.get<string>('YANDEX_SPEECHKIT_LANGUAGE') ||
      'ru-RU';
    const sampleRate = Number(url.searchParams.get('sampleRate')) || 16000;

    return { language, sampleRate };
  }

  private getRecognizer(): RecognizerClient {
    if (this.recognizer) {
      return this.recognizer;
    }

    const protoRoot = join(process.cwd(), 'src', 'audio', 'proto');
    const protoPath = join(
      protoRoot,
      'yandex',
      'cloud',
      'ai',
      'stt',
      'v3',
      'stt_service.proto',
    );
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [protoRoot],
    });

    const speechkitPackage = grpc.loadPackageDefinition(packageDefinition) as {
      speechkit: {
        stt: {
          v3: {
            Recognizer: grpc.ServiceClientConstructor;
          };
        };
      };
    };

    const endpoint =
      this.configService.get<string>('YANDEX_SPEECHKIT_GRPC_ENDPOINT') ||
      'stt.api.cloud.yandex.net:443';

    this.recognizer = new speechkitPackage.speechkit.stt.v3.Recognizer(
      endpoint,
      grpc.credentials.createSsl(),
      {
        'grpc.max_receive_message_length': 16 * 1024 * 1024,
        'grpc.max_send_message_length': 16 * 1024 * 1024,
      },
    ) as unknown as RecognizerClient;

    return this.recognizer;
  }

  private getAuthorizationHeader(): string {
    const apiKey = this.configService.get<string>('YANDEX_API_KEY');
    if (apiKey) {
      return `Api-Key ${apiKey}`;
    }

    const iamToken = this.configService.get<string>('YANDEX_IAM_TOKEN');
    if (iamToken) {
      return `Bearer ${iamToken}`;
    }

    throw new Error(
      'Set YANDEX_API_KEY or YANDEX_IAM_TOKEN for SpeechKit streaming recognition',
    );
  }

  private handleSocketCommand(
    client: WebSocket,
    stream: SpeechKitStream,
    command: string,
  ): void {
    try {
      const payload = JSON.parse(command) as { type?: string };

      if (payload.type === 'stop') {
        stream.end();
        return;
      }
    } catch {
      this.sendJson(client, {
        type: 'error',
        message: 'Unsupported WebSocket command',
      });
    }
  }

  private extractSpeechKitResult(response: SpeechKitResponse):
    | {
        type: SpeechKitEvent;
        text: string;
      }
    | {
        type: 'status';
        message: string;
      }
    | null {
    const partialText = response.partial?.alternatives?.[0]?.text;
    if (partialText) {
      return { type: 'partial', text: partialText };
    }

    const finalText = response.final?.alternatives?.[0]?.text;
    if (finalText) {
      return { type: 'final', text: finalText };
    }

    const normalizedText =
      response.final_refinement?.normalized_text?.alternatives?.[0]?.text;
    if (normalizedText) {
      return { type: 'final_refinement', text: normalizedText };
    }

    const status = response.status_code?.message;
    if (status) {
      return { type: 'status', message: status };
    }

    return null;
  }

  private sendJson(client: WebSocket, payload: unknown): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}
