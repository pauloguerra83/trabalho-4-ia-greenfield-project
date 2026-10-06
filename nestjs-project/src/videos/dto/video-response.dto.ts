import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../video-metadata';
import { VideoStatus } from '../video-status.enum';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ example: 'Minha aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true, example: 3.0 })
  durationSeconds: number | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    description:
      'Curated ffprobe summary with `format`, `video` and `audio` (null without audio)',
    additionalProperties: true,
  })
  metadata: VideoMetadata | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET URL of the JPEG thumbnail (valid for 1 hour)',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Failure reason when status is failed (e.g. upload_expired, invalid_video)',
  })
  processingError: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
