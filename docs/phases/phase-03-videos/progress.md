# phase-03-videos — Progress

**Status:** completed
**SIs:** 13/13 completed

### SI-03.1 — Infra: dependências, configuração e serviços do Compose
- **Status:** completed
- **Tests:** 10 passing (`src/config/env.validation.integration-spec.ts`); `npx tsc --noEmit` exit 0
- **Observations:**
  - Ambiente de clone novo: não havia `.env` nem `node_modules`. O `.env` foi criado a partir do `.env.example` (é ignorado pelo git), e foram rodados `npm install` e `npm run migration:run` antes da SI.
  - **Fora do escopo:** o `.env.example` traz `MAIL_FROM="StreamTube" <noreply@streamtube.com>` sem aspas em volta do valor inteiro. O `docker compose` recusa o arquivo (`unexpected character "<"`), exatamente o caso que o `nestjs-project/CLAUDE.md` proíbe. Foi corrigido só no `.env` local (`MAIL_FROM='"StreamTube" <noreply@streamtube.com>'`); o exemplo precisa de uma correção à parte.
  - O schema Joi restringe `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` e `STORAGE_CORS_ORIGIN` a `http`/`https`. Com `.uri()` puro, `storage:9000` passava como URI (esquema `storage`) e só falharia em tempo de execução.
  - Imagens fixadas: `redis:8.2-alpine` e `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`. O healthcheck do storage usa `curl -f http://localhost:9000/minio/health/live`, executado dentro do próprio container, onde `curl` e `mc` existem.
  - Em dev, o CORS do storage vem de `MINIO_API_CORS_ALLOW_ORIGIN=${STORAGE_CORS_ORIGIN}`. O `PutBucketCors` do bootstrap fica para a SI-03.2.
  - O FFmpeg instalado pelo `apt` da imagem `node:25.6.0-slim` (Debian 12) é a versão 5.1.9.
  - A ferramenta `TaskCreate` não está disponível nesta sessão; o `progress.md` faz o papel de lista visível das SIs.

### SI-03.2 — Serviço de storage (StorageModule)
- **Status:** completed
- **Tests:** 12 passing (`storage.module.spec.ts` 3, `storage.service.integration-spec.ts` 6, `storage-bootstrap.service.integration-spec.ts` 3); `npx tsc --noEmit` exit 0; eslint limpo nos arquivos da SI
- **Observations:**
  - **Desvio do plano, aprovado pelo usuário (fallback no servidor):** o `pgsty/minio` recusa a ação de lifecycle `AbortIncompleteMultipartUpload` (`InvalidArgument`), embora aceite regras de `Expiration`. O bootstrap tenta aplicar a regra (funciona no S3 real); se o servidor recusar, registra um aviso e segue. Em dev, a limpeza de uploads abandonados vem de `MINIO_API_STALE_UPLOADS_EXPIRY=24h` no `compose.yaml` (varredura a cada 6h, padrão do servidor). Pede uma revisão do TD-05 registrando o mecanismo por servidor.
  - O `PutBucketCors` também é recusado (`NotImplemented`), como o plano previa; o CORS de dev vem de `MINIO_API_CORS_ALLOW_ORIGIN`. Um teste confirma o preflight `OPTIONS` vindo de `http://localhost:3001` (libera `PUT`) e o `ETag` exposto ao navegador.
  - **Bug do SDK com MinIO:** o `paginateListParts` entrava em laço infinito, porque o MinIO responde a última página com `IsTruncated: false` e `NextPartNumberMarker: '0'`, e o paginador trata esse `'0'` como novo token. O `StorageService.listParts` passou a usar um laço manual que respeita o `IsTruncated`.
  - O `StorageModule` ainda não está no `AppModule`; ele entra pelo `VideosModule` na SI-03.5. Nesta SI, o bootstrap do bucket foi validado pelos testes de integração.
  - Corpos de `fetch` nos testes usam `Uint8Array<ArrayBuffer>`: com o TypeScript 5.9, `Buffer` não satisfaz o tipo `BodyInit`.
  - No teste de ambiente, o helper `validate` passou a tipar `value` como `Record<string, unknown>`, o que removeu 2 erros de lint que já existiam no teste do `SWAGGER_ENABLED`, além do erro do teste novo.
  - **Fora do escopo (lint que já existia):** `src/test/create-test-data-source.ts:9` usa o tipo `Function` (`@typescript-eslint/no-unsafe-function-type`), então o `npm run lint` completo já falhava antes desta fase. Esse arquivo é editado na SI-03.3; a correção entra lá ou na verificação final.

