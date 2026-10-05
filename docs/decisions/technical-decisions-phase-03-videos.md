---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-05
scope_description: "Backend + infraestrutura de upload e processamento de vídeos: tecnologia de fila, imagem local de storage compatível com S3, cliente S3 e layout de chaves, upload multipart pré-assinado de até 10GB, gatilho de conclusão do upload, topologia do worker, extração de metadados/thumbnail com FFmpeg, URL única do vídeo, entrega de streaming/download, ciclo de status e política de falha."
---

# Decisões Técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o novo módulo `videos` (pré-cadastro, handshake de upload, endpoints de stream e download), o produtor da fila, o entrypoint do worker de vídeo, a migration de `videos` e os novos serviços do Compose (object storage, broker da fila, worker).
- `next-frontend/` — nenhuma decisão em aberto neste documento: a interface de vídeo está explicitamente fora do escopo da Fase 03 (tela de upload e player ficam para fases posteriores). Os TDs Cross-layer abaixo (TD-05, TD-10, TD-11) fixam o contrato HTTP/storage que o frontend vai consumir depois. Esse contrato é compatível com a decisão de BFF estrito (`next-frontend-config-base/TD-03`), porque os bytes dos arquivos trafegam navegador ↔ storage diretamente por URLs pré-assinadas, nunca pela API nem pelo BFF.

_Fontes da pesquisa:_ documentação das bibliotecas consultada via **context7 (MCP)** em 2026-10-05:

- `/taskforcesh/bullmq` (v6.3.11): attempts + backoff exponencial, `jobId`, evento `failed` do worker, `UnrecoverableError`, backend PostgreSQL da v6 e breaking changes da 6.0.0.
- `/nestjs/bull` (`@nestjs/bullmq`): `BullModule.forRoot`/`forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`, `@OnWorkerEvent`.
- `/aws/aws-sdk-js-v3`: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompletedPart`, `getSignedUrl` (validade padrão de 900s), `endpoint` customizado, `forcePathStyle`, `requestChecksumCalculation`/`responseChecksumValidation` (desde a 3.731.0).

Fontes complementares, que não são documentação de biblioteca: docs.nestjs.com (Queues), AWS S3 User Guide (multipart upload), registro do npm (`npm view`, 2026-10-05), testes nos registros Docker (`docker manifest inspect`, 2026-10-05) e os anúncios de descontinuação do MinIO e do `fluent-ffmpeg` (ver TD-02 e TD-08). As versões das bibliotecas são fixadas depois pelo `plan-resolve`, no `library-refs.md`.

_Restrições herdadas (não reabertas):_ configuração via `@nestjs/config` + Joi + namespaces `registerAs` (`phase-01-configuracao-base/TD-01..TD-04`); guard JWT customizado (`phase-02-auth/TD-02`); filtro de exceções de domínio `{ statusCode, error, message }` (`phase-02-auth/TD-07`); DTOs com class-validator (`phase-02-auth/TD-06`); `@nestjs/swagger` (`openapi-docs-nestjs/TD-01`). O **tipo** de object storage já é dado pelo projeto (compatível com S3: S3 em produção, servidor compatível com MinIO localmente). Aqui só se decide como executá-lo e como usá-lo.

---

## TD-01: Tecnologia da Fila de Mensagens

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama de arquitetura deixa a Message Queue como "TBD". A API precisa publicar um job de processamento quando um upload termina, e um worker separado precisa consumi-lo, com retentativas e um estado terminal de falha (TD-12). A escolha adiciona (ou não) um novo container ao `compose.yaml` e define a API de produtor/consumidor usada pelos dois processos. O enunciado reprova soluções sem uma fila real subindo no Compose.

**Options:**

### Option A: BullMQ sobre Redis (`@nestjs/bullmq` + `bullmq` + container Redis)
- Biblioteca de filas de jobs com integração oficial ao NestJS (`BullModule.registerQueue`, `@Processor` + `WorkerHost`). O Redis guarda o estado dos jobs. Tem tentativas (attempts), backoff exponencial, IDs de job para deduplicação e eventos `failed`/`completed` nativos.
- **Pros:** A documentação do NestJS recomenda `@nestjs/bullmq` (o Bull está em modo de manutenção). Retentativa, backoff e deduplicação cobrem o TD-12 sem código próprio. Produtor e consumidor podem rodar em processos diferentes compartilhando o mesmo Redis. O Redis é um container pequeno e padrão.
- **Cons:** Adiciona o Redis à stack. O BullMQ 6.0.0 (2026-07-30) é recente e tem breaking changes em relação ao 5.x, então a versão major precisa ser fixada de forma deliberada (`plan-resolve`).

### Option B: BullMQ v6 com backend PostgreSQL
- O BullMQ 6 introduziu backends plugáveis (Redis e PostgreSQL). O backend PostgreSQL (`createPostgresBackend`) roda a API completa (`Queue`/`Worker`/`QueueEvents`) e tem schema próprio, versionado por `runMigrations`. Os jobs ficariam no serviço `db` já existente.
- **Pros:** Nenhum container novo. Mesma API do BullMQ da Opção A.
- **Cons:** O backend tem cerca de dois meses, e correções de PostgreSQL ainda saem em patches da linha 6.x. O `BullModule.forRoot` do `@nestjs/bullmq` documenta só a opção `connection` (Redis) e nenhuma forma de injetar o `BackendFactory` da v6. Um segundo schema de migrations (o do BullMQ) conviveria com as migrations do TypeORM. Os jobs dividem carga com o banco da aplicação. Sem um serviço de fila dedicado no Compose, arrisca o critério de aceite "fila real subindo no Compose".

### Option C: RabbitMQ (broker AMQP)
- Container de broker de mensagens dedicado. A API publica com `amqplib` ou com o transport RMQ do `@nestjs/microservices`. O worker consome com ack/nack.
- **Pros:** Broker real, com interface de gerenciamento. Independente de linguagem, o que permitiria um worker fora do Node. Semântica de entrega forte (acks, dead-letter exchanges).
- **Cons:** Não tem retentativa com atraso nem backoff exponencial nativos: isso exige montar DLX + TTL. O transport RMQ do `@nestjs/microservices` é orientado a padrões de mensagem, não a jobs (sem estado do job, tentativas ou deduplicação por id). Mais infraestrutura para configurar para um único tipo de job.

### Option D: pg-boss (fila de jobs sobre PostgreSQL)
- Fila de jobs em cima do PostgreSQL (`SKIP LOCKED`). Biblioteca madura, com retentativas, backoff e singleton keys.
- **Pros:** Madura. Nenhum container novo. Enfileiramento transacional, na mesma transação que atualiza a linha do vídeo.
- **Cons:** Sem módulo oficial para NestJS. Mesmo risco de Compose da Opção B (nenhum serviço de fila dedicado). Funciona por polling, o que gera carga no banco da aplicação.

**Recommendation:** **Opção A (BullMQ sobre Redis)**. É o caminho documentado pelo NestJS, traz retentativa, backoff e deduplicação por id de job prontos (necessários no TD-12) e adiciona um único container de fila pequeno e dedicado, o que atende o requisito do Compose. As Opções B e D evitam o container, mas colocam a carga dos jobs no banco da aplicação, e a B é nova demais. A Opção C exige montar a retentativa à mão para um único tipo de job. Fixar a versão major do BullMQ no `plan-resolve`; preferir a 5.x, a menos que a 6.x seja verificada com o `@nestjs/bullmq` 12.

**Decision:** Opção A (BullMQ sobre Redis)

---

## TD-02: Imagem Local do Servidor de Storage Compatível com S3

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O projeto define S3 em produção e MinIO localmente. Desde 2025-10 o projeto MinIO parou de publicar imagens da edição community, e em 2026-02 o repositório foi arquivado. Teste em 2026-10-05: `minio/minio:latest`, `quay.io/minio/minio:latest` e tags fixadas `RELEASE.2025-*` nos dois registros **não resolvem**, assim como `bitnami/minio:latest`. O serviço de storage do Compose precisa, portanto, de uma imagem compatível com S3 que realmente baixe e suporte multipart upload, URLs pré-assinadas, GETs com Range e regras de lifecycle (TD-05, TD-11).

**Options:**

### Option A: Silo — fork comunitário do MinIO (`pgsty/minio`)
- Mantido pela Pigsty, baseado no MinIO `RELEASE.2025-12-03`. Mantém a API S3 do MinIO, as variáveis de ambiente (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`), as convenções da CLI `mc` e o console embutido. Publica tags versionadas (a mais recente é `RELEASE.2026-08-04T00-00-00Z`).
- **Pros:** Substitui o "MinIO local" sem mudanças: mesma configuração, healthcheck e bootstrap de bucket com `mc` documentados em todo lugar. Tags versionadas que podem ser fixadas. Baixa com sucesso.
- **Cons:** Fork de terceiros, sem vínculo com a MinIO Inc. A manutenção de longo prazo depende de um único fornecedor comunitário.

