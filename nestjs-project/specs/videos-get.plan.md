---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:id (consulta do dono) — Test Plan

## Application Overview

`GET /videos/:id` devolve ao dono o estado atual do vídeo: `id`, `slug`, `title`, `status`, `durationSeconds`, `metadata` (`format`, `video`, `audio`), `thumbnailUrl` (GET pré-assinado da thumbnail, ou `null`), `processingError`, `createdAt` e `updatedAt`. O cliente faz polling nesse endpoint para acompanhar a passagem de `processing` para `ready`. Outros usuários recebem 404, sem revelar se o vídeo existe. A consulta pelo `slug` e o acesso anônimo ficam para a Fase 05.

## Test Scenarios

### 1. Consultar o vídeo em cada status

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` com a configuração global do `main.ts`; `beforeEach` com `cleanAllTables`, `emptyBucket()` do bucket de testes e limpeza do storage do throttler; usuário confirmado e autenticado via `POST /auth/login`; vídeo criado por `POST /videos`. Os estados `ready` e `failed` são montados pelo teste atualizando a linha via repositório, com `putObject` de um JPEG em `videos/{videoId}/thumbnail.jpg` no caso `ready`. O processamento real fica no pipeline e2e do SI-03.12.

#### 1.1. video-draft-retorna-campos-de-processamento-nulos

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id com JWT do dono, logo após o `POST /videos`
    - expect: status 200
    - expect: body com `id`, o mesmo `slug` e `title` do início, `status: "draft"`, `durationSeconds: null`, `metadata: null`, `thumbnailUrl: null`, `processingError: null` e `createdAt`/`updatedAt` em ISO-8601

#### 1.2. video-ready-retorna-metadados-e-thumbnail-acessivel

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. Atualizar a linha para `status = 'ready'`, `duration_seconds = 4.5`, `metadata = { format: {...}, video: {...}, audio: null }` e `thumbnail_key = 'videos/{videoId}/thumbnail.jpg'`, e gravar o JPEG nessa chave
  2. GET /videos/:id com JWT do dono
    - expect: status 200
    - expect: `status: "ready"`, `durationSeconds: 4.5` e `metadata` com as chaves `format`, `video` e `audio`
    - expect: `thumbnailUrl` é uma URL pré-assinada do storage
  3. `fetch(thumbnailUrl)`
    - expect: status 200 com `Content-Type: image/jpeg`

#### 1.3. video-failed-retorna-motivo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. DELETE /videos/:id/upload com JWT do dono, levando o vídeo a `failed` com `upload_aborted`
    - expect: status 204
  2. GET /videos/:id com JWT do dono
    - expect: status 200 com `status: "failed"` e `processingError: "upload_aborted"`

### 2. Proteger o acesso ao vídeo

**Setup:** igual ao grupo 1, com um segundo usuário confirmado e autenticado.

#### 2.1. outro-usuario-recebe-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/:id com JWT do segundo usuário
    - expect: status 404
    - expect: body `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
  2. GET /videos/<uuid aleatório inexistente> com JWT do dono
    - expect: status 404 com o mesmo body (a resposta não distingue "não existe" de "não é seu")
  3. GET /videos/:id sem header `Authorization`
    - expect: status 401

#### 2.2. id-que-nao-e-uuid-retorna-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-05T22:40:33Z

**Steps:**
  1. GET /videos/not-a-uuid com JWT do dono
    - expect: status 400
    - expect: body com `error: "VALIDATION_ERROR"`
