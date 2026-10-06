import request from 'supertest';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import {
  AuthenticatedUser,
  VideosTestContext,
  createAuthenticatedUser,
  createVideosTestApp,
  resetVideosTestState,
} from './utils/videos-e2e';

describe('videos-upload-complete', () => {
  let ctx: VideosTestContext;
  let owner: AuthenticatedUser;
  let videoId: string;
  let uploadId: string;
  let etag: string;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');

    const started = await server()
      .post('/videos')
      .set(auth(owner.accessToken))
      .send({ fileName: 'aula.mp4', fileSize: 1000, contentType: 'video/mp4' })
      .expect(201);
    ({ videoId, uploadId } = started.body as {
      videoId: string;
      uploadId: string;
    });

    const urls = await server()
      .post(`/videos/${videoId}/upload/part-urls`)
      .set(auth(owner.accessToken))
      .send({ partNumbers: [1] })
      .expect(200);
    const put = await fetch(
      (urls.body as { parts: { url: string }[] }).parts[0].url,
      { method: 'PUT', body: new Uint8Array(1000) },
    );
    expect(put.status).toBe(200);
    etag = put.headers.get('etag') ?? '';
  });

  function server() {
    return request(ctx.app.getHttpServer());
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  const complete = (token: string, parts: unknown[]) =>
    server()
      .post(`/videos/${videoId}/upload/complete`)
      .set(auth(token))
      .send({ parts });

  const loadVideo = () =>
    ctx.dataSource.getRepository(Video).findOneByOrFail({ id: videoId });

  // 1. Concluir o upload e disparar o processamento

  it('concluir-upload-grava-processing-e-enfileira', async () => {
    const res = await complete(owner.accessToken, [
      { partNumber: 1, ETag: etag },
    ]).expect(202);

    expect(res.body).toEqual({ videoId, status: 'processing' });

    const head = await ctx.app
      .get(StorageService)
      .headObject(`videos/${videoId}/source`);
    expect(head.contentLength).toBe(1000);

    expect(await loadVideo()).toMatchObject({
      status: 'processing',
      size_bytes: 1000,
      upload_id: null,
    });

    const job = await ctx.queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe('video.process');
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  // 2. Rejeitar conclusões inválidas

  it('etag-que-nao-confere-retorna-400-e-mantem-draft', async () => {
    const res = await complete(owner.accessToken, [
      { partNumber: 1, ETag: '"00000000000000000000000000000000"' },
    ]).expect(400);

    expect((res.body as { error: string }).error).toBe('INVALID_UPLOAD_PARTS');
    const video = await loadVideo();
    expect(video.status).toBe('draft');
    expect(video.upload_id).toBe(uploadId);
    expect(await ctx.queue.getJob(videoId)).toBeUndefined();

    await complete(owner.accessToken, [{ partNumber: 1, ETag: etag }]).expect(
      202,
    );
  });

  it('upload-expirado-retorna-410', async () => {
    await ctx.app
      .get(StorageService)
      .abortMultipartUpload(`videos/${videoId}/source`, uploadId);

    const res = await complete(owner.accessToken, [
      { partNumber: 1, ETag: etag },
    ]).expect(410);

    expect((res.body as { error: string }).error).toBe('UPLOAD_EXPIRED');
    expect(await loadVideo()).toMatchObject({
      status: 'failed',
      processing_error: 'upload_expired',
    });
    expect(await ctx.queue.getJob(videoId)).toBeUndefined();
  });

  it('concluir-duas-vezes-retorna-409-sem-segundo-job', async () => {
    const parts = [{ partNumber: 1, ETag: etag }];
    await complete(owner.accessToken, parts).expect(202);

    const res = await complete(owner.accessToken, parts).expect(409);

    expect((res.body as { error: string }).error).toBe('INVALID_VIDEO_STATUS');
    const counts = await ctx.queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    );
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(1);
    expect(await ctx.queue.getJob(videoId)).toBeDefined();
  });

  it('outro-usuario-recebe-404', async () => {
    const stranger = await createAuthenticatedUser(ctx, 'stranger@example.com');

    const res = await complete(stranger.accessToken, [
      { partNumber: 1, ETag: etag },
    ]).expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    expect((await loadVideo()).status).toBe('draft');
    expect(await ctx.queue.getJob(videoId)).toBeUndefined();

    const empty = await complete(owner.accessToken, []).expect(400);
    expect((empty.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });
});
