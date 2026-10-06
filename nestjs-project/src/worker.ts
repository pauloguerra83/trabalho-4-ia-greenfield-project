import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Close BullMQ workers and connections cleanly on SIGTERM (docker stop).
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'Worker');
}
void bootstrap();
