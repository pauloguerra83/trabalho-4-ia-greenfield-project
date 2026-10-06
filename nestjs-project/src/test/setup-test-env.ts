// Loaded by Jest before `dotenv/config`. dotenv never overrides variables
// that are already set, so these values win over the development ones in
// `.env`, isolating tests from the dev queue and bucket.

// Separate queue prefix: the `video-worker` container never consumes test jobs.
process.env.QUEUE_PREFIX = 'streamtube-test';

// Dedicated bucket: tests never touch development files.
process.env.S3_BUCKET = 'streamtube-media-test';

// Tests run inside the `nestjs-api` container, where `localhost:9000` is the
// container itself. Presigned URLs must point at the Compose service name.
process.env.S3_PUBLIC_ENDPOINT = 'http://storage:9000';
