import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  UploadExpiredException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { emptyBucket } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './processing/video-processing.constants';
import { VideoProcessingProducer } from './processing/video-processing.producer';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let s3: S3Client;
  let config: ConfigType<typeof storageConfig>;
  let channelsService: ChannelsService;
  let owner: User;
  let ownerChannel: Channel;
  let queue: Queue;

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
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideosService, VideoProcessingProducer, ChannelsService],
    }).compile();
    await module.init(); // bucket bootstrap

    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    service = module.get(VideosService);
    channelsService = module.get(ChannelsService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = module.get(getRepositoryToken(Video));
    s3 = module.get<S3Client>(S3_INTERNAL_CLIENT);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await emptyBucket(s3, config.bucket);
    await queue.obliterate({ force: true });
    owner = await createUser('owner@example.com');
    ownerChannel = await channelsService.createChannel(owner.id, owner.email);
  });

  async function createUser(email: string): Promise<User> {
    return dataSource.getRepository(User).save({ email, password: 'hash' });
  }

  /** Another user with a channel of their own. */
  async function createStranger(): Promise<User> {
    const stranger = await createUser('stranger@example.com');
    await channelsService.createChannel(stranger.id, stranger.email);
    return stranger;
  }

  async function pendingUploadCount(): Promise<number> {
    const page = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: config.bucket }),
    );
    return page.Uploads?.length ?? 0;
  }

  describe('startUpload', () => {
    it("should persist a draft of the user's channel and open the multipart upload", async () => {
      const result = await service.startUpload(owner.id, {
        fileName: 'aula.mp4',
        fileSize: 150000000,
        contentType: 'video/mp4',
      });

      const video = await videoRepository.findOneByOrFail({
        id: result.videoId,
      });
      expect(video).toMatchObject({
        channel_id: ownerChannel.id,
        source_key: `videos/${result.videoId}/source`,
        status: VideoStatus.DRAFT,
        upload_id: result.uploadId,
        slug: result.slug,
        title: 'aula',
        original_filename: 'aula.mp4',
        size_bytes: 150000000,
      });
      await expect(
        storage.listParts(`videos/${result.videoId}/source`, result.uploadId),
      ).resolves.toEqual([]);
    });

    it('should report CHANNEL_NOT_FOUND for a user without channel and open no upload', async () => {
      const userWithoutChannel = await createUser('nochannel@example.com');

      await expect(
        service.startUpload(userWithoutChannel.id, {
          fileName: 'aula.mp4',
          fileSize: 1000,
          contentType: 'video/mp4',
        }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      expect(await videoRepository.count()).toBe(0);
      expect(await pendingUploadCount()).toBe(0);
    });

    it('should abort the multipart upload when the draft cannot be saved', async () => {
      const saveError = new QueryFailedError(
        'INSERT INTO "videos"',
        [],
        new Error('connection lost'),
      );
      const save = jest
        .spyOn(videoRepository, 'save')
        .mockRejectedValueOnce(saveError);

      const error: unknown = await service
        .startUpload(owner.id, {
          fileName: 'aula.mp4',
          fileSize: 1000,
          contentType: 'video/mp4',
        })
        .catch((e: unknown) => e);
      save.mockRestore();

      expect(error).toBe(saveError);
      expect(await videoRepository.count()).toBe(0);
      expect(await pendingUploadCount()).toBe(0);
    });
  });

  describe('part URLs, resume and abort', () => {
    async function startDraft() {
      return service.startUpload(owner.id, {
        fileName: 'aula.mp4',
        fileSize: 10,
        contentType: 'video/mp4',
      });
    }

    it('should accept a PUT on a part URL and list the received part with its ETag', async () => {
      const draft = await startDraft();
      const { parts } = await service.getPartUrls(owner.id, draft.videoId, [1]);

      const put = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(10),
      });
      expect(put.status).toBe(200);

      const listed = await service.listUploadedParts(owner.id, draft.videoId);
      expect(listed.parts).toEqual([
        { partNumber: 1, ETag: put.headers.get('etag'), size: 10 },
      ]);
    });

    it('should mark the video failed with upload_expired when the storage lost the upload', async () => {
      const draft = await startDraft();
      await storage.abortMultipartUpload(
        `videos/${draft.videoId}/source`,
        draft.uploadId,
      );

      await expect(
        service.listUploadedParts(owner.id, draft.videoId),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      const video = await videoRepository.findOneByOrFail({
        id: draft.videoId,
      });
      expect(video).toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: 'upload_expired',
        upload_id: null,
      });
    });

    it('should abort the upload in the storage and mark the video failed with upload_aborted', async () => {
      const draft = await startDraft();

      await service.abortUpload(owner.id, draft.videoId);

      const video = await videoRepository.findOneByOrFail({
        id: draft.videoId,
      });
      expect(video).toMatchObject({
        status: VideoStatus.FAILED,
        processing_error: 'upload_aborted',
        upload_id: null,
      });
      await expect(
        storage.listParts(`videos/${draft.videoId}/source`, draft.uploadId),
      ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
    });

    it('should hide another user video behind VIDEO_NOT_FOUND', async () => {
      const draft = await startDraft();
      const stranger = await createStranger();

      await expect(
        service.listUploadedParts(stranger.id, draft.videoId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    it('should assemble the object, store its real size and queue video.process', async () => {
      const draft = await service.startUpload(owner.id, {
        fileName: 'aula.mp4',
        fileSize: 1000,
        contentType: 'video/mp4',
      });
      const { parts } = await service.getPartUrls(owner.id, draft.videoId, [1]);
      const put = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(1234),
      });

      const result = await service.completeUpload(owner.id, draft.videoId, [
        { partNumber: 1, ETag: put.headers.get('etag') ?? '' },
      ]);

      expect(result).toEqual({
        videoId: draft.videoId,
        status: VideoStatus.PROCESSING,
      });
      const head = await storage.headObject(`videos/${draft.videoId}/source`);
      expect(head.contentLength).toBe(1234);
      expect(
        await videoRepository.findOneByOrFail({ id: draft.videoId }),
      ).toMatchObject({
        status: VideoStatus.PROCESSING,
        size_bytes: 1234,
        upload_id: null,
      });
      const job = await queue.getJob(draft.videoId);
      expect(job?.name).toBe('video.process');
      expect(job?.data).toEqual({ videoId: draft.videoId });
    });

    it('should keep the draft when an ETag does not match', async () => {
      const draft = await service.startUpload(owner.id, {
        fileName: 'aula.mp4',
        fileSize: 10,
        contentType: 'video/mp4',
      });
      const { parts } = await service.getPartUrls(owner.id, draft.videoId, [1]);
      await fetch(parts[0].url, { method: 'PUT', body: new Uint8Array(10) });

      await expect(
        service.completeUpload(owner.id, draft.videoId, [
          { partNumber: 1, ETag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect(
        (await videoRepository.findOneByOrFail({ id: draft.videoId })).status,
      ).toBe(VideoStatus.DRAFT);
      expect(await queue.getJob(draft.videoId)).toBeUndefined();
    });
  });

  describe('getOwnedVideo', () => {
    it('should return the stored duration and jsonb metadata to the owner only', async () => {
      const draft = await service.startUpload(owner.id, {
        fileName: 'aula.mp4',
        fileSize: 10,
        contentType: 'video/mp4',
      });
      const metadata = {
        format: {
          name: 'mov,mp4,m4a,3gp,3g2,mj2',
          durationSeconds: 4.5,
          sizeBytes: 10,
          bitRate: null,
        },
        video: {
          codec: 'h264',
          width: 640,
          height: 360,
          frameRate: 25,
          bitRate: null,
        },
        audio: null,
      };
      await videoRepository.update(
        { id: draft.videoId },
        { status: VideoStatus.READY, duration_seconds: 4.5, metadata },
      );

      const result = await service.getOwnedVideo(owner.id, draft.videoId);
      expect(result).toMatchObject({
        id: draft.videoId,
        slug: draft.slug,
        status: VideoStatus.READY,
        durationSeconds: 4.5,
        metadata,
        thumbnailUrl: null,
      });

      const stranger = await createStranger();
      await expect(
        service.getOwnedVideo(stranger.id, draft.videoId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl and getDownloadUrl', () => {
    const SOURCE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

    async function readyVideo(): Promise<string> {
      const draft = await service.startUpload(owner.id, {
        fileName: 'minha aula.mp4',
        fileSize: SOURCE.length,
        contentType: 'video/mp4',
      });
      await storage.putObject(
        `videos/${draft.videoId}/source`,
        SOURCE,
        'video/mp4',
      );
      await videoRepository.update(
        { id: draft.videoId },
        { status: VideoStatus.READY, upload_id: null },
      );
      return draft.videoId;
    }

    it('should return a stream URL that the storage serves with Range and 206', async () => {
      const videoId = await readyVideo();

      const { url } = await service.getStreamUrl(owner.id, videoId);
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        SOURCE.subarray(0, 100),
      );
    });

    it('should return a download URL served as an attachment with the original name', async () => {
      const videoId = await readyVideo();

      const { url } = await service.getDownloadUrl(owner.id, videoId);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(disposition.startsWith('attachment')).toBe(true);
      expect(disposition).toContain('filename="minha aula.mp4"');
    });
  });
});
