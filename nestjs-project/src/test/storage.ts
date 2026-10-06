import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  paginateListObjectsV2,
} from '@aws-sdk/client-s3';

/**
 * Removes every object and aborts every pending multipart upload in the
 * test bucket, so suites start from an empty storage state.
 */
export async function emptyBucket(
  client: S3Client,
  bucket: string,
): Promise<void> {
  for await (const page of paginateListObjectsV2(
    { client },
    { Bucket: bucket },
  )) {
    for (const object of page.Contents ?? []) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
    }
  }

  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );
    for (const upload of page.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker);
}
