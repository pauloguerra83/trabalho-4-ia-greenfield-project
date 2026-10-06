import { Inject, Injectable } from '@nestjs/common';
import {
  COMMAND_RUNNER,
  CommandFailedError,
  type CommandRunner,
} from './command-runner';
import {
  INVALID_INPUT_PATTERNS,
  MEDIA_TIMEOUTS_MS,
  THUMBNAIL,
} from './media.constants';
import { InvalidMediaError } from './media.errors';
import type {
  MediaAudioSummary,
  MediaMetadata,
  MediaProbeResult,
  MediaVideoSummary,
} from './media.types';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  sample_rate?: string;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ffprobe frame rates are fractions such as `30000/1001`. */
function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!denominator || !Number.isFinite(numerator)) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Runs the system ffprobe/ffmpeg against an HTTP URL (presigned GET), so the
 * source is read with Range requests and never copied to disk.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(COMMAND_RUNNER) private readonly runCommand: CommandRunner,
  ) {}

  async probe(url: string): Promise<MediaProbeResult> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      MEDIA_TIMEOUTS_MS.PROBE,
    );

    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout.toString()) as FfprobeOutput;
    } catch {
      throw new InvalidMediaError('ffprobe returned unreadable output');
    }

    const metadata = this.curate(output);
    return { durationSeconds: metadata.format.durationSeconds, metadata };
  }

  /** One JPEG frame, 1280px wide with the aspect ratio preserved. */
  async extractThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const seconds = MediaService.thumbnailTimestamp(durationSeconds);
    const jpeg = await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        seconds.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL.WIDTH}:-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      MEDIA_TIMEOUTS_MS.THUMBNAIL,
    );
    if (jpeg.length === 0) {
      throw new InvalidMediaError('ffmpeg produced no frame');
    }
    return jpeg;
  }

  /** `min(10% of the duration, duration − ε)`, never negative. */
  static thumbnailTimestamp(durationSeconds: number): number {
    const position = Math.min(
      durationSeconds * THUMBNAIL.POSITION_RATIO,
      durationSeconds - THUMBNAIL.END_MARGIN_SECONDS,
    );
    return Math.max(0, position);
  }

  private curate(output: FfprobeOutput): MediaMetadata {
    const streams = output.streams ?? [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    if (!videoStream || !videoStream.width || !videoStream.height) {
      throw new InvalidMediaError('no video stream');
    }
    const durationSeconds = toNumber(output.format?.duration);
    if (durationSeconds === null || durationSeconds <= 0) {
      throw new InvalidMediaError('unknown duration');
    }

    const video: MediaVideoSummary = {
      codec: videoStream.codec_name ?? 'unknown',
      width: videoStream.width,
      height: videoStream.height,
      frameRate: parseFrameRate(videoStream.r_frame_rate),
      bitRate: toNumber(videoStream.bit_rate),
    };
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const audio: MediaAudioSummary | null = audioStream
      ? {
          codec: audioStream.codec_name ?? 'unknown',
          channels: audioStream.channels ?? null,
          sampleRate: toNumber(audioStream.sample_rate),
        }
      : null;

    return {
      format: {
        name: output.format?.format_name ?? 'unknown',
        durationSeconds,
        sizeBytes: toNumber(output.format?.size),
        bitRate: toNumber(output.format?.bit_rate),
      },
      video,
      audio,
    };
  }

  /** Unreadable input becomes InvalidMediaError; anything else propagates. */
  private async run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<Buffer> {
    try {
      return await this.runCommand(command, args, { timeoutMs });
    } catch (error) {
      if (
        error instanceof CommandFailedError &&
        INVALID_INPUT_PATTERNS.some((pattern) => pattern.test(error.stderr))
      ) {
        throw new InvalidMediaError(error.stderr.trim());
      }
      throw error;
    }
  }
}
