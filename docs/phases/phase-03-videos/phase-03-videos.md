---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-05T19:10:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-05T19:10:21-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T19:08:04-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-10-02T15:35:44-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-10-02T15:35:44-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o fluxo completo de vídeo: serviço de armazenamento compatível com S3 e fila de processamento em segundo plano subindo no Compose; upload de vídeos de até 10GB via multipart pré-assinado, sem impacto na performance da API, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload; processamento automático após o upload por um worker separado (extração de duração e metadados e geração de thumbnail a partir de um frame); URL única por vídeo, sem conflito; reprodução via streaming e download pelo usuário por URLs pré-assinadas restritas ao dono.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços do Compose

**Description:** Instala as bibliotecas da fase e cria os namespaces de configuração de storage e fila. Coloca `redis` e `storage` no Compose e o FFmpeg na imagem de dev, e isola a fila e o bucket usados pelos testes. É a base de infraestrutura de todas as SIs seguintes.

**Technical actions:**

1. Instalar no `nestjs-project`, dentro do container, `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`, `@aws-sdk/client-s3@^3.1146.0` e `@aws-sdk/s3-request-presigner@^3.1146.0`, nas versões fixadas no `library-refs.md` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
2. Criar os namespaces de configuração e registrá-los no `ConfigModule.forRoot({ load })` (per `phase-01-configuracao-base/TD-03`, `phase-03-videos/TD-09`, `phase-03-videos/TD-14`):
   - `src/config/storage.config.ts`: `registerAs('storage', …)` lendo `S3_ENDPOINT` (default `http://storage:9000`), `S3_PUBLIC_ENDPOINT` (default `http://localhost:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `streamtube-media`) e `STORAGE_CORS_ORIGIN` (default `http://localhost:3001`).
   - `src/config/queue.config.ts`: `registerAs('queue', …)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) e `QUEUE_PREFIX` (default `streamtube`).
   - Em `src/config/env.validation.ts`, `S3_ACCESS_KEY` e `S3_SECRET_KEY` são obrigatórias; as demais chaves têm default. Atualizar também o `.env.example`.
3. Editar o `compose.yaml` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`):
   - Serviço `redis`: imagem oficial com tag fixada e healthcheck `redis-cli ping`.
   - Serviço `storage`: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `server /data --console-address :9001`, portas `9000` e `9001`, volume nomeado, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` iguais a `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `MINIO_API_CORS_ALLOW_ORIGIN` igual à origem do frontend, e o healthcheck documentado da imagem.
   - O `nestjs-api` passa a depender dos dois serviços com `condition: service_healthy`.
