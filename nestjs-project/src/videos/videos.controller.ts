import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import { StartUploadResponseDto } from './dto/start-upload-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUrlResponseDto } from './dto/video-url-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload in the storage. The client then requests presigned part URLs and uploads the file straight to the storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: StartUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel (CHANNEL_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared file size exceeds 10 GiB (VIDEO_TOO_LARGE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: StartUploadDto,
  ): Promise<StartUploadResponseDto> {
    return this.videosService.startUpload(user.sub, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the owner's view of a video: status, duration, metadata, slug and a presigned thumbnail URL. Clients poll it to follow processing → ready.",
  })
  @ApiResponse({
    status: 200,
    description: 'The video',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnedVideo(user.sub, id);
  }

  @Get(':id/stream')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned GET URL for the original file, usable directly in <video src>. The storage serves Range requests (206). Only for ready videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Streaming URL (valid for 1 hour)',
    type: VideoUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoUrlResponseDto> {
    return this.videosService.getStreamUrl(user.sub, id);
  }

  @Get(':id/download')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a presigned GET URL that forces a download (Content-Disposition: attachment) with the original file name. Only for ready videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Download URL (valid for 15 minutes)',
    type: VideoUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, id);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get presigned part URLs',
    description:
      'Returns presigned UploadPart URLs for a batch of part numbers. The client PUTs each part straight to the storage and keeps the ETag response header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs (valid for 1 hour)',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or part number above partCount (INVALID_PART_NUMBER)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.getPartUrls(user.sub, id, dto.partNumbers);
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts the storage already received, so the client can resume an interrupted upload. An expired upload marks the video as failed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Parts already received',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'The storage no longer has the multipart upload (UPLOAD_EXPIRED); the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, id);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Completes the multipart upload, checks the final object (at most 10 GiB) and queues the video processing. The video becomes processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed and processing queued',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (VALIDATION_ERROR) or the storage rejected the part list (INVALID_UPLOAD_PARTS); the video stays a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description:
      'The storage no longer has the multipart upload (UPLOAD_EXPIRED); the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description:
      'The final object exceeds 10 GiB (VIDEO_TOO_LARGE); it is removed and the video becomes failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort the upload',
    description:
      'Aborts the multipart upload in the storage and marks the video as failed (upload_aborted).',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 400,
    description: 'Invalid id (VALIDATION_ERROR)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft (INVALID_VIDEO_STATUS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, id);
  }
}
