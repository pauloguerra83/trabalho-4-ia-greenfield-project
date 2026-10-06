import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({
    enum: [VideoStatus.PROCESSING],
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus.PROCESSING;
}
