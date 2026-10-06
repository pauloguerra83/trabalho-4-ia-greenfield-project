import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidVideoStatusException,
  UploadExpiredException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { StartUploadDto } from './dto/start-upload.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { SLUG_MAX_ATTEMPTS, VIDEO_UPLOAD } from './videos.constants';
import { VideosService } from './videos.service';
import { VideoProcessingProducer } from './processing/video-processing.producer';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';

function queryError(code: string, detail: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO "videos"',
    [],
    Object.assign(new Error(detail), { code, detail }),
  );
}

const slugConflict = () =>
  queryError('23505', 'Key (slug)=(AAAAAAAAAAA) already exists.');

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => ({ ...fields })),
    save: jest.fn((video: Partial<Video>) => Promise.resolve({ ...video })),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const producer = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };
  const channelsService = {
    findByUserIdOrFail: jest.fn(),
  };
  const storage = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    presignUploadPart: jest.fn(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`http://storage:9000/part-${partNumber}`),
    ),
    listParts: jest.fn().mockResolvedValue([]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue({ contentLength: 1000 }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    presignGet: jest.fn((key: string) =>
      Promise.resolve(`http://storage:9000/${key}?signed`),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserIdOrFail.mockResolvedValue({
      id: CHANNEL_ID,
      user_id: USER_ID,
    });
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
        { provide: ChannelsService, useValue: channelsService },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  const dto = (overrides: Partial<StartUploadDto> = {}): StartUploadDto => ({
    fileName: 'aula.mp4',
    fileSize: 1000,
    contentType: 'video/mp4',
    ...overrides,
  });

  describe('startUpload', () => {
    it("should create a draft of the user's channel with the multipart upload id and return the upload plan", async () => {
      const result = await service.startUpload(USER_ID, dto());

      expect(channelsService.findByUserIdOrFail).toHaveBeenCalledWith(USER_ID);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.videoId}/source`,
        'video/mp4',
      );
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.videoId,
          channel_id: CHANNEL_ID,
          source_key: `videos/${result.videoId}/source`,
          status: VideoStatus.DRAFT,
          upload_id: 'upload-1',
          size_bytes: 1000,
        }),
      );
      expect(result).toMatchObject({
        uploadId: 'upload-1',
        status: VideoStatus.DRAFT,
        partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
        partCount: 1,
      });
      expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    });

    it('should report CHANNEL_NOT_FOUND before opening the multipart upload', async () => {
      channelsService.findByUserIdOrFail.mockRejectedValueOnce(
        new ChannelNotFoundException(),
      );

      await expect(service.startUpload(USER_ID, dto())).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('should default the title to the file name without its last extension', async () => {
      const result = await service.startUpload(
        USER_ID,
        dto({ fileName: 'ferias.2024.mp4' }),
      );

      expect(result.title).toBe('ferias.2024');
    });

    it('should keep the full file name when it has nothing but an extension', async () => {
      const result = await service.startUpload(
        USER_ID,
        dto({ fileName: '.mp4' }),
      );

      expect(result.title).toBe('.mp4');
    });

    it('should use the provided title', async () => {
      const result = await service.startUpload(
        USER_ID,
        dto({ title: 'Minha aula' }),
      );

      expect(result.title).toBe('Minha aula');
    });

    it('should round partCount up', async () => {
      const exact = await service.startUpload(
        USER_ID,
        dto({ fileSize: VIDEO_UPLOAD.PART_SIZE_BYTES }),
      );
      const onePastPart = await service.startUpload(
        USER_ID,
        dto({ fileSize: VIDEO_UPLOAD.PART_SIZE_BYTES + 1 }),
      );

      expect(exact.partCount).toBe(1);
      expect(onePastPart.partCount).toBe(2);
    });

    it('should accept exactly 10 GiB and reject anything above with VIDEO_TOO_LARGE', async () => {
      await expect(
        service.startUpload(
          USER_ID,
          dto({ fileSize: VIDEO_UPLOAD.MAX_SIZE_BYTES }),
        ),
      ).resolves.toBeDefined();

      storage.createMultipartUpload.mockClear();
      await expect(
        service.startUpload(
          USER_ID,
          dto({ fileSize: VIDEO_UPLOAD.MAX_SIZE_BYTES + 1 }),
        ),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should retry with a new slug when the generated one collides', async () => {
      videoRepository.save.mockRejectedValueOnce(slugConflict());

      await service.startUpload(USER_ID, dto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.create.mock.calls.map(
        ([fields]) => fields.slug,
      );
      expect(first).not.toBe(second);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should give up after the maximum slug attempts and abort the multipart upload', async () => {
      videoRepository.save.mockRejectedValue(slugConflict());

      await expect(service.startUpload(USER_ID, dto())).rejects.toBeInstanceOf(
        QueryFailedError,
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(SLUG_MAX_ATTEMPTS);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
      videoRepository.save.mockReset();
      videoRepository.save.mockImplementation((video: Partial<Video>) =>
        Promise.resolve({ ...video }),
      );
    });

    it('should not retry other insert errors, abort the multipart upload and rethrow', async () => {
      const fkError = queryError('23503', 'Key (channel_id) is not present.');
      videoRepository.save.mockRejectedValueOnce(fkError);

      await expect(service.startUpload(USER_ID, dto())).rejects.toBe(fkError);

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('should rethrow the insert error even when the compensating abort fails', async () => {
      const fkError = queryError('23503', 'Key (channel_id) is not present.');
      videoRepository.save.mockRejectedValueOnce(fkError);
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('down'));

      await expect(service.startUpload(USER_ID, dto())).rejects.toBe(fkError);
    });
  });

  const VIDEO_ID = '22222222-2222-4222-8222-222222222222';
  // Differs from the key derived from the id: the storage calls must read the
  // stored column, not recompute it.
  const SOURCE_KEY = 'videos/stored-key/source';

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: VIDEO_ID,
      channel_id: CHANNEL_ID,
      source_key: SOURCE_KEY,
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      size_bytes: VIDEO_UPLOAD.PART_SIZE_BYTES * 2 + 1, // 3 parts
      ...overrides,
    } as Video;
  }

  describe('ownership and status guards', () => {
    it('should report VIDEO_NOT_FOUND when the video is not owned by the user', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getPartUrls(USER_ID, VIDEO_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.listUploadedParts(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.abortUpload(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: VIDEO_ID, channel: { user_id: USER_ID } },
      });
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should report INVALID_VIDEO_STATUS for a %s video',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          draftVideo({ status, upload_id: null }),
        );

        await expect(
          service.getPartUrls(USER_ID, VIDEO_ID, [1]),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
        await expect(
          service.listUploadedParts(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
        await expect(
          service.abortUpload(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      },
    );
  });

  describe('getPartUrls', () => {
    it('should presign one URL per requested part with a 1-hour expiry', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      const before = Date.now();

      const result = await service.getPartUrls(USER_ID, VIDEO_ID, [1, 3]);

      expect(result.parts).toEqual([
        { partNumber: 1, url: 'http://storage:9000/part-1' },
        { partNumber: 3, url: 'http://storage:9000/part-3' },
      ]);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        SOURCE_KEY,
        'upload-1',
        3,
        VIDEO_UPLOAD.PART_URL_EXPIRES_IN_SECONDS,
      );
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt - before).toBeGreaterThanOrEqual(3600 * 1000);
      expect(expiresAt - before).toBeLessThan(3600 * 1000 + 5000);
    });

    it('should reject a part number above partCount with INVALID_PART_NUMBER', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.getPartUrls(USER_ID, VIDEO_ID, [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('listUploadedParts', () => {
    it('should return the upload plan and the received parts with ETag', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.listParts.mockResolvedValueOnce([
        { partNumber: 1, etag: '"abc"', size: 10 },
      ]);

      const result = await service.listUploadedParts(USER_ID, VIDEO_ID);

      expect(result).toEqual({
        uploadId: 'upload-1',
        partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
        partCount: 3,
        parts: [{ partNumber: 1, ETag: '"abc"', size: 10 }],
      });
    });

    it('should mark the video failed with upload_expired when the storage lost the upload', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.listParts.mockRejectedValueOnce(
        new StorageUploadNotFoundError('videos/x/source'),
      );

      await expect(
        service.listUploadedParts(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(UploadExpiredException);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.FAILED,
          processing_error: 'upload_expired',
          upload_id: null,
        },
      );
    });

    it('should propagate other storage errors without changing the video', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      const outage = new Error('storage down');
      storage.listParts.mockRejectedValueOnce(outage);

      await expect(service.listUploadedParts(USER_ID, VIDEO_ID)).rejects.toBe(
        outage,
      );
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and mark the video failed with upload_aborted', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await service.abortUpload(USER_ID, VIDEO_ID);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        SOURCE_KEY,
        'upload-1',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.FAILED,
          processing_error: 'upload_aborted',
          upload_id: null,
        },
      );
    });

    it('should still mark the video aborted when the storage no longer has the upload', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.abortMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError('videos/x/source'),
      );

      await service.abortUpload(USER_ID, VIDEO_ID);

      expect(videoRepository.update).toHaveBeenCalledTimes(1);
    });

    it('should propagate other abort errors without changing the video', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('down'));

      await expect(service.abortUpload(USER_ID, VIDEO_ID)).rejects.toThrow(
        'down',
      );
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, ETag: '"abc"' }];

    it('should complete the upload, store the real size, mark processing and enqueue once', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.headObject.mockResolvedValueOnce({ contentLength: 1234 });

      const result = await service.completeUpload(USER_ID, VIDEO_ID, parts);

      expect(result).toEqual({
        videoId: VIDEO_ID,
        status: VideoStatus.PROCESSING,
      });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        SOURCE_KEY,
        'upload-1',
        [{ partNumber: 1, etag: '"abc"' }],
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.PROCESSING,
          size_bytes: 1234,
          upload_id: null,
        },
      );
      expect(producer.enqueue).toHaveBeenCalledTimes(1);
      expect(producer.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should keep the draft and report INVALID_UPLOAD_PARTS when the storage rejects the parts', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new StorageInvalidPartsError('k', 'InvalidPart'),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should mark the video failed with upload_expired when the storage lost the upload', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.completeMultipartUpload.mockRejectedValueOnce(
        new StorageUploadNotFoundError('k'),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(UploadExpiredException);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({ processing_error: 'upload_expired' }),
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should delete an object above 10 GiB and mark the video failed with file_too_large', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storage.headObject.mockResolvedValueOnce({
        contentLength: VIDEO_UPLOAD.MAX_SIZE_BYTES + 1,
      });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.deleteObject).toHaveBeenCalledWith(SOURCE_KEY);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.FAILED,
          processing_error: 'file_too_large',
          upload_id: null,
        },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should report INVALID_VIDEO_STATUS and not enqueue when another completion won the race', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      videoRepository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should mark the video failed and rethrow when the job cannot be queued', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      producer.enqueue.mockRejectedValueOnce(new Error('redis unavailable'));

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toThrow('redis unavailable');
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.FAILED,
          processing_error: 'redis unavailable',
          upload_id: null,
        },
      );
    });

    it('should report INVALID_VIDEO_STATUS for a video that is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, parts),
      ).rejects.toBeInstanceOf(InvalidVideoStatusException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedVideo', () => {
    const createdAt = new Date('2026-10-05T12:00:00.000Z');
    const updatedAt = new Date('2026-10-05T12:05:00.000Z');

    function storedVideo(overrides: Partial<Video> = {}): Video {
      return draftVideo({
        slug: 'AAAAAAAAAAA',
        title: 'Minha aula',
        thumbnail_key: null,
        duration_seconds: null,
        metadata: null,
        processing_error: null,
        created_at: createdAt,
        updated_at: updatedAt,
        ...overrides,
      });
    }

    it('should return null thumbnailUrl and processing fields for a draft', async () => {
      videoRepository.findOne.mockResolvedValue(storedVideo());

      const result = await service.getOwnedVideo(USER_ID, VIDEO_ID);

      expect(result).toEqual({
        id: VIDEO_ID,
        slug: 'AAAAAAAAAAA',
        title: 'Minha aula',
        status: VideoStatus.DRAFT,
        durationSeconds: null,
        metadata: null,
        thumbnailUrl: null,
        processingError: null,
        createdAt: '2026-10-05T12:00:00.000Z',
        updatedAt: '2026-10-05T12:05:00.000Z',
      });
      expect(storage.presignGet).not.toHaveBeenCalled();
    });

    it('should presign the thumbnail for one hour when it exists', async () => {
      videoRepository.findOne.mockResolvedValue(
        storedVideo({
          status: VideoStatus.READY,
          thumbnail_key: `videos/${VIDEO_ID}/thumbnail.jpg`,
          duration_seconds: 3,
        }),
      );

      const result = await service.getOwnedVideo(USER_ID, VIDEO_ID);

      expect(storage.presignGet).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/thumbnail.jpg`,
        3600,
      );
      expect(result.thumbnailUrl).toBe(
        `http://storage:9000/videos/${VIDEO_ID}/thumbnail.jpg?signed`,
      );
      expect(result.durationSeconds).toBe(3);
    });

    it('should report VIDEO_NOT_FOUND for another user video', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getOwnedVideo(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl and getDownloadUrl', () => {
    const readyVideo = (overrides: Partial<Video> = {}) =>
      draftVideo({
        status: VideoStatus.READY,
        upload_id: null,
        original_filename: 'aula.mp4',
        ...overrides,
      });

    const secondsUntil = (iso: string, from: number) =>
      (new Date(iso).getTime() - from) / 1000;

    it('should presign the source for one hour to stream it', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      const before = Date.now();

      const result = await service.getStreamUrl(USER_ID, VIDEO_ID);

      expect(storage.presignGet).toHaveBeenCalledWith(SOURCE_KEY, 3600, {
        contentDisposition: undefined,
      });
      expect(result.url).toBe(`http://storage:9000/${SOURCE_KEY}?signed`);
      expect(secondsUntil(result.expiresAt, before)).toBeGreaterThanOrEqual(
        3600,
      );
      expect(secondsUntil(result.expiresAt, before)).toBeLessThan(3605);
    });

    it('should presign the source for 15 minutes with an attachment disposition to download it', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());
      const before = Date.now();

      const result = await service.getDownloadUrl(USER_ID, VIDEO_ID);

      expect(storage.presignGet).toHaveBeenCalledWith(SOURCE_KEY, 900, {
        contentDisposition:
          'attachment; filename="aula.mp4"; filename*=UTF-8\'\'aula.mp4',
      });
      expect(secondsUntil(result.expiresAt, before)).toBeGreaterThanOrEqual(
        900,
      );
      expect(secondsUntil(result.expiresAt, before)).toBeLessThan(905);
    });

    it('should sanitize quotes and non-ASCII characters in the download file name', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ original_filename: 'férias "2024".mp4' }),
      );

      await service.getDownloadUrl(USER_ID, VIDEO_ID);

      const [, , options] = storage.presignGet.mock.calls[0] as unknown as [
        string,
        number,
        { contentDisposition: string },
      ];
      expect(options.contentDisposition).toBe(
        'attachment; filename="f_rias _2024_.mp4"; ' +
          "filename*=UTF-8''f%C3%A9rias%20%222024%22.mp4",
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should report VIDEO_NOT_READY for a %s video',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(readyVideo({ status }));

        await expect(
          service.getStreamUrl(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        await expect(
          service.getDownloadUrl(USER_ID, VIDEO_ID),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storage.presignGet).not.toHaveBeenCalled();
      },
    );

    it('should report VIDEO_NOT_FOUND for another user video', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getStreamUrl(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getDownloadUrl(USER_ID, VIDEO_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
