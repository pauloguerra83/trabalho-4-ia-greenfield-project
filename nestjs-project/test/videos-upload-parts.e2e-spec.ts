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

interface PartUrlsBody {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

interface UploadedPartsBody {
  uploadId: string;
  partSize: number;
  partCount: number;
  parts: { partNumber: number; ETag: string; size: number }[];
}

describe('videos-upload-parts', () => {
  let ctx: VideosTestContext;
  let owner: AuthenticatedUser;
  let videoId: string;
  let uploadId: string;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ fileName: 'aula.mp4', fileSize: 1000, contentType: 'video/mp4' })
      .expect(201);
    ({ videoId, uploadId } = res.body as { videoId: string; uploadId: string });
  });

  const server = () => request(ctx.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const requestPartUrls = (
    token: string,
    partNumbers: number[],
    id = videoId,
  ) =>
    server()
      .post(`/videos/${id}/upload/part-urls`)
      .set(auth(token))
      .send({ partNumbers });

  const listParts = (token: string, id = videoId) =>
    server().get(`/videos/${id}/upload/parts`).set(auth(token));

  const abortUpload = (token: string, id = videoId) =>
    server().delete(`/videos/${id}/upload`).set(auth(token));

  const loadVideo = () =>
    ctx.dataSource.getRepository(Video).findOneByOrFail({ id: videoId });

  async function putPartOne(): Promise<string> {
    const res = await requestPartUrls(owner.accessToken, [1]).expect(200);
    const put = await fetch((res.body as PartUrlsBody).parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(1000),
    });
    expect(put.status).toBe(200);
    return put.headers.get('etag') ?? '';
  }

  // 1. Enviar, retomar e abortar o upload

  it('url-de-parte-aceita-put-direto-no-storage', async () => {
    const before = Date.now();
    const res = await requestPartUrls(owner.accessToken, [1]).expect(200);

    const body = res.body as PartUrlsBody;
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].partNumber).toBe(1);
    const minutesAhead = (new Date(body.expiresAt).getTime() - before) / 60000;
    expect(minutesAhead).toBeGreaterThanOrEqual(55);
    expect(minutesAhead).toBeLessThanOrEqual(65);

    const put = await fetch(body.parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(1000),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();
  });

  it('listar-partes-permite-retomar', async () => {
    const etag = await putPartOne();

    const res = await listParts(owner.accessToken).expect(200);

    expect(res.body).toEqual({
      uploadId,
      partSize: 67108864,
      partCount: 1,
      parts: [{ partNumber: 1, ETag: etag, size: 1000 }],
    } satisfies UploadedPartsBody);
  });

  it('abortar-upload-marca-video-como-falho', async () => {
    const res = await abortUpload(owner.accessToken).expect(204);
    expect(res.text).toBe('');

    expect(await loadVideo()).toMatchObject({
      status: 'failed',
      processing_error: 'upload_aborted',
      upload_id: null,
    });
    await expect(
      ctx.app
        .get(StorageService)
        .listParts(`videos/${videoId}/source`, uploadId),
    ).rejects.toMatchObject({ name: 'StorageUploadNotFoundError' });
  });

  // 2. Rejeitar operações inválidas no upload

  it('part-number-acima-de-part-count-retorna-400', async () => {
    const res = await requestPartUrls(owner.accessToken, [2]).expect(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PART_NUMBER');

    const empty = await requestPartUrls(owner.accessToken, []).expect(400);
    expect((empty.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });

  it('upload-expirado-retorna-410-e-marca-falha', async () => {
    await ctx.app
      .get(StorageService)
      .abortMultipartUpload(`videos/${videoId}/source`, uploadId);

    const res = await listParts(owner.accessToken).expect(410);

    expect(res.body).toEqual({
      statusCode: 410,
      error: 'UPLOAD_EXPIRED',
      message: 'Upload session has expired',
    });
    expect(await loadVideo()).toMatchObject({
      status: 'failed',
      processing_error: 'upload_expired',
      upload_id: null,
    });
  });

  it('outro-usuario-recebe-404-nos-tres-endpoints', async () => {
    const stranger = await createAuthenticatedUser(ctx, 'stranger@example.com');

    for (const res of [
      await requestPartUrls(stranger.accessToken, [1]),
      await listParts(stranger.accessToken),
      await abortUpload(stranger.accessToken),
    ]) {
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    }
    expect((await loadVideo()).status).toBe('draft');

    const invalidId = await listParts(owner.accessToken, 'not-a-uuid').expect(
      400,
    );
    expect((invalidId.body as { error: string }).error).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('video-fora-de-draft-recebe-409-nos-tres-endpoints', async () => {
    await abortUpload(owner.accessToken).expect(204);

    for (const res of [
      await requestPartUrls(owner.accessToken, [1]),
      await listParts(owner.accessToken),
      await abortUpload(owner.accessToken),
    ]) {
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe(
        'INVALID_VIDEO_STATUS',
      );
    }
  });
});
