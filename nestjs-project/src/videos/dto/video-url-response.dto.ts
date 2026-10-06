import { ApiProperty } from '@nestjs/swagger';

export class VideoUrlResponseDto {
  @ApiProperty({ description: 'Presigned GET URL served by the storage' })
  url: string;

  @ApiProperty({ format: 'date-time', description: 'When the URL expires' })
  expiresAt: string;
}
