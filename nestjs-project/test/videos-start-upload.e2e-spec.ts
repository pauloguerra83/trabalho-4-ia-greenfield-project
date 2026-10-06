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

interface StartUploadBody {
  videoId: string;
  uploadId: string;
  slug: string;
  title: string;
  status: string;
  partSize: number;
  partCount: number;
}

describe('videos-start-upload', () => {
  let ctx: VideosTestContext;
  let user: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    user = await createAuthenticatedUser(ctx, 'owner@example.com');
  });

  const startUpload = (body: Record<string, unknown>, token?: string) => {
    const req = request(ctx.app.getHttpServer()).post('/videos').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const videoCount = () => ctx.dataSource.getRepository(Video).count();

  // 1. Pré-cadastrar o vídeo e abrir o upload

  it('iniciar-upload-cria-rascunho-e-multipart', async () => {
    const res = await startUpload(
      {
        fileName: 'aula.mp4',
        fileSize: 150000000,
        contentType: 'video/mp4',
        title: 'Minha aula',
      },
      user.accessToken,
    ).expect(201);

    const body = res.body as StartUploadBody;
    expect(body.videoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.uploadId).toEqual(expect.any(String));
    expect(body.uploadId).not.toHaveLength(0);
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body).toMatchObject({
      title: 'Minha aula',
      status: 'draft',
      partSize: 67108864,
      partCount: 3,
    });

    const video = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.videoId });
    expect(video).toMatchObject({
      status: 'draft',
      user_id: user.id,
      upload_id: body.uploadId,
      size_bytes: 150000000,
    });

    const parts = await ctx.app
      .get(StorageService)
      .listParts(`videos/${body.videoId}/source`, body.uploadId);
    expect(parts).toEqual([]);
  });

  it('titulo-padrao-e-nome-do-arquivo-sem-extensao', async () => {
    const res = await startUpload(
      { fileName: 'ferias.2024.mp4', fileSize: 1000, contentType: 'video/mp4' },
      user.accessToken,
    ).expect(201);

    const body = res.body as StartUploadBody;
    expect(body.title).toBe('ferias.2024');
    const video = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.videoId });
    expect(video.title).toBe('ferias.2024');
    expect(video.original_filename).toBe('ferias.2024.mp4');
  });

  it('slugs-distintos-entre-videos', async () => {
    const payload = {
      fileName: 'aula.mp4',
      fileSize: 1000,
      contentType: 'video/mp4',
    };

    const first = (await startUpload(payload, user.accessToken).expect(201))
      .body as StartUploadBody;
    const second = (await startUpload(payload, user.accessToken).expect(201))
      .body as StartUploadBody;

    expect(first.slug).not.toBe(second.slug);
    expect(first.videoId).not.toBe(second.videoId);
  });

  // 2. Rejeitar inícios de upload inválidos

  it('arquivo-acima-de-10-gib-retorna-413', async () => {
    const res = await startUpload(
      {
        fileName: 'grande.mp4',
        fileSize: 10737418241,
        contentType: 'video/mp4',
      },
      user.accessToken,
    ).expect(413);

    expect(res.body).toEqual({
      statusCode: 413,
      error: 'VIDEO_TOO_LARGE',
      message: 'Video exceeds the 10 GiB limit',
    });
    expect(await videoCount()).toBe(0);
  });

  it('content-type-que-nao-e-video-retorna-400', async () => {
    const res = await startUpload(
      { fileName: 'foto.png', fileSize: 1000, contentType: 'image/png' },
      user.accessToken,
    ).expect(400);

    const body = res.body as { error: string; message: string[] };
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message.some((m) => m.includes('contentType'))).toBe(true);

    const missingSize = await startUpload(
      { fileName: 'aula.mp4', contentType: 'video/mp4' },
      user.accessToken,
    ).expect(400);
    expect((missingSize.body as { error: string }).error).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('sem-token-retorna-401', async () => {
    await startUpload({
      fileName: 'aula.mp4',
      fileSize: 1000,
      contentType: 'video/mp4',
    }).expect(401);

    expect(await videoCount()).toBe(0);
  });
});
