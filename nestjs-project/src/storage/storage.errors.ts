export class StorageUploadNotFoundError extends Error {
  constructor(key: string) {
    super(`Multipart upload not found for ${key}`);
    this.name = 'StorageUploadNotFoundError';
  }
}

export class StorageInvalidPartsError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid parts for ${key}: ${reason}`);
    this.name = 'StorageInvalidPartsError';
  }
}

const UPLOAD_NOT_FOUND_CODES = new Set(['NoSuchUpload']);
const INVALID_PARTS_CODES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * Maps S3 SDK multipart errors to storage errors without HTTP semantics.
 * Unknown errors are returned unchanged so callers can rethrow them.
 */
export function translateMultipartError(error: unknown, key: string): unknown {
  const name = errorName(error);
  if (name && UPLOAD_NOT_FOUND_CODES.has(name)) {
    return new StorageUploadNotFoundError(key);
  }
  if (name && INVALID_PARTS_CODES.has(name)) {
    return new StorageInvalidPartsError(key, name);
  }
  return error;
}
