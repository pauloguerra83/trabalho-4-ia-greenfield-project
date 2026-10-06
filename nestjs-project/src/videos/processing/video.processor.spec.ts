import { Test } from '@nestjs/testing';
import { Job, UnrecoverableError } from 'bullmq';
import { InvalidMediaError } from '../../media/media.errors';
import { VideoProcessingService } from './video-processing.service';
import type { VideoProcessJobData } from './video-processing.types';
import { VideoProcessor } from './video.processor';

const VIDEO_ID = '33333333-3333-4333-8333-333333333333';

function job(attemptsMade: number, attempts = 3): Job<VideoProcessJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as Job<VideoProcessJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const processing = {
    process: jest.fn(),
    markFailed: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: VideoProcessingService, useValue: processing },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  describe('process', () => {
    it('should delegate the job to the processing service', async () => {
      processing.process.mockResolvedValue(undefined);

      await processor.process(job(0));

      expect(processing.process).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('should turn InvalidMediaError into an UnrecoverableError named invalid_video', async () => {
      processing.process.mockRejectedValue(new InvalidMediaError('no video'));

      const error: unknown = await processor
        .process(job(0))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toBe('invalid_video');
    });

    it('should rethrow transient errors unchanged so BullMQ retries them', async () => {
      const transient = new Error('storage timeout');
      processing.process.mockRejectedValue(transient);

      await expect(processor.process(job(0))).rejects.toBe(transient);
    });
  });

  describe('onFailed', () => {
    it('should not mark the video failed before the last attempt', async () => {
      await processor.onFailed(job(1), new Error('storage timeout'));
      await processor.onFailed(job(2), new Error('storage timeout'));

      expect(processing.markFailed).not.toHaveBeenCalled();
    });

    it('should mark the video failed with the error message on the last attempt', async () => {
      await processor.onFailed(job(3), new Error('storage timeout'));

      expect(processing.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'storage timeout',
      );
    });

    it('should mark the video failed right away on an unrecoverable error', async () => {
      await processor.onFailed(job(1), new UnrecoverableError('invalid_video'));

      expect(processing.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'invalid_video',
      );
    });

    it('should ignore events without a job', async () => {
      await processor.onFailed(undefined, new Error('lost'));

      expect(processing.markFailed).not.toHaveBeenCalled();
    });

    it('should log instead of throwing when the video cannot be marked failed', async () => {
      processing.markFailed.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job(3), new Error('storage timeout')),
      ).resolves.toBeUndefined();
    });
  });
});
