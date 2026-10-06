---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-05T19:09:44-03:00"
  "bullmq":
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-05T19:09:44-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-05T19:09:44-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-05T19:09:44-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T19:08:04-03:00"
---

# Referências de Bibliotecas — Fase 03

Cache da documentação das bibliotecas novas da Fase 03, consultada via **context7** em 2026-10-05. As versões foram fixadas contra o que está instalado no `nestjs-project` (`@nestjs/core` 11.1.16, `typescript` 5.9.3, Node 25) e contra os peers publicados no npm.

| Biblioteca | Versão | TD | context7 | Observação |
|---|---|---|---|---|
| `@nestjs/bullmq` | `^11.0.5` | TD-01, TD-07, TD-14 | `/nestjs/bull` | Peers: `@nestjs/core`/`@nestjs/common` ^10 ou ^11 e `bullmq` ^3 a ^6. Acompanha a linha 11 do NestJS usada no projeto. A 12.0.0 também aceita o Nest 11, mas é a major alinhada ao Nest 12. |
| `bullmq` | `^5.81.5` | TD-01, TD-12, TD-14 | `/taskforcesh/bullmq` | Segue o TD-01 (preferir 5.x). **Divergência de versão:** o context7 indexa a v6.3.11. A API usada nesta fase (Queue, Worker, `attempts`, `backoff`, `jobId`, `prefix`, evento `failed`, `UnrecoverableError`) é a mesma na 5.x. Os recursos exclusivos da v6 (backends plugáveis, `BackendFactory`, backend PostgreSQL) **não** são usados. |
| `@aws-sdk/client-s3` | `^3.1146.0` | TD-03, TD-04, TD-05, TD-08, TD-15 | `/aws/aws-sdk-js-v3` | `engines.node >= 20`. |
| `@aws-sdk/s3-request-presigner` | `^3.1146.0` | TD-03, TD-05, TD-09, TD-11 | `/aws/aws-sdk-js-v3` | Mesma versão do client (as duas libs são publicadas juntas). |

Não entram neste arquivo, porque não são bibliotecas npm: a imagem do Redis (TD-01), o `pgsty/minio` (TD-02) e o binário `ffmpeg`/`ffprobe` do sistema (TD-08, TD-13).

---

### @nestjs/bullmq

**Configuração compartilhada (conexão + prefixo).** `BullModule.forRootAsync` registra um módulo global; o `useFactory` recebe as dependências de `inject` e devolve as `QueueOptions` do BullMQ. O `prefix` definido aqui é repassado pelo `BullExplorer` ao `Worker` (`prefix: queueOpts.prefix`), então produtor e consumidor ficam no mesmo namespace do Redis (TD-14: um prefixo para dev e outro para os testes).

```ts
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.host, port: config.port },
    prefix: config.prefix,
  }),
});
```

**Registro da fila.** `BullModule.registerQueue({ name, defaultJobOptions })` cria o provider da fila (token `BullQueue_<name>`). `defaultJobOptions` aceita os mesmos campos do `queue.add` (ex.: `attempts`).

**Produtor (API).** `@InjectQueue(name)` injeta a instância `Queue` do `bullmq`:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

**Consumidor (worker).** Toda classe `@Processor(name)` precisa estender `WorkerHost`; o `process(job)` vira o callback do Worker. Uma rejeição (exceção) em `process()` marca o job como falho, **sujeito a `attempts`/`backoff`**. O processor só deve ser registrado no módulo do worker (TD-07), para a API não consumir a fila.

```ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* ver regra da tentativa final em bullmq */ }
}
```

- `this.worker` (getter de `WorkerHost`) só está disponível a partir de `onApplicationBootstrap`.
- `extraOptions.manualRegistration: true` (no `forRoot`) impede o registro automático de filas e workers. Útil se for preciso controlar quando o worker sobe nos testes (TD-14).

---

### bullmq

**Opções do job (`queue.add(name, data, opts)`):**

```ts
await queue.add('process', { videoId }, {
  jobId: videoId,                              // dedupe: reenfileirar o mesmo vídeo não duplica o job
  attempts: 3,                                 // TD-12
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 100,                           // mantém os últimos N falhos para inspeção
});
```