### Option B: Imagem MinIO da Chainguard (`cgr.dev/chainguard/minio`)
- Imagem compilada a partir do código-fonte do MinIO pela Chainguard, com endurecimento para ter o mínimo de CVEs. Baixa com sucesso.
- **Pros:** Foco em segurança, recompilada com frequência, mesma semântica do MinIO da Opção A.
- **Cons:** O plano gratuito só publica `latest` (sem versões fixas), então os builds não são reproduzíveis. Acompanha um upstream arquivado.

### Option C: RustFS (`rustfs/rustfs`)
- Servidor compatível com S3 escrito em Rust, licença Apache-2.0. A versão 1.0 virou GA em 2026-09-16 (tag atual `1.0.1`). Suporta multipart, versionamento e lifecycle.
- **Pros:** Em desenvolvimento ativo, licença permissiva e uma linha 1.x com futuro.
- **Cons:** Virou GA há apenas três semanas. Variáveis de ambiente e ferramentas de administração diferentes das do MinIO, então documentação e exemplos fogem da convenção "MinIO local" do projeto. Menos histórico de uso em casos-limite de presign e lifecycle.

**Recommendation:** **Opção A (`pgsty/minio`, com tag `RELEASE.*` fixada)**. É a única opção que mantém exatamente a configuração "MinIO local" do projeto (mesmas variáveis de ambiente, `mc`, console) e permite fixar a versão, deixando o Compose reproduzível. Como a aplicação só fala S3 através do TD-03, trocar para o RustFS depois é uma mudança em um único serviço do Compose.

**Decision:** Opção A (`pgsty/minio`, com tag `RELEASE.*` fixada)

---

## TD-03: Biblioteca Cliente de S3

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A API e o worker precisam criar e concluir multipart uploads, pré-assinar PUTs de partes e GETs de objetos, consultar (head) e gravar objetos (thumbnail) e configurar regras de lifecycle. O mesmo cliente precisa funcionar contra o servidor local compatível com MinIO (TD-02) e contra o AWS S3 em produção.

**Options:**

### Option A: AWS SDK para JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Cliente S3 oficial e modular. Aponta para um endpoint fora da AWS com `endpoint` + `forcePathStyle: true`. `getSignedUrl(client, command)` pré-assina qualquer comando (`UploadPartCommand`, `GetObjectCommand` com `ResponseContentDisposition`).
- **Pros:** Mesmo código em dev (compatível com MinIO) e em produção (S3). Cobre todas as operações necessárias, inclusive o lifecycle `AbortIncompleteMultipartUpload`. Mantido ativamente (3.1146.x).
- **Cons:** API verbosa, baseada em objetos de comando. Árvore de dependências grande (modular, mas ainda volumosa). Desde a 3.731.0, o padrão `requestChecksumCalculation: WHEN_SUPPORTED` calcula CRC32 em todo `UploadPart`/`PutObject`. Numa URL pré-assinada, isso pode exigir que o navegador envie um checksum que ele não calcula, então o cliente precisa ser configurado com `WHEN_REQUIRED`.

### Option B: SDK JavaScript do MinIO (`minio`)
- Cliente S3 próprio do MinIO (`presignedUrl`, `putObject`, `statObject`).
- **Pros:** API mais simples. Funciona com qualquer servidor compatível com S3.
- **Cons:** O fornecedor arquivou o projeto do servidor, então o futuro do SDK é incerto. Não pré-assina chamadas `UploadPart` individuais, que são o centro do multipart feito pelo cliente no TD-05. Menos alinhado com "S3 em produção".

**Recommendation:** **Opção A (AWS SDK v3)**. O TD-05 precisa de URLs pré-assinadas por parte (`UploadPart`), e o SDK oficial pré-assina qualquer comando tanto no servidor local quanto no S3 real, o que mantém a promessa de "trocar MinIO por S3 em produção" restrita a configuração. Parâmetros do cliente a fixar no plano: `endpoint` (TD-09), `forcePathStyle: true` e `requestChecksumCalculation: 'WHEN_REQUIRED'` + `responseChecksumValidation: 'WHEN_REQUIRED'`. Sem isso, as URLs de parte pré-assinadas podem exigir checksums que o cliente do navegador não envia.

