import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';

/**
 * Shared BullMQ connection. The prefix comes from QUEUE_PREFIX so tests and
 * development use separate key namespaces on the same Redis.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