### SI-03.3 — Entidade Video, migration CreateVideos e base do VideosModule
- **Status:** completed
- **Tests:** 12 passing (`video.entity.integration-spec.ts` 7, `slug.util.spec.ts` 2, `migrations.integration-spec.ts` 2, `videos.module.spec.ts` 1); `npx tsc --noEmit` exit 0; eslint limpo em `src/videos`, `src/database`, `src/test` e `src/app.module.ts`
- **Observations:**
  - Migration `1791245075044-CreateVideos` gerada pela CLI e verificada com `migration:run` → `migration:revert` → `migration:run`.
  - **Bug que já existia, corrigido aqui:** o `migrations.integration-spec.ts` falhava em todo banco já migrado. O `beforeAll` apagava as tabelas, mas não os tipos enum, e a migration falhava em `CREATE TYPE ... already exists`. Pior: deixava o banco compartilhado sem nenhuma tabela, e o processo do Jest não encerrava. O teste agora também apaga os enums (`verification_tokens_type_enum`, `videos_status_enum`) e roda os `DROP` em sequência. O banco foi restaurado com `migration:run` antes de gerar a `CreateVideos`.
  - A relação `Video → User` fica só do lado do `Video` (`@ManyToOne`), como no plano e como já fazem `RefreshToken` e `VerificationToken`. A regra `nestjs-entities.md` pede os dois lados, mas um `@OneToMany` no `User` obrigaria todo `DataSource` de teste que carrega o `User` a carregar também o `Video`.
  - O lint que já falhava em `src/test/create-test-data-source.ts` (tipo `Function`) foi corrigido: o parâmetro `entities` passou a usar `DataSourceOptions['entities']`.
  - O teste da entidade usa `synchronize: false`, ou seja, valida o schema real criado pela migration (enum, unique, FK), e não um schema sincronizado.
  - O `id` é atribuído pela aplicação mesmo com `@PrimaryGeneratedColumn('uuid')`; um teste confirma que o valor informado é mantido.
  - O `VideosModule` já está registrado no `AppModule`.

### SI-03.4 — Fila de processamento e producer
- **Status:** completed
- **Tests:** 6 passing (`video-processing.producer.integration-spec.ts` 4, `queue.module.spec.ts` 1, `videos.module.spec.ts` 1); `npx tsc --noEmit` exit 0; eslint limpo em `src/queue` e `src/videos`
- **Observations:**
  - No BullMQ 5.81, `queue.client` é a interface abstrata `IRedisClient`, sem `keys`. O teste do prefixo consulta o hash do job (`hgetall` em `{prefix}:video-processing:{jobId}`) com o prefixo de teste e com o padrão `bull`.
  - As opções do job ficaram em `VIDEO_PROCESS_JOB_OPTIONS` (tipadas como `JobsOptions`) em `video-processing.constants.ts`; o `jobId = videoId` é acrescentado em cada `enqueue`.
  - Como o `VideosModule` está no `AppModule` e agora registra a fila, qualquer teste que sobe o `AppModule` (os e2e das fases anteriores) passa a abrir conexão com o Redis. O serviço `redis` já é dependência `service_healthy` do `nestjs-api`.
  - O `queue.module.spec.ts` (unitário, só de compilação) abre conexão real com o Redis ao registrar a fila, como os specs de módulo que já existiam (`channels.module.spec.ts` com o banco, `mail.module.spec.ts` com o SMTP).

