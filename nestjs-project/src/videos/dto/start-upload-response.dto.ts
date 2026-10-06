import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class StartUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ description: 'Multipart upload id in the storage' })
  uploadId: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ example: 'Minha aula' })
  title: string;

  @ApiProperty({ enum: [VideoStatus.DRAFT], example: VideoStatus.DRAFT })
  status: VideoStatus.DRAFT;

  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 3, description: 'Number of parts to upload' })
  partCount: number;
}