**Decision:** Opção A (AWS SDK v3)

---

## TD-04: Layout de Buckets e Chaves de Objeto

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** A API (pré-assinatura, conclusão do upload), o worker (leitura do original, gravação da thumbnail) e o Compose (criação do bucket, regra de lifecycle) precisam concordar sobre nomes de bucket e formato das chaves. Essas chaves ficam gravadas na tabela `videos`, então o layout é um contrato entre componentes. Depende do TD-02 e do TD-03.

**Options:**

### Option A: Um único bucket privado, com prefixo por vídeo
- Um bucket (ex.: `streamtube-media`). Chaves: `videos/{videoId}/source` (original) e `videos/{videoId}/thumbnail.jpg`. Sem acesso público: toda leitura passa por um GET pré-assinado (TD-11).
- **Pros:** Todos os artefatos de um vídeo compartilham o mesmo prefixo, o que transforma uma limpeza futura em uma simples exclusão por prefixo. Um bucket para criar e uma regra de lifecycle. A postura privada por padrão combina com o acesso só do dono na Fase 03 (TD-11).
- **Cons:** Originais e thumbnails não podem ter classes de armazenamento ou políticas diferentes por bucket (apenas regras por prefixo).

### Option B: Buckets separados por tipo de artefato
- `streamtube-videos` (originais privados) e `streamtube-thumbnails` (possivelmente com leitura pública), ambos com chave `{videoId}`.
- **Pros:** Políticas por bucket: thumbnails poderiam ser servidas publicamente sem pré-assinatura, e classes de armazenamento ou retenção podem ser diferentes.
- **Cons:** Dois buckets para criar, configurar e manter consistentes nos dois ambientes. Thumbnails públicas vazariam artefatos de vídeos em rascunho antes de a Fase 04 definir a visibilidade.

**Recommendation:** **Opção A (um bucket privado, prefixo `videos/{videoId}/…`)**. A Fase 03 ainda não tem conceito de visibilidade pública (ele chega na Fase 04), então um único bucket privado com leituras pré-assinadas é o layout mais simples que não vaza rascunhos. Regras de lifecycle por prefixo ainda permitem políticas diferentes por artefato, se necessário. As chaves usam o `videoId` (PK UUID), nunca o slug público (TD-10), então o slug não interfere no storage.

**Decision:** Opção A (um bucket privado, prefixo)

---

## TD-05: Estratégia de Upload para Arquivos de até 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Um arquivo de 10GB precisa ser enviado sem ocupar recursos da API durante a transferência, e o plano do projeto ("Pontos de Atenção") pede que seja possível **retomar após falha de conexão**. O handshake tem um lado no backend (endpoints, validação, upload id persistido) e um lado no cliente (divisão em partes, retentativas), por isso é um único contrato Cross-layer. Um `PutObject` único no S3 é limitado a 5GB, então um único PUT pré-assinado não comporta 10GB. Depende do TD-03.

**Options:**

### Option A: Multipart upload S3 pré-assinado, orquestrado pela API
- O `POST` de início cria a linha do vídeo em rascunho e chama `CreateMultipartUpload`, devolvendo `videoId`, `uploadId`, tamanho e quantidade de partes. O cliente pede URLs `UploadPart` pré-assinadas em lotes de números de parte, faz PUT de cada pedaço **direto no storage** e depois chama a conclusão com `{partNumber, ETag}[]`. Um endpoint de listagem de partes (`ListParts`) permite retomar. Há abort. Uma regra de lifecycle do bucket `AbortIncompleteMultipartUpload` recupera uploads abandonados.
- **Pros:** Nenhum byte de vídeo passa pela API. As partes podem subir em paralelo e ser reenviadas individualmente, o que permite retomar após falha de rede. Semântica nativa do S3, idêntica em dev e produção. Cabe nos limites do S3 (10GB ÷ 64MiB ≈ 160 partes, até 10.000 permitidas).
- **Cons:** O cliente precisa implementar a divisão em partes, a coleta de ETags e a retomada. O CORS do serviço de storage precisa expor o header `ETag`. Mais endpoints na API (iniciar, assinar partes, listar partes, concluir, abortar).

### Option B: Protocolo de upload retomável tus (`@tus/server` + store S3)
- Um servidor tus, montado na API ou como serviço separado, recebe pedaços via PATCH e os envia por streaming para um multipart S3.
- **Pros:** Protocolo retomável padrão, com clientes prontos (`tus-js-client`, Uppy). A retomada é tratada pelo próprio protocolo.
- **Cons:** **Todos os bytes passam por um processo Node.** Montado na API, é exatamente o padrão "arquivo passando pela API" que o enunciado reprova. Como serviço separado, é mais um container e exige ponte de autenticação. Adiciona um protocolo por cima do que o multipart S3 já oferece.

### Option C: Uma única URL PUT pré-assinada
- A API pré-assina uma URL `PutObject` e o cliente envia o arquivo inteiro em uma requisição.
- **Pros:** O handshake mais simples possível.
- **Cons:** **O S3 rejeita PUTs únicos acima de 5GB**, então não atende o requisito de 10GB. Sem retomada: uma falha aos 9GB recomeça do zero.

**Recommendation:** **Opção A (multipart pré-assinado orquestrado pela API)**. É a única opção que mantém os bytes fora da API, atende os 10GB dentro dos limites do S3 e oferece retomada por parte, como o plano do projeto exige. Parâmetros a fixar no plano: tamanho máximo de `10 GiB`, validado no início pelo tamanho declarado e conferido de novo via `HeadObject` na conclusão; partes de `64 MiB`; tipos de conteúdo `video/*`; regra de lifecycle abortando uploads incompletos após 1 dia; URLs de parte pré-assinadas com validade curta (por exemplo, 1h).

**Decision:** Opção A (multipart pré-assinado orquestrado pela API)

---

## TD-06: Gatilho de Conclusão do Upload para o Processamento

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O processamento precisa começar automaticamente quando o upload termina. Algo precisa (1) perceber que o objeto está completo, (2) tirar o vídeo do estado de upload e (3) enfileirar o job de processamento (TD-01). Depende do TD-05.

**Options:**

