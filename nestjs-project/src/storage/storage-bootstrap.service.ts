import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import {
  S3_INTERNAL_CLIENT,
  STORAGE_CORS,
  STORAGE_LIFECYCLE,
} from './storage.constants';
import { errorName } from './storage.errors';

/** Server responses meaning "this S3 feature is not supported here". */
const UNSUPPORTED_FEATURE_CODES = new Set([
  'NotImplemented',
  'InvalidArgument',
  'MalformedXML',
]);

/**
 * Prepares the bucket idempotently on startup: creates it, then applies the
 * abandoned-upload lifecycle rule and browser CORS. Some S3-compatible
 * servers (MinIO) reject those two bucket settings and configure them at
 * server level instead, so a rejection is logged and startup continues.
 */
@Injectable()
export class StorageBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageBootstrapService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    await this.createBucketIfMissing();
    await this.applyOptionalSetting('lifecycle', () =>
      this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.config.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: STORAGE_LIFECYCLE.ABORT_INCOMPLETE_UPLOADS_RULE_ID,
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation:
                    STORAGE_LIFECYCLE.ABORT_INCOMPLETE_UPLOADS_AFTER_DAYS,
                },
              },
            ],
          },
        }),
      ),
    );
    await this.applyOptionalSetting('CORS', () =>
      this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.config.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [this.config.corsOrigin],
                AllowedMethods: [...STORAGE_CORS.ALLOWED_METHODS],
                AllowedHeaders: [...STORAGE_CORS.ALLOWED_HEADERS],
                ExposeHeaders: [...STORAGE_CORS.EXPOSE_HEADERS],
              },
            ],
          },
        }),
      ),
    );
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
      return;
    } catch (error) {
      if (errorName(error) !== 'NotFound') throw error;
    }
    try {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
      );
    } catch (error) {
      // Another process (API or worker) created it concurrently.
      if (errorName(error) !== 'BucketAlreadyOwnedByYou') throw error;
    }
  }

  private async applyOptionalSetting(
    setting: string,
    apply: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await apply();
    } catch (error) {
      const name = errorName(error);
      if (!name || !UNSUPPORTED_FEATURE_CODES.has(name)) throw error;
      this.logger.warn(
        `Storage server rejected bucket ${setting} (${name}); relying on server-level configuration.`,
      );
    }
  }
}