**Retentativas e falha final.** Em `moveToFailed`, o job é reagendado enquanto `attemptsMade + 1 < opts.attempts` e o erro não for `UnrecoverableError`. **O evento `failed` do Worker é emitido a cada tentativa que falha**, não só na última. Portanto o handler que marca o vídeo como `failed` deve checar `job.attemptsMade >= job.opts.attempts` (o contador já foi incrementado ao emitir o evento).

```ts
import { UnrecoverableError } from 'bullmq';

// erro permanente (ex.: ffprobe não reconhece o arquivo como vídeo): falha sem gastar retentativas
throw new UnrecoverableError('arquivo não é um vídeo válido');
```

**Conexão do Worker.** Workers exigem `maxRetriesPerRequest: null` no ioredis (o BullMQ lança exceção se uma conexão criada manualmente não tiver essa opção). Passando `connection: { host, port }`, o BullMQ cria a conexão já configurada.

**Prefixo.** O padrão é `"bull"`. Todos os componentes que acessam a mesma fila precisam usar o mesmo `prefix` (TD-14).

---

### @aws-sdk/client-s3

**Cliente apontando para o storage compatível com S3 (TD-03, TD-09):**

```ts
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  region: 'us-east-1',
  endpoint: 'http://storage:9000',          // S3_ENDPOINT (interno); um 2º cliente usa S3_PUBLIC_ENDPOINT só para presign
  forcePathStyle: true,                      // v3: renomeado de s3ForcePathStyle
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

Desde a **3.731.0** o padrão é `WHEN_SUPPORTED`: o client calcula CRC32 em todo `UploadPart`/`PutObject` e valida checksums nas respostas. Com URLs pré-assinadas usadas pelo navegador, isso pode exigir um checksum que o navegador não envia, por isso `WHEN_REQUIRED` nos dois campos (TD-03).

**Comandos usados na fase:**

| Comando | Uso | Campos relevantes |
|---|---|---|
| `CreateMultipartUploadCommand` | início do upload (TD-05) | `Bucket`, `Key`, `ContentType` → resposta `UploadId` |
| `UploadPartCommand` | presign por parte (TD-05) | `PartNumber` (1–10000), `UploadId` → resposta `ETag` |
| `ListPartsCommand` | retomada (TD-05) / detectar `uploadId` expirado (AMB-3) | `UploadId` → `Parts[]` (até 1000 por página) |
| `CompleteMultipartUploadCommand` | conclusão (TD-06) | `MultipartUpload.Parts: { PartNumber, ETag }[]` |
| `AbortMultipartUploadCommand` | abortar upload | `UploadId` |
| `HeadObjectCommand` | conferir tamanho ≤ 10 GiB após concluir (TD-05) | resposta `ContentLength` |
| `GetObjectCommand` | presign de stream/download (TD-11) e leitura pelo FFmpeg (TD-08) | `ResponseContentDisposition` |
| `PutObjectCommand` | gravar a thumbnail (TD-08) | `Body`, `ContentType: 'image/jpeg'` |
| `PutBucketLifecycleConfigurationCommand` | regra de abort de multipart incompleto (TD-05) | `Rules[].AbortIncompleteMultipartUpload.DaysAfterInitiation` |
| `PutBucketCorsCommand` | CORS do storage para o navegador (TD-09, revisão do ICC-1) | `CORSRules[]`: `AllowedOrigins`, `AllowedMethods` (`PUT`, `GET`), `AllowedHeaders`, `ExposeHeaders: ['ETag']` |

Uma `ListParts`/`CompleteMultipartUpload` com `UploadId` inexistente falha com `NoSuchUpload`, que é o sinal usado para marcar o vídeo como `failed` com motivo `upload_expired` (AMB-3).

---

### @aws-sdk/s3-request-presigner

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// URL de parte (TD-05)
const partUrl = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// URL de download (TD-11)
const downloadUrl = await getSignedUrl(
  publicClient,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: `attachment; filename="${fileName}"` }),
  { expiresIn: 900 },
);
```

- `expiresIn` em segundos; o padrão é **900**.
- A URL embute o host do cliente que assinou. Por isso as URLs entregues ao navegador são assinadas pelo cliente configurado com `S3_PUBLIC_ENDPOINT`, e as usadas pelo worker/FFmpeg pelo cliente interno (`S3_ENDPOINT`) (TD-09).
- Headers `x-amz-*` que precisem ser exigidos na requisição podem ser forçados com `unhoistableHeaders`. Não é necessário nesta fase, porque o checksum fica desligado (`WHEN_REQUIRED`).
