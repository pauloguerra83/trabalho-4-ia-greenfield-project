import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaService } from '../../media/media.service';
import { thumbnailKey } from '../../storage/storage-keys';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

/** Long enough for ffprobe + ffmpeg to read a large source with Range requests. */
const SOURCE_URL_EXPIRES_IN_SECONDS = 3600;

/** Business rules of the `video.process` job; the BullMQ processor delegates here. */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  /**
   * Extracts duration, metadata and thumbnail, then marks the video `ready`.
   * Idempotent: a retry overwrites the thumbnail and the metadata.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${videoId}: ${video ? `status is ${video.status}` : 'not found'}`,
      );
      return;
    }

    const sourceUrl = await this.storage.presignGet(
      video.source_key,
      SOURCE_URL_EXPIRES_IN_SECONDS,
      { client: 'internal' },
    );
    const { durationSeconds, metadata } = await this.media.probe(sourceUrl);
    const jpeg = await this.media.extractThumbnail(sourceUrl, durationSeconds);

    const key = thumbnailKey(video.id);
    await this.storage.putObject(key, jpeg, 'image/jpeg');
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: key,
        processing_error: null,
      },
    );
  }

  /** Terminal failure, only while the video is still `processing`. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, processing_error: reason },
    );
  }
}