### SI-03.5 — Endpoint POST /videos (início do upload)
- **Status:** completed
- **Tests:** 19 passing (`videos.service.spec.ts` 10, `videos.service.integration-spec.ts` 2, `videos.module.spec.ts` 1, e2e `test/videos-start-upload.e2e-spec.ts` 6, este derivado de `nestjs-project/specs/videos-start-upload.plan.md`); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - **Bug da SI-03.1, corrigido aqui:** no `test/jest-e2e.json`, o `rootDir: "."` é relativo à pasta do próprio arquivo (`test/`), então o `setupFiles` apontava para `test/src/test/setup-test-env.ts`. O caminho certo é `<rootDir>/../src/test/setup-test-env.ts`. Na SI-03.1 nenhum e2e foi rodado, e o erro passou despercebido.
  - Foi acrescentado `"testTimeout": 30000` ao `test/jest-e2e.json`. Com storage e fila no `AppModule`, o boot da aplicação (conexões com Redis e storage e bootstrap do bucket) passa dos 5 s padrão do Jest. A mudança vale para todos os e2e, inclusive os de auth, que também sobem o `AppModule`.
  - Criado `test/utils/videos-e2e.ts` (boot com os pipes e filtros do `main.ts`, limpeza de banco, bucket e throttler, e criação de usuário confirmado com login via `POST /auth/login`), para os 5 e2e de vídeo reaproveitarem.
  - O slug é gerado com até 5 tentativas; cada `save` é um comando isolado (sem transação), então a violação de unicidade não aborta a sequência. A colisão é identificada por `23505` com `(slug)` no `detail`.
  - Se a gravação do rascunho falhar, o multipart é abortado (compensação). Um erro no abort só é registrado em log, e o erro original continua sendo propagado.
  - `@ApiBearerAuth('access-token')` foi aplicado no nível da classe do `VideosController`, porque todos os endpoints de vídeo são autenticados.

### SI-03.6 — Endpoints de URLs de partes, retomada e abort do upload
- **Status:** completed
- **Tests:** 35 passing (`videos.service.spec.ts` e `videos.service.integration-spec.ts`, que acumulam os casos das SI-03.5 e 03.6, mais o e2e `test/videos-upload-parts.e2e-spec.ts` com 7 cenários, derivado de `nestjs-project/specs/videos-upload-parts.plan.md`); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - O `partCount` é calculado a partir de `size_bytes` (`ceil(size / 64 MiB)`) e não é guardado em coluna própria; o cálculo foi para o helper `partCountFor`, compartilhado com o `startUpload`.
  - O `POST /videos/:id/upload/part-urls` responde **200** com `@HttpCode(HttpStatus.OK)`, como no API Contract: a rota gera URLs e não cria recurso.
  - Os motivos de falha (`upload_expired`, `upload_aborted`, `file_too_large`, `invalid_video`) ficaram em `PROCESSING_ERRORS` (`videos.constants.ts`).
  - Uma operação de upload exige `status = 'draft'` **e** `upload_id` preenchido (`assertUploading`); os dois andam juntos, porque `markFailed` zera o `upload_id`.
  - No abort, um `StorageUploadNotFoundError` vira resultado válido (idempotência); qualquer outro erro do storage é propagado e o vídeo não muda.
  - No e2e, a expiração do lifecycle é simulada abortando o multipart direto pelo `StorageService`.