4. Editar o `Dockerfile.dev` para instalar `ffmpeg` junto com `procps` e `curl`. Em dev, a mesma imagem atende a API e o worker (per `phase-03-videos/TD-13`).
5. Criar `src/test/setup-test-env.ts` e listá-lo **antes** de `dotenv/config` nos `setupFiles` do `package.json` (`<rootDir>/test/setup-test-env.ts`) e do `test/jest-e2e.json` (`<rootDir>/src/test/setup-test-env.ts`). Ele fixa `QUEUE_PREFIX=streamtube-test`, `S3_BUCKET=streamtube-media-test` e `S3_PUBLIC_ENDPOINT=http://storage:9000`, para que as URLs pré-assinadas sejam alcançáveis de dentro do container de testes (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: credenciais S3 ausentes rejeitadas; defaults de storage e fila aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `storage` com status `healthy`, e o `nestjs-api` só inicia depois dos dois.
- `docker compose exec nestjs-api ffmpeg -version` e `docker compose exec nestjs-api ffprobe -version` terminam com código 0.
- O console do storage abre em `http://localhost:9001` com as credenciais do `.env`.
- Iniciar a aplicação sem `S3_ACCESS_KEY` falha na validação do Joi, e a aplicação não sobe.
- Durante `npm test` e `npm run test:e2e`, `QUEUE_PREFIX` vale `streamtube-test` e `S3_BUCKET` vale `streamtube-media-test`, mesmo com os valores de dev no `.env`.

---

### SI-03.2 — Serviço de storage (StorageModule)

**Description:** Encapsula o acesso ao storage compatível com S3 num módulo próprio, com dois clientes: o interno, para as chamadas do servidor, e o público, para as URLs entregues ao navegador. Cobre também as operações de multipart e o bootstrap do bucket. API e worker reaproveitam o mesmo módulo.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`):
   - dois providers `S3Client` (tokens `S3_INTERNAL_CLIENT` e `S3_PUBLIC_CLIENT`), criados por factory com `inject: [storageConfig.KEY]`;
   - parâmetros dos clientes: `endpoint` interno ou público, `region`, `credentials`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'`;
   - exporta o `StorageService`.
2. Criar `src/storage/storage.service.ts` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-11`):
   - operações tipadas:
     - `createMultipartUpload(key, contentType)` e `presignUploadPart(key, uploadId, partNumber, expiresIn)`;
     - `listParts(key, uploadId)`, que pagina até o fim;
     - `completeMultipartUpload(key, uploadId, parts)` e `abortMultipartUpload(key, uploadId)`;
     - `headObject(key)`, `putObject(key, body, contentType)` e `deleteObject(key)`;
     - `presignGet(key, expiresIn, options)`, em que `options` define o cliente (`'public' | 'internal'`) e o `contentDisposition` opcional;
   - os presigns entregues a clientes HTTP usam o cliente público;
   - as demais chamadas usam o interno;
   - incluir `src/storage/storage-keys.ts` com `sourceKey(videoId)` (`videos/{videoId}/source`) e `thumbnailKey(videoId)` (`videos/{videoId}/thumbnail.jpg`).
3. Criar `src/storage/storage.errors.ts`, que traduz erros do SDK em erros do storage, sem semântica HTTP:
   - `NoSuchUpload` vira `StorageUploadNotFoundError`;
   - `InvalidPart`, `InvalidPartOrder` e `EntityTooSmall` viram `StorageInvalidPartsError`.

   O `VideosService` mapeia esses erros para o `### Error Catalog`.
4. Criar `src/storage/storage-bootstrap.service.ts`, executado de forma idempotente no `onApplicationBootstrap` (per `phase-03-videos/TD-05`, revisão de `phase-03-videos/TD-09`):
   - cria o `S3_BUCKET` se ele não existir (`HeadBucket` seguido de `CreateBucket`);
   - aplica `PutBucketLifecycleConfiguration` com `AbortIncompleteMultipartUpload.DaysAfterInitiation: 1`;
   - aplica `PutBucketCors` com `AllowedOrigins: [STORAGE_CORS_ORIGIN]`, `AllowedMethods: ['PUT', 'GET']`, `AllowedHeaders: ['*']` e `ExposeHeaders: ['ETag']`;
   - se o servidor responder `NotImplemented` ao CORS, registra um aviso e segue. Em dev, o CORS vem do `MINIO_API_CORS_ALLOW_ORIGIN` do SI-03.1.
5. Criar `src/test/storage.ts`, com `emptyBucket()`: remove os objetos e aborta os multiparts pendentes do bucket de testes, para a limpeza entre suítes (per `phase-03-videos/TD-15`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real, bucket de testes): multipart completo (create → PUT por `fetch` na URL de parte → listParts → complete → headObject); `NoSuchUpload` vira `StorageUploadNotFoundError`; ETag errado vira `StorageInvalidPartsError`; presign público usa o host de `S3_PUBLIC_ENDPOINT` | `src/storage/storage.service.integration-spec.ts` |
| `StorageBootstrapService` | Integration: bucket criado, regra de lifecycle aplicada, segunda execução sem erro | `src/storage/storage-bootstrap.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com os dois clientes | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — configuração `storage` e serviço `storage` no Compose

**Acceptance criteria:**

- Ao subir a aplicação, o bucket `S3_BUCKET` existe no storage com uma regra de lifecycle que aborta multiparts incompletos após 1 dia.
- Subir a aplicação duas vezes seguidas não gera erro no bootstrap do bucket.
- Uma URL de parte pré-assinada aceita `PUT` direto no storage e a resposta traz o header `ETag`.
- Um preflight `OPTIONS` com `Origin: http://localhost:3001` contra uma URL pré-assinada do storage responde com `Access-Control-Allow-Origin` e libera `PUT`. A resposta do `PUT` expõe o `ETag` ao navegador.
- As URLs entregues a clientes começam com `S3_PUBLIC_ENDPOINT`; as chamadas feitas pelo servidor usam `S3_ENDPOINT`.

---

### SI-03.3 — Entidade Video, migration CreateVideos e base do VideosModule

**Description:** Cria a tabela `videos` com o ciclo de status da fase, o gerador de slug da URL única e o módulo de vídeos, sobre o qual os endpoints e o worker são montados.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com `@Entity('videos')` e os campos de `### Data Model → Video` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`):
   - enum `VideoStatus` em `src/videos/video-status.enum.ts`;
   - `size_bytes` com transformer de `bigint` para `number`;
   - `@ManyToOne(() => User)` com `@JoinColumn({ name: 'user_id' })`;
   - `@Index` em `user_id`.
2. Gerar `src/database/migrations/{timestamp}-CreateVideos.ts` com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL: enum `videos_status_enum`, unique em `slug`, FK e índice em `user_id`.
3. Criar `src/videos/slug.util.ts` com `generateSlug()` = `crypto.randomBytes(8).toString('base64url')`, que gera 11 caracteres (per `phase-03-videos/TD-10`).
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar o `VideosModule` no `AppModule`.
5. Atualizar `src/test/create-test-data-source.ts`, para que o `cleanAllTables` apague `videos` antes de `users`, e `src/database/migrations.integration-spec.ts`, para incluir a migration `CreateVideos` e a tabela `videos`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique em `slug`, default `status = 'draft'`, enum rejeita valores fora da lista, `size_bytes` lido como number, colunas nullable | `src/videos/entities/video.entity.integration-spec.ts` |
| `generateSlug` | Unit: 11 caracteres, alfabeto base64url, valores distintos entre chamadas | `src/videos/slug.util.spec.ts` |
| Migrations | Integration: `CreateVideos` cria e reverte a tabela | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com o enum `videos_status_enum`, unique em `slug` e FK `user_id → users.id`. `npm run migration:revert` desfaz tudo.
- Inserir dois vídeos com o mesmo `slug` falha por violação de unicidade.
- Um vídeo inserido sem `status` fica com `status = 'draft'`.
- Gravar um `status` fora de `draft | processing | ready | failed` é rejeitado pelo banco.
- `generateSlug()` devolve sempre 11 caracteres do alfabeto `[A-Za-z0-9_-]`.

---

### SI-03.4 — Fila de processamento e producer

**Description:** Liga a aplicação ao Redis pelo BullMQ, com prefixo por ambiente, e cria o producer que enfileira o job `video.process` com as opções de retentativa da fase.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync`. O `inject: [queueConfig.KEY]` e o `useFactory` retornam `{ connection: { host, port }, prefix }` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-14`).
2. Criar `src/videos/processing/video-processing.constants.ts`, com `VIDEO_PROCESSING_QUEUE = 'video-processing'` e `VIDEO_PROCESS_JOB = 'video.process'`, e `video-processing.types.ts`, com `VideoProcessJobData { videoId: string }`.
3. Criar `src/videos/processing/video-processing.producer.ts`. O `@InjectQueue(VIDEO_PROCESSING_QUEUE)` e o `enqueue(videoId)` usam as opções de `### Events/Messages → video.process`: `jobId: videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`, `removeOnComplete: true` e `removeOnFail: 100` (per `phase-03-videos/TD-12`).
4. No `VideosModule`, importar `QueueModule` e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` e registrar o producer.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, prefixo de teste): job com `jobId = videoId`, `attempts: 3` e backoff exponencial; enfileirar o mesmo `videoId` duas vezes mantém um único job | `src/videos/processing/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Unit: compilação com `BullModule.forRootAsync` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 — dependências, configuração `queue` e serviço `redis`; SI-03.3 — `VideosModule`

**Acceptance criteria:**

- Um job enfileirado fica no Redis sob o prefixo de `QUEUE_PREFIX` (chaves `{prefix}:video-processing:*`), nunca sob o prefixo padrão `bull`.
- Enfileirar duas vezes o mesmo `videoId` mantém um único job na fila `video-processing`.
- O job criado tem nome `video.process`, payload `{ videoId }`, `attempts = 3` e backoff exponencial de 1000 ms.
- Jobs criados com `QUEUE_PREFIX=streamtube-test` não ficam visíveis para um worker configurado com o prefixo `streamtube`.

---

### SI-03.5 — Endpoint POST /videos (início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-start-upload.plan.md`
**Authorization:** Authenticated

**Description:** Pré-cadastra o vídeo como rascunho no início do upload e abre o multipart no storage. Devolve ao cliente o necessário para enviar as partes direto ao storage.

**Technical actions:**

1. Criar `src/videos/dto/start-upload.dto.ts` com o `StartUploadDto`, conforme `### API Contracts → POST /videos` (per `phase-02-auth/TD-06`):
   - `fileName`: `@IsString() @Length(1, 255)`;
   - `fileSize`: `@IsInt() @Min(1)`;
   - `contentType`: `@Matches(/^video\//)`;
   - `title`: `@IsOptional()` com trim e `@Length(1, 255)`.
2. Acrescentar a `src/common/exceptions/domain.exception.ts` as exceções do `### Error Catalog`, com os códigos e as mensagens da tabela (per `phase-02-auth/TD-07`): `VideoNotFoundException`, `VideoTooLargeException`, `InvalidVideoStatusException`, `InvalidPartNumberException`, `InvalidUploadPartsException`, `UploadExpiredException` e `VideoNotReadyException`.
3. Criar `src/videos/videos.service.ts` com `startUpload(userId, dto)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`):
   - rejeita `fileSize > 10737418240` com `VideoTooLargeException`;
   - gera o `id` com `randomUUID()`;
   - usa o `title` informado ou, se ausente, o `fileName` sem extensão (AMB-1);
   - chama `createMultipartUpload(sourceKey(id), contentType)`;
   - insere o `Video` em `draft` com `upload_id`, gerando o `slug` com até 5 tentativas em caso de violação de unicidade (`23505`) do `slug`;
   - se a inserção falhar, aborta o multipart;
   - devolve o corpo do 201, com `partSize` e `partCount`.
