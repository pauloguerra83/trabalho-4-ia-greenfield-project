import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'video.process';

/** Bounded retries with backoff; `jobId` (the video id) is added per job. */
export const VIDEO_PROCESS_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 100,
};
