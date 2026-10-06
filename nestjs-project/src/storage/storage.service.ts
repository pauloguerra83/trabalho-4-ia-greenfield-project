import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { translateMultipartError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
}

export interface PresignGetOptions {
  /** `public` URLs go to HTTP clients; `internal` URLs stay inside the Compose network. */
  client?: 'public' | 'internal';
  contentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!output.UploadId) {
      throw new Error(`Storage returned no UploadId for ${key}`);
    }
    return output.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    // Manual loop on IsTruncated instead of `paginateListParts`: MinIO answers
    // the last page with `NextPartNumberMarker: '0'`, which the SDK paginator
    // treats as a new token and requests forever.
    let partNumberMarker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        partNumberMarker = page.IsTruncated
          ? page.NextPartNumberMarker
          : undefined;
      } while (partNumberMarker);
    } catch (error) {
      throw translateMultipartError(error, key);
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      throw translateMultipartError(error, key);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw translateMultipartError(error, key);
    }
  }

  async headObject(key: string): Promise<ObjectHead> {
    const output = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return { contentLength: output.ContentLength ?? 0 };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async presignGet(
    key: string,
    expiresIn: number,
    options: PresignGetOptions = {},
  ): Promise<string> {
    const client =
      options.client === 'internal' ? this.internalClient : this.publicClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn },
    );
  }
}