### SI-03.7 — Endpoint POST /videos/:id/upload/complete (conclusão e enfileiramento)
- **Status:** completed
- **Tests:** 43 passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts` e `videos.module.spec.ts`, acumulando os casos das SI-03.5 a 03.7, mais o e2e `test/videos-upload-complete.e2e-spec.ts` com 5 cenários, derivado de `nestjs-project/specs/videos-upload-complete.plan.md`); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - A passagem para `processing` é um update **condicional** (`WHERE id = ? AND status = 'draft'`). Com `affected = 0`, responde 409 `INVALID_VIDEO_STATUS` sem enfileirar, o que protege contra duas conclusões concorrentes; o plano não pedia isso explicitamente.
  - Se o enfileiramento falhar, o vídeo é marcado `failed` com a mensagem do erro e o erro é propagado (500), para o vídeo não ficar preso em `processing` sem job.
  - O caso de objeto acima de 10 GiB (413, remoção do objeto, `file_too_large`) só tem teste unitário, com o `HeadObject` mockado. Em e2e ele exigiria enviar 10 GiB, como já previa o aviso do `/plan-test-specs`.
  - O `test/utils/videos-e2e.ts` passou a expor a fila de teste (`ctx.queue`) e a limpá-la (`obliterate`) entre os testes, porque nos e2e da API nenhum worker consome os jobs.
  - O `VideosService` agora injeta o `VideoProcessingProducer`; o teste de integração do service registra a `QueueModule` e a fila.

### SI-03.8 — Serviço de mídia (ffprobe e ffmpeg)
- **Status:** completed
- **Tests:** 24 passing (`media.service.spec.ts`, `media.service.integration-spec.ts` com FFmpeg real lendo do MinIO, e `video.entity.integration-spec.ts`, rodado de novo porque o formato dos metadados mudou); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - A execução dos binários fica atrás do token `COMMAND_RUNNER` (`execFileRunner`, que usa `execFile` sem shell e devolve o stdout como `Buffer`), para o teste unitário simular o processo filho sem `jest.mock` de módulo.
  - Classificação de falhas: o stderr com `Invalid data found`, `moov atom not found` ou `could not find codec parameters`, a ausência de stream de vídeo, a duração desconhecida (ex.: imagem) e a saída vazia do ffmpeg viram `InvalidMediaError` (permanente). Qualquer outra falha do comando (rede, storage, timeout) é propagada como transitória, para o BullMQ tentar de novo.
  - Os metadados curados têm tipos próprios em `src/media/media.types.ts` (`format`: `name`, `durationSeconds`, `sizeBytes`, `bitRate`; `video`: `codec`, `width`, `height`, `frameRate`, `bitRate`; `audio`: `codec`, `channels`, `sampleRate`, ou `null`). `VideoMetadata` virou um alias desse tipo, e o teste da entidade passou a usar o formato novo.
  - Fixtures commitadas: `test/fixtures/sample.mp4` (51 KB, H.264 640×360 a 25 fps com áudio AAC, 3 s, `+faststart`, gerado com `testsrc`/`sine` no próprio container) e `test/fixtures/not-a-video.mp4` (texto puro).
  - O instante da thumbnail é `max(0, min(10% da duração, duração − 0,1 s))`, exposto como `MediaService.thumbnailTimestamp` para o teste unitário. O `scale=1280:-2` também amplia vídeos menores (640×360 → 1280×720), como pede o TD-08 (1280px de largura).
  - O FFmpeg lê a URL pré-assinada **interna** (`client: 'internal'`) e escreve o JPEG em `pipe:1`, sem arquivo temporário.

### SI-03.9 — Worker de processamento (VideoProcessor, entrypoint e container)
- **Status:** completed
- **Tests:** 20 passing (`video.processor.spec.ts`, `video.processor.integration-spec.ts` com o worker real no processo de teste, `worker.module.spec.ts`, e o e2e `videos-start-upload` rodado de novo para validar o `AppModule` refatorado); `npx tsc --noEmit` exit 0; eslint limpo. O container `video-worker` foi verificado manualmente: sobe sem porta exposta e registra `Video worker started`.
- **Observations:**
  - **Bug encontrado pelo `worker.module.spec.ts` e corrigido:** com `autoLoadEntities`, o worker registrava só a `Video`, e o TypeORM falhava em `Entity metadata for Video#user was not found`; em produção, o container entraria em loop de reinício. O `VideoProcessingModule` passou a importar o `UsersModule`, que registra `User` e, pelo `ChannelsModule`, `Channel`. O e2e não pegava o problema porque o `AppModule` já carrega o `UsersModule` pelo `AuthModule`.
  - **Desenho diferente do plano, pela regra de separação de camadas:** a lógica do job está em `VideoProcessingService` (process e markFailed); o `VideoProcessor` só delega, converte `InvalidMediaError` em `UnrecoverableError('invalid_video')` e trata o evento `failed`.
  - O processor e o service ficam no `VideoProcessingModule`, importado **só** pelo `WorkerModule`. A API (`VideosModule`) registra a fila só do lado do producer.
  - **Desvio do plano:** o `CoreModule` (`src/core/core.module.ts`) agrupa só `ConfigModule.forRoot` e `TypeOrmModule.forRootAsync`. O `QueueModule` continua importado pelos módulos que usam a fila (`VideosModule` e `VideoProcessingModule`), para não registrar o `forRootAsync` do BullMQ duas vezes. O `AppModule` ficou com `CoreModule`, `AuthModule` e `VideosModule`.
  - O `ready` e o `failed` são gravados por update condicional (`status = 'processing'`). Um job de vídeo fora de `processing` é ignorado com aviso no log; um reprocessamento sobrescreve thumbnail e metadados.
  - O handler `failed` só grava a falha na última tentativa (`attemptsMade >= opts.attempts`) ou em `UnrecoverableError`. Se não conseguir gravar, registra em log sem relançar, já que é um evento em segundo plano.
  - O `start:worker` usa `ts-node -r tsconfig-paths/register src/worker.ts`, no mesmo padrão do `openapi:export`, para não disputar o `dist/` com o `start:dev` da API; o `start:worker:prod` usa `node dist/worker`. O serviço `video-worker` usa `restart: unless-stopped` e a mesma imagem de dev da API (TD-13).
  - Em dev o `video-worker` usa o prefixo `streamtube` e os testes usam `streamtube-test`, então o container pode ficar ligado durante a suíte (TD-14).

