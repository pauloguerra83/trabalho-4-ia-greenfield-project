import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { InvalidMediaError } from './media.errors';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/** Width and height from the SOF0/SOF2 marker of a JPEG. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < jpeg.length) {
    const marker = jpeg.readUInt16BE(offset);
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xffc0 || marker === 0xffc2) {
      return {
        height: jpeg.readUInt16BE(offset + 5),
        width: jpeg.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error('No SOF marker found');
}

describe('MediaService (integration)', () => {
  let module: TestingModule;
  let media: MediaService;
  let storage: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
        MediaModule,
      ],
    }).compile();
    await module.init(); // bucket bootstrap
    media = module.get(MediaService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  /** Uploads a fixture and returns an internal presigned GET URL for it. */
  async function fixtureUrl(name: string): Promise<string> {
    const key = `videos/${randomUUID()}/source`;
    await storage.putObject(
      key,
      await readFile(join(FIXTURES, name)),
      'video/mp4',
    );
    return storage.presignGet(key, 300, { client: 'internal' });
  }

  it('should read the duration and codecs of a real video over HTTP', async () => {
    const url = await fixtureUrl('sample.mp4');

    const result = await media.probe(url);

    expect(result.durationSeconds).toBeCloseTo(3, 1);
    expect(result.metadata.format.durationSeconds).toBe(result.durationSeconds);
    expect(result.metadata.video).toMatchObject({
      codec: 'h264',
      width: 640,
      height: 360,
      frameRate: 25,
    });
    expect(result.metadata.audio).toMatchObject({ codec: 'aac' });
  });

  it('should extract a 1280px-wide JPEG keeping the aspect ratio', async () => {
    const url = await fixtureUrl('sample.mp4');

    const jpeg = await media.extractThumbnail(url, 3);

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 720 });
  });

  it('should reject a file that is not a video with InvalidMediaError', async () => {
    const url = await fixtureUrl('not-a-video.mp4');

    await expect(media.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });
});
