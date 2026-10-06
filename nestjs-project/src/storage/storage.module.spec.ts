import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  const originalPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  let module: TestingModule;

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://browser-host.test:9000';
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = originalPublicEndpoint;
    await module.close();
  });

  it('should compile and expose StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('should point the internal client at S3_ENDPOINT and the public client at S3_PUBLIC_ENDPOINT', async () => {
    const internal = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const external = module.get<S3Client>(S3_PUBLIC_CLIENT);

    const internalEndpoint = await internal.config.endpoint!();
    const publicEndpoint = await external.config.endpoint!();

    expect(internalEndpoint.hostname).toBe('storage');
    expect(publicEndpoint.hostname).toBe('browser-host.test');
  });

  it('should disable automatic checksums so browsers can use presigned URLs', async () => {
    const external = module.get<S3Client>(S3_PUBLIC_CLIENT);

    expect(await external.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await external.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
  });
});
