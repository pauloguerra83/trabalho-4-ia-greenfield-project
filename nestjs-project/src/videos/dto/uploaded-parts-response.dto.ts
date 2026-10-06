import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  ETag: string;

  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty()
  uploadId: string;

  @ApiProperty({ example: 67108864 })
  partSize: number;

  @ApiProperty({ example: 3 })
  partCount: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already received by the storage, by ascending number',
  })
  parts: UploadedPartDto[];
}