4. Criar `src/videos/videos.controller.ts` (per `openapi-docs-nestjs/TD-01`):
   - `@Controller('videos')` com `@Post()`, usuário via `@CurrentUser()` (`sub`) e resposta 201;
   - decorators OpenAPI explícitos: `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation` e `@ApiResponse`;
   - DTO de resposta `StartUploadResponseDto` e envelope de erro `ApiErrorEnvelopeDto`.
5. No `VideosModule`, importar o `StorageModule` e registrar o `VideosService` e o `VideosController`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.startUpload` | Unit (storage e repositório mockados): título padrão sem extensão, título informado com trim, `VIDEO_TOO_LARGE` acima de 10 GiB, nova tentativa de slug em colisão, abort do multipart quando a inserção falha, `partCount` arredondado para cima | `src/videos/videos.service.spec.ts` |
| `VideosService.startUpload` | Integration (Postgres e MinIO reais): linha `draft` com `upload_id` e multipart aberto no storage | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video` e `generateSlug`

**Acceptance criteria:**

- `POST /videos` com corpo válido e JWT retorna 201 com `videoId`, `uploadId`, `slug` de 11 caracteres, `status: 'draft'`, `partSize: 67108864` e `partCount = ceil(fileSize / 67108864)`.
- `POST /videos` sem `title` e com `fileName: "ferias.2024.mp4"` cria o vídeo com o título `ferias.2024`.
- `POST /videos` com `fileSize: 10737418241` retorna 413 com `error: "VIDEO_TOO_LARGE"` e não cria linha em `videos`.
- `POST /videos` com `contentType: "image/png"` retorna 400 com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem token retorna 401.
- Depois de um `POST /videos` bem-sucedido, a tabela `videos` tem a linha em `draft`, pertencente ao usuário do token, e o storage tem um multipart aberto para `videos/{videoId}/source`.
- Dois vídeos criados em sequência recebem `slug`s diferentes.

---

### SI-03.6 — Endpoints de URLs de partes, retomada e abort do upload

**Route:** POST /videos/:id/upload/part-urls, GET /videos/:id/upload/parts, DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Entrega as URLs pré-assinadas de cada parte, permite retomar um upload interrompido listando as partes já recebidas e permite abortar o upload. Também trata o multipart expirado pelo lifecycle (AMB-3).

**Technical actions:**

1. Criar `src/videos/dto/part-urls.dto.ts` com `partNumbers`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true })`.
2. No `VideosService`, criar dois helpers:
   - `findOwnedOrFail(userId, id)`: busca por `id` e `user_id` e lança `VideoNotFoundException` se não encontrar;
   - `assertDraft(video)`: lança `InvalidVideoStatusException` se o status não for `draft`.
3. Criar `VideosService.getPartUrls(userId, id, partNumbers)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`):
   - rejeita `partNumber > partCount` com `InvalidPartNumberException`, sendo `partCount` derivado de `size_bytes`;
   - pré-assina cada parte com o cliente público e validade de 3600 s;
   - devolve `{ parts, expiresAt }`.
4. Criar `listUploadedParts` e `abortUpload` (AMB-3):
   - `listUploadedParts`: um `StorageUploadNotFoundError` grava `status = 'failed'`, `processing_error = 'upload_expired'` e `upload_id = null`, e lança `UploadExpiredException`;
   - `abortUpload`: chama `abortMultipartUpload` ignorando `StorageUploadNotFoundError` e grava `failed`, `upload_aborted` e `upload_id = null`.
5. Criar as rotas no `VideosController` com `ParseUUIDPipe` no `:id`, respostas 200, 200 e 204 e decorators OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (part-urls, parts, abort) | Unit: não dono (404), status diferente de `draft` (409), `partNumber` acima de `partCount`, `NoSuchUpload` vira `failed`/`upload_expired`, abort idempotente | `src/videos/videos.service.spec.ts` |
| `VideosService` (part-urls, parts, abort) | Integration: `PUT` real numa URL de parte seguido da listagem devolvendo a parte com `ETag`; multipart abortado direto no storage leva o vídeo a `failed`/`upload_expired`; abort grava `upload_aborted` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosService`, `VideosController` e exceções de vídeo

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com `{ "partNumbers": [1] }`, feito pelo dono de um vídeo `draft`, retorna 200 com uma URL que aceita `PUT` direto no storage e `expiresAt` cerca de 1h à frente.
- `POST /videos/:id/upload/part-urls` com um `partNumber` acima de `partCount` retorna 400 com `error: "INVALID_PART_NUMBER"`.
- Depois do envio da parte 1, `GET /videos/:id/upload/parts` retorna 200 com `parts: [{ partNumber: 1, ETag, size }]`.
- `GET /videos/:id/upload/parts` de um upload cujo multipart não existe mais no storage retorna 410 com `error: "UPLOAD_EXPIRED"`, e o vídeo fica `failed` com `processing_error = 'upload_expired'`.
- `DELETE /videos/:id/upload` retorna 204, o multipart deixa de existir no storage e o vídeo fica `failed` com `processing_error = 'upload_aborted'`.
- Os três endpoints, chamados por outro usuário, retornam 404 com `error: "VIDEO_NOT_FOUND"`.
- Os três endpoints, chamados para um vídeo fora de `draft`, retornam 409 com `error: "INVALID_VIDEO_STATUS"`.

---

### SI-03.7 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Fecha o multipart, confere o objeto final e dispara o processamento: o vídeo passa a `processing` e o job `video.process` é enfileirado pela própria API.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (per `phase-03-videos/TD-05`):
   - `parts`: `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(10000) @ValidateNested({ each: true }) @Type(() => CompletedPartDto)`;
   - `CompletedPartDto`: `partNumber` (`@IsInt() @Min(1)`) e `ETag` (`@IsString() @IsNotEmpty()`).
2. Criar `VideosService.completeUpload(userId, id, parts)`:
   - exige dono e status `draft` e chama `completeMultipartUpload`;
   - `StorageInvalidPartsError` vira `InvalidUploadPartsException`, e o vídeo continua `draft`;
   - `StorageUploadNotFoundError` grava `failed`/`upload_expired` e lança `UploadExpiredException` (AMB-3).
