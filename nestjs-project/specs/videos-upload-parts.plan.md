---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# URLs de partes, retomada e abort do upload — Test Plan

## Application Overview

Três endpoints acompanham o upload em andamento de um vídeo `draft`:

- `POST /videos/:id/upload/part-urls` devolve URLs `UploadPart` pré-assinadas para um lote de números de parte. O cliente faz `PUT` de cada pedaço direto no storage.
- `GET /videos/:id/upload/parts` lista as partes que o storage já recebeu, para o cliente retomar um upload interrompido.
- `DELETE /videos/:id/upload` aborta o upload.

Se o multipart não existir mais no storage (abortado pela regra de lifecycle), o vídeo passa a `failed` com `processing_error = 'upload_expired'`. Os três endpoints são exclusivos do dono e só valem para vídeos em `draft`.

## Test Scenarios

### 1. Enviar, retomar e abortar o upload

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` com a configuração global do `main.ts` (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `beforeEach` com `cleanAllTables`, `emptyBucket()` do bucket de testes e limpeza do storage do throttler; usuário confirmado e autenticado via `POST /auth/login`; vídeo `draft` criado por `POST /videos` com `fileSize: 1000` (`partCount: 1`). Em teste, `S3_PUBLIC_ENDPOINT` aponta para `http://storage:9000`, então as URLs são alcançáveis de dentro do container.

#### 1.1. url-de-parte-aceita-put-direto-no-storage

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com JWT do dono e body `{ "partNumbers": [1] }`
    - expect: status 200
    - expect: body `parts` com um item `{ partNumber: 1, url }` e `expiresAt` entre 55 e 65 minutos à frente do horário da requisição
  2. `fetch(url, { method: 'PUT', body: <1000 bytes> })`
    - expect: status 200 do storage
    - expect: header `ETag` presente na resposta

#### 1.2. listar-partes-permite-retomar

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. Obter a URL da parte 1 e fazer `PUT` de 1000 bytes nela, guardando o `ETag`
    - expect: status 200 do storage
  2. GET /videos/:id/upload/parts com JWT do dono
    - expect: status 200
    - expect: body com `uploadId` igual ao do início, `partSize: 67108864`, `partCount: 1` e `parts: [{ partNumber: 1, ETag: <mesmo ETag do PUT>, size: 1000 }]`

#### 1.3. abortar-upload-marca-video-como-falho

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. DELETE /videos/:id/upload com JWT do dono
    - expect: status 204 sem corpo
  2. Consultar a linha em `videos`
    - expect: `status = 'failed'`, `processing_error = 'upload_aborted'` e `upload_id = null`
  3. Chamar `ListParts` no storage com o `uploadId` original
    - expect: o storage responde `NoSuchUpload`

### 2. Rejeitar operações inválidas no upload

**Setup:** igual ao grupo 1, com um segundo usuário confirmado e autenticado para os cenários de acesso.

#### 2.1. part-number-acima-de-part-count-retorna-400

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com JWT do dono e body `{ "partNumbers": [2] }` (o vídeo tem `partCount: 1`)
    - expect: status 400
    - expect: body com `error: "INVALID_PART_NUMBER"`
  2. POST /videos/:id/upload/part-urls com body `{ "partNumbers": [] }`
    - expect: status 400 com `error: "VALIDATION_ERROR"`

#### 2.2. upload-expirado-retorna-410-e-marca-falha

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. Abortar o multipart direto no storage (`StorageService.abortMultipartUpload`), simulando a regra de lifecycle
  2. GET /videos/:id/upload/parts com JWT do dono
    - expect: status 410
    - expect: body `{ statusCode: 410, error: "UPLOAD_EXPIRED", message: "Upload session has expired" }`
  3. Consultar a linha em `videos`
    - expect: `status = 'failed'`, `processing_error = 'upload_expired'` e `upload_id = null`

#### 2.3. outro-usuario-recebe-404-nos-tres-endpoints

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com JWT do segundo usuário e body `{ "partNumbers": [1] }`
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:id/upload/parts com JWT do segundo usuário
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
  3. DELETE /videos/:id/upload com JWT do segundo usuário
    - expect: status 404 com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `draft` no banco
  4. GET /videos/not-a-uuid/upload/parts com JWT do dono
    - expect: status 400 com `error: "VALIDATION_ERROR"`

#### 2.4. video-fora-de-draft-recebe-409-nos-tres-endpoints

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. DELETE /videos/:id/upload com JWT do dono, levando o vídeo a `failed`
    - expect: status 204
  2. POST /videos/:id/upload/part-urls com body `{ "partNumbers": [1] }`
    - expect: status 409 com `error: "INVALID_VIDEO_STATUS"`
  3. GET /videos/:id/upload/parts
    - expect: status 409 com `error: "INVALID_VIDEO_STATUS"`
  4. DELETE /videos/:id/upload de novo
    - expect: status 409 com `error: "INVALID_VIDEO_STATUS"`