### SI-03.10 — Endpoint GET /videos/:id (consulta do dono)
- **Status:** completed
- **Tests:** 46 passing (`videos.service.spec.ts` e `videos.service.integration-spec.ts`, acumulando os casos das SI-03.5 a 03.10, mais o e2e `test/videos-get.e2e-spec.ts` com 5 cenários, derivado de `nestjs-project/specs/videos-get.plan.md`); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - As validades das URLs para clientes ficaram em `VIDEO_URL_EXPIRES_IN_SECONDS` (`THUMBNAIL` 3600, `STREAM` 3600, `DOWNLOAD` 900), já preparadas para a SI-03.11.
  - O `VideoResponseDto` é montado por mapeamento explícito a partir da entidade (snake_case no banco, camelCase na API) e devolve as datas em ISO-8601. O `metadata` aparece no OpenAPI como objeto livre (`additionalProperties`), com a descrição de `format`, `video` e `audio`.
  - A thumbnail só é pré-assinada (cliente público, 1h) quando existe `thumbnail_key`; o `GET` não gera URL para vídeos sem thumbnail.
  - O e2e monta o estado `ready` direto pelo repositório e grava um JPEG no storage, como previsto no spec; o processamento real é testado no e2e do pipeline (SI-03.12).

### SI-03.11 — Endpoints GET /videos/:id/stream e GET /videos/:id/download
- **Status:** completed
- **Tests:** 54 passing (`videos.service.spec.ts` e `videos.service.integration-spec.ts`, acumulando os casos das SI-03.5 a 03.11, mais o e2e `test/videos-stream-download.e2e-spec.ts` com 4 cenários, derivado de `nestjs-project/specs/videos-stream-download.plan.md`); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - O `Content-Disposition` do download segue a RFC 6266 (`src/videos/content-disposition.util.ts`). O `filename="…"` traz uma versão ASCII sem aspas nem barras (caracteres fora do ASCII viram `_`) e o `filename*=UTF-8''…` traz o nome original codificado. Exemplo: `férias "2024".mp4` vira `filename="f_rias _2024_.mp4"; filename*=UTF-8''f%C3%A9rias%20%222024%22.mp4`.
  - Stream e download compartilham o `findReadyOrFail` (dono + `status = 'ready'`, senão `VIDEO_NOT_READY`) e o `presignedSourceUrl`; os dois assinam com o cliente **público** (`S3_PUBLIC_ENDPOINT`).
  - O Range e o 206 são verificados contra o MinIO real, com `Content-Range: bytes 0-99/1000` e o corpo igual aos 100 primeiros bytes.
  - O critério "URL usada depois de `expiresAt` é recusada com 403" não tem teste automatizado: exigiria esperar 1h. A validade (3600 s e 900 s) é coberta pelo teste unitário, como já previa o aviso do `/plan-test-specs`.