3. Depois de concluir, chamar `headObject(sourceKey(id))` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`):
   - se `ContentLength > 10737418240`: remove o objeto, grava `failed` com `processing_error = 'file_too_large'` e lança `VideoTooLargeException`;
   - caso contrário: grava `size_bytes = ContentLength`, `upload_id = null` e `status = 'processing'`.
4. Depois de gravar `processing`, chamar `VideoProcessingProducer.enqueue(videoId)` (per `phase-03-videos/TD-06`). O `jobId = videoId` torna seguro repetir o enfileiramento. Se o enfileiramento lançar erro, grava `failed` com a mensagem e propaga o erro.
5. Criar a rota `@Post(':id/upload/complete')` no `VideosController`, com `ParseUUIDPipe`, `@HttpCode(202)` e decorators OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: `InvalidPart` mantém `draft`; `NoSuchUpload` vira `upload_expired`; objeto acima de 10 GiB é removido e vira `file_too_large` (`HeadObject` mockado); sucesso grava `processing` e enfileira uma vez; falha no enfileiramento grava `failed` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres, MinIO e Redis reais): envio de uma parte, conclusão, objeto em `videos/{id}/source`, `size_bytes` real e job `video.process` na fila de teste | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — `VideoProcessingProducer`; SI-03.6 — URLs de parte e helpers de dono e status

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com as partes enviadas retorna 202 com `{ videoId, status: 'processing' }`. O objeto `videos/{videoId}/source` passa a existir no storage, e `size_bytes` passa a ser o tamanho real do objeto.
- Uma conclusão bem-sucedida coloca um job `video.process` com `jobId = videoId` na fila `video-processing`.
- `POST /videos/:id/upload/complete` com um `ETag` que não confere retorna 400 com `error: "INVALID_UPLOAD_PARTS"`, e o vídeo continua `draft`.
- `POST /videos/:id/upload/complete` de um upload expirado retorna 410 com `error: "UPLOAD_EXPIRED"`, e o vídeo fica `failed` com `processing_error = 'upload_expired'`.
- Quando o objeto final passa de 10 GiB, a conclusão retorna 413 com `error: "VIDEO_TOO_LARGE"`, o objeto é removido e o vídeo fica `failed` com `processing_error = 'file_too_large'`.
- Concluir o mesmo vídeo duas vezes retorna 409 com `error: "INVALID_VIDEO_STATUS"` na segunda chamada e não cria um segundo job.
- `POST /videos/:id/upload/complete` feito por outro usuário retorna 404 com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.8 — Serviço de mídia (ffprobe e ffmpeg)

**Description:** Isola a chamada ao FFmpeg do sistema num serviço próprio. Ele extrai duração e metadados com o ffprobe e gera a thumbnail com o ffmpeg, lendo o vídeo por URL HTTP, sem copiar o arquivo para o disco.

**Technical actions:**

1. Criar `src/media/media.service.ts` com `probe(url)` (per `phase-03-videos/TD-08`):
   - executa via `child_process` (`execFile` promisificado, com timeout) o comando `ffprobe -v error -print_format json -show_format -show_streams <url>`;
   - devolve `{ durationSeconds, metadata }`, em que `metadata` é o JSON curado:
     - `format`: duração, tamanho, bitrate e `format_name`;
     - `video`: codec, largura, altura e fps;
     - `audio`: codec, canais e sample rate, ou `null` quando não há áudio.
2. Criar `src/media/media.errors.ts` com `InvalidMediaError`. Ele é lançado quando a saída do ffprobe é inválida ou quando não há stream de vídeo, e é um erro permanente, que o processor converte em `UnrecoverableError`.
3. Criar `MediaService.extractThumbnail(url, durationSeconds)`:
   - calcula `t = min(10% da duração, duração − 0.1)`, com piso 0;
   - executa `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1`;
   - devolve o JPEG como `Buffer`.
4. Criar `src/media/media.module.ts`, que exporta o `MediaService`.
5. Gerar dentro do container e commitar duas fixtures:
   - `test/fixtures/sample.mp4`: poucos segundos, com vídeo e áudio, gerado com `ffmpeg -f lavfi -i testsrc` + `-f lavfi -i sine`;
   - `test/fixtures/not-a-video.mp4`: bytes de texto, para o caso inválido.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Unit (`execFile` mockado): argumentos de ffprobe e ffmpeg, instante da thumbnail (clipe longo, clipe curto e duração zero), JSON curado e `InvalidMediaError` sem stream de vídeo | `src/media/media.service.spec.ts` |
| `MediaService` | Integration (FFmpeg real lendo as fixtures por URL pré-assinada do MinIO de teste): duração e codecs corretos, JPEG com 1280px de largura e `InvalidMediaError` para o arquivo inválido | `src/media/media.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem; SI-03.2 — `StorageService`, usado pelo teste de integração

**Acceptance criteria:**

- `probe` sobre a fixture `sample.mp4` devolve `durationSeconds` igual à duração do arquivo, com tolerância de 0,1 s, e `metadata` com `format`, `video` e `audio` preenchidos.
- `extractThumbnail` sobre a fixture devolve um JPEG válido com 1280px de largura e a proporção original preservada.
- `probe` sobre `not-a-video.mp4` falha com `InvalidMediaError`.
- `probe` e `extractThumbnail` leem o vídeo pela URL HTTP e não gravam arquivos temporários em disco.

---

### SI-03.9 — Worker de processamento (VideoProcessor, entrypoint e container)

**Description:** Implementa o consumidor da fila: um worker separado, no mesmo código e sem HTTP, que processa `video.process`, grava duração, metadados e thumbnail e aplica a política de falha da fase.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` com `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`. O `process(job)` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-12`):
   - carrega o vídeo e ignora o job se o vídeo não existir ou não estiver em `processing`;
   - pré-assina um GET **interno** (`S3_ENDPOINT`) de `sourceKey(id)` e chama `MediaService.probe` e `extractThumbnail`;
   - chama `putObject(thumbnailKey(id), jpeg, 'image/jpeg')`;
   - grava `duration_seconds`, `metadata`, `thumbnail_key`, `processing_error = null` e `status = 'ready'`.
2. Implementar a política de falha (per `phase-03-videos/TD-12`):
   - `InvalidMediaError` é relançado como `UnrecoverableError('invalid_video')`;
   - `@OnWorkerEvent('failed')` grava `status = 'failed'` e `processing_error` (`invalid_video` ou a mensagem do erro) só quando `job.attemptsMade >= job.opts.attempts` ou quando o erro é `UnrecoverableError`.
3. Extrair a raiz compartilhada de `AppModule` para `src/core/core.module.ts`: `ConfigModule.forRoot` (mesmos `load`, `validationSchema` e opções), `TypeOrmModule.forRootAsync` e `QueueModule`. Depois:
   - fazer o `AppModule` importar o `CoreModule`;
   - criar `src/worker.module.ts` com `CoreModule`, `BullModule.registerQueue`, `StorageModule`, `MediaModule`, `TypeOrmModule.forFeature([Video])` e o `VideoProcessor`, sem controllers, guards ou providers HTTP (per `phase-03-videos/TD-07`).
