import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { InvalidMediaError } from '../../media/media.errors';
import { PROCESSING_ERRORS } from '../videos.constants';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';
import type { VideoProcessJobData } from './video-processing.types';

/**
 * Consumes `video.process`. Registered only by the worker entrypoint, so the
 * HTTP API never consumes the queue.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    try {
      await this.processing.process(job.data.videoId);
    } catch (error) {
      // A file ffprobe cannot read will never succeed: fail without retries.
      if (error instanceof InvalidMediaError) {
        throw new UnrecoverableError(PROCESSING_ERRORS.INVALID_VIDEO);
      }
      throw error;
    }
  }

  /**
   * BullMQ emits `failed` on every failed attempt; the video only becomes
   * `failed` on the last one or on an unrecoverable error.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const unrecoverable = error instanceof UnrecoverableError;
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!unrecoverable && !attemptsExhausted) return;

    try {
      await this.processing.markFailed(job.data.videoId, error.message);
    } catch (markError) {
      // Event handler: rethrowing would crash the worker, so log instead.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(markError)}`,
      );
    }
  }
}
