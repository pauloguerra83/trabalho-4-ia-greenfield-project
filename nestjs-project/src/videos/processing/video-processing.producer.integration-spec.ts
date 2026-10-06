import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import { QueueModule } from '../../queue/queue.module';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import type { VideoProcessJobData } from './video-processing.types';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<VideoProcessJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should enqueue video.process with the video id as job id and bounded retries', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(VIDEO_PROCESS_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('should store jobs under the QUEUE_PREFIX namespace, never the default bull prefix', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    // Each job is a Redis hash at `{prefix}:{queue}:{jobId}`.
    const redis = await queue.client;
    const prefixed = await redis.hgetall(
      `${process.env.QUEUE_PREFIX}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    const defaultPrefixed = await redis.hgetall(
      `bull:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
    );
    expect(prefixed.name).toBe(VIDEO_PROCESS_JOB);
    expect(defaultPrefixed).toEqual({});
  });

  it('should keep test jobs invisible to a queue using the development prefix', async () => {
    const videoId = randomUUID();
    await producer.enqueue(videoId);

    const devQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: queue.opts.connection,
      prefix: 'streamtube',
    });
    try {
      expect(await devQueue.getJob(videoId)).toBeUndefined();
    } finally {
      await devQueue.close();
    }
  });
});
