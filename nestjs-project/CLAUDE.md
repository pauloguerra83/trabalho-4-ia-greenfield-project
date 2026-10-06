# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Storage:** `docker compose ps storage` — expect `healthy` (its healthcheck probes `/minio/health/live`)
- **Video worker:** `docker compose logs --tail 20 video-worker` — expect `Video worker started`

The `video-worker` container is part of the environment: it starts with `docker compose up -d` and keeps consuming the video queue (`restart: unless-stopped`). On a fresh clone it restarts until `npm install` has populated `node_modules` in the shared volume.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing worker (`src/worker.ts`, no HTTP port); same image as `nestjs-api`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 8 for BullMQ, port `6379`
- `storage` — S3-compatible storage (`pgsty/minio`), API on port `9000`, web console on `http://localhost:9001` (credentials `S3_ACCESS_KEY` / `S3_SECRET_KEY`)
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`

The development image (`Dockerfile.dev`) includes `ffmpeg`/`ffprobe`, so the whole test suite (including the real FFmpeg tests) runs in `nestjs-api`. Both `nestjs-api` and `video-worker` use this image; a production image without FFmpeg for the API is a deployment concern (Phase 07).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and storage are ready
docker compose exec redis redis-cli ping
docker compose ps storage

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Video worker (ts-node; what the video-worker container runs)
npm run start:worker:prod                # Video worker from the compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["<rootDir>/test/setup-test-env.ts", "dotenv/config"]` (e2e config: `<rootDir>/../src/test/setup-test-env.ts`, since its `rootDir` is `test/`) — `setup-test-env.ts` runs first and forces the test-only values below; `dotenv/config` then loads `.env` without overriding them. Without `dotenv/config`, `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `testTimeout: 30000` in `test/jest-e2e.json` — booting `AppModule` connects to Postgres, Redis and the storage and prepares the bucket, which exceeds Jest's 5 s default.

Test-only values forced by `src/test/setup-test-env.ts`:

| Variable | Test value | Why |
|----------|------------|-----|
| `QUEUE_PREFIX` | `streamtube-test` | Tests run their own worker in-process; the `video-worker` container (prefix `streamtube`) never consumes test jobs, so it can stay up during the suite |
| `S3_BUCKET` | `streamtube-media-test` | Tests never touch development files; suites empty it with `emptyBucket()` (`src/test/storage.ts`) |
| `S3_PUBLIC_ENDPOINT` | `http://storage:9000` | Presigned URLs must be reachable from inside the `nestjs-api` container, where `localhost:9000` is the container itself |

Video tests need `db`, `redis` and `storage` up. E2E suites for videos share `test/utils/videos-e2e.ts` (app bootstrap with `main.ts` globals, state reset, authenticated user) and the fixtures in `test/fixtures/`.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos

Upload and processing of videos (Phase 03). Full spec: `docs/phases/phase-03-videos/phase-03-videos.md`.

### Modules

| Path | Responsibility |
|---|---|
| `src/videos/` | `VideosModule`: entity `Video`, `VideosController` (8 endpoints below), `VideosService` (upload, ownership, presigned URLs). Imports `ChannelsModule`, `StorageModule` and `QueueModule`, and registers the queue on the producer side only |
| `src/videos/processing/` | `VideoProcessingProducer` (API side) and `VideoProcessingModule` → `VideoProcessor` + `VideoProcessingService` (worker side; imported only by `WorkerModule`) |
| `src/storage/` | `StorageModule`: two S3 clients (internal `S3_ENDPOINT`, public `S3_PUBLIC_ENDPOINT`), multipart operations, presign, bucket bootstrap |
| `src/queue/` | `QueueModule`: `BullModule.forRootAsync` over Redis with `QUEUE_PREFIX` |
| `src/media/` | `MediaService`: `ffprobe` (duration + curated metadata) and `ffmpeg` (JPEG thumbnail) |
| `src/core/` | `CoreModule`: `ConfigModule` + `TypeOrmModule`, shared by `AppModule` and `WorkerModule` |
| `src/worker.ts` | Worker entrypoint (`createApplicationContext(WorkerModule)`), run by the `video-worker` container |

### Ownership

A video belongs to a **channel** (`videos.channel_id → channels.id`), and each user owns exactly one channel, created at registration. `POST /videos` resolves the channel through `ChannelsService.findByUserIdOrFail`, and every `/videos/:id…` lookup filters by `{ id, channel: { user_id: <JWT sub> } }`. A video of another user answers 404 `VIDEO_NOT_FOUND`, so the API never reveals whether it exists.

### Endpoints

All of them require `Authorization: Bearer` (401 without it), and `:id` goes through `ParseUUIDPipe` (400 `VALIDATION_ERROR`).

| Method & route | Success | Errors |
|---|---|---|
| `POST /videos` | 201 `{ videoId, uploadId, slug, title, status, partSize, partCount }` | 400 `VALIDATION_ERROR`, 404 `CHANNEL_NOT_FOUND`, 413 `VIDEO_TOO_LARGE` |
| `POST /videos/:id/upload/part-urls` | 200 `{ parts: [{ partNumber, url }], expiresAt }` | 400 `VALIDATION_ERROR` / `INVALID_PART_NUMBER`, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATUS` |
| `GET /videos/:id/upload/parts` | 200 `{ uploadId, partSize, partCount, parts }` | 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATUS`, 410 `UPLOAD_EXPIRED` |
| `DELETE /videos/:id/upload` | 204 | 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATUS` |
| `POST /videos/:id/upload/complete` | 202 `{ videoId, status: 'processing' }` | 400 `INVALID_UPLOAD_PARTS`, 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATUS`, 410 `UPLOAD_EXPIRED`, 413 `VIDEO_TOO_LARGE` |
| `GET /videos/:id` | 200 owner view (`status`, `durationSeconds`, `metadata`, `thumbnailUrl`, `processingError`, …) | 404 `VIDEO_NOT_FOUND` |
| `GET /videos/:id/stream` | 200 `{ url, expiresAt }` (1 h; storage serves Range/206) | 404 `VIDEO_NOT_FOUND`, 409 `VIDEO_NOT_READY` |
| `GET /videos/:id/download` | 200 `{ url, expiresAt }` (15 min; `Content-Disposition: attachment`) | 404 `VIDEO_NOT_FOUND`, 409 `VIDEO_NOT_READY` |

### Upload and processing flow

1. `POST /videos` creates the video as `draft` in the user's channel, with a unique `slug`, and opens the S3 multipart upload (64 MiB parts, up to 10 GiB).
2. The client requests part URLs and `PUT`s each part **straight to the storage**: no video byte goes through the API. It reads the `ETag` of each response.
3. `POST /videos/:id/upload/complete` assembles the object, checks its size, moves the video to `processing` and enqueues `video.process` (`jobId = videoId`, 3 attempts, exponential backoff).
4. The `video-worker` runs `ffprobe` + `ffmpeg` on the source, stores `videos/{id}/thumbnail.jpg`, and moves the video to `ready`. Invalid media or exhausted retries move it to `failed` with `processing_error`.

Status cycle: `draft → processing → ready | failed` (`failed` is terminal). It describes processing only; publishing is a separate concern (Phase 04).

Storage keys are stored on the row: `source_key` (`videos/{id}/source`, set at creation) and `thumbnail_key` (`videos/{id}/thumbnail.jpg`, set by the worker).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
