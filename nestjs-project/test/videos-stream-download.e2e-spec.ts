import request from 'supertest';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import {
  AuthenticatedUser,
  VideosTestContext,
  createAuthenticatedUser,
  createVideosTestApp,
  resetVideosTestState,
} from './utils/videos-e2e';

interface UrlBody {
  url: string;
  expiresAt: string;
}

const SOURCE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

describe('videos-stream-download', () => {
  let ctx: VideosTestContext;
  let owner: AuthenticatedUser;
  let readyVideoId: string;
  let draftVideoId: string;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
    readyVideoId = await startUpload('minha aula.mp4');
    draftVideoId = await startUpload('rascunho.mp4');

    await ctx.app
      .get(StorageService)
      .putObject(`videos/${readyVideoId}/source`, SOURCE, 'video/mp4');
    await ctx.dataSource
      .getRepository(Video)
      .update(
        { id: readyVideoId },
        { status: VideoStatus.READY, upload_id: null },
      );
  });

  function server() {
    return request(ctx.app.getHttpServer());
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function startUpload(fileName: string): Promise<string> {
    const res = await server()
      .post('/videos')
      .set(auth(owner.accessToken))
      .send({ fileName, fileSize: SOURCE.length, contentType: 'video/mp4' })
      .expect(201);
    return (res.body as { videoId: string }).videoId;
  }

  const minutesAhead = (iso: string, from: number) =>
    (new Date(iso).getTime() - from) / 60000;

  // 1. Assistir e baixar um vídeo pronto

  it('stream-de-video-pronto-atende-range', async () => {
    const before = Date.now();
    const res = await server()
      .get(`/videos/${readyVideoId}/stream`)
      .set(auth(owner.accessToken))
      .expect(200);

    const body = res.body as UrlBody;
    expect(minutesAhead(body.expiresAt, before)).toBeGreaterThanOrEqual(55);
    expect(minutesAhead(body.expiresAt, before)).toBeLessThanOrEqual(65);

    const range = await fetch(body.url, { headers: { Range: 'bytes=0-99' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      SOURCE.subarray(0, 100),
    );
  });

  it('download-de-video-pronto-forca-anexo', async () => {
    const before = Date.now();
    const res = await server()
      .get(`/videos/${readyVideoId}/download`)
      .set(auth(owner.accessToken))
      .expect(200);

    const body = res.body as UrlBody;
    expect(minutesAhead(body.expiresAt, before)).toBeGreaterThanOrEqual(14);
    expect(minutesAhead(body.expiresAt, before)).toBeLessThanOrEqual(16);

    const download = await fetch(body.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(SOURCE);
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain('minha aula.mp4');
  });

  // 2. Recusar acesso indevido

  it('video-fora-de-ready-retorna-409', async () => {
    for (const path of ['stream', 'download']) {
      const res = await server()
        .get(`/videos/${draftVideoId}/${path}`)
        .set(auth(owner.accessToken))
        .expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'VIDEO_NOT_READY',
        message: 'Video is not ready',
      });
    }
  });

  it('outro-usuario-recebe-404', async () => {
    const stranger = await createAuthenticatedUser(ctx, 'stranger@example.com');

    for (const path of ['stream', 'download']) {
      const res = await server()
        .get(`/videos/${readyVideoId}/${path}`)
        .set(auth(stranger.accessToken))
        .expect(404);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    }

    await server().get(`/videos/${readyVideoId}/stream`).expect(401);
  });
});