### SI-03.12 — Teste do pipeline completo e contrato OpenAPI
- **Status:** completed
- **Tests:** 2 passing (`test/videos-pipeline.e2e-spec.ts`: upload pela API → fila → worker no processo de teste → `ready` com thumbnail e stream 206; arquivo inválido → `failed`/`invalid_video`), em cerca de 31 s, rodado com o container `video-worker` **ligado** para comprovar o isolamento por prefixo de fila (TD-14); `npx tsc --noEmit` exit 0; eslint limpo
- **Observations:**
  - O worker sobe no teste com `Test.createTestingModule({ imports: [WorkerModule] })` + `init()`, ou seja, o mesmo módulo do entrypoint `worker.ts`. O cliente acompanha o processamento por polling de `GET /videos/:id`, como define o AMB-2.
  - `openapi.json` regenerado com `npm run openapi:export`: 8 endpoints de `/videos` com os códigos do Error Catalog (899 linhas adicionadas, nenhuma removida; a parte de auth não mudou).
  - **Fora do escopo (limitação que já existia):** o `openapi:export` roda via `ts-node`, sem o plugin CLI do `@nestjs/swagger`, então os DTOs de **entrada** saem com `properties: {}`. Já era assim com `RegisterDto`, `LoginDto` etc. Os DTOs de resposta, com `@ApiProperty` explícito, saem completos. Corrigir pede gerar o spec a partir do build com o plugin ou um `PluginMetadataGenerator` (hoje `src/metadata.ts` é um stub).
  - **Pendência para o frontend:** o `scripts/sync-openapi.sh` (copia para `next-frontend/openapi.json`) não foi rodado, porque esta fase não toca o `next-frontend/`. Precisa ser rodado, junto com a regeneração do `types.gen.ts`, quando o frontend consumir os endpoints de vídeo.

### SI-03.13 — Documentação da fase e notas para a Fase 04
- **Status:** completed
- **Tests:** no tests (documentação)
- **Observations:**
  - `CLAUDE.md` da raiz: a Message Queue (BullMQ sobre Redis) e o Object Storage (`pgsty/minio`, chaves `videos/{videoId}/…`) foram documentados, e foi acrescentada a subseção "The only authorized exception: `S3_PUBLIC_ENDPOINT`" em Docker Networking (origem separada para o navegador e CORS restrito ao frontend; revisão do TD-09).
  - `nestjs-project/CLAUDE.md`: serviços `redis`, `storage`, `video-worker` e `mailpit` com portas; checagens de prontidão; comandos `start:worker` e `start:worker:prod`; nota sobre a imagem de dev comum com FFmpeg (TD-13); `setupFiles` e `testTimeout` dos e2e; tabela das variáveis forçadas nos testes (TD-14, TD-15).
  - Guia `testing-guide-nestjs-project`: "Object Storage — Local Filesystem" foi trocado por "Object Storage — MinIO real (Docker)", e "Message Queue — Real (Docker)" virou "Message Queue — BullMQ over Redis (Docker)", com prefixo de fila de teste, worker no processo de teste e semântica de retentativas. As menções a adapter local no `SKILL.md` e no `artifacts/services.md` foram trocadas.
  - Como o guia mudou, o `SKILL.md` está no `sources_mtime` do `context.md`, e o `/plan-*` desta fase vai acusar desatualização se rodar de novo. Nenhum `/plan-*` precisa rodar de novo na Fase 03.
  - Os `CLAUDE.md` e o guia continuam em inglês, como o restante desses arquivos.

