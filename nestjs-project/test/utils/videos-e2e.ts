import * as argon2 from 'argon2';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import storageConfig from '../../src/config/storage.config';
import { S3_INTERNAL_CLIENT } from '../../src/storage/storage.constants';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { emptyBucket } from '../../src/test/storage';
import { User } from '../../src/users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../../src/videos/processing/video-processing.constants';

export interface VideosTestContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  s3: S3Client;
  bucket: string;
  throttlerStorage: ThrottlerStorageService;
  /** The video-processing queue under the test QUEUE_PREFIX. */
  queue: Queue;
}

export interface AuthenticatedUser {
  id: string;
  accessToken: string;
}

/** Boots AppModule with the same global pipes and filters as `main.ts`. */
export async function createVideosTestApp(): Promise<VideosTestContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: app.get(DataSource),
    s3: app.get<S3Client>(S3_INTERNAL_CLIENT),
    bucket: app.get<ConfigType<typeof storageConfig>>(storageConfig.KEY).bucket,
    throttlerStorage: app.get<ThrottlerStorageService>(ThrottlerStorage),
    queue: app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
  };
}

/** Clean database, test bucket, test queue and rate-limit counters between tests. */
export async function resetVideosTestState(
  ctx: VideosTestContext,
): Promise<void> {
  await cleanAllTables(ctx.dataSource);
  await emptyBucket(ctx.s3, ctx.bucket);
  await ctx.queue.obliterate({ force: true });
  ctx.throttlerStorage.storage.clear();
}

/** Creates a confirmed user and authenticates through `POST /auth/login`. */
export async function createAuthenticatedUser(
  ctx: VideosTestContext,
  email: string,
  password = 'password123',
): Promise<AuthenticatedUser> {
  const user = await ctx.dataSource.getRepository(User).save({
    email,
    password: await argon2.hash(password),
    is_confirmed: true,
  });

  const response = await request(ctx.app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const body = response.body as { access_token: string };

  return { id: user.id, accessToken: body.access_token };
}