### Option A: Orientado pela API — o endpoint de conclusão enfileira
- A chamada de conclusão feita pelo cliente faz a API executar `CompleteMultipartUpload`, verificar o objeto (`HeadObject` com tamanho ≤ 10GB), mudar o status para `processing` e enfileirar `video.process` com `jobId = videoId`.
- **Pros:** Um único caminho de código, explícito e testável, na API. Posse e validação são checadas antes de existir qualquer job. Portável entre S3, forks do MinIO e RustFS (sem configuração de notificação específica do servidor). Determinístico nos testes e2e.
- **Cons:** Se o cliente nunca chamar a conclusão, nada é processado. É aceitável: o upload não terminou, e a regra de lifecycle mais o status `draft` cuidam do que sobrar.

### Option B: Notificações de evento do storage
- Configurar o servidor de storage para emitir eventos `s3:ObjectCreated:CompleteMultipartUpload` (webhook para a API, ou direto para Redis ou AMQP). O consumidor mapeia a chave para um vídeo e enfileira.
- **Pros:** O processamento começa mesmo que o cliente caia logo depois da última parte.
- **Cons:** A configuração de notificação é específica de cada servidor (env/`mc event` no MinIO, S3 → SNS/SQS/EventBridge), então dev e produção ficam diferentes. Um webhook de entrada a mais precisa de autenticação. Mais difícil de testar de forma determinística. Sem a chamada de conclusão na API, os ETags das partes ainda precisariam ser juntados em algum lugar, o que na prática reintroduz a Opção A.

**Recommendation:** **Opção A (conclusão orientada pela API)**. Com o multipart orquestrado pelo cliente (TD-05), a API precisa chamar `CompleteMultipartUpload` de qualquer forma, então enfileirar ali não custa nada, é portável e fica transacional com a mudança de status. A Opção B só adiciona infraestrutura que se comporta de forma diferente em cada ambiente.

**Decision:** Opção A (conclusão orientada pela API)
---

## TD-07: Topologia de Execução do Worker de Vídeo

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** A arquitetura define um container separado "Video Worker (FFmpeg)" que consome a fila, lê e grava no storage e atualiza o banco. Ele precisa da entidade `Video`, do data source do TypeORM, dos namespaces de configuração e do cliente S3 já construídos para a API. A localização do worker também define Dockerfile, serviço do Compose e configuração de testes. Depende do TD-01.

**Options:**