4. Criar `src/worker.ts`, que chama `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks()`, e o script `start:worker`. O script roda o entrypoint sem compartilhar o `dist/` com o `start:dev` da API (por exemplo, `ts-node src/worker.ts`, no mesmo padrão do `openapi:export`).
5. Acrescentar o serviço `video-worker` ao `compose.yaml` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-13`):
   - mesmo `build` (`Dockerfile.dev`) e mesmo volume do `nestjs-api`;
   - `command: npm run start:worker` e `restart: unless-stopped`;
   - `depends_on` com `db`, `redis` e `storage` saudáveis.

   Em dev, a mesma imagem atende os dois serviços; o "target dedicado" citado no TD-07 fica para a imagem de produção da Fase 07.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit (repositório, storage e media mockados): ignora vídeo fora de `processing`; sucesso grava `ready`; `InvalidMediaError` vira `UnrecoverableError`; o handler `failed` só grava na última tentativa ou em erro irrecuperável | `src/videos/processing/video.processor.spec.ts` |
| `VideoProcessor` | Integration (Postgres, MinIO, Redis e FFmpeg reais, prefixo de teste): job com a fixture leva o vídeo a `ready` com `duration_seconds`, `metadata` e thumbnail no storage; fixture inválida leva a `failed`/`invalid_video` sem retentativas | `src/videos/processing/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação sem providers HTTP | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.4 — fila e constantes; SI-03.8 — `MediaService`

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker`, que se conecta ao Redis com o prefixo de `QUEUE_PREFIX` e não abre porta HTTP.
- Um job `video.process` de um vídeo em `processing` com arquivo válido termina com o vídeo em `ready`, `duration_seconds` e `metadata` preenchidos e o objeto `videos/{videoId}/thumbnail.jpg` no storage.
- Um job de um arquivo que não é vídeo termina, após uma única tentativa, com `status = 'failed'` e `processing_error = 'invalid_video'`.
- Um erro transitório na primeira tentativa não marca o vídeo como `failed`; ele só passa a `failed` depois da terceira tentativa falha.
- Processar de novo o mesmo vídeo sobrescreve thumbnail e metadados sem erro.
- Um job de um vídeo que não está em `processing` termina sem alterar a linha.

---

### SI-03.10 — Endpoint GET /videos/:id (consulta do dono)

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner

**Description:** Expõe ao dono o estado do vídeo: status, duração, metadados, slug e URL pré-assinada da thumbnail. O cliente usa esse endpoint em polling para acompanhar a passagem de `processing` para `ready` (AMB-2).

**Technical actions:**

1. Criar `VideosService.getOwnedVideo(userId, id)` (per `phase-03-videos/TD-11`):
   - usa `findOwnedOrFail` para carregar o vídeo;
   - preenche `thumbnailUrl` com um GET pré-assinado pelo cliente público, para `thumbnail_key`, com validade de 3600 s;
   - deixa `thumbnailUrl` como `null` quando não há `thumbnail_key`.
2. Criar `src/videos/dto/video-response.dto.ts` com o `VideoResponseDto`. Os campos seguem `### API Contracts → GET /videos/:id`: `id`, `slug`, `title`, `status`, `durationSeconds`, `metadata`, `thumbnailUrl`, `processingError`, `createdAt` e `updatedAt`. O mapeamento a partir da entidade é explícito.
3. Criar a rota `@Get(':id')` no `VideosController`, com `ParseUUIDPipe`, resposta 200 e decorators OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: `thumbnailUrl` nulo sem `thumbnail_key`, presign quando existe, 404 para não dono | `src/videos/videos.service.spec.ts` |
| `VideosService.getOwnedVideo` | Integration: a consulta filtra por dono e devolve `metadata` (jsonb) e `durationSeconds` gravados | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosService` e `VideosController`

**Acceptance criteria:**

- `GET /videos/:id` feito pelo dono de um vídeo `draft` retorna 200 com `status: 'draft'`, `slug`, `title`, `durationSeconds: null`, `metadata: null` e `thumbnailUrl: null`.
- `GET /videos/:id` de um vídeo `ready` retorna `durationSeconds`, `metadata` com `format`, `video` e `audio`, e um `thumbnailUrl` que responde 200 com `Content-Type: image/jpeg`.
- `GET /videos/:id` de um vídeo `failed` retorna `processingError` com o motivo gravado.
- `GET /videos/:id` feito por outro usuário retorna 404 com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/not-a-uuid` retorna 400 com `error: "VALIDATION_ERROR"`.

---

### SI-03.11 — Endpoints GET /videos/:id/stream e GET /videos/:id/download

**Route:** GET /videos/:id/stream, GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-stream-download.plan.md`
**Authorization:** Owner

**Description:** Entrega ao dono URLs pré-assinadas para assistir por streaming e para baixar o vídeo. O storage atende Range e 206, e nenhum byte de vídeo passa pela API.

**Technical actions:**

1. Criar `VideosService.getStreamUrl(userId, id)` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-09`):
   - exige que o usuário seja o dono e lança `VideoNotReadyException` se `status ≠ 'ready'`;
   - devolve `{ url, expiresAt }`, com um GET pré-assinado pelo cliente público para `sourceKey(id)` e validade de 3600 s.
2. Criar `VideosService.getDownloadUrl(userId, id)` (per `phase-03-videos/TD-11`):
   - aplica as mesmas regras do stream, com validade de 900 s;
   - define `ResponseContentDisposition` como `attachment; filename="{nome sanitizado}"; filename*=UTF-8''{nome codificado}`, a partir de `original_filename`.
3. Criar as rotas `@Get(':id/stream')` e `@Get(':id/download')` no `VideosController`, com `ParseUUIDPipe`, resposta 200, `UrlResponseDto` (`url`, `expiresAt`) e decorators OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (stream e download) | Unit: 409 fora de `ready`, validade de 3600 e 900 s, `Content-Disposition` com nome sanitizado | `src/videos/videos.service.spec.ts` |
| `VideosService` (stream e download) | Integration (MinIO real): a URL de stream responde 206 a `Range: bytes=0-99`; a URL de download responde com `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosService` e `VideosController`

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` do dono retorna 200 com `url` e com `expiresAt` cerca de 1h à frente. Um `GET` na `url` com `Range: bytes=0-99` recebe 206 com apenas os 100 bytes pedidos.
- `GET /videos/:id/download` de um vídeo `ready` retorna 200 com `url` e com `expiresAt` cerca de 15 min à frente. A `url` responde com `Content-Disposition: attachment` e o nome original do arquivo.
- `GET /videos/:id/stream` ou `GET /videos/:id/download` de um vídeo fora de `ready` retorna 409 com `error: "VIDEO_NOT_READY"`.
- `GET /videos/:id/stream` ou `GET /videos/:id/download` feito por outro usuário retorna 404 com `error: "VIDEO_NOT_FOUND"`.
- Uma URL de stream usada depois de `expiresAt` é recusada pelo storage com 403.

---

### SI-03.12 — Teste do pipeline completo e contrato OpenAPI

**Description:** Prova de ponta a ponta a entrega principal da fase: upload → fila → worker → `ready` → stream. O worker roda no próprio processo de teste, com prefixo de fila e bucket exclusivos. Esta SI também atualiza o contrato OpenAPI commitado com os endpoints de vídeo.

**Technical actions:**

1. Criar `test/videos-pipeline.e2e-spec.ts` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`):
   - sobe a API com a mesma configuração global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter` e `ValidationExceptionFilter`);
   - sobe o `WorkerModule` no mesmo processo, via `createApplicationContext`;
   - registra, confirma e autentica um usuário;
   - percorre o fluxo: `POST /videos` → `POST /videos/:id/upload/part-urls` → `PUT` da fixture `sample.mp4` na URL → `POST /videos/:id/upload/complete`;
   - faz polling de `GET /videos/:id`, com timeout, até `ready`, e depois chama `GET /videos/:id/stream` com Range.
2. Cobrir o caminho de falha no mesmo fluxo: a fixture `not-a-video.mp4` termina em `failed` com `processingError: 'invalid_video'`.
3. Limpar o estado entre os testes, no `beforeEach` e no `afterAll`: banco (`cleanAllTables`), bucket de testes (`emptyBucket`) e fila (`obliterate` da fila de teste). Fechar a API e o worker com `close()`.
4. Rodar `npm run openapi:export` e commitar o `openapi.json` atualizado com os 8 endpoints de `/videos` (per `openapi-docs-nestjs/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo | E2E: upload → fila → worker → `ready` → stream; arquivo inválido termina em `failed` | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.9 — worker; SI-03.10 — `GET /videos/:id`; SI-03.11 — stream

