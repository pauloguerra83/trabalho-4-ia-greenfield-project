import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { emptyBucket } from '../test/storage';
import { sourceKey } from './storage-keys';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const PART_EXPIRES_IN = 3600;

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let client: S3Client;
  let config: ConfigType<typeof storageConfig>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await module.init(); // runs the bucket bootstrap

    storage = module.get(StorageService);
    client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await emptyBucket(client, config.bucket);
  });

  async function startUploadWithOnePart(body: Uint8Array<ArrayBuffer>) {
    const key = sourceKey(randomUUID());
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(
      key,
      uploadId,
      1,
      PART_EXPIRES_IN,
    );
    const response = await fetch(url, { method: 'PUT', body });
    return { key, uploadId, url, response };
  }

  it('should run a full multipart upload through a presigned part URL', async () => {
    const body = new Uint8Array(1000).fill(7);

    const { key, uploadId, response } = await startUploadWithOnePart(body);

    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();

    const parts = await storage.listParts(key, uploadId);
    expect(parts).toEqual([{ partNumber: 1, etag, size: 1000 }]);

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag! },
    ]);
    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(1000);
  });

  it('should sign part URLs with the S3_PUBLIC_ENDPOINT host', async () => {
    const { url } = await startUploadWithOnePart(new Uint8Array(10));

    expect(url.startsWith(`${config.publicEndpoint}/${config.bucket}/`)).toBe(
      true,
    );
  });

  it('should let the frontend origin PUT parts and read the ETag (CORS)', async () => {
    const key = sourceKey(randomUUID());
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(
      key,
      uploadId,
      1,
      PART_EXPIRES_IN,
    );

    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: config.corsOrigin,
        'Access-Control-Request-Method': 'PUT',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      config.corsOrigin,
    );
    expect(
      preflight.headers.get('access-control-allow-methods') ?? '',
    ).toContain('PUT');

    const put = await fetch(url, {
      method: 'PUT',
      headers: { Origin: config.corsOrigin },
      body: new Uint8Array(10),
    });
    expect(put.status).toBe(200);
    expect(
      (put.headers.get('access-control-expose-headers') ?? '').toLowerCase(),
    ).toContain('etag');
  });

  it('should translate NoSuchUpload into StorageUploadNotFoundError', async () => {
    const { key, uploadId } = await startUploadWithOnePart(new Uint8Array(10));
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      StorageUploadNotFoundError,
    );
    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"any"' },
      ]),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('should translate a mismatching ETag into StorageInvalidPartsError', async () => {
    const { key, uploadId } = await startUploadWithOnePart(new Uint8Array(10));

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsError);
  });

  it('should serve objects through presigned GET URLs with the requested disposition', async () => {
    const key = sourceKey(randomUUID());
    await storage.putObject(key, Buffer.from('hello'), 'video/mp4');

    const url = await storage.presignGet(key, 900, {
      contentDisposition: 'attachment; filename="aula.mp4"',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );

    await storage.deleteObject(key);
    await expect(storage.headObject(key)).rejects.toMatchObject({
      name: 'NotFound',
    });
  });
});
