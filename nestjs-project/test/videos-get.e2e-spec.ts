import { randomUUID } from 'crypto';
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

interface VideoBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  durationSeconds: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('videos-get', () => {
  let ctx: VideosTestContext;
  let owner: AuthenticatedUser;
  let videoId: string;
  let slug: string;

  beforeAll(async () => {
    ctx = await createVideosTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  beforeEach(async () => {
    await resetVideosTestState(ctx);
    owner = await createAuthenticatedUser(ctx, 'owner@example.com');
    const res = await server()
      .post('/videos')
      .set(auth(owner.accessToken))
      .send({
        fileName: 'aula.mp4',
        fileSize: 1000,
        contentType: 'video/mp4',
        title: 'Minha aula',
      })
      .expect(201);
    ({ videoId, slug } = res.body as { videoId: string; slug: string });
  });

  function server() {
    return request(ctx.app.getHttpServer());
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  const getVideo = (token: string, id = videoId) =>
    server().get(`/videos/${id}`).set(auth(token));

  // 1. Consultar o vídeo em cada status

  it('video-draft-retorna-campos-de-processamento-nulos', async () => {
    const res = await getVideo(owner.accessToken).expect(200);

    const body = res.body as VideoBody;
    expect(body).toMatchObject({
      id: videoId,
      slug,
      title: 'Minha aula',
      status: 'draft',
      durationSeconds: null,
      metadata: null,
      thumbnailUrl: null,
      processingError: null,
    });
    expect(body.createdAt).toMatch(ISO_DATE);
    expect(body.updatedAt).toMatch(ISO_DATE);
  });

  it('video-ready-retorna-metadados-e-thumbnail-acessivel', async () => {
    const thumbnailKey = `videos/${videoId}/thumbnail.jpg`;
    await ctx.app
      .get(StorageService)
      .putObject(
        thumbnailKey,
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        'image/jpeg',
      );
    await ctx.dataSource.getRepository(Video).update(
      { id: videoId },
      {
        status: VideoStatus.READY,
        duration_seconds: 4.5,
        thumbnail_key: thumbnailKey,
        upload_id: null,
        metadata: {
          format: {
            name: 'mov,mp4,m4a,3gp,3g2,mj2',
            durationSeconds: 4.5,
            sizeBytes: 1000,
            bitRate: null,
          },
          video: {
            codec: 'h264',
            width: 640,
            height: 360,
            frameRate: 25,
            bitRate: null,
          },
          audio: null,
        },
      },
    );

    const res = await getVideo(owner.accessToken).expect(200);

    const body = res.body as VideoBody;
    expect(body.status).toBe('ready');
    expect(body.durationSeconds).toBe(4.5);
    expect(Object.keys(body.metadata ?? {}).sort()).toEqual([
      'audio',
      'format',
      'video',
    ]);
    expect(body.thumbnailUrl).toEqual(expect.any(String));

    const thumbnail = await fetch(body.thumbnailUrl!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  it('video-failed-retorna-motivo', async () => {
    await server()
      .delete(`/videos/${videoId}/upload`)
      .set(auth(owner.accessToken))
      .expect(204);

    const res = await getVideo(owner.accessToken).expect(200);

    expect(res.body).toMatchObject({
      status: 'failed',
      processingError: 'upload_aborted',
    });
  });

  // 2. Proteger o acesso ao vídeo

  it('outro-usuario-recebe-404', async () => {
    const stranger = await createAuthenticatedUser(ctx, 'stranger@example.com');
    const notFound = {
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    };

    const foreign = await getVideo(stranger.accessToken).expect(404);
    expect(foreign.body).toEqual(notFound);

    const missing = await getVideo(owner.accessToken, randomUUID()).expect(404);
    expect(missing.body).toEqual(notFound);

    await server().get(`/videos/${videoId}`).expect(401);
  });

  it('id-que-nao-e-uuid-retorna-400', async () => {
    const res = await getVideo(owner.accessToken, 'not-a-uuid').expect(400);

    expect((res.body as { error: string }).error).toBe('VALIDATION_ERROR');
  });
});
