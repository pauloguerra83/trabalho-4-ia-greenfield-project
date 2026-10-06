import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  InvalidVideoStatusException,
  UploadExpiredException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { sourceKey } from '../storage/storage-keys';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import { CompletedPartDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import { StartUploadResponseDto } from './dto/start-upload-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUrlResponseDto } from './dto/video-url-response.dto';
import { attachmentDisposition } from './content-disposition.util';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './processing/video-processing.producer';
import { generateSlug } from './slug.util';
import { VideoStatus } from './video-status.enum';
import {
  PROCESSING_ERRORS,
  SLUG_MAX_ATTEMPTS,
  VIDEO_UPLOAD,
  VIDEO_URL_EXPIRES_IN_SECONDS,
} from './videos.constants';

function partCountFor(sizeBytes: number): number {
  return Math.ceil(sizeBytes / VIDEO_UPLOAD.PART_SIZE_BYTES);
}

/** File name without its last extension; falls back to the full name. */
function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^./\\]*$/, '').trim();
  return withoutExtension || fileName;
}

function isSlugConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; detail?: string };
  return (
    driverError.code === '23505' &&
    (driverError.detail ?? '').includes('(slug)')
  );
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly producer: VideoProcessingProducer,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload. The
   * client then uploads the parts straight to the storage.
   */
  async startUpload(
    userId: string,
    dto: StartUploadDto,
  ): Promise<StartUploadResponseDto> {
    if (dto.fileSize > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    const id = randomUUID();
    const key = sourceKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        user_id: userId,
        title: dto.title ?? titleFromFileName(dto.fileName),
        original_filename: dto.fileName,
        content_type: dto.contentType,
        size_bytes: dto.fileSize,
        status: VideoStatus.DRAFT,
        upload_id: uploadId,
      });
    } catch (error) {
      await this.abortQuietly(key, uploadId);
      throw error;
    }

    return {
      videoId: video.id,
      uploadId,
      slug: video.slug,
      title: video.title,
      status: VideoStatus.DRAFT,
      partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
      partCount: partCountFor(dto.fileSize),
    };
  }

  /** Owner view of a video, polled by the client to follow the processing. */
  async getOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedOrFail(userId, videoId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.presignGet(
          video.thumbnail_key,
          VIDEO_URL_EXPIRES_IN_SECONDS.THUMBNAIL,
        )
      : null;

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
      processingError: video.processing_error,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  /** Presigned GET of the source for `<video src>`; the storage serves Range/206. */
  async getStreamUrl(
    userId: string,
    videoId: string,
  ): Promise<VideoUrlResponseDto> {
    const video = await this.findReadyOrFail(userId, videoId);
    return this.presignedSourceUrl(video, VIDEO_URL_EXPIRES_IN_SECONDS.STREAM);
  }

  /** Presigned GET that forces a download with the original file name. */
  async getDownloadUrl(
    userId: string,
    videoId: string,
  ): Promise<VideoUrlResponseDto> {
    const video = await this.findReadyOrFail(userId, videoId);
    return this.presignedSourceUrl(
      video,
      VIDEO_URL_EXPIRES_IN_SECONDS.DOWNLOAD,
      attachmentDisposition(video.original_filename),
    );
  }

  /** Presigned `UploadPart` URLs for a batch of part numbers. */
  async getPartUrls(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const video = await this.findOwnedOrFail(userId, videoId);
    const uploadId = this.assertUploading(video);
    const partCount = partCountFor(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }

    const expiresIn = VIDEO_UPLOAD.PART_URL_EXPIRES_IN_SECONDS;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(
          sourceKey(video.id),
          uploadId,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expiresAt };
  }

  /** Parts already received by the storage, used to resume an upload. */
  async listUploadedParts(
    userId: string,
    videoId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.findOwnedOrFail(userId, videoId);
    const uploadId = this.assertUploading(video);

    let parts: UploadedPart[];
    try {
      parts = await this.storage.listParts(sourceKey(video.id), uploadId);
    } catch (error) {
      if (error instanceof StorageUploadNotFoundError) {
        await this.markFailed(video.id, PROCESSING_ERRORS.UPLOAD_EXPIRED);
        throw new UploadExpiredException();
      }
      throw error;
    }

    return {
      uploadId,
      partSize: VIDEO_UPLOAD.PART_SIZE_BYTES,
      partCount: partCountFor(video.size_bytes),
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        ETag: part.etag,
        size: part.size,
      })),
    };
  }

  /** Aborts the multipart upload; the video ends as `failed`. */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedOrFail(userId, videoId);
    const uploadId = this.assertUploading(video);

    try {
      await this.storage.abortMultipartUpload(sourceKey(video.id), uploadId);
    } catch (error) {
      // Already gone (e.g. expired by the storage): aborting is idempotent.
      if (!(error instanceof StorageUploadNotFoundError)) throw error;
    }
    await this.markFailed(video.id, PROCESSING_ERRORS.UPLOAD_ABORTED);
  }

  /**
   * Completes the multipart upload, checks the final object and starts the
   * processing: the video becomes `processing` and `video.process` is queued.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPartDto[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedOrFail(userId, videoId);
    const uploadId = this.assertUploading(video);
    const key = sourceKey(video.id);

    try {
      await this.storage.completeMultipartUpload(
        key,
        uploadId,
        parts.map((part) => ({ partNumber: part.partNumber, etag: part.ETag })),
      );
    } catch (error) {
      if (error instanceof StorageInvalidPartsError) {
        // The video stays a draft so the client can fix the list and retry.
        throw new InvalidUploadPartsException();
      }
      if (error instanceof StorageUploadNotFoundError) {
        await this.markFailed(video.id, PROCESSING_ERRORS.UPLOAD_EXPIRED);
        throw new UploadExpiredException();
      }
      throw error;
    }

    const { contentLength } = await this.storage.headObject(key);
    if (contentLength > VIDEO_UPLOAD.MAX_SIZE_BYTES) {
      await this.storage.deleteObject(key);
      await this.markFailed(video.id, PROCESSING_ERRORS.FILE_TOO_LARGE);
      throw new VideoTooLargeException();
    }

    // Conditional on `draft`: a concurrent completion loses the race with 409.
    const { affected } = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        size_bytes: contentLength,
        upload_id: null,
      },
    );
    if (!affected) throw new InvalidVideoStatusException();

    try {
      await this.producer.enqueue(video.id);
    } catch (error) {
      await this.markFailed(
        video.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    return { videoId: video.id, status: VideoStatus.PROCESSING };
  }

  private async findOwnedOrFail(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({
      id: videoId,
      user_id: userId,
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async findReadyOrFail(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(userId, videoId);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return video;
  }

  private async presignedSourceUrl(
    video: Video,
    expiresIn: number,
    contentDisposition?: string,
  ): Promise<VideoUrlResponseDto> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const url = await this.storage.presignGet(sourceKey(video.id), expiresIn, {
      contentDisposition,
    });
    return { url, expiresAt };
  }

  /** Upload operations only apply to drafts, which always hold an upload id. */
  private assertUploading(video: Video): string {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStatusException();
    }
    return video.upload_id;
  }

  private async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.FAILED, processing_error: reason, upload_id: null },
    );
  }

  private async insertWithUniqueSlug(
    fields: Omit<Partial<Video>, 'slug'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateSlug() }),
        );
      } catch (error) {
        if (!isSlugConflict(error) || attempt >= SLUG_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }

  /** Compensation: the original error is what the caller must see. */
  private async abortQuietly(key: string, uploadId: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadId);
    } catch (abortError) {
      this.logger.warn(
        `Failed to abort multipart upload ${uploadId} for ${key}: ${String(abortError)}`,
      );
    }
  }
}
