export const VIDEO_UPLOAD = {
  /** 10 GiB. */
  MAX_SIZE_BYTES: 10737418240,
  /** 64 MiB; at most 160 parts for a 10 GiB file. */
  PART_SIZE_BYTES: 67108864,
  PART_URL_EXPIRES_IN_SECONDS: 3600,
} as const;

/** Expiry of the presigned GET URLs handed to clients. */
export const VIDEO_URL_EXPIRES_IN_SECONDS = {
  THUMBNAIL: 3600,
  STREAM: 3600,
  DOWNLOAD: 900,
} as const;

/** Values stored in `videos.processing_error` when a video becomes `failed`. */
export const PROCESSING_ERRORS = {
  UPLOAD_EXPIRED: 'upload_expired',
  UPLOAD_ABORTED: 'upload_aborted',
  FILE_TOO_LARGE: 'file_too_large',
  INVALID_VIDEO: 'invalid_video',
} as const;

/** Maximum part numbers per `part-urls` request. */
export const PART_URLS_MAX_BATCH = 100;

/** Retries when a generated slug collides with an existing one. */
export const SLUG_MAX_ATTEMPTS = 5;
