import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { PART_URLS_MAX_BATCH } from '../videos.constants';

export class PartUrlsDto {
  /** Part numbers to presign (1-based, unique, at most 100 per request). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PART_URLS_MAX_BATCH)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
