import { readFile } from 'fs/promises';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { WorkerModule } from '../src/worker.module';
import {
  AuthenticatedUser,
  VideosTestContext,
  createAuthenticatedUser,
  createVideosTestApp,
  resetVideosTestState,
} from './utils/videos-e2e';

const FIXTURES = join(__dirname, 'fixtures');
const PIPELINE_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 40_000;

interface VideoBody {
  status: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  processingError: string | null;
}

/**
 * Full pipeline: upload through the API → queue → worker → ready. The worker
 * runs inside the test process with the test queue prefix (TD-14), so the
 * `video-worker` container, if running, never sees these jobs.
 */
describe('videos-pipeline', () => {
  let ctx: VideosTestContext;
  let worker: TestingModule;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init(); // starts the BullMQ worker
  }, PIPELINE_TIMEOUT_MS);

  afterAll(async () => {
    await worker?.close();
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
  });

  function server() {
    return request(ctx.app.getHttpServer());
  }

  function auth() {
    return { Authorization: `Bearer ${owner.accessToken}` };
  }

  /** Runs the client side of the upload and returns the video id. */
  async function uploadThroughApi(fixture: string): Promise<string> {
    const bytes = await readFile(join(FIXTURES, fixture));

    const started = await server()
      .post('/videos')
      .set(auth())
      .send({
        fileName: fixture,
        fileSize: bytes.length,
        contentType: 'video/mp4',
      })
      .expect(201);
    const { videoId, partCount } = started.body as {
      videoId: string;
      partCount: number;
    };
    expect(partCount).toBe(1);

    const urls = await server()
      .post(`/videos/${videoId}/upload/part-urls`)
      .set(auth())
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch(
      (urls.body as { parts: { url: string }[] }).parts[0].url,
      { method: 'PUT', body: new Uint8Array(bytes) },
    );
    expect(put.status).toBe(200);

    await server()
      .post(`/videos/${videoId}/upload/complete`)
      .set(auth())
      .send({ parts: [{ partNumber: 1, ETag: put.headers.get('etag') }] })
      .expect(202);

    return videoId;
  }

  /** Polls GET /videos/:id, as a client does, until processing ends. */
  async function waitForProcessing(videoId: string): Promise<VideoBody> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const res = await server()
        .get(`/videos/${videoId}`)
        .set(auth())
        .expect(200);
      const body = res.body as VideoBody;
      if (body.status !== 'processing') return body;
      if (Date.now() > deadline) {
        throw new Error(`Video ${videoId} still processing after timeout`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  it(
    'upload-processamento-ready-e-stream',
    async () => {
      const videoId = await uploadThroughApi('sample.mp4');

      const video = await waitForProcessing(videoId);

      expect(video.status).toBe('ready');
      expect(video.durationSeconds).toBeCloseTo(3, 1);
      expect(video.thumbnailUrl).toEqual(expect.any(String));
      const thumbnail = await fetch(video.thumbnailUrl!);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

      const stream = await server()
        .get(`/videos/${videoId}/stream`)
        .set(auth())
        .expect(200);
      const range = await fetch((stream.body as { url: string }).url, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(range.status).toBe(206);
    },
    PIPELINE_TIMEOUT_MS,
  );

  it(
    'arquivo-invalido-termina-em-failed',
    async () => {
      const videoId = await uploadThroughApi('not-a-video.mp4');

      const video = await waitForProcessing(videoId);

      expect(video.status).toBe('failed');
      expect(video.processingError).toBe('invalid_video');
      expect(video.thumbnailUrl).toBeNull();
    },
    PIPELINE_TIMEOUT_MS,
  );
});
