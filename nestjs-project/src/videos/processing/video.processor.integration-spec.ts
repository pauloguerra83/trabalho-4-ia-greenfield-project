import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { sourceKey, thumbnailKey } from '../../storage/storage-keys';
import { S3_INTERNAL_CLIENT } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { emptyBucket } from '../../test/storage';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { generateSlug } from '../slug.util';
import { VideoStatus } from '../video-status.enum';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingProducer } from './video-processing.producer';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const WAIT_TIMEOUT_MS = 20_000;

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('VideoProcessor (integration)', () => {
  jest.setTimeout(30_000);

  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let s3: S3Client;
  let config: ConfigType<typeof storageConfig>;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        VideoProcessingModule,
        // Producer side, as VideosModule does in the API.
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    await module.init(); // starts the BullMQ worker inside the test process

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    s3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await emptyBucket(s3, config.bucket);
    const owner = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hash' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'owner', nickname: 'owner', user_id: owner.id });
  });

  async function seedVideo(
    fixture: string,
    status: VideoStatus = VideoStatus.PROCESSING,
  ): Promise<string> {
    const id = randomUUID();
    await storage.putObject(
      sourceKey(id),
      await readFile(join(FIXTURES, fixture)),
      'video/mp4',
    );
    await videoRepository.save({
      id,
      channel_id: channel.id,
      source_key: sourceKey(id),
      slug: generateSlug(),
      title: fixture,
      original_filename: fixture,
      content_type: 'video/mp4',
      size_bytes: 1,
      status,
      upload_id: null,
    });
    return id;
  }

  const waitForStatus = (id: string, status: VideoStatus) =>
    waitFor(
      () => videoRepository.findOneByOrFail({ id }),
      (video) => video.status === status,
    );

  it('should take a valid video to ready with duration, metadata and thumbnail', async () => {
    const id = await seedVideo('sample.mp4');

    await producer.enqueue(id);
    const video = await waitForStatus(id, VideoStatus.READY);

    expect(video.duration_seconds).toBeCloseTo(3, 1);
    expect(video.metadata?.video).toMatchObject({ codec: 'h264', width: 640 });
    expect(video.thumbnail_key).toBe(thumbnailKey(id));
    expect(video.processing_error).toBeNull();
    const thumbnail = await storage.headObject(thumbnailKey(id));
    expect(thumbnail.contentLength).toBeGreaterThan(0);
  });

  it('should fail a file that is not a video with invalid_video after a single attempt', async () => {
    const id = await seedVideo('not-a-video.mp4');

    await producer.enqueue(id);
    const video = await waitForStatus(id, VideoStatus.FAILED);

    expect(video.processing_error).toBe('invalid_video');
    const job = await queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
  });

  it('should overwrite thumbnail and metadata when the same video is processed again', async () => {
    const id = await seedVideo('sample.mp4');
    await producer.enqueue(id);
    await waitForStatus(id, VideoStatus.READY);

    await videoRepository.update(
      { id },
      { status: VideoStatus.PROCESSING, metadata: null },
    );
    await producer.enqueue(id);
    const video = await waitForStatus(id, VideoStatus.READY);

    expect(video.metadata).not.toBeNull();
    expect(video.thumbnail_key).toBe(thumbnailKey(id));
  });

  it('should leave a video that is not processing untouched', async () => {
    const id = await seedVideo('sample.mp4', VideoStatus.DRAFT);

    await producer.enqueue(id);
    // Completed jobs are removed (removeOnComplete), so the job disappears.
    await waitFor(
      () => queue.getJob(id),
      (job) => job === undefined,
    );

    const video = await videoRepository.findOneByOrFail({ id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.thumbnail_key).toBeNull();
  });
});
