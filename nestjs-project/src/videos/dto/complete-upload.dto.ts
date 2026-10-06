import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** S3 accepts at most 10000 parts per multipart upload. */
const MAX_PARTS = 10000;

export class CompletedPartDto {
  /** Part number (1-based). */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag response header returned by the storage for this part's PUT. */
  @IsString()
  @IsNotEmpty()
  ETag: string;
}

export class CompleteUploadDto {
  /** Every uploaded part, by ascending part number. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
