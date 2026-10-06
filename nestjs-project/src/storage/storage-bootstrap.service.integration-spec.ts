import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  DeleteBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageBootstrapService } from './storage-bootstrap.service';
import { S3_INTERNAL_CLIENT, STORAGE_LIFECYCLE } from './storage.constants';
import { StorageModule } from './storage.module';

// A bucket of its own, so the test can observe creation from scratch.
const BOOTSTRAP_BUCKET = 'streamtube-bootstrap-test';

describe('StorageBootstrapService (integration)', () => {
  const originalBucket = process.env.S3_BUCKET;
  let module: TestingModule;
  let bootstrap: StorageBootstrapService;
  let client: S3Client;

  beforeAll(async () => {
    process.env.S3_BUCKET = BOOTSTRAP_BUCKET;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    bootstrap = module.get(StorageBootstrapService);
    client = module.get<S3Client>(S3_INTERNAL_CLIENT);
    await client
      .send(new DeleteBucketCommand({ Bucket: BOOTSTRAP_BUCKET }))
      .catch(() => undefined);
  });

  afterAll(async () => {
    await client
      .send(new DeleteBucketCommand({ Bucket: BOOTSTRAP_BUCKET }))
      .catch(() => undefined);
    process.env.S3_BUCKET = originalBucket;
    await module.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should create the bucket when it does not exist', async () => {
    await bootstrap.ensureBucket();

    await expect(
      client.send(new HeadBucketCommand({ Bucket: BOOTSTRAP_BUCKET })),
    ).resolves.toBeDefined();
  });

  it('should apply the abandoned-upload rule or report that the server handles it', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await bootstrap.ensureBucket();

    const lifecycle = await client
      .send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: BOOTSTRAP_BUCKET,
        }),
      )
      .catch(() => undefined);
    const ruleApplied = (lifecycle?.Rules ?? []).some(
      (rule) =>
        rule.ID === STORAGE_LIFECYCLE.ABORT_INCOMPLETE_UPLOADS_RULE_ID &&
        rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation ===
          STORAGE_LIFECYCLE.ABORT_INCOMPLETE_UPLOADS_AFTER_DAYS,
    );
    const fallbackReported = warn.mock.calls.some(([message]) =>
      String(message).includes('lifecycle'),
    );

    expect(ruleApplied || fallbackReported).toBe(true);
  });

  it('should be idempotent across repeated startups', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(bootstrap.ensureBucket()).resolves.toBeUndefined();
    await expect(bootstrap.ensureBucket()).resolves.toBeUndefined();
  });
});
