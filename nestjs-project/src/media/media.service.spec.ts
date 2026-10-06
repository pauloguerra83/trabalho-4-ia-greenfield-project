import { Test } from '@nestjs/testing';
import { COMMAND_RUNNER, CommandFailedError } from './command-runner';
import { InvalidMediaError } from './media.errors';
import { MediaService } from './media.service';

const URL =
  'http://storage:9000/streamtube-media/videos/id/source?X-Amz-Signature=abc&X-Amz-Expires=300';

const PROBE_OUTPUT = {
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '3.000000',
    size: '51230',
    bit_rate: '136613',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 640,
      height: 360,
      r_frame_rate: '30000/1001',
      bit_rate: '55970',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 1,
      sample_rate: '44100',
    },
  ],
};

describe('MediaService', () => {
  let service: MediaService;
  const runCommand = jest.fn();

  beforeEach(async () => {
    runCommand.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: COMMAND_RUNNER, useValue: runCommand },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  const respondWith = (json: unknown) =>
    runCommand.mockResolvedValueOnce(Buffer.from(JSON.stringify(json)));

  describe('probe', () => {
    it('should run ffprobe on the URL as a single argument, without a shell', async () => {
      respondWith(PROBE_OUTPUT);

      await service.probe(URL);

      expect(runCommand).toHaveBeenCalledWith(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          URL,
        ],
        { timeoutMs: expect.any(Number) as number },
      );
    });

    it('should return the duration and the curated format, video and audio summaries', async () => {
      respondWith(PROBE_OUTPUT);

      const result = await service.probe(URL);

      expect(result).toEqual({
        durationSeconds: 3,
        metadata: {
          format: {
            name: 'mov,mp4,m4a,3gp,3g2,mj2',
            durationSeconds: 3,
            sizeBytes: 51230,
            bitRate: 136613,
          },
          video: {
            codec: 'h264',
            width: 640,
            height: 360,
            frameRate: 29.97,
            bitRate: 55970,
          },
          audio: { codec: 'aac', channels: 1, sampleRate: 44100 },
        },
      });
    });

    it('should report a null audio summary for silent videos', async () => {
      respondWith({ ...PROBE_OUTPUT, streams: [PROBE_OUTPUT.streams[0]] });

      const result = await service.probe(URL);

      expect(result.metadata.audio).toBeNull();
    });

    it('should reject files without a video stream as InvalidMediaError', async () => {
      respondWith({ ...PROBE_OUTPUT, streams: [PROBE_OUTPUT.streams[1]] });

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should reject media without a known duration as InvalidMediaError', async () => {
      respondWith({
        ...PROBE_OUTPUT,
        format: { ...PROBE_OUTPUT.format, duration: 'N/A' },
      });

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should turn "Invalid data found" from ffprobe into InvalidMediaError', async () => {
      runCommand.mockRejectedValueOnce(
        new CommandFailedError(
          'ffprobe',
          'source: Invalid data found when processing input\n',
          new Error('exit 1'),
        ),
      );

      await expect(service.probe(URL)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should propagate other ffprobe failures as transient errors', async () => {
      const networkError = new CommandFailedError(
        'ffprobe',
        'Connection refused\n',
        new Error('exit 1'),
      );
      runCommand.mockRejectedValueOnce(networkError);

      await expect(service.probe(URL)).rejects.toBe(networkError);
    });
  });

  describe('extractThumbnail', () => {
    it('should seek, take one frame scaled to 1280px wide and stream the JPEG to stdout', async () => {
      runCommand.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff]));

      const jpeg = await service.extractThumbnail(URL, 30);

      expect(jpeg).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(runCommand).toHaveBeenCalledWith(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '3.000',
          '-i',
          URL,
          '-frames:v',
          '1',
          '-vf',
          'scale=1280:-2',
          '-f',
          'image2',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        { timeoutMs: expect.any(Number) as number },
      );
    });

    it('should report InvalidMediaError when ffmpeg produces no frame', async () => {
      runCommand.mockResolvedValueOnce(Buffer.alloc(0));

      await expect(service.extractThumbnail(URL, 3)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });
  });

  describe('thumbnailTimestamp', () => {
    it.each([
      [600, 60],
      [3, 0.3],
      [0.05, 0],
      [0, 0],
    ])('should pick %ss → %ss', (duration, expected) => {
      expect(MediaService.thumbnailTimestamp(duration)).toBeCloseTo(
        expected,
        6,
      );
    });

    it('should stay before the end of a clip shorter than a second', () => {
      expect(MediaService.thumbnailTimestamp(0.5)).toBeCloseTo(0.05, 6);
      expect(MediaService.thumbnailTimestamp(0.11)).toBeLessThan(0.11);
    });
  });
});
