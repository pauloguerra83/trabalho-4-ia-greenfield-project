import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

// Joi types `value` as `any` on the failed branch; expose it as a typed record.
const validate = (
  env: Record<string, string>,
): { error?: ValidationError; value: Record<string, unknown> } => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env = { ...requiredEnv } as Record<string, string>;
      delete env[key];

      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply storage and queue defaults when they are not set', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-media',
      STORAGE_CORS_ORIGIN: 'http://localhost:3001',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should reject an S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'storage:9000' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});

describe('test environment isolation', () => {
  it('should run tests against a dedicated queue prefix and bucket', () => {
    expect(process.env.QUEUE_PREFIX).toBe('streamtube-test');
    expect(process.env.S3_BUCKET).toBe('streamtube-media-test');
  });

  it('should sign test URLs with a host reachable from the container', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe('http://storage:9000');
  });
});