**Acceptance criteria:**

- Um vídeo enviado pela API em uma única parte e concluído chega a `status: 'ready'` em `GET /videos/:id` dentro do timeout do teste, com `durationSeconds` e `thumbnailUrl` preenchidos.
- A URL de stream desse vídeo responde 206 a uma requisição com `Range`.
- Um arquivo que não é vídeo, enviado pelo mesmo fluxo, termina em `status: 'failed'` com `processingError: 'invalid_video'`.
- Com o container `video-worker` ligado durante a suíte, o resultado não muda: o worker do Compose não consome os jobs dos testes.
- O `openapi.json` commitado descreve os 8 endpoints de `/videos`, com os códigos de erro do `### Error Catalog`.

---

### SI-03.13 — Documentação da fase e notas para a Fase 04

**Description:** Atualiza a documentação do projeto para refletir a nova infraestrutura (fila, storage e worker) e as decisões que precisam estar escritas: a exceção do `S3_PUBLIC_ENDPOINT` e a estratégia de testes com MinIO real. Também registra o que fica fora do escopo da fase: a publicação do vídeo é responsabilidade da Fase 04, num campo separado do `status`, porque um vídeo `ready` continua não publicado.

**Technical actions:**

1. Atualizar o `CLAUDE.md` da raiz (per revisão de `phase-03-videos/TD-09`):
   - a Message Queue passa de "TBD" para BullMQ sobre Redis;
   - o Object Storage usa `pgsty/minio` em dev;
   - a seção "Docker Networking" ganha a exceção documentada do `S3_PUBLIC_ENDPOINT`: é o único valor `localhost` autorizado, porque é usado pelo navegador. O storage é uma origem separada, com CORS restrito à origem do frontend, e o BFF estrito continua valendo para a API NestJS.
2. Atualizar o `nestjs-project/CLAUDE.md` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-14`):
   - serviços `redis`, `storage` e `video-worker`, com as portas;
   - checagens de prontidão (`docker compose exec redis redis-cli ping` e o health do storage) e comandos do worker (`start:worker` e logs);
   - variáveis forçadas nos testes: `QUEUE_PREFIX`, `S3_BUCKET` e `S3_PUBLIC_ENDPOINT`;
   - em dev, `nestjs-api` e `video-worker` usam a mesma imagem com FFmpeg.
3. Atualizar o guia de testes (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`):
   - em `.claude/skills/testing-guide-nestjs-project/references/external-systems.md`, a seção "Object Storage — Local Filesystem" passa a ser "Object Storage — MinIO real (Docker)", com bucket de testes exclusivo e limpeza entre suítes;
   - no mesmo arquivo, a seção "Message Queue — Real (Docker)" ganha o prefixo de fila exclusivo e o worker no processo de teste;
   - no `SKILL.md` do guia, ajustar as menções a storage local.
4. Registrar no `progress.md` da fase, como nota para as fases seguintes (per `phase-03-videos/TD-12`):
   - a Fase 04 precisa modelar a publicação em campo separado (por exemplo, `published_at` ou visibilidade), porque o `status` da Fase 03 descreve só o processamento;
   - o "target dedicado" do TD-07 vira, em dev, a mesma imagem para API e worker (TD-13), e a separação de imagens fica para a Fase 07.

**Tests:** _(empty — documentação; verificada pelos critérios de aceite)_

**Dependencies:** SI-03.12 — pipeline completo validado

**Acceptance criteria:**

- O `CLAUDE.md` da raiz descreve BullMQ sobre Redis como fila e documenta o `S3_PUBLIC_ENDPOINT` como a única exceção autorizada à regra de nome de serviço do Compose.
- O `nestjs-project/CLAUDE.md` lista `redis`, `storage` e `video-worker`, com o comando de verificação de prontidão de cada um.
- O guia `testing-guide-nestjs-project` não recomenda mais filesystem local para storage; ele descreve MinIO real com bucket de testes e prefixo de fila exclusivo.
- O `progress.md` da fase registra que a publicação da Fase 04 fica num campo separado do `status`.

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Criada pela migration `CreateVideos` (SI-03.3).

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | uuid | PK | Gerado na aplicação (`crypto.randomUUID()`) antes do `CreateMultipartUpload`, porque a chave do objeto usa o `videoId` (phase-03-videos/TD-04) |
| user_id | uuid | FK → users.id, not null | Dono do vídeo (JWT `sub`) |
| slug | varchar(11) | unique, not null | Base64url de `crypto.randomBytes(8)`, gerado no pré-cadastro e imutável; nova tentativa em violação de unicidade (phase-03-videos/TD-10) |
| title | varchar(255) | not null | Opcional no início do upload; quando ausente, recebe o nome do arquivo sem extensão (AMB-1). Edição de título fica para a Fase 04 |
| original_filename | varchar(255) | not null | Nome do arquivo informado pelo cliente; base do título padrão e do `Content-Disposition` do download |
| content_type | varchar(127) | not null | Sempre `video/*` (phase-03-videos/TD-05) |
| size_bytes | bigint | not null | Tamanho declarado no início, substituído pelo `ContentLength` do `HeadObject` na conclusão (phase-03-videos/TD-05). O driver `pg` devolve `bigint` como string: a coluna usa um transformer para `number` (10 GiB cabe em `Number.MAX_SAFE_INTEGER`) |
| status | enum `videos_status_enum` | not null, default `'draft'`, valores `'draft'`, `'processing'`, `'ready'`, `'failed'` | Ciclo `draft → processing → ready \| failed`, `failed` terminal (phase-03-videos/TD-12) |
| upload_id | varchar | nullable | `UploadId` do multipart (phase-03-videos/TD-05); volta a `null` depois de concluir ou abortar |
| thumbnail_key | varchar | nullable | `videos/{videoId}/thumbnail.jpg`, preenchido pelo worker quando a thumbnail é gravada (phase-03-videos/TD-08) |
| duration_seconds | double precision | nullable | Duração extraída pelo ffprobe (phase-03-videos/TD-08) |
| metadata | jsonb | nullable | JSON curado do ffprobe com os resumos `format`, `video` e `audio` (phase-03-videos/TD-08) |
| processing_error | text | nullable | Motivo da falha quando `status = 'failed'`: `upload_expired` (AMB-3), `upload_aborted`, `file_too_large`, `invalid_video` ou a mensagem do último erro do worker (phase-03-videos/TD-12) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** `Video` → `User` (many-to-one, lado dono via `user_id`). `User` não ganha relação inversa nesta fase.
**Indexes:** unique em `slug`; índice em `user_id` (FK).

**Chaves no storage** (phase-03-videos/TD-04), derivadas do `id` e sem coluna própria, no bucket privado configurado em `S3_BUCKET`:

- `videos/{videoId}/source`: arquivo original enviado por multipart.
- `videos/{videoId}/thumbnail.jpg`: thumbnail JPEG de 1280px de largura gerada pelo worker.

**Constantes de upload** (phase-03-videos/TD-05):

