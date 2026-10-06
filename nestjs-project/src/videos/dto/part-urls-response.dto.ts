import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned URL for a PUT straight to the storage',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ format: 'date-time', description: 'When the URLs expire' })
  expiresAt: string;
}
