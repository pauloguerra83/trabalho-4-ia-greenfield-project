import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class StartUploadDto {
  /** Original file name; its name without extension is the default title. */
  @IsString()
  @Length(1, 255)
  fileName: string;

  /** Declared file size in bytes (at most 10 GiB). */
  @IsInt()
  @Min(1)
  fileSize: number;

  /** MIME type of the file; must be a video type. */
  @IsString()
  @Matches(/^video\//, { message: 'contentType must be a video MIME type' })
  contentType: string;

  /** Optional title; defaults to the file name without extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 255)
  title?: string;
}
