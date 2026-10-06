export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const STORAGE_LIFECYCLE = {
  ABORT_INCOMPLETE_UPLOADS_RULE_ID: 'abort-incomplete-multipart-uploads',
  ABORT_INCOMPLETE_UPLOADS_AFTER_DAYS: 1,
} as const;

export const STORAGE_CORS = {
  ALLOWED_METHODS: ['PUT', 'GET'],
  ALLOWED_HEADERS: ['*'],
  EXPOSE_HEADERS: ['ETag'],
} as const;