### Option A: Mesmo código NestJS, com entrypoint e container separados
- Um segundo bootstrap em `nestjs-project/src` (ex.: `worker.ts` → `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP) registra o processor do BullMQ. O serviço `video-worker` do Compose reaproveita o código da API e adiciona o FFmpeg à sua imagem (um target dedicado no Dockerfile).
- **Pros:** Reaproveita entidade, repositório, configuração, migrations e serviço de storage sem nenhuma duplicação. Um `package.json` e um único pipeline de lint/tsc/testes, então a Definition of Done cobre o worker automaticamente. Pode ser escalado de forma independente no Compose.
- **Cons:** A imagem do worker carrega dependências da API que ele não usa. As fronteiras de módulo precisam manter providers exclusivos de HTTP fora do `WorkerModule`.

### Option B: Subprojeto separado (`video-worker/`) com `package.json` próprio
- Um projeto Node independente (TS puro ou NestJS) na raiz do repositório, com seu próprio mapeamento de entidades, configuração e testes.
- **Pros:** Isolamento rígido e imagem mínima. Ciclo de release independente.
- **Cons:** Duplica a entidade `Video`, a configuração do banco, o cliente S3 e a validação de env, que passam a divergir. Um segundo conjunto de ferramentas para lint, checagem de tipos e testes. Contraria a ideia de "continuidade, não retrabalho".

### Option C: Consumidor no mesmo processo da API
- `@Processor` registrado no próprio processo da API (opcionalmente com sandboxed processors do BullMQ).
- **Pros:** Nenhum container extra. Ligação mais simples.
- **Cons:** Contraria a arquitetura (container de worker separado) e o enunciado ("processo/container separado"). A carga de CPU do FFmpeg disputa o mesmo container com o tráfego HTTP.

**Recommendation:** **Opção A (mesmo código, entrypoint e container separados)**. Atende a arquitetura de container separado reaproveitando todos os blocos já existentes, e o worker fica dentro do pipeline único de DoD do `nestjs-project` (testes + `tsc` + lint). O FFmpeg roda como processo filho (TD-08), então o event loop do Node não é bloqueado e os sandboxed processors são desnecessários.

**Decision:** Opção A (mesmo código, entrypoint e container separados)

---

## TD-08: Abordagem de Extração de Metadados e Geração de Thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa ler a duração e os metadados técnicos (container, codecs, resolução, bitrate) e gerar uma thumbnail JPEG a partir de um frame do vídeo, para arquivos de até 10GB, sem copiar o arquivo inteiro para o worker. A abordagem define a imagem do worker (binários do FFmpeg), como o original é lido (disco local ou HTTP) e o JSON de metadados gravado no banco. Depende do TD-03 e do TD-07.

**Options:**

### Option A: `ffprobe`/`ffmpeg` do sistema (pacote da imagem) executados via `child_process`, lendo uma URL GET pré-assinada
- O worker pré-assina um GET de curta duração para `videos/{id}/source` e executa `ffprobe -v error -print_format json -show_format -show_streams <url>`, depois `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=…` para gerar um JPEG, que é enviado com `PutObject`. A entrada HTTP do FFmpeg usa requisições com Range, então só os cabeçalhos do arquivo e o ponto de busca são baixados. O frame da thumbnail é pego em `min(10% da duração, duração − ε)`, voltando para `t=0` em clipes muito curtos.
- **Pros:** Nenhuma dependência de wrapper. Os binários vêm do pacote da distribuição na imagem do worker. Sem download de 10GB nem disco temporário. O JSON estruturado do ffprobe vai direto para a coluna de metadados. Fácil de testar unitariamente, mockando a fronteira do spawn, e de testar em integração com o FFmpeg real e um arquivo pequeno de fixture.
- **Cons:** Montagem de argumentos e parsing de saída feitos à mão. A busca remota depende de acesso de rede do worker ao storage (endpoint interno, ver TD-09).

### Option B: Binários npm `ffmpeg-static` / `ffprobe-static` + `child_process`
- Mesma abordagem de spawn, mas os binários vêm de pacotes npm em vez da imagem.
- **Pros:** Versão do binário fixada no `package.json`. Nenhuma mudança no Dockerfile.
- **Cons:** Binários grandes acabam no `node_modules` **tanto da API quanto do worker** (código único, TD-07). Os builds empacotados ficam atrás do FFmpeg upstream, e downloads específicos de plataforma durante a instalação são frágeis em um container de desenvolvimento com bind mount.

### Option C: Wrapper `fluent-ffmpeg`
- API JS fluente sobre a CLI do FFmpeg (`ffprobe()`, `.screenshots()`).
- **Pros:** API conveniente, muitos exemplos na internet.
- **Cons:** **Descontinuado no npm e arquivado em 2025-05-22**. O mantenedor afirma que ele não funciona mais corretamente com versões recentes do FFmpeg e recomenda chamar o FFmpeg diretamente. Inaceitável para código novo.

**Recommendation:** **Opção A (FFmpeg do sistema executado diretamente sobre uma URL pré-assinada)**. Segue a orientação do próprio upstream após a descontinuação do `fluent-ffmpeg`, mantém os binários fora do `node_modules` compartilhado e deixa o FFmpeg ler o original por Range via HTTP, de modo que um arquivo de 10GB nunca é copiado para o worker. Saída: thumbnail em `videos/{id}/thumbnail.jpg` (JPEG, 1280px de largura, proporção preservada). Os metadados mantêm `duration_seconds` como coluna tipada, mais um JSON curado (resumos de `format`, stream de `video` e stream de `audio`).

**Decision:** Opção A (FFmpeg do sistema executado diretamente sobre uma URL pré-assinada)

---

## TD-09: Configuração do Endpoint de Storage (Host Interno vs. Host Acessível pelo Navegador)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Uma URL pré-assinada embute o host para o qual foi assinada, e a assinatura é inválida para qualquer outro host. Os containers acessam o storage pelo nome do serviço do Compose (regra de Docker do CLAUDE.md: `http://storage:9000`), mas um navegador no host não resolve `storage`. As URLs entregues aos clientes (upload de partes, stream, download) precisam de um host acessível pelo navegador, enquanto as chamadas da própria API e a entrada do FFmpeg no worker precisam continuar com o host interno. Esse contrato envolve o schema de env, o `.env.example`, o `compose.yaml`, o código do serviço de storage e os futuros consumidores no frontend. Depende do TD-03.

**Options:**

### Option A: Dois endpoints — interno para chamadas do servidor, público para presigns entregues a clientes
- `S3_ENDPOINT=http://storage:9000` monta o cliente usado nas operações do servidor e nos presigns do worker. `S3_PUBLIC_ENDPOINT` (dev: `http://localhost:9000`, produção: o host real do S3/CDN) monta um segundo cliente S3, usado **apenas para pré-assinar** as URLs devolvidas aos clientes HTTP.
- **Pros:** Respeita a regra de Docker em toda chamada entre containers. As URLs pré-assinadas funcionam no navegador. Em produção, os dois valores podem apontar para o mesmo host S3. Explícito e testável.
- **Cons:** Duas instâncias de cliente S3 e uma variável de ambiente a mais. Os desenvolvedores precisam entender por que um dos endpoints é `localhost` (apenas o voltado ao navegador), o que precisa ser documentado como a única exceção autorizada.

### Option B: Endpoint único, tornando o nome do serviço resolvível a partir do host
- Assinar tudo com `http://storage:9000` e pedir aos desenvolvedores que mapeiem `storage` para `127.0.0.1` no arquivo hosts.
- **Pros:** Um cliente, uma variável de ambiente.
- **Cons:** Exige configuração manual do sistema operacional em cada máquina de desenvolvimento. Fácil de esquecer, e a falha parece um upload quebrado. Vaza nomes de infraestrutura para o contrato com o cliente.

### Option C: Fazer o tráfego dos clientes passar pela API/BFF
- Os clientes nunca veem URLs do storage: a API (ou o BFF do Next) repassa os bytes de e para o storage.
- **Pros:** Origem única. Sem CORS no storage.
- **Cons:** Coloca os bytes de vídeo de volta em processos Node, que é exatamente o que o TD-05 e o TD-11 evitam, e o enunciado reprova isso no upload.

**Recommendation:** **Opção A (endpoints interno + público)**. É a única opção que mantém os bytes fora da API e obedece à regra de nome de serviço do Compose em todo o tráfego entre containers. O valor `localhost` aparece apenas no `S3_PUBLIC_ENDPOINT`, voltado ao navegador, e isso precisa estar documentado no CLAUDE.md para não ser confundido com uma violação da regra de rede do Docker.

**Decision:** Opção A (endpoints interno + público)

---

## TD-10: Identificador de URL Única do Vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público curto, único e seguro para URL ("URL curta e única que nunca conflite", Pontos de Atenção). Ele é gerado no pré-cadastro, persistido com restrição de unicidade, exposto pela API e usado depois pelas rotas do frontend (ex.: `/watch/{slug}`), então backend e frontend compartilham o formato.

**Options:**

### Option A: ID curto aleatório com `crypto.randomBytes` (base64url, 11 caracteres) + índice único + nova tentativa
- Gerar 8 bytes aleatórios, codificar em base64url (11 caracteres, no estilo do YouTube, 64 bits de entropia) e inserir com restrição `UNIQUE`. Em caso de violação de unicidade, gerar outro e tentar de novo algumas vezes.
- **Pros:** Curto, não sequencial (não enumerável), sem dependência (`crypto` do Node). A restrição do banco garante o "nunca conflita". A probabilidade de colisão é desprezível nessa escala, e a nova tentativa garante a correção mesmo assim.
- **Cons:** Exige código de nova tentativa em caso de conflito. Não é legível por humanos.

### Option B: Usar a chave primária UUID na URL
- Expor `videos.id` (UUID) diretamente como identificador público.
- **Pros:** Nenhuma coluna ou código extra. Único por construção.
- **Cons:** 36 caracteres: não é a URL curta que o plano pede. Acopla a URL pública à PK interna.

### Option C: Codificação Sqids/Hashids de um número sequencial
- Adicionar um `bigserial` e codificá-lo com Sqids em uma string curta.
- **Pros:** Curto e único por construção (codificação bijetiva), sem nova tentativa.
- **Cons:** Sequencial por baixo: decodificável e enumerável, o que vaza o volume de uploads e facilita adivinhar vídeos unlisted (Fases 04/05). Adiciona uma dependência e uma segunda coluna de sequência.

**Recommendation:** **Opção A (ID aleatório base64url de 11 caracteres com restrição de unicidade)**. Atende o "curto e sem conflito" sem dependência e, ao contrário do Sqids, não é enumerável, o que importa para a visibilidade unlisted (acesso só por link) das Fases 04 e 05. Coluna `slug varchar(11) UNIQUE`, gerada no pré-cadastro e imutável.

**Decision:** Opção A (ID aleatório base64url de 11 caracteres com restrição de unicidade)

---

## TD-11: Entrega de Streaming e Download, e Quem Pode Acessá-los

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A reprodução precisa começar sem baixar o arquivo inteiro, o que exige HTTP Range / `206 Partial Content`, e os usuários precisam conseguir baixar o arquivo. Um `<video src>` em HTML não consegue enviar o header `Authorization`, então o mecanismo de entrega também define o controle de acesso. Visibilidade (público ou unlisted) e publicação só chegam na Fase 04, então todos os vídeos da Fase 03 são não publicados. Depende do TD-03, do TD-04 e do TD-09.

**Options:**

### Option A: A API devolve URLs GET pré-assinadas de curta duração (o storage atende Range/206 nativamente)
- `GET /videos/{id}/stream` (JWT, dono) devolve `{ url, expiresAt }` com uma URL `GetObject` pré-assinada. `GET /videos/{id}/download` devolve uma URL pré-assinada com `ResponseContentDisposition=attachment; filename="…"`. Range e 206 são tratados pelo servidor S3.
- **Pros:** Nenhum byte de vídeo passa pela API. Range, busca (seeking) e 206 são nativos e testados em batalha nos servidores S3. Funciona com `<video src>`, porque nenhum header é necessário. Bate com a relação "Frontend → Object Storage: Streams" do diagrama.
- **Cons:** A URL funciona como um token de portador até expirar (mitigado com TTL curto). O comportamento de Range é do servidor de storage, não é testável como código da API (verificado no e2e contra o serviço de storage real).

### Option B: A API repassa os bytes com suporte a Range
- O controller interpreta o `Range`, chama `GetObject` com esse intervalo e repassa o corpo via `StreamableFile` com `206`, `Content-Range` e `Accept-Ranges`.
- **Pros:** Origem única, acesso verificado a cada requisição, storage nunca exposto.
- **Cons:** Cada byte de cada visualização passa pela API, que é o problema de escalabilidade que a arquitetura evita. Parsing de Range e casos-limite escritos à mão. A autenticação no `<video>` exigiria cookies ou tokens na query string de qualquer forma.

### Option C: Streaming adaptativo (transcodificação HLS/DASH)
- O worker transcodifica em versões segmentadas e um manifesto. Os players buscam os segmentos.
- **Pros:** Bitrate adaptativo. É a abordagem do "YouTube de verdade".
- **Cons:** Transcodificação não está nas capacidades da Fase 03 (apenas extração de duração e metadados mais uma thumbnail). Multiplica o tempo de processamento e o armazenamento. Fora do escopo.

**Recommendation:** **Opção A (URLs GET pré-assinadas, acesso só do dono na Fase 03)**. O suporte nativo a Range do S3 entrega streaming sem tocar na API, e URLs pré-assinadas são o único mecanismo que funciona com `<video src>` sem cookies. Acesso: na Fase 03, só o dono autenticado pode obter URLs de stream e de download, e só com status `ready`. A Fase 05 adiciona acesso anônimo para vídeos publicados como regra aditiva, então nunca será preciso adaptar uma restrição depois. A validade das URLs é parâmetro do plano (ex.: 1h para stream, 15 min para download).

**Decision:** Opção A (URLs GET pré-assinadas, acesso só do dono na Fase 03)
---

## TD-12: Ciclo de Status do Vídeo e Política de Falha no Processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A linha do vídeo é criada como rascunho quando o upload começa, passa para processamento quando o upload termina e termina como pronta ou com erro. A coluna de status é escrita pela API (iniciar, concluir, abortar) e pelo worker (pronto ou erro), e a política de falha depende dos recursos da fila (TD-01). A Fase 04 vai adicionar o fluxo de publicação ("rascunho → publicação"), então o status da Fase 03 não pode bloquear isso.

**Options:**

### Option A: Enum único `status` `draft → processing → ready | failed`, retentativas limitadas, `failed` terminal
- `draft` = pré-cadastrado, upload em andamento ou não concluído. `processing` = upload concluído e job enfileirado ou em execução. `ready` = metadados e thumbnail gravados. `failed` = o processamento esgotou as tentativas (texto em `processing_error`). O job roda com `attempts: 3`, backoff exponencial e `jobId = videoId` (reenfileiramento idempotente). O evento `failed` do worker do BullMQ dispara **a cada tentativa que falha**, não só na última. Por isso o handler grava `failed` apenas quando `job.attemptsMade >= job.opts.attempts`. Erros permanentes, como um arquivo que o ffprobe não reconhece como vídeo, são lançados como `UnrecoverableError`, que vai direto para falha sem gastar retentativas. O worker é idempotente: sobrescreve thumbnail e metadados ao tentar de novo. Uploads `draft` abandonados são recuperados pela regra de lifecycle do storage (TD-05).
- **Pros:** Bate literalmente com o ciclo do enunciado e do plano. Uma única coluna para consultar. Retentativas limitadas absorvem erros transitórios (oscilação do storage, reinício do worker) sem esconder erros permanentes (arquivo corrompido).
- **Cons:** A palavra "draft" se sobrepõe ao rascunho de publicação da Fase 04. A Fase 04 precisa modelar a publicação separadamente (ex.: `published_at` ou uma coluna de visibilidade), e um vídeo `ready` continua não publicado até lá.

### Option B: Dois campos independentes desde já — `processing_status` + `publication_status`
- `processing_status: uploading | processing | ready | failed` e `publication_status: draft | published` (só `draft` é usado na Fase 03). Mesma política de retentativa da A.
- **Pros:** Sem sobreposição de nomes com a Fase 04. O estado de publicação existe desde o início.
- **Cons:** Introduz um conceito da Fase 04 (publicação) na Fase 03 sem comportamento nenhum por trás. Diverge do ciclo literal `rascunho → processando → pronto/erro` que o enunciado avalia. Duas colunas para manter consistentes.

### Option C: Enum único, sem retentativa automática (falha imediata)
- Mesmos estados da A, mas qualquer erro de processamento grava `failed` na hora (`attempts: 1`).
- **Pros:** O mais simples. As falhas aparecem imediatamente.
- **Cons:** Erros transitórios de storage ou rede e reinícios do worker fazem uploads válidos falharem de vez, obrigando a reenviar 10GB.

**Recommendation:** **Opção A (enum único `draft | processing | ready | failed`, com 3 tentativas e backoff exponencial, `failed` terminal + mensagem de erro)**. Bate com o ciclo exigido, mantém a Fase 03 livre de conceitos da Fase 04, e as retentativas limitadas evitam que o usuário tenha de reenviar 10GB por causa de um erro transitório. O plano da Fase 04 precisa adicionar a publicação como campo separado; registrar essa passagem nas notas de fora de escopo do plano da Fase 03. Sem endpoint de reprocessamento manual na Fase 03.

**Decision:** Option A: Enum único `status` `draft → processing → ready | failed`, retentativas limitadas, `failed` terminal

---

## TD-13: Onde o FFmpeg fica disponível para a suíte de testes

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Origem: issue `MD-1` de `docs/phases/phase-03-videos/validation.md`. Pelo `nestjs-project/CLAUDE.md`, todos os comandos de teste (`npm test`, `npm run test:e2e`) rodam dentro do container `nestjs-api`, cuja imagem (`Dockerfile.dev`, `node:25.6.0-slim`) não tem FFmpeg. O TD-07 previu o FFmpeg só na imagem do worker, mas também manteve o worker no pipeline único de DoD. Sem FFmpeg onde o Jest roda, os testes reais de `ffprobe`/`ffmpeg` (TD-08) não executam. A escolha afeta `Dockerfile.dev`, `compose.yaml`, os scripts de teste e a Definition of Done. Complementa o TD-07 e o TD-08, sem reabri-los.

**Options:**

### Option A: FFmpeg na imagem de desenvolvimento comum, usada pela API e pelo worker
- O `Dockerfile.dev` passa a instalar `ffmpeg` (pacote da distribuição). Os serviços `nestjs-api` e `video-worker` usam a mesma imagem de dev, em containers separados (TD-07 mantido). A suíte inteira continua rodando no `nestjs-api`.
- **Pros:** um único comando de teste e a mesma DoD (`npm test`, `npm run test:e2e`, `tsc`, `lint` no mesmo container). Nenhuma mudança no fluxo documentado no CLAUDE.md. Um único Dockerfile para manter em dev.
- **Cons:** a imagem de dev da API fica maior (o FFmpeg e suas bibliotecas somam centenas de MB) e carrega um binário que a API não usa em runtime. A separação de imagens de produção fica para quando houver deploy (Fase 07).

### Option B: Dockerfile com dois targets e testes do worker rodando no container do worker
- O `Dockerfile.dev` ganha os targets `api` (sem FFmpeg) e `worker` (com FFmpeg). Os testes que dependem de FFmpeg rodam com um script próprio (ex.: `npm run test:worker`) dentro do container `video-worker`; o resto da suíte segue no `nestjs-api`.
- **Pros:** a imagem da API continua enxuta. A separação fica igual à de produção desde já.
- **Cons:** a DoD passa a ter dois comandos em dois containers, e o "suíte completa verde" depende de lembrar dos dois. É preciso separar os testes por padrão de arquivo ou configuração do Jest. Aumenta o risco de um teste ficar fora das duas execuções.

### Option C: Suíte inteira rodando no container do worker
- Só a imagem do worker tem FFmpeg, e todos os comandos de teste passam a ser executados no `video-worker` (a imagem dele é um superconjunto da API).
- **Pros:** um único comando de teste; a imagem da API fica sem FFmpeg.
- **Cons:** muda a convenção documentada ("todo comando roda no `nestjs-api`"), confunde onde rodar `tsc`/`lint`/testes e acopla a suíte da API a um container cuja função é processar a fila (ele precisaria ser iniciado mesmo para testar só a API).

**Recommendation:** **Opção A (FFmpeg na imagem de desenvolvimento comum)**. Mantém intactas a convenção do CLAUDE.md e a Definition of Done (um container, os mesmos quatro comandos), e é o único jeito de rodar os testes reais de FFmpeg sem dividir a suíte. O custo é o tamanho da imagem de dev, aceitável num ambiente local; a imagem de produção sem FFmpeg para a API é uma otimização de deploy que pertence à Fase 07. Registrar no plano que o "target dedicado" citado no texto da Opção A do TD-07 vira, em dev, a mesma imagem para os dois serviços.

**Decision:** _[pending]_

---

## TD-14: Como o worker é exercitado nos testes sem interferir no ambiente de dev

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Testes e desenvolvimento usam o mesmo Postgres (`streamtube`, ver `src/test/create-test-data-source.ts`) e vão usar o mesmo Redis. Se o container `video-worker` estiver rodando durante `npm test`, ele pode consumir os jobs criados pelos testes, processando-os contra dados que o teste apaga em seguida (`cleanAllTables`) e deixando os testes não determinísticos. Pela documentação consultada via context7, o BullMQ separa filas pelo `prefix` das chaves no Redis (padrão `"bull"`, que precisa ser igual em todos os componentes que acessam a fila), e o `@nestjs/bullmq` repassa esse `prefix` ao `Worker`. Depende do TD-13 (FFmpeg disponível onde o processor roda).

**Options:**

### Option A: Worker dentro do processo de teste, com prefixo de fila exclusivo para testes
- Os testes de integração do processor e o teste do pipeline completo sobem o módulo do worker no próprio Jest (`Test.createTestingModule` com o processor, ou `createApplicationContext(WorkerModule)`). O prefixo da fila vem de uma variável de ambiente (ex.: `QUEUE_PREFIX`): um valor em dev e outro exclusivo nos testes, de modo que o container `video-worker` nunca enxerga os jobs de teste.
- **Pros:** determinístico: o teste controla quando o worker sobe, processa e fecha. Funciona com o `video-worker` do Compose ligado ou desligado. Testa o processor real contra Redis, Postgres e storage reais.
- **Cons:** uma variável de ambiente a mais no schema Joi, no `.env.example` e no `compose.yaml`. O teste do pipeline completo precisa esperar (polling com timeout) o status `ready` no banco.

### Option B: Usar o container `video-worker` do Compose nos testes e2e
- O e2e faz o upload pela API e espera o worker do Compose processar, consultando o banco até `ready`.
- **Pros:** exercita exatamente o container que roda em dev. Nenhum código de bootstrap do worker nos testes.
- **Cons:** o resultado depende de o container estar de pé e com o código atualizado. Corre contra o `cleanAllTables` dos testes no mesmo banco. Falhas no worker aparecem só como timeout no teste, sem stack trace. Não há como isolar os testes de um desenvolvedor usando a aplicação ao mesmo tempo.

### Option C: Testes de integração do processor no processo de teste, sem teste de pipeline completo
- Igual à Opção A para o processor (recebe um job e verifica banco e storage), mas o e2e da API para no enfileiramento (verifica o job na fila) e não existe teste que una upload → fila → worker → `ready`.
- **Pros:** testes mais rápidos e simples, sem espera assíncrona.
- **Cons:** a entrega "processamento automático do vídeo" nunca é verificada de ponta a ponta. Uma quebra no contrato entre o produtor (API) e o consumidor (worker), como o nome da fila, o formato do payload ou o prefixo, passa despercebida.

**Recommendation:** **Opção A (worker no processo de teste, com prefixo de fila exclusivo)**. É a única opção determinística que testa o processamento real e o contrato produtor ↔ consumidor de ponta a ponta sem depender do estado do container de dev. O prefixo por ambiente é o mecanismo nativo do BullMQ para isolar filas no mesmo Redis e custa uma variável de ambiente. A Opção B deixa o resultado dos testes à mercê do container e do banco compartilhado; a Opção C deixa sem verificação justamente a entrega principal da fase.

**Decision:** _[pending]_

---

## TD-15: Storage usado pelos testes que envolvem upload e worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O guia `testing-guide-nestjs-project` (`references/external-systems.md`, seção "Object Storage — Local Filesystem", escrita antes das decisões da Fase 03) manda usar um adaptador de filesystem local nos testes. Mas o TD-03, o TD-05, o TD-08 e o TD-11 dependem de recursos que só existem na API S3: multipart com URLs pré-assinadas por parte, `HeadObject`, GET pré-assinado com Range (lido pelo FFmpeg via HTTP) e regras de lifecycle. O enunciado também pede para não mockar o que dá para testar com a infra do Compose. Depende do TD-14.

**Options:**

### Option A: MinIO real do Compose com um bucket exclusivo para testes
- Os testes usam o serviço de storage do Compose (`pgsty/minio`, TD-02) com um bucket próprio (ex.: `streamtube-media-test`, definido por variável de ambiente), criado no setup se não existir e esvaziado entre suítes.
- **Pros:** exercita de verdade multipart, presign, Range e `HeadObject`, exatamente como em dev e produção. Isolado dos arquivos de dev. Segue a orientação do enunciado.
- **Cons:** os testes dependem do container de storage estar de pé (como já dependem do Postgres). É preciso limpar o bucket entre suítes. O guia de testes precisa ser atualizado para não contradizer a prática.

### Option B: Adaptador de filesystem local (como diz o guia de testes)
- Uma interface de storage com duas implementações, local e S3; os testes usam a local, num diretório temporário.
- **Pros:** testes sem dependência do container de storage. Segue o texto atual do guia.
- **Cons:** não existe URL pré-assinada nem Range de um filesystem local acessível ao FFmpeg do worker. Multipart e lifecycle não são exercitados. Os testes passariam com um código que falharia contra o S3 real. Exige manter um segundo adaptador só para testes.

### Option C: MinIO real com o mesmo bucket de dev e prefixo `test/` nas chaves
- Os testes usam o bucket de desenvolvimento, gravando sob um prefixo de chave próprio.
- **Pros:** nenhum bucket extra para criar.
- **Cons:** as chaves seguem o layout `videos/{videoId}/…` do TD-04; acrescentar um prefixo só para testes desvia do layout real. Limpar por prefixo no bucket de dev arrisca apagar arquivos de desenvolvimento por engano.

**Recommendation:** **Opção A (MinIO real com bucket exclusivo de testes)**. É a única opção que testa as capacidades de que a fase realmente depende (multipart pré-assinado, Range lido pelo FFmpeg, `HeadObject`) mantendo o layout de chaves do TD-04 e isolando os dados de dev. Atualizar a seção "Object Storage" do guia `testing-guide-nestjs-project` deve entrar como tarefa do plano, para que o guia não contradiga a decisão.

**Decision:** _[pending]_

---


## Decisions Summary

| ID | Scope | Decisão | Recomendação | Escolha |
|----|-------|---------|--------------|---------|
| TD-01 | Backend | Tecnologia da Fila de Mensagens | BullMQ sobre Redis (`@nestjs/bullmq`) | A (BullMQ sobre Redis) |
| TD-02 | Repo-wide | Imagem Local do Servidor de Storage Compatível com S3 | `pgsty/minio` (fork Silo), tag fixada | A (`pgsty/minio`, com tag `RELEASE.*` fixada) |
| TD-03 | Backend | Biblioteca Cliente de S3 | AWS SDK v3 (`client-s3` + `s3-request-presigner`) | A (AWS SDK v3) |
| TD-04 | Backend | Layout de Buckets e Chaves de Objeto | Um bucket privado, `videos/{videoId}/…` | A (um bucket privado, prefixo) |
| TD-05 | Cross-layer | Estratégia de Upload para Arquivos de até 10GB | Multipart S3 pré-assinado orquestrado pela API | A (multipart pré-assinado orquestrado pela API) |
| TD-06 | Backend | Gatilho de Conclusão do Upload para o Processamento | Endpoint de conclusão da API enfileira o job | A (conclusão orientada pela API) |
| TD-07 | Backend | Topologia de Execução do Worker de Vídeo | Mesmo código, entrypoint + container separados | A (mesmo código, entrypoint e container separados) |
| TD-08 | Backend | Extração de Metadados e Geração de Thumbnail | FFmpeg do sistema executado sobre URL pré-assinada | A (FFmpeg do sistema executado diretamente sobre uma URL pré-assinada) |
| TD-09 | Cross-layer | Configuração do Endpoint de Storage | Endpoints interno + público (navegador) | A (endpoints interno + público) |
| TD-10 | Cross-layer | Identificador de URL Única do Vídeo | Base64url aleatório de 11 caracteres + índice único | A (ID aleatório base64url de 11 caracteres com restrição de unicidade) |
| TD-11 | Cross-layer | Entrega de Streaming e Download, e Acesso | URLs GET pré-assinadas, só o dono, só `ready` | A (URLs GET pré-assinadas, acesso só do dono na Fase 03) |
| TD-12 | Backend | Ciclo de Status do Vídeo e Política de Falha | `draft → processing → ready \| failed`, 3 tentativas | A (enum único `draft → processing → ready \| failed`, retentativas limitadas, `failed` terminal) |
| TD-13 | Repo-wide | Onde o FFmpeg fica disponível para a suíte de testes | FFmpeg na imagem de dev comum (API + worker) | _[pending]_ |
| TD-14 | Backend | Como o worker é exercitado nos testes sem interferir no dev | Worker no processo de teste + prefixo de fila exclusivo | _[pending]_ |
| TD-15 | Backend | Storage usado pelos testes de upload e worker | MinIO real com bucket exclusivo de testes | _[pending]_ |
