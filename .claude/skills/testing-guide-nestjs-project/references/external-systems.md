> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — MinIO real (Docker)

**Strategy:** Real S3-compatible storage (`pgsty/minio`, Compose service `storage`) in development and tests, AWS S3 in production. Tests use a **dedicated bucket** so they never touch development files. Do not replace it with a local-filesystem adapter or an SDK mock: the phase depends on S3 behaviors that only a real server exercises — presigned multipart uploads, `ListParts`/`NoSuchUpload`, `HeadObject`, Range/206 for streaming and FFmpeg reading the source over HTTP.

**Approach:**
- `src/test/setup-test-env.ts` (first entry of Jest `setupFiles`) forces `S3_BUCKET=streamtube-media-test` and `S3_PUBLIC_ENDPOINT=http://storage:9000` — tests run inside the `nestjs-api` container, so presigned URLs must point at the Compose service name.
- `StorageBootstrapService` creates the bucket on `module.init()`; call `init()` on the testing module before using `StorageService`.
- Empty the bucket between tests with `emptyBucket(client, bucket)` from `src/test/storage.ts` (deletes objects and aborts pending multipart uploads).
- Upload parts with `fetch(presignedUrl, { method: 'PUT', body })` — the real client flow. Use `Uint8Array<ArrayBuffer>` bodies (with TypeScript 5.9 `Buffer` does not satisfy `BodyInit`).
- Simulate an expired multipart upload by aborting it through `StorageService.abortMultipartUpload` before the call under test.

**Setup pattern:**
```typescript
const module = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
    StorageModule,
  ],
}).compile();
await module.init(); // bucket bootstrap

const client = module.get<S3Client>(S3_INTERNAL_CLIENT);
const { bucket } = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);

beforeEach(() => emptyBucket(client, bucket));
afterAll(() => module.close()); // destroys the S3 clients
```

**Integration test:**
```typescript
it('should accept a PUT on a presigned part URL', async () => {
  const key = sourceKey(randomUUID());
  const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
  const url = await storage.presignUploadPart(key, uploadId, 1, 3600);

  const response = await fetch(url, { method: 'PUT', body: new Uint8Array(10) });

  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBeTruthy();
});
```

**Server quirks (MinIO):** bucket CORS and the `AbortIncompleteMultipartUpload` lifecycle action are rejected; development configures them at server level (`MINIO_API_CORS_ALLOW_ORIGIN`, `MINIO_API_STALE_UPLOADS_EXPIRY`). `ListParts` answers the last page with `NextPartNumberMarker: '0'`, which makes the SDK `paginateListParts` loop forever — paginate on `IsTruncated`.

---

## Message Queue — BullMQ over Redis (Docker)

**Strategy:** Real BullMQ over the Compose `redis` service. Tests use a **dedicated key prefix** (`QUEUE_PREFIX=streamtube-test`, forced by `src/test/setup-test-env.ts`), so the `video-worker` container — prefix `streamtube` — never consumes test jobs and can stay up during the suite. Consumers are exercised by running the **worker inside the test process**, which keeps tests deterministic.

**Approach:**
- Publisher tests: assert the job by id (`queue.getJob(videoId)`) — name, data and options (`attempts`, `backoff`).
- Consumer tests: import the consumer module (`VideoProcessingModule`, or `WorkerModule` for the full pipeline) and call `module.init()` — that starts the BullMQ worker; enqueue a job and poll the database until the expected status, with a timeout.
- Clean the queue between tests with `queue.obliterate({ force: true })`.
- `module.close()` closes queues and workers; skipping it leaves Jest hanging on open Redis handles.
- In BullMQ 5.x `queue.client` is an abstract `IRedisClient` (no `keys`); inspect a job hash with `hgetall('{prefix}:{queue}:{jobId}')`.

**Setup pattern:**
```typescript
const module = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [storageConfig, queueConfig] }),
    TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES, { synchronize: false }).options),
    VideoProcessingModule, // consumer: the worker starts on init()
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }), // producer side
  ],
  providers: [VideoProcessingProducer],
}).compile();
await module.init();
```

```typescript
it('should take a valid video to ready', async () => {
  await producer.enqueue(videoId);

  const video = await waitFor(
    () => videoRepository.findOneByOrFail({ id: videoId }),
    (v) => v.status === VideoStatus.READY,
  );
  expect(video.thumbnail_key).toBe(thumbnailKey(videoId));
});
```

**Retry semantics:** the worker `failed` event fires on **every** failed attempt. Assert the terminal state for the last attempt (`attemptsMade >= opts.attempts`) and for `UnrecoverableError` (fails without retries); unit-test the handler with fake jobs instead of waiting for real backoff.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
