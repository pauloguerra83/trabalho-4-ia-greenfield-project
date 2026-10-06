import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';

const QUEUE_NAME = 'queue-module-spec';

describe('QueueModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: QUEUE_NAME }),
      ],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should register queues with the QUEUE_PREFIX from configuration', () => {
    const queue = module.get<Queue>(getQueueToken(QUEUE_NAME));

    expect(queue.opts.prefix).toBe(process.env.QUEUE_PREFIX);
  });
});
