import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import type { VideoProcessJobData } from './video-processing.types';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /** Idempotent: `jobId = videoId`, so enqueueing the same video twice keeps one job. */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId },
    );
  }
}
