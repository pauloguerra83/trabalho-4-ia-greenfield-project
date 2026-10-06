---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete (conclusão do upload) — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` fecha o upload de um vídeo `draft`. A API executa `CompleteMultipartUpload` com as partes informadas (`{ partNumber, ETag }[]`) e confere o objeto final com `HeadObject` (limite de 10 GiB). Em seguida, grava o tamanho real, passa o vídeo para `processing` e enfileira o job `video.process` com `jobId = videoId` na fila `video-processing`. Partes que não conferem com o storage mantêm o vídeo em `draft`. Um multipart expirado leva o vídeo a `failed` com `upload_expired`. O endpoint é exclusivo do dono.

## Test Scenarios

### 1. Concluir o upload e disparar o processamento

**Setup:**

- `Test.createTestingModule({ imports: [AppModule] })` com a configuração global do `main.ts`.
- `beforeEach`: `cleanAllTables`, `emptyBucket()` do bucket de testes, `obliterate({ force: true })` da fila `video-processing` (prefixo de teste) e limpeza do storage do throttler.
- Usuário confirmado e autenticado via `POST /auth/login`.
- Vídeo `draft` criado por `POST /videos` com `fileSize: 1000`; parte 1 enviada por `PUT` na URL de `POST /videos/:id/upload/part-urls`, com o `ETag` guardado.
- Nenhum worker roda neste arquivo: os jobs ficam na fila para inspeção pela instância `Queue` obtida do módulo (`getQueueToken('video-processing')`).

#### 1.1. concluir-upload-grava-processing-e-enfileira

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/complete com JWT do dono e body `{ "parts": [{ "partNumber": 1, "ETag": "<ETag do PUT>" }] }`
    - expect: status 202
    - expect: body `{ videoId: <id>, status: "processing" }`
  2. `HeadObject` em `videos/{videoId}/source` no storage
    - expect: o objeto existe com `ContentLength = 1000`
  3. Consultar a linha em `videos`
    - expect: `status = 'processing'`, `size_bytes = 1000` e `upload_id = null`
  4. `queue.getJob(videoId)` na fila `video-processing`
    - expect: o job existe com nome `video.process`, `data = { videoId }`, `opts.attempts = 3` e backoff exponencial

### 2. Rejeitar conclusões inválidas

**Setup:** igual ao grupo 1, com um segundo usuário confirmado e autenticado para o cenário de acesso.

#### 2.1. etag-que-nao-confere-retorna-400-e-mantem-draft

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/complete com body `{ "parts": [{ "partNumber": 1, "ETag": "\"00000000000000000000000000000000\"" }] }`
    - expect: status 400
    - expect: body com `error: "INVALID_UPLOAD_PARTS"`
  2. Consultar a linha em `videos` e a fila
    - expect: `status = 'draft'` e `upload_id` preenchido
    - expect: nenhum job para o `videoId`
  3. Repetir a conclusão com o `ETag` correto
    - expect: status 202 (o cliente consegue corrigir e concluir)

#### 2.2. upload-expirado-retorna-410

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. Abortar o multipart direto no storage (`StorageService.abortMultipartUpload`), simulando a regra de lifecycle
  2. POST /videos/:id/upload/complete com as partes enviadas
    - expect: status 410 com `error: "UPLOAD_EXPIRED"`
  3. Consultar a linha em `videos` e a fila
    - expect: `status = 'failed'` e `processing_error = 'upload_expired'`
    - expect: nenhum job para o `videoId`

#### 2.3. concluir-duas-vezes-retorna-409-sem-segundo-job

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/complete com as partes corretas
    - expect: status 202
  2. POST /videos/:id/upload/complete de novo, com o mesmo body
    - expect: status 409 com `error: "INVALID_VIDEO_STATUS"`
  3. Contar os jobs da fila `video-processing`
    - expect: existe exatamente um job, com `jobId = videoId`

#### 2.4. outro-usuario-recebe-404

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/complete com JWT do segundo usuário e as partes corretas
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `draft` e nenhum job é criado
  2. POST /videos/:id/upload/complete com JWT do dono e body `{ "parts": [] }`
    - expect: status 400 com `error: "VALIDATION_ERROR"`