| Constante | Valor |
|-----------|-------|
| Tamanho máximo | 10737418240 bytes (10 GiB) |
| `partSize` | 67108864 bytes (64 MiB) |
| `partCount` | `ceil(fileSize / partSize)` (no máximo 160 partes) |
| Validade da URL de parte | 3600 s (1h) |

### API Contracts

Regras comuns a todos os endpoints desta fase:

- Exigem `Authorization: Bearer <access_token>` (guard JWT global de phase-02-auth/TD-02); sem token válido, respondem 401.
- O parâmetro `:id` passa pelo `ParseUUIDPipe`; um valor que não é UUID responde 400 `VALIDATION_ERROR`.
- Vídeo inexistente ou de outro usuário responde 404 `VIDEO_NOT_FOUND`, sem revelar se o vídeo existe (phase-03-videos/TD-11).
- Toda URL devolvida ao cliente é assinada pelo cliente S3 configurado com `S3_PUBLIC_ENDPOINT`; as chamadas da própria API e do worker usam `S3_ENDPOINT` (phase-03-videos/TD-09).
- O envio das partes (PUT) e a leitura do vídeo (GET) acontecem direto entre o navegador e o storage; nenhum byte de vídeo passa pela API (phase-03-videos/TD-05, phase-03-videos/TD-11).

#### POST /videos (SI-03.5)

Inicia o upload: cria o vídeo como rascunho (`draft`) e abre o multipart no storage (phase-03-videos/TD-05).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1 a 255 caracteres
- fileSize: integer, required — em bytes, mínimo 1; acima de 10737418240 (10 GiB) responde 413 `VIDEO_TOO_LARGE`
- contentType: string, required — precisa começar com `video/`
- title: string, optional — 1 a 255 caracteres após trim; quando ausente, o título é o `fileName` sem extensão (AMB-1)

**Response 201:**
- videoId: string (uuid)
- uploadId: string — `UploadId` do multipart (phase-03-videos/TD-05)
- slug: string — 11 caracteres base64url (phase-03-videos/TD-10)
- title: string
- status: `'draft'`
- partSize: integer — 67108864
- partCount: integer — `ceil(fileSize / partSize)`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema (campo ausente, `contentType` que não começa com `video/`, `fileSize` não inteiro)
- 401: sem token válido
- 413 VIDEO_TOO_LARGE: `fileSize` acima de 10 GiB

---

#### POST /videos/:id/upload/part-urls (SI-03.6)

Devolve URLs `UploadPart` pré-assinadas para um lote de números de parte (phase-03-videos/TD-05).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1 a 100 itens, sem repetição, cada um ≥ 1; um número acima de `partCount` responde 400 `INVALID_PART_NUMBER`

**Response 200:**
- parts: `{ partNumber: integer, url: string }[]` — uma URL de PUT direto no storage por parte pedida
- expiresAt: string (ISO-8601) — validade das URLs (1h)

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema ou `:id` que não é UUID
- 400 INVALID_PART_NUMBER: algum `partNumber` acima de `partCount`
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATUS: vídeo com status diferente de `draft`

---

#### GET /videos/:id/upload/parts (SI-03.6)

Lista as partes que o storage já recebeu, para o cliente retomar um upload interrompido (`ListParts`, paginado até o fim).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- uploadId: string
- partSize: integer
- partCount: integer
- parts: `{ partNumber: integer, ETag: string, size: integer }[]` — partes já recebidas, em ordem crescente de `partNumber`

**Error responses:**
- 400 VALIDATION_ERROR: `:id` que não é UUID
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATUS: vídeo com status diferente de `draft`
- 410 UPLOAD_EXPIRED: o storage responde `NoSuchUpload` (multipart abortado pelo lifecycle); o vídeo passa a `failed` com `processing_error = 'upload_expired'` (AMB-3)

---

#### DELETE /videos/:id/upload (SI-03.6)

Aborta o upload em andamento (`AbortMultipartUpload`). O vídeo passa a `failed` com `processing_error = 'upload_aborted'` e `upload_id = null`. Um `NoSuchUpload` no abort é ignorado (operação idempotente).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: `:id` que não é UUID
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATUS: vídeo com status diferente de `draft`

---

#### POST /videos/:id/upload/complete (SI-03.7)

Conclui o upload e dispara o processamento (phase-03-videos/TD-06): `CompleteMultipartUpload` → `HeadObject` (confere `ContentLength` ≤ 10 GiB) → `size_bytes` atualizado, `upload_id = null`, status `processing` → enfileira o job `video.process` (ver `### Events/Messages`).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: `{ partNumber: integer, ETag: string }[]`, required — 1 a 10000 itens, `partNumber` em ordem crescente e sem repetição; `ETag` lido do header de resposta de cada PUT