## Verificação final (Definition of Done)

| Check | Resultado |
|---|---|
| `npm test -- --runInBand` | 38/38 suítes, 258/258 testes (~171 s), encerramento limpo |
| `npm run test:e2e -- --runInBand` | 9/9 suítes, 81/81 testes (~118 s), encerramento limpo |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 (sem erros; 1 aviso `no-unsafe-argument`, configurado como `warn`) |

- **Lint que já existia:** o `npm run lint` completo falhava com 147 erros em 9 arquivos das Fases 01 e 02 (testes de auth, channels, filtros, mail, users e o `channels.service.ts`), nenhum da Fase 03. Por decisão do usuário, a correção foi feita nesta branch, num commit separado só de lint (`a5a6252`), tipando os mocks e os registros de teste, sem mudar comportamento. O helper `src/test/mailpit.ts` também foi tipado.
- **`testTimeout: 30000` na config de unitários + integração (`package.json`):** com o ambiente recém-ligado, a primeira suíte (`auth.service.integration-spec.ts`) estourava os 5 s padrão no `beforeAll` (compilação do `ts-jest` + primeira conexão); rodada sozinha, ela passava. Ficou com o mesmo valor do `test/jest-e2e.json`, porque os testes de integração dependem de Postgres, Redis e storage reais.
- Quatro arquivos que o Prettier tinha reescrito só no fim de linha (`data-source.ts`, as duas migrations antigas e o `seed.ts`) foram restaurados ao `HEAD`.

## Notas para as próximas fases

- **Fase 04 — publicação em campo separado (TD-12):** o `status` da Fase 03 (`draft → processing → ready | failed`) descreve **só o processamento**. Um vídeo `ready` continua não publicado. A Fase 04 precisa modelar a publicação num campo próprio (ex.: `published_at` ou uma coluna de visibilidade), sem reaproveitar o `draft` deste enum.
- **"Target dedicado" do TD-07 → Fase 07 (TD-13):** em dev, `nestjs-api` e `video-worker` usam a mesma imagem `Dockerfile.dev`, com FFmpeg. A separação em imagens de produção (API sem FFmpeg, worker com FFmpeg) fica para o deploy da Fase 07.
- **Fase 05 — acesso público:** o acesso anônimo a vídeos publicados e a consulta pela URL única (`slug`) entram como regras aditivas sobre o `GET /videos/:id`, o `/stream` e o `/download`, hoje restritos ao dono (TD-11, AMB-2).
- **Frontend:** rodar o `scripts/sync-openapi.sh` e regenerar o `types.gen.ts` quando o `next-frontend` consumir os endpoints de vídeo. O upload precisa de CORS no storage para `STORAGE_CORS_ORIGIN` e da leitura do header `ETag` de cada `PUT`.
- **Revisão do TD-05 (opcional, a critério do usuário):** registrar que, no `pgsty/minio`, a limpeza de uploads abandonados e o CORS vêm de configuração do servidor (`MINIO_API_STALE_UPLOADS_EXPIRY`, `MINIO_API_CORS_ALLOW_ORIGIN`), porque o servidor recusa as regras por bucket.