**Response 202:**
- videoId: string (uuid)
- status: `'processing'`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema ou `:id` que não é UUID
- 400 INVALID_UPLOAD_PARTS: o storage rejeita a lista de partes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`); o vídeo continua `draft` e o cliente pode corrigir e repetir
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 INVALID_VIDEO_STATUS: vídeo com status diferente de `draft`
- 410 UPLOAD_EXPIRED: o storage responde `NoSuchUpload`; o vídeo passa a `failed` com `processing_error = 'upload_expired'` (AMB-3)
- 413 VIDEO_TOO_LARGE: o objeto final passa de 10 GiB; o objeto é removido e o vídeo passa a `failed` com `processing_error = 'file_too_large'`

---

#### GET /videos/:id (SI-03.10)

Consulta do dono, usada pelo cliente para acompanhar `processing → ready` por polling (AMB-2). A consulta pela URL única (`slug`) e o acesso anônimo ficam para a Fase 05.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `'draft' | 'processing' | 'ready' | 'failed'`
- durationSeconds: number | null
- metadata: object | null — `{ format, video, audio }` (phase-03-videos/TD-08)
- thumbnailUrl: string | null — GET pré-assinado da thumbnail com validade de 1h; `null` enquanto não houver `thumbnail_key`
- processingError: string | null
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `:id` que não é UUID
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário

---

#### GET /videos/:id/stream (SI-03.11)

Devolve uma URL `GetObject` pré-assinada de `videos/{videoId}/source` para uso direto em `<video src>`. Range e 206 são tratados pelo storage (phase-03-videos/TD-11).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — validade de 1h
- expiresAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `:id` que não é UUID
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 VIDEO_NOT_READY: vídeo com status diferente de `ready`

---

#### GET /videos/:id/download (SI-03.11)

Devolve uma URL `GetObject` pré-assinada com `ResponseContentDisposition: attachment; filename="{original_filename}"` (nome sanitizado), que força o download (phase-03-videos/TD-11).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — validade de 15 min
- expiresAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `:id` que não é UUID
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro usuário
- 409 VIDEO_NOT_READY: vídeo com status diferente de `ready`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| POST /videos | ✗ | ✓ | — | Cria um vídeo do próprio usuário autenticado |
| POST /videos/:id/upload/part-urls | ✗ | ✗ | ✓ | Não dono recebe 404 `VIDEO_NOT_FOUND` |
| GET /videos/:id/upload/parts | ✗ | ✗ | ✓ | Não dono recebe 404 `VIDEO_NOT_FOUND` |
| DELETE /videos/:id/upload | ✗ | ✗ | ✓ | Não dono recebe 404 `VIDEO_NOT_FOUND` |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ | Não dono recebe 404 `VIDEO_NOT_FOUND` |
| GET /videos/:id | ✗ | ✗ | ✓ | Não dono recebe 404 `VIDEO_NOT_FOUND` (AMB-2) |
| GET /videos/:id/stream | ✗ | ✗ | ✓ | Só com `status = 'ready'` (phase-03-videos/TD-11) |
| GET /videos/:id/download | ✗ | ✗ | ✓ | Só com `status = 'ready'` (phase-03-videos/TD-11) |

Anônimo recebe 401 em todos os endpoints. O acesso anônimo a vídeos publicados chega na Fase 05 como regra aditiva, sem alterar as regras desta fase (phase-03-videos/TD-11).

### Error Catalog

O formato de erro é herdado de phase-02-auth/TD-07: `{ statusCode, error, message }`, com o código de domínio em `error`. Erros de validação continuam com `error: 'VALIDATION_ERROR'` e `message` como array. As mensagens ficam em inglês, como nas exceções já existentes em `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Message | Trigger |
|-----------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | `Video not found` | Qualquer endpoint `/videos/:id…` com id inexistente ou de outro usuário |
| VIDEO_TOO_LARGE | 413 | `Video exceeds the 10 GiB limit` | `POST /videos` com `fileSize` acima de 10 GiB, ou `POST /videos/:id/upload/complete` quando o `HeadObject` mostra mais de 10 GiB (objeto removido, vídeo `failed` com `file_too_large`) |
| INVALID_VIDEO_STATUS | 409 | `Operation not allowed for the current video status` | Operações de upload (`part-urls`, `parts`, abort, `complete`) com status diferente de `draft` |
| INVALID_PART_NUMBER | 400 | `Part number is out of range` | `POST /videos/:id/upload/part-urls` com `partNumber` acima de `partCount` |
| INVALID_UPLOAD_PARTS | 400 | `Uploaded parts do not match the storage state` | `POST /videos/:id/upload/complete` rejeitado pelo storage (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`); o vídeo continua `draft` |
| UPLOAD_EXPIRED | 410 | `Upload session has expired` | `GET /videos/:id/upload/parts` ou `POST /videos/:id/upload/complete` quando o storage responde `NoSuchUpload`; o vídeo passa a `failed` com `upload_expired` (AMB-3) |
| VIDEO_NOT_READY | 409 | `Video is not ready` | `GET /videos/:id/stream` ou `GET /videos/:id/download` com status diferente de `ready` |

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Queue:** `video-processing`, com o prefixo de chaves do Redis vindo de `QUEUE_PREFIX`: um valor em dev e outro exclusivo nos testes, de modo que o container `video-worker` nunca consome jobs de teste (per `phase-03-videos/TD-14`)
**Producer:** `VideoProcessingProducer`, chamado pelo `VideosService` na conclusão do upload (per `phase-03-videos/TD-06`)
**Consumer:** `VideoProcessor` (`@Processor('video-processing')` + `WorkerHost`), registrado só no `WorkerModule`, que sobe pelo entrypoint `src/worker.ts` (`NestFactory.createApplicationContext`) no container `video-worker` (per `phase-03-videos/TD-07`)
**Trigger:** `POST /videos/:id/upload/complete` depois de o `HeadObject` confirmar o objeto e o status passar a `processing`
**Delivery semantics:** at-least-once; o worker é idempotente e sobrescreve thumbnail e metadados ao tentar de novo (per `phase-03-videos/TD-12`)

**Job options** (per `phase-03-videos/TD-12`):

| Opção | Valor |
|-------|-------|
| jobId | `videoId` (reenfileirar o mesmo vídeo não duplica o job) |
| attempts | `3` |
| backoff | `{ type: 'exponential', delay: 1000 }` |
| removeOnComplete | `true` |
| removeOnFail | `100` |

**Processamento** (per `phase-03-videos/TD-08`):

1. Ignora o job, sem erro, se o vídeo não existe mais ou não está em `processing`.
2. Pré-assina um GET curto de `videos/{videoId}/source` com o cliente **interno** (`S3_ENDPOINT`) e executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process`; grava `duration_seconds` e o JSON curado em `metadata` (`format`, `video`, `audio`).
3. Executa `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2` com `t = min(10% da duração, duração − ε)` (volta para `t = 0` em clipes muito curtos) e grava o JPEG em `videos/{videoId}/thumbnail.jpg` via `PutObject` (`ContentType: 'image/jpeg'`).
4. Preenche `thumbnail_key` e passa o status para `ready`.

**Falhas** (per `phase-03-videos/TD-12`):

- Arquivo que o ffprobe não reconhece como vídeo (sem stream de vídeo ou saída inválida) é lançado como `UnrecoverableError`, que falha sem gastar retentativas; `processing_error = 'invalid_video'`.
- Erros transitórios (storage, rede, reinício do worker) são relançados para o BullMQ tentar de novo com backoff.
- O evento `failed` do worker dispara a cada tentativa que falha. O handler só grava `status = 'failed'` e `processing_error` quando `job.attemptsMade >= job.opts.attempts` ou quando o erro é `UnrecoverableError`.
- Não há endpoint de reprocessamento manual nesta fase.

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depende de SI-03.1 (configuração e serviço de storage no Compose)
│   ├── SI-03.5 — depende de SI-03.2 + SI-03.3 (StorageService e entidade Video)
│   │   ├── SI-03.6 — depende de SI-03.5 (VideosService e controller)
│   │   │   └── SI-03.7 — depende de SI-03.6 + SI-03.4 (helpers de dono/status e producer)
│   │   ├── SI-03.10 — depende de SI-03.5 (VideosService e controller)
│   │   └── SI-03.11 — depende de SI-03.5 (VideosService e controller)
│   └── SI-03.8 — depende de SI-03.1 + SI-03.2 (FFmpeg na imagem e storage no teste)
│       └── SI-03.9 — depende de SI-03.8 + SI-03.4 (MediaService e fila)
│           └── SI-03.12 — depende de SI-03.9 + SI-03.10 + SI-03.11 (pipeline completo)
│               └── SI-03.13 — depende de SI-03.12 (documentação após validação)
└── SI-03.4 — depende de SI-03.1 + SI-03.3 (configuração da fila, Redis e VideosModule)
SI-03.3 (root, independente)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços do Compose
- [ ] SI-03.2 — Serviço de storage (StorageModule)
- [ ] SI-03.3 — Entidade Video, migration CreateVideos e base do VideosModule
- [ ] SI-03.4 — Fila de processamento e producer
- [ ] SI-03.5 — Endpoint POST /videos (início do upload)
- [ ] SI-03.6 — Endpoints de URLs de partes, retomada e abort do upload
- [ ] SI-03.7 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)
- [ ] SI-03.8 — Serviço de mídia (ffprobe e ffmpeg)
- [ ] SI-03.9 — Worker de processamento (VideoProcessor, entrypoint e container)
- [ ] SI-03.10 — Endpoint GET /videos/:id (consulta do dono)
- [ ] SI-03.11 — Endpoints GET /videos/:id/stream e GET /videos/:id/download
- [ ] SI-03.12 — Teste do pipeline completo e contrato OpenAPI
- [ ] SI-03.13 — Documentação da fase e notas para a Fase 04

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
